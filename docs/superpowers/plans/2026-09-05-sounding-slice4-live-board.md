# Slice 4 — The Live Board on the Web: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web live page looks and behaves like the approved prototype (board, heard words, round control, sheet with Context / Transcript / Chart, scrub-to-replay), and the reading keeps moving during model calls.

**Architecture:** (1) `SoundingSession.feedCommitted` interprets *outside* the op queue and applies inside it, so ticks flow; replay stays byte-identical because the runner awaits `feedCommitted` and time does not move meanwhile. (2) The prototype's presentation is ported into small TypeScript modules under `src/ui/board/` (layout, board, heard, transcript, lanes, sheet) with pure parts unit-tested; `live.ts` becomes glue: WebSocket + mic (unchanged) + an in-memory event store that the board renders live or, when scrubbing, from any earlier moment. (3) The live server gains `--lang`.

**Tech Stack:** TypeScript, Vite, vitest, existing `ws` server, Google Fonts (Fraunces + IBM Plex Mono), Playwright MCP for the browser check.

Spec: `docs/superpowers/specs/2026-09-05-sounding-slice4-live-board-design.md`. Reference implementation of every visual behaviour: `docs/design/sounding-phone.template.html` (read it first for Tasks 3–4; port, don't reinvent).

## Global Constraints

- Determinism: `tests/fixtures-drift-determinism.test.ts` must stay green unchanged — replaying a fixture twice yields byte-identical logs, and the guard finds no wall-clock or randomness reads in `src/core`, `src/salience`, `src/interpret`, `src/replay`. Task 1 touches `src/core/session.ts` only; it may not read the clock.
- `EventLog.append` requires monotonic `t`. Op B's timestamp is `max(t, latestT)`.
- The wire protocol is unchanged: `LiveMessage = SoundingEvent | live.heard | live.status`. Nothing new is sent to the server by Context or Follow (display-only this slice).
- All existing `live.ts` safety behaviour is preserved verbatim in spirit: the single `finish()` exit, `onclose` as sole state owner, generation guard on both `setupAudio` continuations, `pendingStream`, Stop gated on `listening`, `ctx.resume()`. Re-read the current `src/ui/live.ts` before rewriting it.
- Visual constants from the prototype: mark font-size `15 + min(0.5,p)·62` px, weight `320 + min(0.5,p)·760`, opacity `0.55 + min(0.45,p)`; heard word 34–48 px italic, shrink to 0.22 and fade over 1.5 s, removed at 1.7 s; buoy underline 2.6 s; sink 1.8 s; sheet detents peek = height − 62 px, medium = 50 %, large = 9 % from top; lanes: `L=118, R=16, TOP=8, AX=22`, lane height `min(30, (H−TOP−AX)/n)`.
- Fonts: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=IBM+Plex+Mono:wght@400;500&display=swap">` with real fallbacks.
- Theme tokens exactly as in the template (`:root` light, `@media (prefers-color-scheme: dark)` guarded `:root:not([data-theme="light"])`, `:root[data-theme="dark"]`).
- `npm test` (currently 164), `npx tsc --noEmit -p .`, `npm run build` all clean before each commit. Nothing under `recordings/`/`soundings/` committed; delete produced `soundings/live-*.jsonl`.
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/session.ts` (modify) | interpret outside the queue; `latestT`; `surface` waits for in-flight calls |
| `tests/session-nonblocking.test.ts` (create) | ticks flow during a slow call; candidates at arrival time; surface waits; replay unchanged |
| `src/live/transcribe-live.ts`, `src/live/server.ts` (modify) | `languageCodes` option; `--lang` |
| `tests/live-server-args.test.ts`, `tests/live-transcribe-client.test.ts` (modify) | `--lang` parsing; setup message carries the language |
| `src/ui/board/layout.ts` (create) | sunflower slots + clamp (pure) |
| `src/ui/board/model.ts` (create) | pure models: reading diff, transcript model, lane series, surfaced ranking |
| `src/ui/board/board.ts` (create) | DOM: marks (arrive/sink/ghost/lit/instant) |
| `src/ui/board/heard.ts` (create) | DOM: heard-word flashes |
| `src/ui/board/transcript.ts` (create) | DOM: transcript pane |
| `src/ui/board/lanes.ts` (create) | SVG: lanes, playhead, scrub |
| `src/ui/board/sheet.ts` (create) | DOM: detents, tabs |
| `src/ui/board/board.css` (create) | all board styling, ported from the template |
| `tests/board-layout.test.ts`, `tests/board-model.test.ts` (create) | pure parts |
| `live.html`, `src/ui/live.ts` (rewrite), `src/ui/live.css` (delete, replaced by `board.css` + page rules) | the page |

---

### Task 1: Engine — interpret outside the queue, apply inside

**Files:**
- Modify: `src/core/session.ts`
- Test: `tests/session-nonblocking.test.ts`

**Interfaces:** `SoundingSession`'s public API is unchanged (`drop`, `advanceTo`, `feedPending`, `feedCommitted`, `surface`, `log`). New private state: `latestT: Ms`, `inFlight: Set<Promise<void>>`.

- [ ] **Step 1: Write the failing tests**

`tests/session-nonblocking.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../src/interpret/port'

/** An interpreter whose answer is released by the test, so the test controls when the call "finishes". */
class GatedInterpreter implements Interpreter {
  readonly id = 'gated'; readonly input = 'transcript' as const
  release: (() => void) | null = null
  interpret(input: InterpreterInput): Promise<InterpretationResult> {
    return new Promise((resolve) => { this.release = () => resolve({ candidates: [{ label: 'sister', strength: 0.9, confidence: 0.9, source: this.id, segmentId: input.segmentId }], costUsd: 0, latencyMs: 0 }) })
  }
}
function makeSession(interp: Interpreter) {
  const cfg = { ...DEFAULT_SALIENCE_CONFIG }
  const s = new SoundingSession(interp, new ReadingDynamics(new TokenIdentityResolver(), cfg), cfg, 'nb-test')
  s.drop()
  return s
}
const seg = (id: string, t: number) => ({ segmentId: id, transcript: 'my sister called', startT: t - 3000, endT: t })

describe('interpretation does not block the clock', () => {
  it('ticks keep landing while a call is pending, and the candidates land at arrival time', async () => {
    const gi = new GatedInterpreter(); const s = makeSession(gi)
    const fc = s.feedCommitted(3000, seg('s1', 3000))
    // let op A run and the interpreter start
    await new Promise((r) => setTimeout(r, 0))
    expect(gi.release).not.toBeNull()
    await s.advanceTo(6000)                          // 30 ticks while the call is pending
    const before = s.log.all()
    expect(before.filter((e) => e.type === 'reading.changed').at(-1)!.t).toBe(6000)
    expect(before.some((e) => e.type === 'candidates.emitted')).toBe(false)
    gi.release!()
    await fc
    const ce = s.log.all().find((e) => e.type === 'candidates.emitted')!
    expect(ce.t).toBe(6000)                          // applied when it arrived, not at the segment time
    expect(s.log.all().map((e) => e.t).every((t, i, a) => i === 0 || t >= a[i - 1])).toBe(true)
  })

  it('in replay (caller awaits feedCommitted before advancing) the candidates land at the segment time', async () => {
    const gi = new GatedInterpreter(); const s = makeSession(gi)
    const fc = s.feedCommitted(3000, seg('s1', 3000))
    await new Promise((r) => setTimeout(r, 0)); gi.release!(); await fc
    expect(s.log.all().find((e) => e.type === 'candidates.emitted')!.t).toBe(3000)
  })

  it('surface waits for in-flight interpretations', async () => {
    const gi = new GatedInterpreter(); const s = makeSession(gi)
    void s.feedCommitted(3000, seg('s1', 3000))
    await new Promise((r) => setTimeout(r, 0))
    let surfaced = false
    const sp = s.surface(4000).then(() => { surfaced = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(surfaced).toBe(false)
    gi.release!(); await sp
    const types = s.log.all().map((e) => e.type)
    expect(types.indexOf('candidates.emitted')).toBeLessThan(types.indexOf('sounding.surfaced'))
    expect(types.at(-1)).toBe('sounding.surfaced')
  })

  it('a rejected interpretation rejects feedCommitted but leaves the session usable', async () => {
    const bad: Interpreter = { id: 'bad', input: 'transcript', interpret: () => Promise.reject(new Error('boom')) }
    const s = makeSession(bad)
    await expect(s.feedCommitted(3000, seg('s1', 3000))).rejects.toThrow('boom')
    await s.advanceTo(3500)
    expect(s.log.all().at(-1)!.t).toBe(3500)
    await s.surface(3600)
    expect(s.log.all().at(-1)!.type).toBe('sounding.surfaced')
  })
})
```

Check `TokenIdentityResolver`'s actual export name in `src/salience/identity.ts` and the `ConceptCandidate` field names in `src/core/types.ts` before running; adjust the test's candidate literal to the real shape.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/session-nonblocking.test.ts`
Expected: the first and third tests FAIL (ticks are stuck behind the call: the last `reading.changed` is not 6000, or the surface test times out); the second passes already.

- [ ] **Step 3: Implement**

Replace `feedCommitted`, `surface`, `processCommitted`, and the timestamp bookkeeping in `src/core/session.ts` with:

```ts
  private latestT: Ms = 0
  private readonly inFlight = new Set<Promise<void>>()

  private touch(t: Ms): void { if (t > this.latestT) this.latestT = t }

  advanceTo(t: Ms): Promise<void> {
    this.touch(t)
    return this.enqueue(() => this.advanceNow(t))
  }

  feedPending(t: Ms, text: string): Promise<void> {
    this.touch(t)
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'segment.pending', t, text })
      this.dynamics.nudge(t, text)
    })
  }

  /**
   * Commit a segment. The interpreter call runs OUTSIDE the op queue so
   * ticks keep flowing during it; the log append + apply run inside the
   * queue at max(t, latestT). In replay the caller awaits this before moving
   * time, so the candidates land at `t` exactly as before (byte-identical
   * logs); in live mode they land when they arrive.
   */
  feedCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void> {
    this.touch(t)
    const p = (async () => {
      const input = await this.enqueue(async () => {
        this.advanceNow(t)
        this.log.append({ type: 'segment.committed', t, ...seg })
        return this.buildInput(seg)
      })
      const result = await this.interpreter.interpret(input)
      // captured at arrival so that ops already queued behind B with
      // smaller t still append monotonically
      const tA = Math.max(t, this.latestT)
      await this.enqueue(async () => {
        this.advanceNow(tA)
        this.log.append({
          type: 'candidates.emitted', t: tA, segmentId: seg.segmentId, source: this.interpreter.id,
          candidates: result.candidates, costUsd: result.costUsd, latencyMs: result.latencyMs,
        })
        await this.dynamics.applyCandidates(tA, result.candidates)
      })
    })()
    const tracked = p.then(() => undefined, () => undefined)
    this.inFlight.add(tracked)
    void tracked.then(() => this.inFlight.delete(tracked))
    return p
  }

  /** Surfacing waits for every in-flight interpretation so nothing lands after the end. */
  async surface(t: Ms): Promise<void> {
    this.touch(t)
    while (this.inFlight.size) await Promise.all([...this.inFlight])
    await this.enqueue(() => {
      this.advanceNow(Math.max(t, this.latestT))
      this.log.append({ type: 'sounding.surfaced', t: Math.max(t, this.latestT) })
    })
  }
```

Delete the old `processCommitted`. Keep `buildInput`, `advanceNow`, `enqueue`, `drop` as they are. Update the class doc comment to describe the two-op shape.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/session-nonblocking.test.ts tests/fixtures-drift-determinism.test.ts tests/live-sounding.test.ts tests/live-headless.test.ts && npx tsc --noEmit -p . && npm test`
Expected: all green; determinism byte-identical. If a fixture snapshot test elsewhere asserts the *position* of `candidates.emitted` relative to `reading.changed`, it must still pass (in replay nothing moved). If `tests/live-sounding.test.ts` (which used to catch the enqueue-order bug) fails, read why before touching it: it asserts no `live.status error` and committed↔candidates pairing, both of which must still hold.

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts tests/session-nonblocking.test.ts
git commit -m "engine: interpret outside the op queue, apply inside it

Ticks no longer wait behind a model call; the candidates are applied at
max(segment time, latest time asked of the session), which is the segment
time in replay (logs byte-identical) and the arrival time live. surface()
waits for in-flight interpretations.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

### Task 2: `--lang` for Transcribe Live

**Files:**
- Modify: `src/live/transcribe-live.ts` (`SETUP` becomes a function of language), `src/live/server.ts` (`--lang`, default `en-US`)
- Test: `tests/live-transcribe-client.test.ts` (setup carries `languageCodes: ['en-US']` by default and `[]` for `auto`), `tests/live-server-args.test.ts` (`--lang en-US` accepted, `--lang` without value rejected)

- [ ] **Step 1: Tests first** — add to the existing files: (a) constructing `new TranscribeLiveClient('KEY', { socketFactory, languageCodes: ['en-US'] })` sends a setup whose `inputAudioTranscription.languageCodes` equals `['en-US']`; with `languageCodes: []` it sends `[]`; default (option omitted) is `['en-US']`. (b) `parseArgs(['--lang', 'auto']).lang === 'auto'`; `parseArgs(['--lang'])` throws.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** — `export function setupMessage(languageCodes: string[]) { return { setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes, mode: 'VERBATIM' } } } }`; keep `SETUP` exported as `setupMessage(['en-US'])` for any existing import; the client stores `this.languageCodes = opts.languageCodes ?? ['en-US']` and sends `setupMessage(this.languageCodes)`. Server: `lang: string` in `Args` (default `'en-US'`), `--lang <code|auto>`, and `makeTranscriber` passes `{ languageCodes: args.lang === 'auto' ? [] : [args.lang] }`.
- [ ] **Step 4:** `npx tsc --noEmit -p . && npm test` green.
- [ ] **Step 5: Commit** — `feat(live): --lang for Transcribe Live (default en-US)` with the trailer.

---

### Task 3: Board modules (pure models + DOM renderers) ported from the prototype

**Files:**
- Create: `src/ui/board/layout.ts`, `src/ui/board/model.ts`, `src/ui/board/board.ts`, `src/ui/board/heard.ts`, `src/ui/board/transcript.ts`, `src/ui/board/lanes.ts`, `src/ui/board/sheet.ts`, `src/ui/board/board.css`
- Test: `tests/board-layout.test.ts`, `tests/board-model.test.ts`

**Interfaces (produced; Task 4 depends on these exact names):**

```ts
// layout.ts
export interface Box { width: number; height: number }
export class SlotLayout { slotFor(id: string): number; position(id: string, box: Box, labelHalfWidth: number): { x: number; y: number }; reset(): void }
// model.ts
export interface MarkView { id: string; label: string; p: number }
export interface ReadingSnapshot { t: Ms; marks: MarkView[]; transitions: Transition[]; slack: boolean }
export function snapshotOf(e: Extract<SoundingEvent, { type: 'reading.changed' }>): ReadingSnapshot
export interface Diff { arrived: MarkView[]; kept: MarkView[]; departed: Array<{ id: string; reason: 'displaced' | 'absorbed' | 'faded'; by?: string }> }
export function diffReadings(prev: ReadingSnapshot | null, next: ReadingSnapshot): Diff
export interface TranscriptModel { stamps: Array<{ t: Ms; label: string }>; segments: Array<{ t: Ms; text: string }>; pendingTail: string }
export function transcriptAt(events: readonly SoundingEvent[], now: Ms): TranscriptModel   // committed ≤ now, pending deltas since the last committed ≤ now
export function laneSeries(readings: ReadingSnapshot[], endT: Ms): Array<{ id: string; label: string; firstT: Ms; points: Array<[Ms, number]> }>  // order of first appearance
export function ranked(snapshot: ReadingSnapshot): Array<{ label: string; pct: number; rel: number }>
// board.ts
export interface Board { apply(s: ReadingSnapshot, opts?: { instant?: boolean }): void; seedGhosts(labels: Array<{ id: string; label: string }>): void; clearGhosts(): void; setLit(id: string | null): void; reset(): void; onTap(cb: (id: string) => void): void }
export function createBoard(field: HTMLElement): Board
// heard.ts
export function createHeard(layer: HTMLElement): { flash(words: string[]): void; clear(): void }
// transcript.ts
export function createTranscript(el: HTMLElement): { render(m: TranscriptModel, autoscroll: boolean): void }
// lanes.ts
export function createLanes(svg: SVGSVGElement): { build(series: ReturnType<typeof laneSeries>, endT: Ms): void; head(now: Ms): void; setLit(id: string | null): void; onScrub(cb: (ms: Ms) => void): void; onTapLane(cb: (id: string) => void): void }
// sheet.ts
export type Detent = 'peek' | 'medium' | 'large'
export function createSheet(root: HTMLElement, opts: { grab: HTMLElement; tabs: HTMLElement; body: HTMLElement; scrim: HTMLElement }): { set(d: Detent): void; get(): Detent; showTab(name: string): void; onTab(cb: (name: string) => void): void }
```

- [ ] **Step 1: Tests for the pure parts** — `tests/board-layout.test.ts`: slots are stable per id and assigned in first-seen order; positions for a 366×604 box with half-width 120 are inside `[half+10, w−half−10]` × `[28, h−28]`; `reset()` clears slots. `tests/board-model.test.ts`: `diffReadings` classifies arrived/kept/departed with `displaced` + `by` from transitions and `absorbed` from `merged`; `transcriptAt` returns committed segments ≤ now, a stamp every 30 s of segment start, and the pending tail since the last committed; `laneSeries` orders by first appearance and produces step points ending at `endT`; `ranked` sorts by prominence with `rel` = p/top. Build inputs by hand (three or four readings, two committed segments, a few pendings).
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement.** Port from the template, function by function: `slotFor`/`positionFor` → `SlotLayout` (the caller passes the measured half-width so the class stays pure); `applyReading` → `diffReadings` (pure) + `createBoard.apply` (DOM; keep classes `mark`, `arrive`, `sink`, `absorbed`, `ghost`, `lit`, and the `instant` class on the field); `flash` → `createHeard`; `buildTranscript`/`renderTranscript` → `transcriptAt` + `createTranscript`; `series`/`buildChart`/`renderHead`/scrub handlers → `laneSeries` + `createLanes`; `setDetent`/`fitBody`/drag handlers/`showTab` → `createSheet`. Move every rule from the template's `<style>` that concerns the board, marks, heard words, sheet, transcript, chart, context, and the round control into `src/ui/board/board.css`, keeping the token block at the top. Heard-word extraction is the server's job (`live.heard`), so `createHeard.flash` just animates.
- [ ] **Step 4:** `npx tsc --noEmit -p . && npm test` green (DOM modules compile; only pure parts are unit-tested).
- [ ] **Step 5: Commit** — `feat(ui): board modules ported from the phone prototype` with the trailer.

---

### Task 4: The page

**Files:**
- Rewrite: `live.html`, `src/ui/live.ts`; delete `src/ui/live.css` (its two rules move into `board.css`).
- Keep: `public/pcm-worklet.js`, `src/ui/chart.ts` (replay instrument only).

**Consumes:** every Task 3 interface; `LiveMessage` (`import type` from `../live/live-sounding`); `summarizeCounters`.

- [ ] **Step 1: `live.html`** — the prototype's screen markup without the phone frame: status strip (`#state` with dot, `#clock`, `#counters` in the right slot instead of the speed buttons), `#field`, `#heard`, controls with the round `#big` button (`aria-label`) and `#hint`, `#scrim`, and the `#sheet` with grabber, three tabs and three panes (`#context` with textarea + chips + "Seed the board"/"Clear", `#transcript`, chart pane with `#surfacedbox` and `#chartsvg viewBox="0 0 390 560"`). Fonts link in the head; `board.css` linked; `main` fills the viewport; sheet content centred at `max-width: 760px` on wide screens.

- [ ] **Step 2: `live.ts`** — keep the existing networking/mic/finish code (read it first; it must survive unchanged in behaviour) and replace all rendering with the modules. New glue, complete:

```ts
// ---- event store + display cursor
const events: SoundingEvent[] = []
const readings: ReadingSnapshot[] = []
let replaying = false            // true while the user scrubs; new events still accumulate
let headT: Ms = 0                // latest event time seen
let shownT: Ms = 0               // time the board currently displays
let lastShown: ReadingSnapshot | null = null

function onMessage(m: LiveMessage) {
  if (m.type === 'live.heard') { if (!replaying) heard.flash(m.words); return }
  if (m.type === 'live.status') { /* unchanged status handling; on 'stopped' → finish + showSurfaced() */ return }
  events.push(m); headT = m.t
  if (m.type === 'reading.changed') readings.push(snapshotOf(m))
  if (m.type === 'candidates.emitted') counters.textContent = summary(events)
  if (!replaying) showLive(m)
}
function showLive(m: SoundingEvent) {
  shownT = m.t; clockEl.textContent = fmt(m.t)
  if (m.type === 'reading.changed') { const s = snapshotOf(m); board.apply(s); lastShown = s; slackWord(s.slack) }
  if (m.type === 'segment.committed' || m.type === 'segment.pending') transcript.render(transcriptAt(events, m.t), true)
  lanes.build(laneSeries(readings, Math.max(headT, 1)), Math.max(headT, 1)); lanes.head(m.t)
}
function showAt(t: Ms) {                       // scrub target
  replaying = true; shownT = t
  const s = readings.filter((r) => r.t <= t).at(-1) ?? null
  board.reset(); if (s) board.apply(s, { instant: true }); lastShown = s
  transcript.render(transcriptAt(events, t), false)
  lanes.head(t); clockEl.textContent = fmt(t)
  stateEl.textContent = 'replaying · tap to return'
}
function backToLive() {
  replaying = false
  const s = readings.at(-1) ?? null
  board.reset(); if (s) board.apply(s, { instant: true }); lastShown = s
  transcript.render(transcriptAt(events, headT), true); lanes.head(headT); clockEl.textContent = fmt(headT)
  stateEl.textContent = state === 'live' ? 'listening' : state === 'idle' ? (surfacedOnce ? 'surfaced' : 'ready') : state
}
lanes.onScrub(showAt)
stateEl.addEventListener('click', () => { if (replaying) backToLive() })
```

Follow (display-only): `board.onTap(id => { lit = lit === id ? null : id; board.setLit(lit); lanes.setLit(lit); hint.innerHTML = lit ? `following <b>${labelOf(id)}</b> · tap again to let go` : '' })`; `lanes.onTapLane(sameHandler)`.

Context (display-only): "Seed the board" reads the textarea, keeps the lowercase text as `contextText`, and calls `board.seedGhosts(...)` for any label already known from `readings` that matches (same matching rule as the template); additionally, when a *new* label first appears in a `reading.changed` and matches `contextText`, the board's `apply` treats a pre-seeded ghost as confirmed (same as the template). Since labels are unknown before talking, seeding before Drop only stores the text; the note in the Context tab says so.

Surfaced: on `live.status stopped`, `finish('saved …')`, then `surfacedbox.innerHTML` from `ranked(readings.at(-1))` and `sheet.showTab('chart'); sheet.set('medium')`.

The round control: `#big` click → same `start()` / `stop()` as today; the `listening` class on the screen drives the dot→square animation from `board.css`; while `state === 'starting'` the button is disabled; `aria-label` updated (`Drop` / `Surface`).

- [ ] **Step 3: Verify** — `npx tsc --noEmit -p . && npm test && npm run build` (remove `dist/`). Browser check with the fake transcriber: `npm run live -- --fixture circling --fake-transcriber -i recurrence` + `npm run dev`; open `/live.html` with Playwright, stub `getUserMedia` to a silent stream if the prompt blocks, click the round control → status `listening`, heard words flash (`.word` spans appear/disappear), marks appear (`.mark`), open the sheet to medium → Transcript fills → Chart shows lanes with a moving playhead → drag on the chart → status `replaying · tap to return`, board rebuilt from an earlier reading (fewer/different marks) → tap the status → back to live → click the control → `saved soundings/live-…` and the sheet opens on Chart with the ranked list. Confirm no console errors. Kill servers; delete the log; remove `.playwright-mcp/`.

- [ ] **Step 4: Commit** — `feat(ui): the live board — prototype design on the web live page` with the trailer.

---

## Self-review

- Spec coverage: engine (T1), language (T2), board/sheet/transcript/chart/heard/round control (T3+T4), scrub-while-live + back to live (T4), Context/Follow display-only (T4), surfaced sheet (T4), replay instrument untouched, no new wire messages.
- Placeholders: T3's DOM ports say "port from the template, function by function" and name every source function; the template is in the repo, so this is a concrete instruction, not a TBD.
- Type consistency: `ReadingSnapshot`, `Diff`, `TranscriptModel`, `laneSeries` return type, `Board`, `Detent` are used with the names defined in T3's interface block.

---

### Task 5: Desktop layout — side panels instead of the sheet (spec §2b)

**Files:**
- Create: `src/ui/board/panels.ts` (side panels: open/close, resize, persistence), `src/ui/board/popover.ts` (context popover)
- Modify: `live.html` (both containers present; panels + edge tabs + popover markup), `src/ui/live.ts` (a `layout` controller that routes to sheet or panels), `src/ui/board/board.css` (desktop rules under `@media (min-width: 720px)`)
- Test: `tests/board-panels.test.ts` (pure width clamp + persistence codec)

**Interfaces:**
- Consumes: Task 4's page (`live.ts` glue, `sheet`, `board.relayout()`), `createLanes`, `createTranscript`.
- Produces:
```ts
// panels.ts
export type Side = 'left' | 'right'
export interface PanelSpec { side: Side; min: number; max: number; default: number; key: string }
export function clampWidth(spec: PanelSpec, w: number): number
export function encodeState(s: Record<Side, { open: boolean; width: number }>): string
export function decodeState(raw: string | null, defaults: Record<Side, { open: boolean; width: number }>): Record<Side, { open: boolean; width: number }>
export function createPanels(root: HTMLElement, specs: Record<Side, PanelSpec>, onChange: () => void): { open(side: Side, v?: boolean): void; isOpen(side: Side): boolean; toggle(side: Side): void }
// popover.ts
export function createPopover(anchor: HTMLElement, panel: HTMLElement): { open(): void; close(): void; isOpen(): boolean }
// live.ts (internal)
const layout = { showTranscript(): void; showChart(): void; showContext(): void; closeContext(): void; onSurfaced(): void; isDesktop(): boolean }
```

- [ ] **Step 1: Tests first** — `tests/board-panels.test.ts`: `clampWidth` clamps to `[min,max]` and returns `default` for NaN; `encodeState`/`decodeState` round-trip, and `decodeState` returns defaults for `null`, invalid JSON, or wrong shapes.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**

`src/ui/board/panels.ts`:
```ts
export type Side = 'left' | 'right'
export interface PanelSpec { side: Side; min: number; max: number; default: number; key: string }
export type PanelState = Record<Side, { open: boolean; width: number }>

export function clampWidth(spec: PanelSpec, w: number): number {
  if (!Number.isFinite(w)) return spec.default
  return Math.max(spec.min, Math.min(spec.max, Math.round(w)))
}
export function encodeState(s: PanelState): string { return JSON.stringify(s) }
export function decodeState(raw: string | null, defaults: PanelState): PanelState {
  if (!raw) return defaults
  try {
    const p = JSON.parse(raw) as Partial<PanelState>
    const pick = (side: Side) => {
      const v = p?.[side]
      return v && typeof v.open === 'boolean' && Number.isFinite(v.width) ? { open: v.open, width: v.width } : defaults[side]
    }
    return { left: pick('left'), right: pick('right') }
  } catch { return defaults }
}

const KEY = 'sounding.panels'
export function createPanels(root: HTMLElement, specs: Record<Side, PanelSpec>, onChange: () => void) {
  const defaults: PanelState = { left: { open: false, width: specs.left.default }, right: { open: false, width: specs.right.default } }
  let state: PanelState
  try { state = decodeState(localStorage.getItem(KEY), defaults) } catch { state = defaults }
  state.left.width = clampWidth(specs.left, state.left.width); state.right.width = clampWidth(specs.right, state.right.width)
  const el = (side: Side) => root.querySelector<HTMLElement>(`.panel-${side}`)!
  const grip = (side: Side) => root.querySelector<HTMLElement>(`.panel-${side} .grip`)!
  const tab = (side: Side) => root.querySelector<HTMLElement>(`.edge.${side}`)!
  function paint() {
    for (const side of ['left', 'right'] as Side[]) {
      const p = el(side); p.style.width = `${state[side].width}px`; p.classList.toggle('open', state[side].open)
      tab(side).setAttribute('aria-expanded', String(state[side].open))
    }
    root.style.setProperty('--left-w', state.left.open ? `${state.left.width}px` : '0px')
    root.style.setProperty('--right-w', state.right.open ? `${state.right.width}px` : '0px')
    try { localStorage.setItem(KEY, encodeState(state)) } catch { /* storage unavailable */ }
    onChange()
  }
  function open(side: Side, v = true) { state[side].open = v; paint() }
  for (const side of ['left', 'right'] as Side[]) {
    tab(side).addEventListener('click', () => open(side, !state[side].open))
    let drag: { x: number; w: number } | null = null
    const g = grip(side)
    g.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, w: state[side].width }; g.setPointerCapture(e.pointerId); root.classList.add('resizing') })
    g.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x; state[side].width = clampWidth(specs[side], side === 'left' ? drag.w + dx : drag.w - dx); paint() })
    const end = () => { drag = null; root.classList.remove('resizing') }
    g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end)
  }
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement | null)?.closest?.('textarea, input')) return
    for (const side of ['left', 'right'] as Side[]) if (e.key.toLowerCase() === specs[side].key) open(side, !state[side].open)
  })
  paint()
  return { open, isOpen: (side: Side) => state[side].open, toggle: (side: Side) => open(side, !state[side].open) }
}
```

`src/ui/board/popover.ts`:
```ts
export function createPopover(anchor: HTMLElement, panel: HTMLElement) {
  let on = false
  const place = () => { const a = anchor.getBoundingClientRect(); const host = panel.offsetParent as HTMLElement | null; const h = host ? host.getBoundingClientRect() : { left: 0, top: 0 }; panel.style.left = `${a.left + a.width / 2 - h.left}px`; panel.style.bottom = `${(h.top + (host?.clientHeight ?? window.innerHeight)) - a.top + 12}px` }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  const onDoc = (e: MouseEvent) => { if (!panel.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close() }
  function open() { on = true; panel.hidden = false; place(); panel.classList.add('open'); document.addEventListener('keydown', onKey); setTimeout(() => document.addEventListener('mousedown', onDoc), 0); window.addEventListener('resize', place) }
  function close() { if (!on) return; on = false; panel.classList.remove('open'); setTimeout(() => { if (!on) panel.hidden = true }, 250); document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc); window.removeEventListener('resize', place) }
  return { open, close, isOpen: () => on }
}
```

`live.html` (desktop additions inside the screen root, alongside the sheet from Task 4):
```html
<aside class="panel-left" aria-label="Transcript"><div class="grip" aria-hidden="true"></div><h2>Transcript</h2><div class="transcript" id="transcript-d"></div></aside>
<aside class="panel-right" aria-label="Chart"><div class="grip" aria-hidden="true"></div><h2>Chart</h2><div class="sub">what surfaced, and when · drag to replay · tap a name to follow it</div><div class="surfaced" id="surfacedbox-d"></div><svg id="chartsvg-d" viewBox="0 0 390 560" preserveAspectRatio="none"></svg></aside>
<button class="edge left" aria-expanded="false" aria-controls="transcript-d">transcript <kbd>T</kbd></button>
<button class="edge right" aria-expanded="false" aria-controls="chartsvg-d">chart <kbd>C</kbd></button>
<div class="popover" id="context-pop" hidden><div class="context" id="context-d"></div></div>
```
The narrow layout keeps its own `#transcript`, `#chartsvg`, `#surfacedbox`, `#context` inside the sheet. Two transcript renderers and two lane renderers are created; `live.ts` renders into **both** on every update (cheap: DOM rebuild is per-event, not per-frame) so switching layouts on resize needs no state transfer. The Context pane content is built once into whichever container is active via a `buildContext(el)` function called for both.

`board.css` desktop rules:
```css
@media (min-width: 720px) {
  .screen { display: grid; grid-template-rows: 54px minmax(0, 1fr) 150px; grid-template-columns: var(--left-w, 0px) minmax(0, 1fr) var(--right-w, 0px); }
  .screen > .status, .screen > .controls { grid-column: 2; }
  .screen > .field, .screen > .heard { grid-column: 2; grid-row: 2; }
  .sheet, .scrim { display: none; }
  .panel-left, .panel-right { grid-row: 1 / -1; position: relative; overflow: hidden; background: var(--sheet); border-color: var(--line); display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; width: 0; transition: width 0.35s cubic-bezier(.2,.7,.2,1); }
  .resizing .panel-left, .resizing .panel-right { transition: none; }
  .panel-left { grid-column: 1; border-right: 1px solid var(--line); }
  .panel-right { grid-column: 3; border-left: 1px solid var(--line); grid-template-rows: auto auto auto minmax(0, 1fr); }
  .panel-left:not(.open), .panel-right:not(.open) { width: 0 !important; border-width: 0; }
  .panel-left h2, .panel-right h2 { margin: 0; padding: 18px 22px 8px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--chrome); font-weight: 400; }
  .panel-left .transcript { padding-bottom: 40px; }
  .panel-right svg { min-height: 0; }
  .grip { position: absolute; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 2; }
  .panel-left .grip { right: -4px; } .panel-right .grip { left: -4px; }
  .edge { all: unset; cursor: pointer; position: absolute; top: 50%; z-index: 6; font-family: "IBM Plex Mono", monospace; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--chrome-2); writing-mode: vertical-rl; transform: translateY(-50%); padding: 10px 4px; opacity: 0.8; }
  .edge kbd { font: inherit; opacity: 0.6; margin-top: 8px; }
  .edge.left { left: 6px; transform: translateY(-50%) rotate(180deg); }
  .edge.right { right: 6px; }
  .edge[aria-expanded="true"] { color: var(--ink); }
  .edge:focus-visible { outline: 2px solid var(--accent); }
  .popover { position: absolute; z-index: 9; width: min(440px, 80vw); transform: translate(-50%, 8px); opacity: 0; background: var(--sheet); border-radius: 18px; box-shadow: 0 16px 40px rgba(0,0,0,0.2); padding: 16px 18px 14px; transition: transform 0.25s ease, opacity 0.25s ease; }
  .popover.open { transform: translate(-50%, 0); opacity: 1; }
}
@media (max-width: 719.98px) { .panel-left, .panel-right, .edge, .popover { display: none !important; } }
```
The edge tabs and popover markup live in `live.html` but are hidden under 720 px; the sheet is hidden at ≥ 720 px.

`live.ts` layout controller:
```ts
const mq = window.matchMedia('(min-width: 720px)')
const panels = createPanels(screen, { left: { side: 'left', min: 280, max: 560, default: 360, key: 't' }, right: { side: 'right', min: 320, max: 720, default: 440, key: 'c' } }, () => board.relayout())
const contextPop = createPopover(ctxButton, document.getElementById('context-pop')!)
const layout = {
  isDesktop: () => mq.matches,
  showTranscript() { if (mq.matches) panels.open('left'); else { sheet.showTab('transcript'); sheet.set('medium') } },
  showChart() { if (mq.matches) panels.open('right'); else { sheet.showTab('chart'); sheet.set('medium') } },
  showContext() { if (mq.matches) contextPop.open(); else { sheet.showTab('context'); sheet.set('medium') } },
  closeContext() { contextPop.close() },
  onSurfaced() { this.showChart() },
}
mq.addEventListener('change', () => { contextPop.close(); sheet.set('peek'); board.relayout() })
```
`drop()` calls `layout.closeContext()`. The "bring context" text button under the round control is shown while idle in both layouts (in the narrow layout it opens the sheet's Context tab).

- [ ] **Step 4: Verify** — `npx tsc --noEmit -p . && npm test && npm run build`. Browser check at 1280×800 with the fake transcriber: edge tabs toggle panels and the board reflows (marks stay inside the narrower field: check every `.mark` rect against `#field`'s rect); `T`/`C` keys work; dragging a grip resizes within limits and the width survives a reload (localStorage); the chart panel scrubs and `replaying · tap to return` behaves as in Task 4; "bring context" opens the popover, Escape closes it, Seed shows ghosts; surface opens the chart panel with the ranked list. Then resize the viewport to 390×800: panels vanish, the sheet works as in Task 4. Kill servers; delete logs; remove `.playwright-mcp/`.
- [ ] **Step 5: Commit** — `feat(ui): desktop layout — transcript and chart as side panels, context as a popover` + trailer.

# Slice 5 — Context and Follow Reach the Interpreter: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Context text improves transcription spelling and labelling; tapping a mark tells the interpreter what the speaker is drilling into. Both are logged. Neither adds weight to the reading.

**Architecture:** Hints ride on `InterpreterInput` (`hints?: { context?, follow? }`) and are set on the session by two new queued ops that also append `context.brought` / `mark.followed` events. Providers append a hint block to their prompts. The live server accepts `start{context}`, `context`, `follow` messages, derives Transcribe Live `customVocabulary` from the context, and maps followed ids to labels. The page sends what it already displays. The cast CLI gets `--context <file>`.

**Tech Stack:** TypeScript, vitest, existing providers/server/page.

Spec: `docs/superpowers/specs/2026-09-06-sounding-slice5-context-follow-design.md`.

## Global Constraints

- Determinism: `tests/fixtures-drift-determinism.test.ts` stays green unchanged; no wall-clock/randomness in `src/core`, `src/salience`, `src/interpret`, `src/replay`. Engine changes touch only `src/core/events.ts`, `src/core/session.ts`, `src/interpret/port.ts`.
- New events: `{ type: 'context.brought'; t; text: string }` and `{ type: 'mark.followed'; t; conceptId: string | null; label: string | null }`; `EventLog.REQUIRED_FIELDS` updated (`['text']`, `['conceptId', 'label']`). Monotonic append as always.
- Hint block text (verbatim, both providers, appended only when the respective hint is present, context trimmed to 1200 chars):
  ```
  Context the speaker brought before talking. Names and terms here are likely to recur: use their exact spelling as labels. This context is NOT evidence of anything said — never report a concept only because it appears here.
  <context>
  ```
  ```
  The speaker is following "<label>". If the talk touches it, report it and its evidence attentively. Do not invent support for it.
  ```
- Filler rule addition (both prompts, appended to the existing discourse rule sentence): `, the language being spoken, or whether the listener understands it`.
- Wire protocol additions: browser → server `start{context?}`, `context{text}`, `follow{conceptId|null}`; context ≤ 4000 chars; unknown follow id → let go + `live.status warning`. Server → browser unchanged.
- Vocabulary: `vocabularyFrom(text)` — capitalised runs (inner `of|the|and|for|de` allowed), quoted phrases (`"…"`, `“…”`, `'…'`), CamelCase and ALLCAPS tokens (≥ 2 letters); de-dupe case-sensitively, first-appearance order, max 50, each ≤ 40 chars. Sent as `inputAudioTranscription.customVocabulary` in the Transcribe Live setup.
- Context and Follow never change weights: no calls into `ReadingDynamics` from either op.
- `npm test` (currently 201), `npx tsc --noEmit -p .`, `npm run build` clean before each commit. Nothing under `recordings/`/`soundings/` committed; **delete only files you created, by exact name — never by glob.**
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `src/interpret/port.ts` (modify) | `InterpretationHints`; `hints?` on both inputs |
| `src/core/events.ts` (modify) | two new event types + required fields |
| `src/core/session.ts` (modify) | `setContext`, `setFollow`, current hints attached in `buildInput` |
| `tests/session-hints.test.ts` (create) | ops append events; inputs carry hints; determinism untouched |
| `src/providers/claude-extraction.ts`, `src/providers/gemini-audio.ts` (modify) | `hintBlock(hints)` shared helper in `src/providers/hints.ts`; prompts append it; filler line |
| `tests/provider-hints.test.ts` (create) | block text exact; absent → unchanged |
| `src/cli/cast.ts` (modify) | `--context <file>` |
| `src/live/vocabulary.ts` (create) + `tests/live-vocabulary.test.ts` | `vocabularyFrom` |
| `src/live/transcribe-live.ts` (modify) | `customVocabulary` option → setup |
| `src/live/live-sounding.ts`, `src/live/server.ts` (modify) | `setContext`/`setFollow` passthrough with label lookup; message handling |
| `tests/live-sounding.test.ts` (modify) | context/follow flow with stub transcriber + stub interpreter capturing hints |
| `src/ui/live.ts` (modify) | send `context`/`follow`; context in `start` |
| `src/ui/board/layout.ts`, `src/ui/board/board.ts` (modify) | collision avoidance (Task 5) |

---

### Task 1: Hints on the port; `context.brought` and `mark.followed` in the log; session ops

**Files:** modify `src/interpret/port.ts`, `src/core/events.ts`, `src/core/session.ts`; create `tests/session-hints.test.ts`.

**Interfaces (produced):**
```ts
// port.ts
export interface InterpretationHints { context?: string; follow?: string }
export interface Transcript { kind: 'transcript'; segmentId: string; text: string; startT: Ms; endT: Ms; hints?: InterpretationHints }
export interface AudioSegment { kind: 'audio'; segmentId: string; mimeType: string; data: Uint8Array; startT: Ms; endT: Ms; hints?: InterpretationHints }
// session.ts
setContext(t: Ms, text: string): Promise<void>
setFollow(t: Ms, conceptId: string | null, label: string | null): Promise<void>
```

- [ ] **Step 1: Tests** — `tests/session-hints.test.ts`: (a) `setContext(1000,'Trust Wallet, Apple')` then `feedCommitted(3000, seg)` with a capturing stub interpreter → log has `context.brought@1000` before `segment.committed@3000`, and the captured input has `hints.context === 'Trust Wallet, Apple'` and no `follow`; (b) `setFollow(4000,'c2','work-life balance')` then another commit → captured `hints.follow === 'work-life balance'` and `mark.followed@4000{conceptId:'c2',label:'work-life balance'}` in the log; `setFollow(5000, null, null)` clears it (next input has no `follow`); (c) neither op changes the reading: the `reading.changed` marks before and after `setContext`/`setFollow` are deep-equal; (d) `EventLog.fromJsonl` round-trips both new events and rejects a `mark.followed` missing `label`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — `port.ts` as above; `events.ts` union + `REQUIRED_FIELDS`; `session.ts`:
```ts
  private hints: InterpretationHints = {}
  setContext(t: Ms, text: string): Promise<void> {
    this.touch(t)
    return this.enqueue(() => { this.advanceNow(t); this.log.append({ type: 'context.brought', t, text }); this.hints = { ...this.hints, context: text } })
  }
  setFollow(t: Ms, conceptId: string | null, label: string | null): Promise<void> {
    this.touch(t)
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'mark.followed', t, conceptId, label })
      const { follow: _drop, ...rest } = this.hints
      this.hints = label ? { ...rest, follow: label } : rest
    })
  }
```
and in `buildInput` attach `hints: Object.keys(this.hints).length ? { ...this.hints } : undefined` to both branches.
- [ ] **Step 4:** `npx tsc --noEmit -p . && npm test` — determinism byte-identical (no fixture sets hints).
- [ ] **Step 5: Commit** — `feat(engine): context and follow hints on the port, logged as events` + trailer.

---

### Task 2: Prompts carry the hints; filler rule; cast `--context`

**Files:** create `src/providers/hints.ts`; modify `src/providers/claude-extraction.ts`, `src/providers/gemini-audio.ts`, `src/cli/cast.ts`; create `tests/provider-hints.test.ts`.

- [ ] **Step 1: Tests** — `hintBlock({})` → `''`; `hintBlock({context:'Trust Wallet'})` → exactly the context block (verbatim text above, with `\n` between the sentence and the text); `hintBlock({follow:'work-life balance'})` → exactly the follow block; both → context block, blank line, follow block; context longer than 1200 chars is trimmed with `…`. `buildUserPrompt(window, hints)` ends with the block when hints present and is unchanged otherwise; `buildGeminiRequest(audio)` text part ends with the block when `audio.hints` present. Both prompts contain the new filler clause.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — `hints.ts`:
```ts
import type { InterpretationHints } from '../interpret/port'
const MAX_CONTEXT = 1200
export function hintBlock(h: InterpretationHints | undefined): string {
  if (!h) return ''
  const parts: string[] = []
  if (h.context && h.context.trim()) {
    const c = h.context.trim()
    parts.push(`Context the speaker brought before talking. Names and terms here are likely to recur: use their exact spelling as labels. This context is NOT evidence of anything said — never report a concept only because it appears here.\n${c.length > MAX_CONTEXT ? c.slice(0, MAX_CONTEXT) + '…' : c}`)
  }
  if (h.follow && h.follow.trim()) parts.push(`The speaker is following "${h.follow.trim()}". If the talk touches it, report it and its evidence attentively. Do not invent support for it.`)
  return parts.join('\n\n')
}
```
Claude: `buildUserPrompt(window: string[], hints?: InterpretationHints)` appends `\n\n${block}` when non-empty; `interpret` passes `input.hints`. Gemini: `buildGeminiRequest(audio)` uses `AUDIO_PROMPT + (block ? '\n\n' + block : '')`. Filler clause appended to the existing rule sentence in both prompts. `cast.ts`: `--context <file>` (missing file → clear error), `await session.setContext(0, readFileSync(file,'utf8'))` right after `session.drop()`.
- [ ] **Step 4:** tsc + tests. Optional real check if `.env` present and `recordings/mic-20260905-145437.m4a` exists: write a temp context file "Ray Dalio; TSMC; Nvidia" and `npm run cast -- recordings/mic-20260905-145437.m4a -i gemini --context /tmp/ctx.txt` → the log's first event after `sounding.dropped` is `context.brought`; delete the produced `soundings/mic-20260905-145437.gemini.jsonl`? **No** — that file pre-exists (Victor's cast); instead run with `-i recurrence` (free, no overwrite of the gemini log) and just check the event ordering; the recurrence output file `soundings/mic-20260905-145437.recurrence.jsonl` is yours to delete by name afterwards.
- [ ] **Step 5: Commit** — `feat(providers): prompts carry context and follow hints; language-as-discourse rule; cast --context` + trailer.

---

### Task 3: Vocabulary, Transcribe Live custom vocabulary, server wiring

**Files:** create `src/live/vocabulary.ts`, `tests/live-vocabulary.test.ts`; modify `src/live/transcribe-live.ts` (+ its test), `src/live/live-sounding.ts`, `src/live/server.ts`, `tests/live-sounding.test.ts`.

**Interfaces:**
```ts
export function vocabularyFrom(text: string): string[]
// TranscribeLiveClient options: customVocabulary?: string[]  → setupMessage(languageCodes, customVocabulary)
// LiveSounding: setContext(text: string): Promise<void>; follow(conceptId: string | null): Promise<{ label: string | null }>
// LiveSoundingOptions: context?: string (applied at start, before the first commit)
```

- [ ] **Step 1: Tests** — vocabulary: `"Today I talked to the people from Apple about Trust Wallet and the App Store. 'Sounding' is my app; TSMC and Nvidia."` → `['Today','Apple','Trust Wallet','App Store','Sounding','TSMC','Nvidia']` (sentence-initial "Today" is accepted; keep the rule simple: capitalised runs), dedupe, cap 50, ≤ 40 chars each, order preserved. Transcribe client: constructor option `customVocabulary: ['Sounding']` → setup `inputAudioTranscription.customVocabulary` equals it; default `[]`. LiveSounding (stub transcriber + capturing stub interpreter, as in the existing tests): `start()` with `context: 'Trust Wallet'` → first event after `sounding.dropped` is `context.brought`; a commit's captured input has `hints.context`; `follow('c1')` after a reading that contains `c1` → `mark.followed{conceptId:'c1', label:<its label>}` and the next input has `hints.follow`; `follow('nope')` → `mark.followed{conceptId:null,label:null}` and the returned label is `null`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — `vocabulary.ts` per the constraints; `setupMessage(languageCodes, customVocabulary = [])`; client option; `makeTranscriber(args, clock, context?)` passes `vocabularyFrom(context)` for the real client. `LiveSounding`: track `labels: Map<string,string>` from every `reading.changed` in `flush()` (or from the session log), `setContext(text)` → `run(() => session.setContext(clock.now(), text))`, `follow(id)` → label lookup → `run(() => session.setFollow(now, id ?? null, label))`; in `start()`, if `opts.context`, call `setContext` right after `drop()` and before `transcriber.connect`. Server: in the `start` branch read `msg.context` (string ≤ 4000 → else warning + ignore), pass to `makeTranscriber` and `LiveSounding`; new branches `context` (`live?.setContext`) and `follow` (`live?.follow`; unknown → warning `unknown concept, let go`). Validate types; ignore when no session.
- [ ] **Step 4:** tsc + full suite. Smoke (no key): `node_modules/.bin/tsx src/live/server.ts --fixture circling --fake-transcriber --speed 30 -i recurrence --headless` still exits 0 with empty stderr; delete the log it writes by name.
- [ ] **Step 5: Commit** — `feat(live): context → custom vocabulary + hint; follow → hint; wire messages` + trailer.

---

### Task 4: The page sends context and follow

**Files:** modify `src/ui/live.ts` (both layouts share the handlers), the Context note text in `live.html`.

- [ ] **Step 1:** In `start()`, include `context: contextText` in the `start` message when non-empty. In the seed handler (`buildContext`), after seeding ghosts, if `state === 'live'` send `{type:'context', text}`. In `toggleFollow(id)`, send `{type:'follow', conceptId: lit}` (null when letting go) if the socket is open. Context note: add "Names here also help the transcriber from the next drop." Nothing else changes.
- [ ] **Step 2:** `npx tsc --noEmit -p . && npm test && npm run build`. Browser check (fake transcriber server on port 8790, `?port=8790`, `getUserMedia` stubbed): seed "Trust Wallet, sister" before drop → drop → the transcript shows the fixture; follow the first mark → stop → read the saved log (by the exact name in the status) and assert it contains `context.brought` right after `sounding.dropped` and a `mark.followed` with a label; delete that file by name; remove `.playwright-mcp/`.
- [ ] **Step 3: Commit** — `feat(ui): the page sends context and follow to the live server` + trailer.

---

### Task 5: Marks don't collide (layout repulsion)

**Files:** modify `src/ui/board/layout.ts`, `src/ui/board/board.ts`; extend `tests/board-layout.test.ts`.

The sunflower slot layout places by first appearance and can put a large label next to a neighbour ("too demanding" over "new position"). Add one pass of separation after slot placement:

```ts
// layout.ts
export interface Placed { id: string; x: number; y: number; halfW: number; halfH: number }
/** Push overlapping boxes apart along the axis of least overlap, a few iterations; keeps everything inside the box. */
export function separate(items: Placed[], box: Box, iterations = 6, pad = 6): Placed[]
```
- [ ] **Step 1: Tests** — two items overlapping horizontally end up non-overlapping and inside the box; an item already clear is unmoved; four items in a tight cluster all end up pairwise clear after ≤ 6 iterations; nothing leaves `[halfW+10, w−halfW−10] × [28, h−28]`.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — `separate`: for each pair with overlap `ox = (a.halfW + b.halfW + pad) − |dx|`, `oy = (a.halfH + b.halfH + pad) − |dy|`; if both > 0, move each by half of the smaller overlap along that axis (away from each other; deterministic tie-break: move along y when `ox > oy`), then clamp; repeat `iterations` times. In `board.ts`, after computing slot positions for all live marks in `apply()` and `relayout()`, measure each mark's box (`getBoundingClientRect` width/height ÷ 2), run `separate`, and set the final `left/top`. Ghosts participate (they occupy space).
- [ ] **Step 4:** tsc + tests + build; browser sanity with the fake transcriber that marks no longer overlap (compute pairwise rect intersections of `.mark` elements after 20 s: expect none).
- [ ] **Step 5: Commit** — `fix(board): separate overlapping marks after slot placement` + trailer.

---

## Self-review

- Spec coverage: §1 (T1), §2 (T2 incl. filler clause), §3 (T3 vocabulary/client), §4 (T3 server), §5 (T4), §6 (T2 cast), error handling (T3 warnings), testing (each task). Task 5 is Victor's collision fix, not in the spec, small and self-contained.
- Placeholders: none — every step shows code or exact expectations.
- Type consistency: `InterpretationHints`, `hintBlock`, `vocabularyFrom`, `setContext/setFollow` (session), `setContext/follow` (LiveSounding), `separate/Placed` — used with the names defined where introduced.

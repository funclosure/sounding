# Slice 3 — Live Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Talk into the browser and see the reading move while you talk: heard words flash and shrink within a second, marks move within a few seconds of finishing a thought.

**Architecture:** A local Node process (`npm run live`) owns the mic stream, the Gemini Transcribe Live WebSocket, the `SoundingSession`, and the interpreter calls, and pushes every `SoundingEvent` to the browser over a local WebSocket. The browser captures 16 kHz PCM with an AudioWorklet and renders events. Pure pieces (segmenter, PCM ring buffer, heard-words) are unit-tested; the Transcribe client is tested against a fake socket; the whole server runs headless against a fixture with a fake transcriber and an accelerated clock, so the end-to-end path is tested without keys or audio.

**Tech Stack:** TypeScript, Node 22 (built-in `WebSocket` client), `ws` (server), ffmpeg, Vite, browser AudioWorklet + MediaStream, vitest.

Spec: `docs/superpowers/specs/2026-09-05-sounding-slice3-live-design.md` (read it first; the "Facts" section has the verified wire shapes).

## Global Constraints

- API keys never reach the browser. The Transcribe Live key is in the WebSocket URL, so that connection is made only from `src/live/`. `src/cli/env.ts`'s `loadDotEnv()` runs at live-server startup.
- Live mode never writes audio to disk. The only persisted artifact is `soundings/live-<YYYYMMDD-HHmmss>.<interp>.jsonl`. `recordings/` and `soundings/` are gitignored; never `git add` anything under them.
- `src/core`, `src/salience`, `src/interpret`, `src/replay` are walked by the wall-clock guard in `tests/fixtures-drift-determinism.test.ts`. The only change allowed there in this slice is Task 1 (a config constant and prompt text in `src/providers`, which is outside the guard). `src/live/` and `src/ui/` are the wall-clock boundary.
- Transcribe Live protocol, verbatim from the spec: endpoint `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<KEY>`; setup `{"setup":{"model":"models/gemini-3.5-transcribe-live","generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"languageCodes":[],"mode":"VERBATIM"}}}`; audio `{"realtimeInput":{"audio":{"data":"<base64>","mimeType":"audio/pcm;rate=16000"}}}`; end `{"realtimeInput":{"audioStreamEnd":true}}`; incoming `serverContent.interimInputTranscription.text` (cumulative per utterance), `serverContent.inputTranscription.text` (final), `setupComplete`. Session limit: reconnect at 9.5 min.
- PCM everywhere: 16 kHz, 16-bit signed little-endian, mono; 100 ms = 1600 samples = 3200 bytes.
- Segmenter constants: `maxSegmentMs` 8000, `minSegmentWords` 4. Ring buffer 30 000 ms. Heard-word animation 1.5 s. Live server default port 8787.
- Tuning: `halfLifeMs` 45 000 → 20 000. Prompt addition (both providers, verbatim): `Do not report discourse or framing — "what I'm thinking", "this afternoon", "let me talk about", time-of-day, or the act of talking itself. Report only the content being thought about.`
- Commands: `npm test`, `npx tsc --noEmit -p .`. Suite must stay green (currently 127 tests).
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `src/salience/config.ts` (modify) | `halfLifeMs` 20 000 |
| `src/providers/gemini-audio.ts`, `src/providers/claude-extraction.ts` (modify) | filler-exclusion line in prompts |
| `src/replay/fixtures/topic-shift.ts` (modify) | drop the now-redundant local `halfLifeMs` override if the fixture still passes without it; otherwise keep and document |
| `src/live/segmenter.ts` (create) | interim/final → pending deltas + committed segments (pure) |
| `src/live/pcm-ring.ts` (create) | 30 s PCM ring, slice, WAV encode (pure) |
| `src/live/heard-words.ts` (create) | content words to flash, surface form (pure) |
| `src/live/transcriber.ts` (create) | `Transcriber` interface shared by real and fake |
| `src/live/transcribe-live.ts` (create) | Gemini Transcribe Live client with reconnect |
| `src/live/fake-transcriber.ts` (create) | replays a `FixtureScript` as interims/finals on a clock (dev/test) |
| `src/live/fake-mic.ts` (create) | ffmpeg-decoded file → 100 ms PCM chunks on the clock (dev) |
| `src/live/clock.ts` (create) | session clock with optional speed factor (wall-clock boundary) |
| `src/live/live-sounding.ts` (create) | one live sounding: session + transcriber + ring + segmenter + event forwarding + log persistence |
| `src/live/server.ts` (create) | CLI + `ws` server; browser ↔ `LiveSounding`; headless mode |
| `src/ui/chart.ts` (create) | mark rendering + inspector, extracted from `main.ts` |
| `src/ui/main.ts` (modify) | use `chart.ts` |
| `live.html`, `src/ui/live.ts`, `src/ui/live.css`, `public/pcm-worklet.js` (create) | live page |
| `package.json` (modify) | `ws`, `@types/ws`, script `live` |
| tests: `tests/live-segmenter.test.ts`, `tests/live-pcm-ring.test.ts`, `tests/live-heard-words.test.ts`, `tests/live-transcribe-client.test.ts`, `tests/live-headless.test.ts` |

---

### Task 1: Tuning — faster decay, no filler labels

**Files:**
- Modify: `src/salience/config.ts:16` (`halfLifeMs: 45_000` → `20_000`, update the comment)
- Modify: `src/providers/gemini-audio.ts` (AUDIO_PROMPT rules), `src/providers/claude-extraction.ts` (SYSTEM_PROMPT guidance)
- Modify (maybe): `src/replay/fixtures/topic-shift.ts:22`
- Test: existing suite; `tests/fixtures-shift-contention.test.ts`, `tests/hysteresis.test.ts`, `tests/dynamics.test.ts`, `tests/fixtures-circling-slack.test.ts`

**Interfaces:** none new. Later tasks rely on `DEFAULT_SALIENCE_CONFIG.halfLifeMs === 20_000`.

- [ ] **Step 1: Change the constant**

In `src/salience/config.ts` replace the `halfLifeMs: 45_000,` line with:

```ts
  halfLifeMs: 20_000, // 2026-09-05: 45s left dropped topics on the chart ~90s on a live memo; 20s clears filler in under a minute
```

- [ ] **Step 2: Run the suite and record what moved**

Run: `npm test`
Expected: most tests pass. If a fixture test fails on a latency or ordering expectation, read the failure, re-run that fixture to see the new numbers, and update the expectation **with a comment giving the old and new values and why** (faster decay). Do not loosen an assertion to `toBeGreaterThan(0)`; keep it tight around the new observed value. Record every changed expectation in your report.

Then try removing `halfLifeMs: 15_000` from `src/replay/fixtures/topic-shift.ts` `configOverrides` (leave `capacity: 4`). Run `npx vitest run tests/fixtures-shift-contention.test.ts`. If it passes, keep the removal and update the fixture's header comment (lines 9–10) to say the default now covers the 30 s bound. If it fails, restore the override and leave the comment.

- [ ] **Step 3: Add the filler-exclusion line to both prompts**

In `src/providers/gemini-audio.ts`, inside `AUDIO_PROMPT`'s `Rules:` list, add as the first rule:

```
- Do not report discourse or framing — "what I'm thinking", "this afternoon", "let me talk about", time-of-day, or the act of talking itself. Report only the content being thought about.
```

In `src/providers/claude-extraction.ts`, inside `SYSTEM_PROMPT`'s `Guidance:` list, add the same line as the second bullet (after the "Prefer what recurs…" bullet).

- [ ] **Step 4: Verify on the live memo (Gemini calls only, transcript is cached)**

Run: `npm run cast -- recordings/mic-20260905-145437.m4a -i gemini 2>&1 | tail -12`
Expected: the final reading contains none of "what I'm thinking", "this afternoon", "find some time". Paste the final reading into your report. (If the recording is missing on this machine, say so and skip; the prompt change is still verified by inspection.)

Then run: `npx tsc --noEmit -p . && npm test` — clean, all green.

- [ ] **Step 5: Commit**

```bash
git add src/salience/config.ts src/providers/gemini-audio.ts src/providers/claude-extraction.ts src/replay/fixtures/topic-shift.ts tests/
git commit -m "tune: half-life 45s→20s; prompts exclude discourse filler

On a live 2.5-minute memo, opening filler held 10-16% of the chart for 90s
and a topic dropped at 0:50 stayed on top until 2:00. Faster decay and a
prompt rule against framing/meta-talk fix both. Fixture expectations that
encoded the old latency are re-derived (see comments).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

### Task 2: Pure live units — segmenter, PCM ring, heard words

**Files:**
- Create: `src/live/segmenter.ts`, `src/live/pcm-ring.ts`, `src/live/heard-words.ts`
- Test: `tests/live-segmenter.test.ts`, `tests/live-pcm-ring.test.ts`, `tests/live-heard-words.test.ts`

**Interfaces (produced):**
```ts
// segmenter.ts
export interface LiveSegment { segmentId: string; transcript: string; startT: Ms; endT: Ms }
export interface SegmenterOptions { maxSegmentMs?: number; minSegmentWords?: number }
export class Segmenter {
  constructor(opts?: SegmenterOptions)
  onInterim(t: Ms, text: string): { pendingDelta: string; commit: LiveSegment | null }
  onFinal(t: Ms, text: string): { commit: LiveSegment | null }
  onIdle(t: Ms): { commit: LiveSegment | null }   // called by a 1s timer; same time-based rule
}
// pcm-ring.ts
export class PcmRing {
  constructor(windowMs?: number, sampleRate?: number)  // 30000, 16000
  push(chunk: Int16Array, endT: Ms): void
  slice(fromT: Ms, toT: Ms): Int16Array
  heldRange(): { fromT: Ms; toT: Ms }
}
export function toWav(samples: Int16Array, sampleRate?: number): Uint8Array
// heard-words.ts
export function heardWords(delta: string): string[]
```

- [ ] **Step 1: Write the failing tests**

`tests/live-segmenter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Segmenter } from '../src/live/segmenter'

describe('Segmenter', () => {
  it('emits the new words as the pending delta when the interim grows', () => {
    const s = new Segmenter()
    expect(s.onInterim(500, 'Okay,').pendingDelta).toBe('Okay,')
    expect(s.onInterim(1000, 'Okay, let me').pendingDelta).toBe('let me')
    expect(s.onInterim(1500, 'Okay, let me').pendingDelta).toBe('')
  })

  it('emits the revised tail when the interim rewrites earlier words', () => {
    const s = new Segmenter()
    s.onInterim(500, 'about one thinking')
    expect(s.onInterim(1000, "about what I'm thinking").pendingDelta).toBe("what I'm thinking")
  })

  it('cuts a segment after maxSegmentMs when at least minSegmentWords are new', () => {
    const s = new Segmenter({ maxSegmentMs: 8000, minSegmentWords: 4 })
    s.onInterim(500, 'one two')
    expect(s.onInterim(7900, 'one two three four five').commit).toBeNull()
    const r = s.onInterim(8100, 'one two three four five six')
    expect(r.commit).toMatchObject({ transcript: 'one two three four five six', startT: 0, endT: 8100 })
    expect(r.commit!.segmentId).toBe('live-1')
  })

  it('does not cut when fewer than minSegmentWords are new', () => {
    const s = new Segmenter({ maxSegmentMs: 8000, minSegmentWords: 4 })
    s.onInterim(500, 'one two three')
    expect(s.onInterim(9000, 'one two three').commit).toBeNull()
    expect(s.onIdle(12000).commit).toBeNull()
  })

  it('a final commits only the remainder after a time-based cut, then resets', () => {
    const s = new Segmenter({ maxSegmentMs: 8000, minSegmentWords: 4 })
    s.onInterim(8100, 'one two three four five')
    const cut = s.onInterim(8200, 'one two three four five').commit
    expect(cut).toBeNull() // already committed at 8100? no: first interim at 8100 is the first sample
    const first = s.onIdle(8500).commit
    expect(first).toMatchObject({ transcript: 'one two three four five', segmentId: 'live-1' })
    const fin = s.onFinal(9000, 'one two three four five six seven').commit
    expect(fin).toMatchObject({ transcript: 'six seven', startT: 8500, endT: 9000, segmentId: 'live-2' })
    // next utterance starts fresh
    expect(s.onInterim(9500, 'new').pendingDelta).toBe('new')
  })

  it('a final with nothing new commits nothing', () => {
    const s = new Segmenter()
    s.onInterim(500, 'hello there friend again')
    s.onIdle(9000)
    expect(s.onFinal(9200, 'hello there friend again').commit).toBeNull()
  })

  it('segment timestamps are monotonic across utterances', () => {
    const s = new Segmenter({ maxSegmentMs: 1000, minSegmentWords: 1 })
    const a = s.onInterim(1100, 'a b').commit!
    const b = s.onFinal(1500, 'a b c').commit!
    const c = s.onInterim(2700, 'd e').commit!
    expect(a.endT).toBeLessThanOrEqual(b.startT)
    expect(b.endT).toBeLessThanOrEqual(c.startT)
  })
})
```

`tests/live-pcm-ring.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PcmRing, toWav } from '../src/live/pcm-ring'

function chunk(v: number, n = 1600): Int16Array { return new Int16Array(n).fill(v) }

describe('PcmRing', () => {
  it('slices the requested time range from what it holds', () => {
    const r = new PcmRing(1000, 16000) // 1s window
    r.push(chunk(1), 100); r.push(chunk(2), 200); r.push(chunk(3), 300)
    const s = r.slice(100, 300)
    expect(s.length).toBe(3200)
    expect(s[0]).toBe(2); expect(s[3199]).toBe(3)
  })

  it('drops the oldest audio once the window is exceeded and clamps slices', () => {
    const r = new PcmRing(300, 16000) // holds 4800 samples
    for (let i = 1; i <= 6; i++) r.push(chunk(i), i * 100)
    expect(r.heldRange()).toEqual({ fromT: 300, toT: 600 })
    const s = r.slice(0, 600)
    expect(s.length).toBe(4800)
    expect(s[0]).toBe(4); expect(s[4799]).toBe(6)
  })

  it('returns an empty slice for a range entirely before what it holds', () => {
    const r = new PcmRing(300, 16000)
    for (let i = 1; i <= 6; i++) r.push(chunk(i), i * 100)
    expect(r.slice(0, 200).length).toBe(0)
  })
})

describe('toWav', () => {
  it('writes a valid 44-byte RIFF header for 16kHz mono 16-bit', () => {
    const wav = toWav(new Int16Array([0, 1, -1]), 16000)
    expect(wav.length).toBe(44 + 6)
    const s = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n))
    expect(s(0, 4)).toBe('RIFF'); expect(s(8, 4)).toBe('WAVE'); expect(s(12, 4)).toBe('fmt '); expect(s(36, 4)).toBe('data')
    const dv = new DataView(wav.buffer, wav.byteOffset)
    expect(dv.getUint32(24, true)).toBe(16000) // sample rate
    expect(dv.getUint16(22, true)).toBe(1)     // channels
    expect(dv.getUint16(34, true)).toBe(16)    // bits
    expect(dv.getUint32(40, true)).toBe(6)     // data bytes
    expect(dv.getInt16(46, true)).toBe(-1)
  })
})
```

`tests/live-heard-words.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { heardWords } from '../src/live/heard-words'

describe('heardWords', () => {
  it('keeps content words in their spoken form and drops stopwords', () => {
    expect(heardWords("I think Ray Dalio is the good reference")).toEqual(['Ray', 'Dalio', 'good', 'reference'])
  })
  it('strips punctuation and ignores fragments', () => {
    expect(heardWords('Okay, let me talk to you about one.')).toEqual(['talk'])
  })
  it('returns nothing for empty or all-stopword input', () => {
    expect(heardWords('')).toEqual([])
    expect(heardWords('so I just')).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/live-segmenter.test.ts tests/live-pcm-ring.test.ts tests/live-heard-words.test.ts`
Expected: FAIL, cannot find modules under `src/live/`.

- [ ] **Step 3: Implement**

`src/live/segmenter.ts`:

```ts
// Turns Transcribe Live's interim/final stream into the engine's two loops.
// Interims are cumulative per utterance and revise earlier words; finals only
// arrive on pauses, so continuous talk is cut on a clock as well.
import type { Ms } from '../core/types'

export interface LiveSegment { segmentId: string; transcript: string; startT: Ms; endT: Ms }
export interface SegmenterOptions { maxSegmentMs?: number; minSegmentWords?: number }

const words = (s: string) => s.trim().split(/\s+/).filter((w) => w.length > 0)

export class Segmenter {
  private readonly maxSegmentMs: number
  private readonly minSegmentWords: number
  private lastInterim = ''
  private committedPrefix = ''  // words of the current utterance already committed
  private lastCommitT: Ms = 0
  private seq = 0

  constructor(opts: SegmenterOptions = {}) {
    this.maxSegmentMs = opts.maxSegmentMs ?? 8000
    this.minSegmentWords = opts.minSegmentWords ?? 4
  }

  onInterim(t: Ms, text: string): { pendingDelta: string; commit: LiveSegment | null } {
    const prev = words(this.lastInterim)
    const next = words(text)
    let i = 0
    while (i < prev.length && i < next.length && prev[i] === next[i]) i++
    const pendingDelta = next.slice(i).join(' ')
    this.lastInterim = text
    return { pendingDelta, commit: this.maybeCut(t) }
  }

  onIdle(t: Ms): { commit: LiveSegment | null } {
    return { commit: this.maybeCut(t) }
  }

  onFinal(t: Ms, text: string): { commit: LiveSegment | null } {
    const remainder = this.tailAfterCommitted(text)
    let commit: LiveSegment | null = null
    if (words(remainder).length > 0) commit = this.emit(t, remainder)
    this.lastInterim = ''
    this.committedPrefix = ''
    this.lastCommitT = t
    return { commit }
  }

  private maybeCut(t: Ms): LiveSegment | null {
    if (t - this.lastCommitT < this.maxSegmentMs) return null
    const tail = this.tailAfterCommitted(this.lastInterim)
    if (words(tail).length < this.minSegmentWords) return null
    const seg = this.emit(t, tail)
    this.committedPrefix = this.lastInterim
    return seg
  }

  /** Words of `text` after the committed prefix (by word count, since finals may re-punctuate). */
  private tailAfterCommitted(text: string): string {
    const n = words(this.committedPrefix).length
    return words(text).slice(n).join(' ')
  }

  private emit(t: Ms, transcript: string): LiveSegment {
    this.seq += 1
    const seg = { segmentId: `live-${this.seq}`, transcript, startT: this.lastCommitT, endT: t }
    this.lastCommitT = t
    return seg
  }
}
```

`src/live/pcm-ring.ts`:

```ts
// In-memory ring of recent PCM for audio-native interpretation. Never written to disk.
import type { Ms } from '../core/types'

export class PcmRing {
  private readonly capacity: number
  private readonly buf: Int16Array
  private write = 0        // next write index
  private held = 0         // samples currently held (≤ capacity)
  private endT: Ms = 0     // timestamp of the last sample
  readonly sampleRate: number

  constructor(windowMs = 30_000, sampleRate = 16_000) {
    this.sampleRate = sampleRate
    this.capacity = Math.round((windowMs / 1000) * sampleRate)
    this.buf = new Int16Array(this.capacity)
  }

  push(chunk: Int16Array, endT: Ms): void {
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.write] = chunk[i]
      this.write = (this.write + 1) % this.capacity
    }
    this.held = Math.min(this.capacity, this.held + chunk.length)
    this.endT = endT
  }

  heldRange(): { fromT: Ms; toT: Ms } {
    return { fromT: this.endT - (this.held / this.sampleRate) * 1000, toT: this.endT }
  }

  slice(fromT: Ms, toT: Ms): Int16Array {
    const { fromT: hf, toT: ht } = this.heldRange()
    const a = Math.max(fromT, hf)
    const b = Math.min(toT, ht)
    if (b <= a) return new Int16Array(0)
    const startSample = Math.round(((a - hf) / 1000) * this.sampleRate)
    const n = Math.round(((b - a) / 1000) * this.sampleRate)
    const out = new Int16Array(n)
    const oldest = (this.write - this.held + this.capacity) % this.capacity
    for (let i = 0; i < n; i++) out[i] = this.buf[(oldest + startSample + i) % this.capacity]
    return out
  }
}

export function toWav(samples: Int16Array, sampleRate = 16_000): Uint8Array {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const dv = new DataView(out.buffer)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i) }
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE')
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  str(36, 'data'); dv.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true)
  return out
}
```

`src/live/heard-words.ts`:

```ts
// Which words to flash on screen for a pending delta: content words, in the
// form they were spoken. Uses the engine's single tokenizer so "what counts
// as a word" agrees with the fast loop.
import { normalizeToken, STOPWORDS } from '../core/text'

export function heardWords(delta: string): string[] {
  return delta
    .split(/\s+/)
    .map((raw) => ({ raw: raw.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ''), norm: normalizeToken(raw) }))
    .filter(({ raw, norm }) => raw.length > 0 && norm.length > 1 && !STOPWORDS.has(norm))
    .map(({ raw }) => raw)
}
```

- [ ] **Step 4: Run tests until green; fix the segmenter test if your reading of the spec differs**

Run: `npx vitest run tests/live-segmenter.test.ts tests/live-pcm-ring.test.ts tests/live-heard-words.test.ts`
Expected: PASS. The fifth segmenter test contains a comment questioning itself; resolve it by reading the implementation: the first interim at 8100 has 5 new words and `t − lastCommitT ≥ 8000`, so `onInterim(8100)` itself commits `live-1` and the later `onIdle(8500)` commits nothing. Correct the test to assert that (commit on the 8100 call, `null` from onIdle, final at 9000 commits `six seven` with `startT: 8100`). Tests must describe real behavior.

Then: `npx tsc --noEmit -p . && npm test` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/live/segmenter.ts src/live/pcm-ring.ts src/live/heard-words.ts tests/live-segmenter.test.ts tests/live-pcm-ring.test.ts tests/live-heard-words.test.ts
git commit -m "feat(live): segmenter, PCM ring buffer, heard-words (pure units)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

### Task 3: Transcriber interface, Gemini Transcribe Live client, fake transcriber, clock

**Files:**
- Create: `src/live/transcriber.ts`, `src/live/transcribe-live.ts`, `src/live/fake-transcriber.ts`, `src/live/clock.ts`
- Test: `tests/live-transcribe-client.test.ts`

**Interfaces:**
- Consumes: Task 2 nothing directly. `FixtureScript` from `src/replay/fixture.ts` (`segments: {startT,endT,text}[]`).
- Produces:
```ts
// transcriber.ts
export interface TranscriberCallbacks { onInterim(text: string): void; onFinal(text: string): void; onStatus(state: 'connecting'|'listening'|'reconnecting'|'error', message?: string): void }
export interface Transcriber { connect(cbs: TranscriberCallbacks): Promise<void>; sendAudio(pcm: Int16Array): void; end(): Promise<void> }
// transcribe-live.ts
export class TranscribeLiveClient implements Transcriber { constructor(apiKey: string, opts?: { socketFactory?: (url: string) => WebSocketLike; sessionLimitMs?: number; now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }) }
export interface WebSocketLike { send(data: string): void; close(): void; onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onerror: ((ev: unknown) => void) | null; onclose: ((ev: { code: number; reason: string }) => void) | null; readyState: number }
// fake-transcriber.ts
export class FakeTranscriber implements Transcriber { constructor(script: FixtureScript, clock: Clock, opts?: { interimEveryMs?: number }) }
// clock.ts
export class Clock { constructor(speed = 1); start(): void; now(): Ms; every(ms: Ms, fn: () => void): () => void /* returns stop */ }
```

- [ ] **Step 1: Write the failing test**

`tests/live-transcribe-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TranscribeLiveClient, type WebSocketLike } from '../src/live/transcribe-live'

class FakeSocket implements WebSocketLike {
  static created: FakeSocket[] = []
  sent: string[] = []
  closed = false
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  constructor(public url: string) { FakeSocket.created.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true; this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }) }
  open() { this.readyState = 1; this.onopen?.({}) }
  receive(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

function makeClient(now: { t: number }, timers: Array<{ at: number; fn: () => void }>) {
  return new TranscribeLiveClient('KEY', {
    socketFactory: (url) => new FakeSocket(url),
    sessionLimitMs: 1000,
    now: () => now.t,
    setTimer: ((fn: () => void, ms: number) => { timers.push({ at: now.t + ms, fn }); return timers.length as unknown as NodeJS.Timeout }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  })
}

describe('TranscribeLiveClient', () => {
  it('sends the setup message, resolves on setupComplete, frames audio, dispatches interim/final', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const got: string[] = []
    const p = c.connect({ onInterim: (t) => got.push('I:' + t), onFinal: (t) => got.push('F:' + t), onStatus: () => {} })
    const ws = FakeSocket.created[0]
    expect(ws.url).toContain('BidiGenerateContent?key=KEY')
    ws.open()
    expect(JSON.parse(ws.sent[0])).toEqual({ setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: [], mode: 'VERBATIM' } } })
    ws.receive({ setupComplete: {} })
    await p
    c.sendAudio(new Int16Array([1, 2, 3]))
    const audio = JSON.parse(ws.sent[1])
    expect(audio.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000')
    expect(Buffer.from(audio.realtimeInput.audio.data, 'base64').length).toBe(6)
    ws.receive({ serverContent: { interimInputTranscription: { text: 'hel' } } })
    ws.receive({ serverContent: { inputTranscription: { text: 'hello' } } })
    ws.receive({ serverContent: {}, voiceActivity: { type: 'ACTIVITY_END', audioOffset: '1s' } })
    expect(got).toEqual(['I:hel', 'F:hello'])
    await c.end()
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } })
  })

  it('reconnects at the session limit and routes new audio to the new socket', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    FakeSocket.created[0].open(); FakeSocket.created[0].receive({ setupComplete: {} }); await p
    now.t = 1000
    timers.find((x) => x.at === 1000)!.fn()                   // session-limit timer fires
    expect(FakeSocket.created.length).toBe(2)
    const old = FakeSocket.created[0], fresh = FakeSocket.created[1]
    fresh.open(); fresh.receive({ setupComplete: {} })
    await Promise.resolve()
    c.sendAudio(new Int16Array([9]))
    expect(fresh.sent.some((s) => s.includes('"audio"'))).toBe(true)
    expect(old.sent.at(-1)).toContain('audioStreamEnd')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/live-transcribe-client.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

`src/live/transcriber.ts`:

```ts
export type TranscriberState = 'connecting' | 'listening' | 'reconnecting' | 'error'
export interface TranscriberCallbacks {
  onInterim(text: string): void
  onFinal(text: string): void
  onStatus(state: TranscriberState, message?: string): void
}
export interface Transcriber {
  connect(cbs: TranscriberCallbacks): Promise<void>
  sendAudio(pcm: Int16Array): void
  end(): Promise<void>
}
```

`src/live/clock.ts`:

```ts
// The live session clock. src/live is the wall-clock boundary: the engine
// only ever sees the Ms values this produces. `speed` > 1 is for headless
// fixture runs (fake transcriber), never for real audio.
import type { Ms } from '../core/types'

export class Clock {
  private t0 = 0
  constructor(private readonly speed = 1) {}
  start(): void { this.t0 = performance.now() }
  now(): Ms { return Math.round((performance.now() - this.t0) * this.speed) }
  /** Run fn every `ms` of session time; returns a stop function. */
  every(ms: Ms, fn: () => void): () => void {
    const h = setInterval(fn, Math.max(1, ms / this.speed))
    return () => clearInterval(h)
  }
  /** Sleep for `ms` of session time. */
  sleep(ms: Ms): Promise<void> { return new Promise((r) => setTimeout(r, Math.max(0, ms / this.speed))) }
}
```

`src/live/transcribe-live.ts`:

```ts
// Gemini 3.5 Transcribe Live over the Live API WebSocket. Verified wire
// shapes are in the slice-3 spec ("Facts"). Key lives in the URL, so this
// runs only in the local Node process.
import type { Transcriber, TranscriberCallbacks } from './transcriber'

export interface WebSocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  readyState: number
}

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
export const SETUP = { setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: [], mode: 'VERBATIM' } } }
const SESSION_LIMIT_MS = 9.5 * 60_000

interface Options {
  socketFactory?: (url: string) => WebSocketLike
  sessionLimitMs?: number
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export class TranscribeLiveClient implements Transcriber {
  private ws: WebSocketLike | null = null
  private cbs: TranscriberCallbacks | null = null
  private limitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly factory: (url: string) => WebSocketLike
  private readonly sessionLimitMs: number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(private readonly apiKey: string, opts: Options = {}) {
    this.factory = opts.socketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike)
    this.sessionLimitMs = opts.sessionLimitMs ?? SESSION_LIMIT_MS
    this.setTimer = opts.setTimer ?? setTimeout
    this.clearTimer = opts.clearTimer ?? clearTimeout
  }

  async connect(cbs: TranscriberCallbacks): Promise<void> {
    this.cbs = cbs
    cbs.onStatus('connecting')
    this.ws = await this.open()
    cbs.onStatus('listening')
    this.armLimit()
  }

  sendAudio(pcm: Int16Array): void {
    if (!this.ws || this.ws.readyState !== 1) return
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: bytes.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }))
  }

  async end(): Promise<void> {
    if (this.limitTimer) this.clearTimer(this.limitTimer)
    const ws = this.ws
    this.ws = null
    if (!ws) return
    await this.drain(ws)
  }

  private open(): Promise<WebSocketLike> {
    return new Promise((resolve, reject) => {
      const ws = this.factory(`${ENDPOINT}?key=${this.apiKey}`)
      let settled = false
      ws.onopen = () => ws.send(JSON.stringify(SETUP))
      ws.onerror = (e) => { if (!settled) { settled = true; reject(new Error(`transcribe-live socket error: ${String((e as { message?: string })?.message ?? e)}`)) } else this.cbs?.onStatus('error', String((e as { message?: string })?.message ?? e)) }
      ws.onclose = (e) => { if (!settled) { settled = true; reject(new Error(`transcribe-live closed before setup: ${e.code} ${e.reason}`)) } }
      ws.onmessage = async (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : Buffer.from(await (ev.data as Blob).arrayBuffer()).toString('utf8')
        let m: { setupComplete?: unknown; serverContent?: { interimInputTranscription?: { text?: string }; inputTranscription?: { text?: string } }; error?: unknown }
        try { m = JSON.parse(text) } catch { return }
        if (m.setupComplete !== undefined) { if (!settled) { settled = true; resolve(ws) } return }
        if (m.error) { this.cbs?.onStatus('error', JSON.stringify(m.error).slice(0, 200)); return }
        const sc = m.serverContent
        if (sc?.interimInputTranscription?.text !== undefined) this.cbs?.onInterim(sc.interimInputTranscription.text)
        else if (sc?.inputTranscription?.text !== undefined) this.cbs?.onFinal(sc.inputTranscription.text)
      }
    })
  }

  /** Send audioStreamEnd, wait briefly for a trailing final, close. */
  private drain(ws: WebSocketLike): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; try { ws.close() } catch { /* already closed */ } resolve() } }
      const prev = ws.onmessage
      ws.onmessage = (ev) => { prev?.(ev); if (typeof ev.data === 'string' && ev.data.includes('"inputTranscription"')) finish() }
      try { ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })) } catch { finish(); return }
      this.setTimer(finish, 3000)
    })
  }

  private armLimit(): void {
    this.limitTimer = this.setTimer(() => void this.rotate(), this.sessionLimitMs)
  }

  /** Open a fresh session before the 10-minute cap; audio goes to the new socket as soon as it is up. */
  private async rotate(): Promise<void> {
    const old = this.ws
    this.cbs?.onStatus('reconnecting')
    try {
      const fresh = await this.open()
      this.ws = fresh
      this.cbs?.onStatus('listening')
      this.armLimit()
      if (old) void this.drain(old)
    } catch (e) {
      this.cbs?.onStatus('error', `reconnect failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
```

Note for the reconnect test: `rotate()` opens the new socket *then* switches `this.ws`; until `setupComplete` arrives on the fresh socket, `sendAudio` still goes to the old one, which is what the spec allows ("during the swap"). The test opens and completes the fresh socket before sending, then asserts the new socket got the audio and the old got `audioStreamEnd`.

`src/live/fake-transcriber.ts`:

```ts
// Replays a FixtureScript as if Transcribe Live were hearing it: interims
// grow word by word every `interimEveryMs`, a final fires at each segment's
// endT. Lets the whole live path run without a key or a microphone.
import type { FixtureScript } from '../replay/fixture'
import type { Transcriber, TranscriberCallbacks } from './transcriber'
import type { Clock } from './clock'

export class FakeTranscriber implements Transcriber {
  private stop: (() => void) | null = null
  constructor(private readonly script: FixtureScript, private readonly clock: Clock, private readonly opts: { interimEveryMs?: number } = {}) {}

  async connect(cbs: TranscriberCallbacks): Promise<void> {
    cbs.onStatus('listening')
    const every = this.opts.interimEveryMs ?? 500
    let segIdx = 0
    let lastInterimWords = 0
    this.stop = this.clock.every(every, () => {
      const t = this.clock.now()
      const seg = this.script.segments[segIdx]
      if (!seg) return
      if (t < seg.startT) return
      const wordsAll = seg.text.split(/\s+/)
      const frac = Math.min(1, (t - seg.startT) / Math.max(1, seg.endT - seg.startT))
      const n = Math.max(1, Math.round(frac * wordsAll.length))
      if (t >= seg.endT) {
        cbs.onFinal(seg.text)
        segIdx += 1
        lastInterimWords = 0
        return
      }
      if (n !== lastInterimWords) { lastInterimWords = n; cbs.onInterim(wordsAll.slice(0, n).join(' ')) }
    })
  }
  sendAudio(): void { /* audio is irrelevant to the fake */ }
  async end(): Promise<void> { this.stop?.(); this.stop = null }
}
```

- [ ] **Step 4: Tests green, typecheck**

Run: `npx vitest run tests/live-transcribe-client.test.ts && npx tsc --noEmit -p . && npm test`
Expected: PASS. If `WebSocket` is flagged by tsc as unknown in Node typings, add `/// <reference lib="dom" />` is NOT the fix (this is Node); instead cast via `globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }` in the default factory.

- [ ] **Step 5: Commit**

```bash
git add src/live/transcriber.ts src/live/transcribe-live.ts src/live/fake-transcriber.ts src/live/clock.ts tests/live-transcribe-client.test.ts
git commit -m "feat(live): Transcribe Live client with reconnect, fake transcriber, session clock

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

### Task 4: LiveSounding orchestrator and the live server

**Files:**
- Create: `src/live/live-sounding.ts`, `src/live/fake-mic.ts`, `src/live/server.ts`
- Modify: `package.json` (deps `ws`, `@types/ws`; script `"live": "tsx src/live/server.ts"`)
- Test: `tests/live-headless.test.ts`

**Interfaces:**
- Consumes: Task 2 `Segmenter`, `PcmRing`, `toWav`, `heardWords`; Task 3 `Transcriber`, `TranscribeLiveClient`, `FakeTranscriber`, `Clock`; engine `SoundingSession`, `ReadingDynamics`, `EmbeddingIdentityResolver`, `DEFAULT_SALIENCE_CONFIG`, interpreters from `src/providers` and `src/interpret/recurrence` (see `src/cli/cast.ts` `makeInterpreter` for the exact constructors), `summarizeCounters`.
- Produces:
```ts
// live-sounding.ts
export type LiveMessage = SoundingEvent | { type: 'live.heard'; t: Ms; words: string[] } | { type: 'live.status'; state: string; message?: string }
export interface LiveSoundingOptions { interpreterName: 'gemini'|'claude'|'recurrence'; transcriber: Transcriber; clock: Clock; send: (m: LiveMessage) => void; soundingId: string }
export class LiveSounding { constructor(opts); start(): Promise<void>; pushAudio(pcm: Int16Array): void; stop(): Promise<{ logPath: string; summary: string }> }
// fake-mic.ts
export function streamFile(path: string, clock: Clock, onChunk: (pcm: Int16Array) => void): Promise<void>  // resolves at EOF
```
- Wire protocol (browser ↔ server), consumed by Task 5:
  - browser → server: text `{"type":"start","interpreter":"gemini"}`, text `{"type":"stop"}`, binary frames = raw s16le PCM chunks.
  - server → browser: text frames, each one `LiveMessage` as JSON, in order.

- [ ] **Step 1: Install the server dependency**

Run: `npm install ws && npm install -D @types/ws`
Add to `package.json` scripts: `"live": "tsx src/live/server.ts"`.

- [ ] **Step 2: Write the failing headless test**

`tests/live-headless.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { EventLog } from '../src/core/events'

describe('live server, headless fixture run', () => {
  it('runs the circling fixture through the live path with a fake transcriber and writes a valid log', () => {
    const r = spawnSync('node_modules/.bin/tsx', ['src/live/server.ts', '--fixture', 'circling', '--fake-transcriber', '--speed', '30', '-i', 'recurrence', '--headless'], { encoding: 'utf8', timeout: 120_000 })
    expect(r.status, r.stderr).toBe(0)
    const m = r.stdout.match(/wrote (soundings\/live-[^\s]+\.recurrence\.jsonl)/)
    expect(m, r.stdout).not.toBeNull()
    const path = m![1]
    expect(existsSync(path)).toBe(true)
    const log = EventLog.fromJsonl(readFileSync(path, 'utf8'))
    const types = log.all().map((e) => e.type)
    expect(types[0]).toBe('sounding.dropped')
    expect(types.at(-1)).toBe('sounding.surfaced')
    expect(types.filter((t) => t === 'segment.committed').length).toBeGreaterThanOrEqual(3)
    expect(types.filter((t) => t === 'segment.pending').length).toBeGreaterThanOrEqual(10)
    const ticks = log.all().filter((e) => e.type === 'reading.changed').map((e) => e.t)
    expect(ticks.length).toBeGreaterThan(100)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBe(100)
    unlinkSync(path)
  }, 130_000)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/live-headless.test.ts`
Expected: FAIL (server file missing → non-zero status).

- [ ] **Step 4: Implement `live-sounding.ts`**

```ts
// One live sounding. Owns the session, the transcriber, the ring buffer and
// the segmenter; forwards every log event to `send`; writes the log on stop.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SoundingSession } from '../core/session'
import type { SoundingEvent } from '../core/events'
import type { Ms } from '../core/types'
import { ReadingDynamics } from '../salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../salience/config'
import { EmbeddingIdentityResolver } from '../providers/embedding-identity'
import { RecurrenceInterpreter } from '../interpret/recurrence'
import { ClaudeExtractionInterpreter } from '../providers/claude-extraction'
import { GeminiAudioInterpreter } from '../providers/gemini-audio'
import { summarizeCounters } from '../replay/counters'
import type { Interpreter } from '../interpret/port'
import { Segmenter } from './segmenter'
import { PcmRing, toWav } from './pcm-ring'
import { heardWords } from './heard-words'
import type { Transcriber } from './transcriber'
import type { Clock } from './clock'

export type InterpreterName = 'gemini' | 'claude' | 'recurrence'
export type LiveMessage =
  | SoundingEvent
  | { type: 'live.heard'; t: Ms; words: string[] }
  | { type: 'live.status'; state: string; message?: string }

export interface LiveSoundingOptions {
  interpreterName: InterpreterName
  transcriber: Transcriber
  clock: Clock
  send: (m: LiveMessage) => void
  soundingId: string
}

function makeInterpreter(name: InterpreterName): Interpreter {
  if (name === 'claude') return new ClaudeExtractionInterpreter()
  if (name === 'gemini') return new GeminiAudioInterpreter()
  return new RecurrenceInterpreter()
}

export class LiveSounding {
  private readonly session: SoundingSession
  private readonly ring = new PcmRing()
  private readonly segmenter = new Segmenter()
  private sent = 0
  private stopClock: (() => void) | null = null
  private stopIdle: (() => void) | null = null
  private stopped = false

  constructor(private readonly opts: LiveSoundingOptions) {
    const interpreter = makeInterpreter(opts.interpreterName)
    const config = { ...DEFAULT_SALIENCE_CONFIG }
    const dynamics = new ReadingDynamics(new EmbeddingIdentityResolver(config.similarityThreshold), config)
    const audioSource = interpreter.input === 'audio'
      ? async (seg: { segmentId: string; startT: Ms; endT: Ms }) => ({
          kind: 'audio' as const, segmentId: seg.segmentId, mimeType: 'audio/wav',
          data: toWav(this.ring.slice(seg.endT - 30_000, seg.endT)), startT: seg.startT, endT: seg.endT,
        })
      : undefined
    this.session = new SoundingSession(interpreter, dynamics, config, opts.soundingId, audioSource)
  }

  async start(): Promise<void> {
    const { clock, transcriber } = this.opts
    clock.start()
    this.session.drop()
    this.flush()
    await transcriber.connect({
      onInterim: (text) => void this.onInterim(text),
      onFinal: (text) => void this.onFinal(text),
      onStatus: (state, message) => this.opts.send({ type: 'live.status', state, message }),
    })
    this.stopClock = clock.every(100, () => void this.run(() => this.session.advanceTo(clock.now())))
    this.stopIdle = clock.every(1000, () => void this.onIdle())
  }

  pushAudio(pcm: Int16Array): void {
    if (this.stopped) return
    this.ring.push(pcm, this.opts.clock.now())
    this.opts.transcriber.sendAudio(pcm)
  }

  async stop(): Promise<{ logPath: string; summary: string }> {
    this.stopped = true
    this.stopClock?.(); this.stopIdle?.()
    await this.opts.transcriber.end()
    await this.run(() => this.session.surface(this.opts.clock.now()))
    mkdirSync('soundings', { recursive: true })
    const logPath = join('soundings', `${this.opts.soundingId}.jsonl`)
    writeFileSync(logPath, this.session.log.toJsonl())
    const c = summarizeCounters(this.session.log.all())
    const summary = `${c.callCount} interpretation calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms · max ${Math.round(c.maxLatencyMs)}ms`
    return { logPath, summary }
  }

  private async onInterim(text: string): Promise<void> {
    const t = this.opts.clock.now()
    const { pendingDelta, commit } = this.segmenter.onInterim(t, text)
    if (pendingDelta) {
      const words = heardWords(pendingDelta)
      if (words.length) this.opts.send({ type: 'live.heard', t, words })
      await this.run(() => this.session.feedPending(t, pendingDelta))
    }
    if (commit) await this.run(() => this.session.feedCommitted(commit.endT, commit))
  }

  private async onFinal(text: string): Promise<void> {
    const { commit } = this.segmenter.onFinal(this.opts.clock.now(), text)
    if (commit) await this.run(() => this.session.feedCommitted(commit.endT, commit))
  }

  private async onIdle(): Promise<void> {
    const { commit } = this.segmenter.onIdle(this.opts.clock.now())
    if (commit) await this.run(() => this.session.feedCommitted(commit.endT, commit))
  }

  /** Run a session op, then forward whatever it appended. Errors go to the client as status, never crash. */
  private async run(op: () => Promise<void>): Promise<void> {
    try { await op() } catch (e) { this.opts.send({ type: 'live.status', state: 'error', message: e instanceof Error ? e.message : String(e) }) }
    this.flush()
  }

  private flush(): void {
    const all = this.session.log.all()
    while (this.sent < all.length) this.opts.send(all[this.sent++])
  }
}
```

Important: `feedCommitted` awaits the interpreter (seconds). The session's internal queue serializes it, so clock ticks queue behind it and the log stays monotonic; the timestamps handed in are the ones captured when the event happened, so `advanceTo(now)` calls that were queued during a slow call catch up in order. The `flush` after each op forwards events in log order.

- [ ] **Step 5: Implement `fake-mic.ts`**

```ts
// Feeds a recording as if it were the microphone: ffmpeg → 16k s16le mono on
// stdout, delivered in 100ms chunks on the session clock. Dev/tuning only.
import { spawn } from 'node:child_process'
import type { Clock } from './clock'

const CHUNK_BYTES = 3200

export function streamFile(path: string, clock: Clock, onChunk: (pcm: Int16Array) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    ff.stdout.on('data', (d: Buffer) => chunks.push(d))
    ff.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    ff.on('error', (e) => reject(e.message.includes('ENOENT') ? new Error('ffmpeg not found in PATH — install with: brew install ffmpeg') : e))
    ff.on('close', async (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`))
      const all = Buffer.concat(chunks)
      for (let off = 0; off + 2 <= all.length; off += CHUNK_BYTES) {
        const slice = all.subarray(off, Math.min(off + CHUNK_BYTES, all.length))
        const pcm = new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length - (slice.length % 2)))
        onChunk(pcm)
        await clock.sleep(100)
      }
      resolve()
    })
  })
}
```

- [ ] **Step 6: Implement `server.ts`**

```ts
// The live server: browser mic ↔ LiveSounding ↔ Gemini. `npm run live`.
//   npm run live -- [-i gemini|claude|recurrence] [--port 8787] [--from <audio>] [--fixture <name> --fake-transcriber] [--speed N] [--headless]
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { loadDotEnv } from '../cli/env'
import { FIXTURES } from '../replay/fixtures/index'
import { transcribeRecording } from '../providers/whisper-transcription'
import { stampName } from '../devserver/paths'
import { Clock } from './clock'
import { LiveSounding, type InterpreterName, type LiveMessage } from './live-sounding'
import { TranscribeLiveClient } from './transcribe-live'
import { FakeTranscriber } from './fake-transcriber'
import { streamFile } from './fake-mic'
import type { Transcriber } from './transcriber'
import type { FixtureScript } from '../replay/fixture'

interface Args { interpreter: InterpreterName; port: number; from?: string; fixture?: string; fakeTranscriber: boolean; speed: number; headless: boolean }

export function parseArgs(argv: string[]): Args {
  const a: Args = { interpreter: 'gemini', port: 8787, fakeTranscriber: false, speed: 1, headless: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i], next = argv[i + 1]
    if (v === '-i') { if (!['gemini', 'claude', 'recurrence'].includes(next)) throw new Error(`-i must be gemini|claude|recurrence`); a.interpreter = next as InterpreterName; i++ }
    else if (v === '--port') { a.port = Number(next); if (!Number.isInteger(a.port)) throw new Error('--port needs an integer'); i++ }
    else if (v === '--from') { if (!next) throw new Error('--from needs a path'); a.from = next; i++ }
    else if (v === '--fixture') { if (!next) throw new Error('--fixture needs a name'); a.fixture = next; i++ }
    else if (v === '--fake-transcriber') a.fakeTranscriber = true
    else if (v === '--speed') { a.speed = Number(next); if (!Number.isFinite(a.speed) || a.speed <= 0) throw new Error('--speed needs a positive number'); i++ }
    else if (v === '--headless') a.headless = true
    else throw new Error(`unknown argument ${v}`)
  }
  if (a.fakeTranscriber && !a.fixture && !a.from) throw new Error('--fake-transcriber needs --fixture <name> or --from <audio>')
  if (a.speed !== 1 && !a.fakeTranscriber) throw new Error('--speed is only valid with --fake-transcriber')
  return a
}

async function makeTranscriber(args: Args, clock: Clock): Promise<Transcriber> {
  if (args.fakeTranscriber) {
    let script: FixtureScript | undefined
    if (args.fixture) script = FIXTURES.find((f) => f.name === args.fixture)
    else if (args.from) script = await transcribeRecording(args.from, 'models/ggml-large-v3-turbo.bin')
    if (!script) throw new Error(`fixture not found: ${args.fixture}`)
    return new FakeTranscriber(script, clock)
  }
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set — get one at aistudio.google.com')
  return new TranscribeLiveClient(key)
}

async function runHeadless(args: Args): Promise<void> {
  const clock = new Clock(args.speed)
  const transcriber = await makeTranscriber(args, clock)
  const soundingId = `live-${stampName(new Date()).slice(4)}.${args.interpreter}`
  const live = new LiveSounding({ interpreterName: args.interpreter, transcriber, clock, send: () => {}, soundingId })
  await live.start()
  const script = args.fixture ? FIXTURES.find((f) => f.name === args.fixture) : undefined
  if (args.from) await streamFile(args.from, clock, (pcm) => live.pushAudio(pcm))
  else if (script) await clock.sleep(script.endT + 1500)
  const { logPath, summary } = await live.stop()
  console.log(summary)
  console.log(`wrote ${logPath}`)
}

function serve(args: Args): void {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: args.port })
  console.log(`live server listening on ws://localhost:${args.port} — interpreter ${args.interpreter}${args.from ? `, fake mic from ${args.from}` : ''}`)
  wss.on('connection', (ws: WsSocket) => {
    let live: LiveSounding | null = null
    let fakeMic: Promise<void> | null = null
    const send = (m: LiveMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
    const stop = async () => {
      if (!live) return
      const l = live; live = null
      try { const { logPath, summary } = await l.stop(); console.log(summary); console.log(`wrote ${logPath}`); send({ type: 'live.status', state: 'stopped', message: logPath }) }
      catch (e) { send({ type: 'live.status', state: 'error', message: e instanceof Error ? e.message : String(e) }) }
    }
    ws.on('message', async (data: Buffer, isBinary: boolean) => {
      if (isBinary) { live?.pushAudio(new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - (data.length % 2)))); return }
      let msg: { type?: string; interpreter?: string }
      try { msg = JSON.parse(data.toString('utf8')) } catch { return }
      if (msg.type === 'start' && !live) {
        const interpreter = (['gemini', 'claude', 'recurrence'].includes(msg.interpreter ?? '') ? msg.interpreter : args.interpreter) as InterpreterName
        const clock = new Clock(args.speed)
        try {
          const transcriber = await makeTranscriber({ ...args, interpreter }, clock)
          const soundingId = `live-${stampName(new Date()).slice(4)}.${interpreter}`
          live = new LiveSounding({ interpreterName: interpreter, transcriber, clock, send, soundingId })
          await live.start()
          if (args.from) fakeMic = streamFile(args.from, clock, (pcm) => live?.pushAudio(pcm)).then(stop)
        } catch (e) { send({ type: 'live.status', state: 'error', message: e instanceof Error ? e.message : String(e) }); live = null }
      } else if (msg.type === 'stop') await stop()
    })
    ws.on('close', () => void stop())
    void fakeMic
  })
}

const isDirectRun = process.argv[1]?.endsWith('server.ts')
if (isDirectRun) {
  loadDotEnv()
  let args: Args
  try { args = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2) }
  if (args.headless) runHeadless(args).then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
  else serve(args)
}
```

`stampName` returns `mic-YYYYMMDD-HHmmss`; `.slice(4)` drops the `mic-` prefix so live logs are `live-YYYYMMDD-HHmmss.<interp>.jsonl`.

- [ ] **Step 7: Run the headless test, typecheck, full suite**

Run: `npx vitest run tests/live-headless.test.ts && npx tsc --noEmit -p . && npm test`
Expected: PASS. The headless run takes a few seconds at speed 30 (the circling fixture is ~60 s of session time). If the pending count is low, check that `FakeTranscriber` emits interims only when the word count changes (it should) and that `Segmenter.onInterim` returns non-empty deltas.

Then a real-key smoke (only if `GEMINI_API_KEY` is in `.env` and `recordings/synthetic-memo.m4a` exists): `npm run live -- --from recordings/synthetic-memo.m4a -i recurrence --headless` — this uses the **real** Transcribe Live on the file's audio with the free interpreter. Expected: `wrote soundings/live-….recurrence.jsonl`, and `grep -c segment.committed` on it ≥ 5. Record the count and the run time in your report. Delete the produced log afterwards.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/live/live-sounding.ts src/live/fake-mic.ts src/live/server.ts tests/live-headless.test.ts
git commit -m "feat(live): live server — mic/fake-mic → Transcribe Live → session → event stream

One LiveSounding per browser connection; every SoundingEvent is forwarded
as JSON in log order; live.heard carries the words to flash; the log is
written on stop. Headless fixture mode with a fake transcriber and an
accelerated clock runs the whole path in tests without keys or audio.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

### Task 5: The live page

**Files:**
- Create: `src/ui/chart.ts` (extracted from `main.ts`), `live.html`, `src/ui/live.ts`, `src/ui/live.css`, `public/pcm-worklet.js`
- Modify: `src/ui/main.ts` (use `chart.ts`; no behavior change)

**Interfaces:**
- Consumes: wire protocol from Task 4 (`start`/`stop` JSON, binary PCM up; `LiveMessage` JSON down). `layoutReading` from `src/ui/layout.ts`.
- Produces: `createChart({ chart, inspector, slackEl }): { render(reading), recordTransitions(t, transitions), reset(), fmt(t) }`.

- [ ] **Step 1: Extract `src/ui/chart.ts` from `main.ts`**

Create `src/ui/chart.ts` containing, moved verbatim from `main.ts`: `fmt`, `recordTransitions` (over an internal `history` map), `renderReading`, `describe`, `renderInspector`, and the `selectedConceptId` state, wrapped as:

```ts
import { layoutReading } from './layout'
import type { Reading, Transition, Ms } from '../core/types'

export interface ChartView {
  render(reading: Reading): void
  recordTransitions(t: Ms, transitions: readonly Transition[]): void
  reset(): void
}

export function fmt(t: Ms): string {
  const s = Math.floor(t / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function createChart(els: { chart: SVGSVGElement; inspector: HTMLElement; slackEl: HTMLElement }): ChartView {
  const history = new Map<string, Array<{ t: Ms; transition: Transition }>>()
  let selectedConceptId: string | null = null
  // ... move renderReading / describe / renderInspector / recordTransitions here unchanged,
  // referencing els.chart / els.inspector / els.slackEl instead of module globals ...
  return {
    render: renderReading,
    recordTransitions,
    reset() { history.clear(); selectedConceptId = null; els.chart.innerHTML = ''; els.inspector.innerHTML = '<p>Click a mark to see its transition history.</p>'; els.slackEl.hidden = true },
  }
}
```

Then in `main.ts`: `const view = createChart({ chart, inspector, slackEl })`; replace every `renderReading(x)` with `view.render(x)`, every `recordTransitions(t, trs)` with `view.recordTransitions(t, trs)`, and in `reset()` replace the four lines that clear `history`, `selectedConceptId`, `inspector.innerHTML`, `chart.innerHTML`, `slackEl.hidden` with `view.reset()`. Delete the moved functions from `main.ts`. `fmt` is imported from `./chart`.

Run: `npx tsc --noEmit -p . && npm test` — clean. Then the replay-page regression check: `npm run dev`, open `/`, load `soundings/synthetic-memo.gemini.jsonl` via the file picker, speed instant, Drop → 7 marks, click one → inspector list. (Use the Playwright MCP tools; kill the dev server after.)

- [ ] **Step 2: The worklet — `public/pcm-worklet.js`**

```js
// Captures mic audio and posts 100ms Int16 PCM chunks at 16 kHz.
// If the AudioContext could not be created at 16 kHz, decimates linearly.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.target = 16000
    this.ratio = sampleRate / this.target
    this.acc = []          // float samples at target rate
    this.pos = 0           // fractional read position for decimation
  }
  process(inputs) {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    if (this.ratio === 1) { for (let i = 0; i < ch.length; i++) this.acc.push(ch[i]) }
    else {
      // linear interpolation from context rate down to 16k
      let p = this.pos
      while (p < ch.length - 1) { const i = Math.floor(p), f = p - i; this.acc.push(ch[i] * (1 - f) + ch[i + 1] * f); p += this.ratio }
      this.pos = p - ch.length
    }
    while (this.acc.length >= 1600) {
      const out = new Int16Array(1600)
      for (let i = 0; i < 1600; i++) { const s = Math.max(-1, Math.min(1, this.acc[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff }
      this.acc = this.acc.slice(1600)
      this.port.postMessage(out.buffer, [out.buffer])
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
```

- [ ] **Step 3: `live.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sounding — live</title>
    <link rel="stylesheet" href="/src/ui/style.css" />
    <link rel="stylesheet" href="/src/ui/live.css" />
  </head>
  <body>
    <header>
      <select id="live-interp" title="Interpreter">
        <option value="gemini">gemini</option>
        <option value="claude">claude</option>
        <option value="recurrence">recurrence</option>
      </select>
      <button id="listen">Listen</button>
      <span id="live-status"></span>
      <span id="clock">0:00</span>
      <span id="slack-indicator" hidden>slack</span>
      <span id="counters"></span>
    </header>
    <main>
      <div id="stage">
        <svg id="chart"></svg>
        <div id="heard"></div>
      </div>
      <aside id="inspector"><p>Click a mark to see its transition history.</p></aside>
    </main>
    <script type="module" src="/src/ui/live.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: `src/ui/live.css`**

```css
#stage { position: relative; flex: 1; min-width: 0; }
#stage #chart { width: 100%; height: 100%; display: block; }
#heard { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.heard-word {
  position: absolute; transform: translate(-50%, -50%) scale(1); opacity: 0.9;
  font-size: 48px; font-weight: 600; color: #17323d; white-space: nowrap;
  transition: transform 1.5s ease-out, opacity 1.5s ease-out;
}
.heard-word.fading { transform: translate(-50%, -50%) scale(0.25); opacity: 0; }
#live-status { min-width: 14ch; color: #3d5a6a; font-variant-numeric: tabular-nums; }
#live-status.listening { color: #c6472e; }
```

If `main` in `style.css` is a flex row with `#chart` flex-growing, mirror that on `#stage` so the layout matches the replay page; check `style.css` lines 1–12 and adjust minimally.

- [ ] **Step 5: `src/ui/live.ts`**

```ts
// The live page: mic → local live server → events → chart. Wall clock allowed here.
import { createChart, fmt } from './chart'
import { summarizeCounters } from '../replay/counters'
import type { SoundingEvent } from '../core/events'
import type { Ms } from '../core/types'

type LiveMessage = SoundingEvent | { type: 'live.heard'; t: Ms; words: string[] } | { type: 'live.status'; state: string; message?: string }

const interp = document.getElementById('live-interp') as HTMLSelectElement
const listenBtn = document.getElementById('listen') as HTMLButtonElement
const statusEl = document.getElementById('live-status')!
const clockEl = document.getElementById('clock')!
const countersEl = document.getElementById('counters')!
const heardEl = document.getElementById('heard')!
const view = createChart({
  chart: document.getElementById('chart') as unknown as SVGSVGElement,
  inspector: document.getElementById('inspector')!,
  slackEl: document.getElementById('slack-indicator')!,
})

const port = new URLSearchParams(location.search).get('port') ?? '8787'
let ws: WebSocket | null = null
let audio: { ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null = null
let events: SoundingEvent[] = []
let state: 'idle' | 'starting' | 'live' | 'stopping' = 'idle'

function setStatus(text: string, listening = false) { statusEl.textContent = text; statusEl.classList.toggle('listening', listening) }

function flashWords(words: string[]) {
  const { width, height } = heardEl.getBoundingClientRect()
  for (const w of words) {
    const el = document.createElement('span')
    el.className = 'heard-word'
    el.textContent = w
    el.style.left = `${15 + Math.random() * 70}%`
    el.style.top = `${15 + Math.random() * 70}%`
    heardEl.appendChild(el)
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('fading')))
    setTimeout(() => el.remove(), 1600)
  }
  void width; void height
}

function onMessage(m: LiveMessage) {
  if (m.type === 'live.heard') { flashWords(m.words); return }
  if (m.type === 'live.status') {
    if (m.state === 'error') setStatus(`error: ${m.message ?? ''}`)
    else if (m.state === 'stopped') { setStatus(`saved ${m.message ?? ''}`); void teardownAudio(); state = 'idle'; listenBtn.textContent = 'Listen'; listenBtn.disabled = false }
    else setStatus(m.state, m.state === 'listening')
    return
  }
  events.push(m)
  clockEl.textContent = fmt(m.t)
  if (m.type === 'reading.changed') { view.recordTransitions(m.t, m.transitions); view.render(m.reading) }
  if (m.type === 'candidates.emitted') { const c = summarizeCounters(events); countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms` }
}

async function setupAudio(socket: WebSocket) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  let ctx: AudioContext
  try { ctx = new AudioContext({ sampleRate: 16000 }) } catch { ctx = new AudioContext() }
  await ctx.audioWorklet.addModule('/pcm-worklet.js')
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 })
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => { if (socket.readyState === WebSocket.OPEN) socket.send(e.data) }
  src.connect(node)
  audio = { ctx, stream, node }
}

async function teardownAudio() {
  if (!audio) return
  audio.node.disconnect()
  audio.stream.getTracks().forEach((t) => t.stop())
  await audio.ctx.close()
  audio = null
}

async function start() {
  state = 'starting'; listenBtn.disabled = true; setStatus('connecting…')
  events = []; view.reset(); countersEl.textContent = ''; clockEl.textContent = '0:00'
  const socket = new WebSocket(`ws://localhost:${port}`)
  socket.binaryType = 'arraybuffer'
  socket.onerror = () => { setStatus(`error: cannot reach live server at ws://localhost:${port} — run: npm run live`); state = 'idle'; listenBtn.disabled = false }
  socket.onclose = () => { if (state === 'live') { setStatus('connection closed'); void teardownAudio(); state = 'idle'; listenBtn.textContent = 'Listen'; listenBtn.disabled = false } }
  socket.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data as string)) } catch (e) { console.error(e) } }
  socket.onopen = async () => {
    try {
      await setupAudio(socket)
    } catch (e) {
      setStatus(`error: ${e instanceof Error && e.name === 'NotAllowedError' ? 'microphone access denied' : (e instanceof Error ? e.message : String(e))}`)
      socket.close(); state = 'idle'; listenBtn.disabled = false; return
    }
    socket.send(JSON.stringify({ type: 'start', interpreter: interp.value }))
    ws = socket; state = 'live'; listenBtn.textContent = 'Stop'; listenBtn.disabled = false; interp.disabled = true
  }
}

async function stop() {
  if (!ws) return
  state = 'stopping'; listenBtn.disabled = true; setStatus('stopping…')
  await teardownAudio()
  ws.send(JSON.stringify({ type: 'stop' }))
  interp.disabled = false
  // 'stopped' status from the server flips the button back
}

listenBtn.addEventListener('click', () => { if (state === 'idle') void start(); else if (state === 'live') void stop() })
```

- [ ] **Step 6: Typecheck, tests, and the live browser check**

Run: `npx tsc --noEmit -p . && npm test` — clean.

Browser check A (no key, no mic, deterministic): in one shell `npm run live -- --fixture circling --fake-transcriber -i recurrence`; in another `npm run dev`. With Playwright: open `http://localhost:5173/live.html`, select `recurrence`, click Listen. Chrome will prompt for the mic; Playwright's default context auto-grants when launched with `--use-fake-ui-for-media-stream`; if the prompt blocks, use `browser_evaluate` to stub `navigator.mediaDevices.getUserMedia` to return a silent `MediaStream` from `new AudioContext().createMediaStreamDestination().stream`. Expected within 10 s: status reads `listening`, heard words flash (snapshot shows `.heard-word` spans appearing then disappearing), the clock advances, marks appear on the chart (the circling fixture surfaces "sister"). Click Stop → status `saved soundings/live-….recurrence.jsonl`, the file exists. Delete it afterwards.

Browser check B (real, needs a human): leave to the controller — `npm run live` (gemini) + `npm run dev`, talk for a minute.

Kill both servers. Remove `.playwright-mcp/`.

- [ ] **Step 7: Commit**

```bash
git add src/ui/chart.ts src/ui/main.ts live.html src/ui/live.ts src/ui/live.css public/pcm-worklet.js
git commit -m "feat(ui): live page — mic worklet → live server → heard words + reading

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

## Self-review

- **Spec coverage:** tuning (T1); segmenter with time-based cut, ring buffer, heard words (T2); Transcribe Live client with reconnect, fake transcriber, clock (T3); server, wire protocol = event log, fake mic, headless test, log persistence, no audio on disk, `.env` in the server only (T4); live page, worklet, heard-word animation, shared chart, error statuses (T5). `voiceActivity` messages are received and ignored (T3 client), which the spec permits.
- **Placeholders:** none. The `chart.ts` extraction says "moved verbatim" and names each function; the implementer has `main.ts` in front of them.
- **Type consistency:** `LiveSegment {segmentId, transcript, startT, endT}` matches `feedCommitted`'s parameter; `Transcriber` callbacks are the same in T3 and T4; `LiveMessage` is defined in T4 and re-declared structurally in T5's `live.ts` (no import across the browser/node boundary is needed); `createChart` returns `{render, recordTransitions, reset}` used identically in `main.ts` and `live.ts`; `stampName` (from slice mic-record) is `mic-YYYYMMDD-HHmmss`, sliced to build `live-…`.

# Sounding Slice 2 Implementation Plan — Model Interpretation, Both Paths, A/B on Recordings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real voice memo runs through the full pipeline via `npm run cast` under three interpreters (recurrence / Claude extraction / Gemini audio-native), producing persisted event logs, real cost counters, a side-by-side A/B report, and a UI that replays saved logs — with the synonym-drift fixture collapsing to exactly one mark under the new embedding resolver.

**Architecture:** The pure engine (`src/core`, `src/salience`, `src/interpret`, `src/replay`) stays wall-clock-free; a new `src/providers/` layer holds all I/O (whisper.cpp transcription, Claude SDK, Gemini REST, ffmpeg slicing, local embeddings) and a new `src/cli/` layer holds `cast` and `compare`. Segmentation is transcription-driven in both interpretation paths, so A/B runs on identical capture events. Spec: `docs/superpowers/specs/2026-08-28-sounding-slice2-design.md`.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Vite. New runtime deps: `@anthropic-ai/sdk`, `@huggingface/transformers`. New dev dep: `tsx`. External binaries: `whisper-cli`, `ffmpeg` (both already installed via Homebrew).

## Global Constraints

- **Purity boundary:** the wall-clock/randomness guard (`Date.now|performance.now|new Date(|Math.random`) applies to `src/core`, `src/salience`, `src/interpret`, `src/replay` ONLY. `src/providers`, `src/cli`, `src/ui` are exempt (they are the I/O layer).
- **Anthropic calls use the official `@anthropic-ai/sdk`**, model string exactly `claude-opus-5`, structured outputs via `output_config.format` (json_schema), system prompt marked `cache_control: {type: "ephemeral"}`. Zero-arg client constructor (resolves the `ant` login profile or `ANTHROPIC_API_KEY`). Check `stop_reason === "refusal"` before reading content.
- **Gemini and whisper.cpp via plain `fetch`/`child_process`** — no additional SDK dependencies. Provider pricing constants live in `src/providers/pricing.ts`, marked UPDATE-ME where post-cutoff verification is required.
- **No keys in the browser.** The UI consumes saved logs only; model calls happen only in the CLI.
- **`recordings/`, `soundings/`, `models/` are gitignored** (real thinking-out-loud is private by default; opt files in deliberately).
- **`similarityThreshold` joins `SalienceConfig`** (default `0.6`), tuned by the acceptance pair: synonym-drift → exactly 1 mark AND contention → no false merges.
- **Determinism:** unchanged for the pure engine and token-resolver runs. Embedding-resolver replay is deterministic within a machine; cross-machine byte-identity is explicitly relaxed (spec).
- Nautical vocabulary continues. Commit at the end of every task with the message given.
- Slice-1 suites must stay green after every task (`npm test`).

## File Structure

```
src/core/session.ts        MODIFIED: op-queue serialization, audioSource, interpreter.input dispatch
src/core/events.ts         MODIFIED: fromJsonl schema validation
src/salience/identity.ts   MODIFIED: async resolve; exported normalizeLabel
src/salience/dynamics.ts   MODIFIED: async applyCandidates; nudge token-overlap
src/salience/config.ts     MODIFIED: + similarityThreshold
src/interpret/port.ts      MODIFIED: Interpreter.input; AudioSegment → encoded bytes
src/interpret/recurrence.ts MODIFIED: + input: 'transcript'
src/replay/runner.ts       MODIFIED: await pending/advance; createReplay options
src/providers/embeddings.ts           local MiniLM embed + dot
src/providers/embedding-identity.ts   EmbeddingIdentityResolver
src/providers/whisper-transcription.ts whisper-cli → FixtureScript
src/providers/audio-slicer.ts         ffmpeg window → AudioSegment
src/providers/pricing.ts              pricing constants + llmCost
src/providers/candidates.ts           shared candidate mapping/clamping
src/providers/claude-extraction.ts    Interpreter (transcript)
src/providers/gemini-audio.ts         Interpreter (audio)
src/cli/cast.ts            recording → soundings/<name>.<interp>.jsonl
src/cli/compare.ts         two logs → side-by-side report
src/ui/main.ts             MODIFIED: load-sounding-log playback mode
index.html                 MODIFIED: log file input
tests/…                    one test file per task (paths in each task)
```

---

### Task 1: Async identity resolver

**Files:**
- Modify: `src/salience/identity.ts`, `src/salience/dynamics.ts`, `src/core/session.ts`
- Modify (mechanical awaits): `tests/identity.test.ts`, `tests/dynamics.test.ts`, `tests/hysteresis.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact signatures):
  - `IdentityResolver.resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null>`
  - `ReadingDynamics.applyCandidates(t: Ms, candidates: ConceptCandidate[]): Promise<void>`
  - `export function normalizeLabel(label: string): string` from `src/salience/identity.ts`
- `nudge` and `tick` stay synchronous.

- [ ] **Step 1: Update the interface and implementation**

`src/salience/identity.ts` — full new content:

```ts
import { normalizeToken } from '../core/text'
import type { Concept, ConceptCandidate } from '../core/types'

/**
 * Candidate → existing-concept-or-new. Swappable: the embedding-similarity
 * resolver implements this same interface. resolve is async because
 * embedding computation is; the token resolver resolves immediately.
 */
export interface IdentityResolver {
  resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null>
}

export function normalizeLabel(label: string): string {
  return label.split(' ').map(normalizeToken).join(' ')
}

export class TokenIdentityResolver implements IdentityResolver {
  async resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null> {
    const key = normalizeLabel(candidate.label)
    for (const c of concepts) {
      if (normalizeLabel(c.label) === key) return c.id
    }
    return null
  }
}
```

- [ ] **Step 2: Make applyCandidates async**

In `src/salience/dynamics.ts`, change the signature and the resolver call (rest of the method body unchanged):

```ts
  async applyCandidates(t: Ms, candidates: ConceptCandidate[]): Promise<void> {
    this.decayTo(t)
    this.lastSpeechT = t
    for (const cand of candidates) {
      const support = cand.strength * cand.confidence
      const existingId = await this.resolver.resolve(cand, [...this.concepts.values()])
      // ... unchanged from here
```

In `src/core/session.ts` `feedCommitted`, the final line becomes:

```ts
    await this.dynamics.applyCandidates(t, result.candidates)
```

- [ ] **Step 3: Propagate awaits in tests (mechanical)**

Every call site of `resolver.resolve(...)` and `d.applyCandidates(...)` in `tests/identity.test.ts`, `tests/dynamics.test.ts`, `tests/hysteresis.test.ts` gains `await`, and its enclosing `it(...)` callback becomes `async`. Example (identity):

```ts
  it('matches identical normalized labels', async () => {
    expect(await resolver.resolve(candidate('sister'), [concept('c1', 'sister')])).toBe('c1')
  })
```

The `makeFull()` helper in `tests/hysteresis.test.ts` becomes `async function makeFull()` and its callers `await makeFull()`. No assertion values change anywhere.

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck`
Expected: all suites pass (typecheck errors are the guide to any missed await).

- [ ] **Step 5: Commit**

```bash
git add src/salience/identity.ts src/salience/dynamics.ts src/core/session.ts tests/identity.test.ts tests/dynamics.test.ts tests/hysteresis.test.ts
git commit -m "refactor: async identity resolution (prepares embedding resolver)"
```

---

### Task 2: Port evolution + guard narrowing

**Files:**
- Modify: `src/interpret/port.ts`, `src/interpret/recurrence.ts`, `tests/recurrence.test.ts`, `tests/fixtures-drift-determinism.test.ts`

**Interfaces:**
- Produces (exact shapes consumed by Tasks 3, 4, 12, 13, 14):

```ts
export interface AudioSegment {
  kind: 'audio'
  segmentId: string
  mimeType: string      // e.g. 'audio/mpeg'
  data: Uint8Array      // encoded bytes of the audio window
  startT: Ms
  endT: Ms
}

export interface Interpreter {
  readonly id: string
  readonly input: 'transcript' | 'audio'
  interpret(input: InterpreterInput): Promise<InterpretationResult>
}
```

- [ ] **Step 1: Update the port**

In `src/interpret/port.ts`: replace the old `AudioSegment` (PCM `samples`/`sampleRate` — a never-consumed placeholder) with the encoded-bytes shape above, and add `readonly input: 'transcript' | 'audio'` to `Interpreter`. `Transcript`, `InterpreterInput`, `InterpretationResult` unchanged. Keep the existing comment explaining why the union must not collapse.

- [ ] **Step 2: Update the recurrence interpreter and its test**

`src/interpret/recurrence.ts` — add one line inside the class:

```ts
  readonly input = 'transcript' as const
```

`tests/recurrence.test.ts` — the audio-rejection test's audio literal becomes:

```ts
    const audio = { kind: 'audio' as const, segmentId: 'a1', mimeType: 'audio/mpeg', data: new Uint8Array(0), startT: 0, endT: 0 }
```

- [ ] **Step 3: Narrow the wall-clock guard**

In `tests/fixtures-drift-determinism.test.ts`, replace the guard test's walk entry point:

```ts
  it('the engine never reads wall clock or randomness', () => {
    const banned = /Date\.now|performance\.now|new Date\(|Math\.random/
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts') && banned.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
    // Pure engine only. src/providers, src/cli, src/ui are the I/O layer and exempt.
    for (const dir of ['src/core', 'src/salience', 'src/interpret', 'src/replay']) walk(dir)
    expect(offenders).toEqual([])
  })
```

- [ ] **Step 4: Run the suite**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/interpret/port.ts src/interpret/recurrence.ts tests/recurrence.test.ts tests/fixtures-drift-determinism.test.ts
git commit -m "feat: interpreter input kind, encoded AudioSegment, guard narrowed to pure engine"
```

---

### Task 3: Session operation queue (serialization)

**Files:**
- Modify: `src/core/session.ts`, `src/replay/runner.ts`
- Test: `tests/session-serialization.test.ts` (new); Modify: `tests/session.test.ts`

**Interfaces:**
- Produces: `SoundingSession.advanceTo/feedPending/feedCommitted/surface` all return `Promise<void>` and are serialized through one internal queue. `drop()` stays sync. Constructor signature unchanged in this task.

- [ ] **Step 1: Write the failing test**

`tests/session-serialization.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../src/interpret/port'

/** Interpreter whose first call blocks until released — to provoke interleaving. */
class GatedInterpreter implements Interpreter {
  readonly id = 'gated'
  readonly input = 'transcript' as const
  private calls = 0
  release!: () => void
  private gate = new Promise<void>((res) => (this.release = res))
  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    this.calls += 1
    if (this.calls === 1) await this.gate
    if (input.kind !== 'transcript') throw new Error('transcript only')
    return {
      candidates: [{ label: input.text, strength: 1, confidence: 1, source: this.id, segmentId: input.segmentId }],
      costUsd: 0,
      latencyMs: 0,
    }
  }
}

function makeSession(interpreter: Interpreter) {
  const config = DEFAULT_SALIENCE_CONFIG
  const dynamics = new ReadingDynamics(new TokenIdentityResolver(), config)
  return new SoundingSession(interpreter, dynamics, config, 'serial-test')
}

describe('session operation queue', () => {
  it('unawaited overlapping calls still produce a correctly ordered log', async () => {
    const interp = new GatedInterpreter()
    const s = makeSession(interp)
    s.drop()
    const first = s.feedCommitted(4000, { segmentId: 'seg1', transcript: 'alpha', startT: 0, endT: 4000 })
    const pending = s.feedPending(4200, 'beta incoming')
    const second = s.feedCommitted(8000, { segmentId: 'seg2', transcript: 'beta', startT: 4000, endT: 8000 })
    interp.release()
    await Promise.all([first, pending, second])
    const types = s.log.all().map((e) => `${e.type}@${e.t}`)
    const idx = (needle: string) => types.findIndex((x) => x.startsWith(needle))
    // seg1's candidates land before anything at a later timestamp
    expect(idx('candidates.emitted@4000')).toBeGreaterThan(idx('segment.committed@4000'))
    expect(idx('segment.pending@4200')).toBeGreaterThan(idx('candidates.emitted@4000'))
    expect(idx('candidates.emitted@8000')).toBeGreaterThan(idx('segment.pending@4200'))
    // and the log is timestamp-monotonic (append would have thrown otherwise)
    const ts = s.log.all().map((e) => e.t)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
  })

  it('an interpreter error does not wedge the queue', async () => {
    const failing: Interpreter = {
      id: 'boom',
      input: 'transcript',
      interpret: async () => {
        throw new Error('boom')
      },
    }
    const s = makeSession(failing)
    s.drop()
    await expect(s.feedCommitted(4000, { segmentId: 'seg1', transcript: 'x', startT: 0, endT: 4000 })).rejects.toThrow('boom')
    await s.advanceTo(5000) // queue still alive
    expect(s.log.all().some((e) => e.type === 'reading.changed')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/session-serialization.test.ts`
Expected: FAIL — without the queue, the pending event at t=4200 is appended while seg1's interpretation is gated, then seg1's `candidates.emitted@4000` violates monotonicity (append throws) or ordering assertions fail.

- [ ] **Step 3: Implement the queue**

`src/core/session.ts` — full new content:

```ts
import { EventLog } from './events'
import type { Ms } from './types'
import type { AudioSegment, Interpreter, InterpreterInput } from '../interpret/port'
import type { ReadingDynamics } from '../salience/dynamics'
import type { SalienceConfig } from '../salience/config'

export type AudioSource = (seg: { segmentId: string; startT: Ms; endT: Ms }) => Promise<AudioSegment>

/**
 * One sounding, from drop to surface. All time-advancing operations pass
 * through a single internal queue: interpretation is async, and interleaved
 * calls must not corrupt segment↔candidates pairing or log monotonicity.
 * Time only moves via the timestamps callers hand in — replay and live mode
 * are indistinguishable from here down.
 */
export class SoundingSession {
  readonly log = new EventLog()
  private lastTick: Ms = 0
  private opQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly interpreter: Interpreter,
    private readonly dynamics: ReadingDynamics,
    private readonly config: SalienceConfig,
    private readonly soundingId: string,
    private readonly audioSource?: AudioSource,
  ) {}

  private enqueue<T>(op: () => T | Promise<T>): Promise<T> {
    const run = this.opQueue.then(op)
    // keep the chain alive whether op succeeds or fails; the caller still
    // sees the rejection through `run`
    this.opQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  drop(): void {
    this.log.append({ type: 'sounding.dropped', t: 0, soundingId: this.soundingId })
  }

  advanceTo(t: Ms): Promise<void> {
    return this.enqueue(() => this.advanceNow(t))
  }

  feedPending(t: Ms, text: string): Promise<void> {
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'segment.pending', t, text })
      this.dynamics.nudge(t, text)
    })
  }

  feedCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void> {
    return this.enqueue(() => this.processCommitted(t, seg))
  }

  surface(t: Ms): Promise<void> {
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'sounding.surfaced', t })
    })
  }

  private async processCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void> {
    this.advanceNow(t)
    this.log.append({ type: 'segment.committed', t, ...seg })
    const input = await this.buildInput(seg)
    const result = await this.interpreter.interpret(input)
    this.log.append({
      type: 'candidates.emitted',
      t,
      segmentId: seg.segmentId,
      source: this.interpreter.id,
      candidates: result.candidates,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    })
    await this.dynamics.applyCandidates(t, result.candidates)
  }

  private async buildInput(seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<InterpreterInput> {
    if (this.interpreter.input === 'audio') {
      if (!this.audioSource) {
        throw new Error(`interpreter ${this.interpreter.id} needs audio input but the session has no audioSource`)
      }
      return this.audioSource({ segmentId: seg.segmentId, startT: seg.startT, endT: seg.endT })
    }
    return { kind: 'transcript', segmentId: seg.segmentId, text: seg.transcript, startT: seg.startT, endT: seg.endT }
  }

  private advanceNow(t: Ms): void {
    while (this.lastTick + this.config.tickMs <= t) {
      this.lastTick += this.config.tickMs
      const { transitions, reading } = this.dynamics.tick(this.lastTick)
      this.log.append({ type: 'reading.changed', t: this.lastTick, transitions, reading })
    }
  }
}
```

(Note: `buildInput`/`audioSource` are included here because they are part of the same file rewrite; their dedicated test lands in Task 4.)

- [ ] **Step 4: Await the new promises in the runner and existing tests**

`src/replay/runner.ts` — in `ReplayRunner.advanceTo`, the pending branch and the trailing advance gain `await`:

```ts
      if (e.type === 'segment.pending') {
        await this.session.feedPending(e.t, e.text)
      } else {
        await this.session.feedCommitted(e.t, { segmentId: e.segmentId, transcript: e.transcript, startT: e.startT, endT: e.endT })
      }
    }
    await this.session.advanceTo(target)
```

and `runToEnd` awaits surface: `await this.session.surface(this.endT)`.

`tests/session.test.ts` — `s.advanceTo(...)`, `s.feedPending(...)`, `s.surface(...)` calls gain `await` and enclosing `it()`s become async (the assertions are unchanged; typecheck flags each site). `src/ui/main.ts` needs no change (its `runToEnd`/`advanceTo` calls are already awaited).

- [ ] **Step 5: Run the suite**

Run: `npx vitest run tests/session-serialization.test.ts && npm test && npm run typecheck`
Expected: new tests pass; all slice-1 suites stay green.

- [ ] **Step 6: Commit**

```bash
git add src/core/session.ts src/replay/runner.ts tests/session-serialization.test.ts tests/session.test.ts
git commit -m "feat: serialize session operations through an internal queue; audioSource plumbing"
```

---

### Task 4: audioSource dispatch test

**Files:**
- Test: `tests/session-audio.test.ts` (new; implementation already landed in Task 3's session rewrite)

**Interfaces:**
- Consumes: `AudioSource` type and `SoundingSession` 5th constructor arg (Task 3); `AudioSegment` (Task 2).

- [ ] **Step 1: Write the tests**

`tests/session-audio.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { AudioSegment, Interpreter, InterpreterInput, InterpretationResult } from '../src/interpret/port'

class RecordingAudioInterpreter implements Interpreter {
  readonly id = 'audio-recorder'
  readonly input = 'audio' as const
  received: InterpreterInput[] = []
  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    this.received.push(input)
    return { candidates: [], costUsd: 0, latencyMs: 0 }
  }
}

const seg = { segmentId: 'seg1', transcript: 'hello there', startT: 0, endT: 4000 }

function make(interpreter: Interpreter, audioSource?: ConstructorParameters<typeof SoundingSession>[4]) {
  const config = DEFAULT_SALIENCE_CONFIG
  const dynamics = new ReadingDynamics(new TokenIdentityResolver(), config)
  const s = new SoundingSession(interpreter, dynamics, config, 'audio-test', audioSource)
  s.drop()
  return s
}

describe('audioSource dispatch', () => {
  it('hands an audio interpreter the AudioSegment from audioSource', async () => {
    const interp = new RecordingAudioInterpreter()
    const window: AudioSegment = { kind: 'audio', segmentId: 'seg1', mimeType: 'audio/mpeg', data: new Uint8Array([1, 2, 3]), startT: 0, endT: 4000 }
    const s = make(interp, async (req) => {
      expect(req).toEqual({ segmentId: 'seg1', startT: 0, endT: 4000 })
      return window
    })
    await s.feedCommitted(4000, seg)
    expect(interp.received).toEqual([window])
  })

  it('throws a clear error when an audio interpreter has no audioSource', async () => {
    const s = make(new RecordingAudioInterpreter())
    await expect(s.feedCommitted(4000, seg)).rejects.toThrow(/no audioSource/)
  })
})
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/session-audio.test.ts && npm test`
Expected: PASS (implementation exists from Task 3); full suite green.

- [ ] **Step 3: Commit**

```bash
git add tests/session-audio.test.ts
git commit -m "test: audioSource dispatch for audio-input interpreters"
```

---

### Task 5: Nudge token-overlap unification

**Files:**
- Modify: `src/salience/dynamics.ts` (nudge body only)
- Test: add cases to `tests/hysteresis.test.ts`

**Interfaces:** no signature changes.

- [ ] **Step 1: Write the failing tests** (append to the `fast-loop nudges` describe in `tests/hysteresis.test.ts`)

```ts
  it('nudges a natural-language label on any content-token overlap', async () => {
    const d = new ReadingDynamics(new TokenIdentityResolver(), CFG)
    await d.applyCandidates(1000, [cand("her sister's judgment", 1), cand('beta', 0.4)])
    d.tick(1100)
    d.nudge(1200, 'thinking about my sister again')
    const res = d.tick(1300)
    expect(res.transitions).toContainEqual(
      expect.objectContaining({ kind: 'nudged', delta: CFG.nudgeFactor }),
    )
  })

  it('does not nudge on stopword-only overlap', async () => {
    const d = new ReadingDynamics(new TokenIdentityResolver(), CFG)
    await d.applyCandidates(1000, [cand('the big decision', 1), cand('beta', 0.4)])
    d.tick(1100)
    d.nudge(1200, 'the and of about')
    const res = d.tick(1300)
    expect(res.transitions.filter((tr) => tr.kind === 'nudged')).toEqual([])
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/hysteresis.test.ts`
Expected: first new test FAILS — the slice-1 rule requires *every* label token (raw-split, unnormalized) in the pending set; "sister's" ≠ "sister".

- [ ] **Step 3: Implement**

In `src/salience/dynamics.ts`, `nudge` body — replace the label-matching block:

```ts
  nudge(t: Ms, pendingText: string): void {
    this.decayTo(t)
    this.lastSpeechT = t
    const pendingTokens = new Set(tokenize(pendingText))
    for (const id of this.surfaced) {
      const c = this.concepts.get(id)!
      // Fast-loop identity shares the slow loop's normalization: tokenize the
      // label (normalization + stopword removal) and fire on ANY overlap, so
      // natural-language labels from model interpreters keep the fast loop alive.
      const labelTokens = tokenize(c.label)
      if (labelTokens.length > 0 && labelTokens.some((tok) => pendingTokens.has(tok))) {
        c.weight += this.config.nudgeFactor
        this.pendingTransitions.push({ kind: 'nudged', conceptId: id, delta: this.config.nudgeFactor })
      }
    }
  }
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/hysteresis.test.ts && npm test`
Expected: all pass (slice-1 nudge tests used single-token labels — unaffected by loosening).

- [ ] **Step 5: Commit**

```bash
git add src/salience/dynamics.ts tests/hysteresis.test.ts
git commit -m "feat: nudge identity unified with shared tokenization (any-overlap)"
```

---

### Task 6: Bounded displacement latency

**Files:**
- Modify: `tests/fixtures-shift-contention.test.ts` (and possibly `src/replay/fixtures/topic-shift.ts` configOverrides)

- [ ] **Step 1: Add the assertion**

In the `topic-shift fixture` describe:

```ts
  it('displacement begins within a bounded interval after the shift', async () => {
    const { readings } = await run(topicShift)
    const shiftAt = topicShift.truth.topicShiftAt!
    const firstDisplacement = readings.find(
      (r) => r.t >= shiftAt && r.transitions.some((tr) => tr.kind === 'displaced'),
    )
    expect(firstDisplacement).toBeDefined()
    expect(firstDisplacement!.t - shiftAt).toBeLessThanOrEqual(30_000)
  })
```

- [ ] **Step 2: Run and, if needed, tune**

Run: `npx vitest run tests/fixtures-shift-contention.test.ts`

If the bound FAILS: diagnose from the log (print the first displaced transition's t with a scratch script — do not guess). The fix is **fixture-local tuning**, not a global default change: adjust `topic-shift.ts`'s `configOverrides` (e.g. `hysteresisMargin: 0.10` and/or `halfLifeMs: 30_000` alongside the existing `capacity: 4`) until the bound holds AND the existing topic-shift assertions (zero pre-shift displacements, ≥2 post-shift, ≥2 phase-2 final marks) all still pass. Do NOT relax the 30s bound; do NOT change `DEFAULT_SALIENCE_CONFIG` (a global tuning pass belongs to real-recording work, not this task). Document what you changed and the measured first-displacement latency in the commit message.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures-shift-contention.test.ts src/replay/fixtures/topic-shift.ts
git commit -m "test: bounded displacement latency (<=30s post-shift) on topic-shift"
```

---

### Task 7: JSONL schema validation in fromJsonl

**Files:**
- Modify: `src/core/events.ts`
- Test: add a describe to `tests/events.test.ts`

**Interfaces:**
- Produces: `EventLog.fromJsonl(jsonl: string): EventLog` now throws `Error` with `line N:` prefixes on malformed input. Success path unchanged.

- [ ] **Step 1: Write the failing tests** (append to `tests/events.test.ts`)

```ts
describe('fromJsonl validation', () => {
  const good = '{"type":"sounding.dropped","t":0,"soundingId":"s1"}'

  it('still round-trips valid logs', () => {
    expect(EventLog.fromJsonl(good).toJsonl()).toBe(good)
  })

  it('rejects invalid JSON with a line number', () => {
    expect(() => EventLog.fromJsonl(`${good}\nnot json`)).toThrow(/line 2: invalid JSON/)
  })

  it('rejects unknown event types', () => {
    expect(() => EventLog.fromJsonl('{"type":"mystery.event","t":0}')).toThrow(/line 1: unknown event type/)
  })

  it('rejects a missing or non-numeric t', () => {
    expect(() => EventLog.fromJsonl('{"type":"sounding.surfaced","t":"soon"}')).toThrow(/line 1: .*t/)
  })

  it('rejects missing required fields', () => {
    expect(() => EventLog.fromJsonl('{"type":"segment.committed","t":100,"segmentId":"s"}')).toThrow(/line 1: .*transcript/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/events.test.ts`
Expected: new tests FAIL (current fromJsonl blindly casts).

- [ ] **Step 3: Implement**

In `src/core/events.ts`, replace `fromJsonl`:

```ts
  private static readonly REQUIRED_FIELDS: Record<SoundingEvent['type'], string[]> = {
    'sounding.dropped': ['soundingId'],
    'segment.pending': ['text'],
    'segment.committed': ['segmentId', 'transcript', 'startT', 'endT'],
    'candidates.emitted': ['segmentId', 'source', 'candidates', 'costUsd', 'latencyMs'],
    'reading.changed': ['transitions', 'reading'],
    'sounding.surfaced': [],
  }

  static fromJsonl(jsonl: string): EventLog {
    const log = new EventLog()
    const lines = jsonl.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      const where = `line ${i + 1}`
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error(`${where}: invalid JSON`)
      }
      if (typeof parsed !== 'object' || parsed === null) throw new Error(`${where}: not an object`)
      const e = parsed as Record<string, unknown>
      const required = EventLog.REQUIRED_FIELDS[e.type as SoundingEvent['type']]
      if (required === undefined) throw new Error(`${where}: unknown event type ${JSON.stringify(e.type)}`)
      if (typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t < 0) throw new Error(`${where}: missing or invalid t`)
      for (const field of required) {
        if (!(field in e)) throw new Error(`${where}: missing required field ${field}`)
      }
      log.append(parsed as SoundingEvent)
    }
    return log
  }
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/events.test.ts && npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/core/events.ts tests/events.test.ts
git commit -m "feat: schema-validate fromJsonl (event logs now load untrusted disk input)"
```

---

### Task 8: createReplay resolver option + similarityThreshold config

**Files:**
- Modify: `src/replay/runner.ts`, `src/salience/config.ts`
- Test: add to `tests/replay.test.ts`

**Interfaces:**
- Produces: `createReplay(script: FixtureScript, opts?: { resolver?: IdentityResolver })` — default remains `TokenIdentityResolver`. `SalienceConfig` gains `similarityThreshold: number` (default `0.6`).

- [ ] **Step 1: Write the failing test** (append to `tests/replay.test.ts`)

```ts
import { TokenIdentityResolver } from '../src/salience/identity'
import type { Concept, ConceptCandidate } from '../src/core/types'

describe('createReplay options', () => {
  it('uses an injected resolver', async () => {
    const calls: string[] = []
    const spy = new (class extends TokenIdentityResolver {
      override async resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null> {
        calls.push(candidate.label)
        return super.resolve(candidate, concepts)
      }
    })()
    const { runner } = createReplay(tiny, { resolver: spy })
    await runner.runToEnd()
    expect(calls.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/replay.test.ts` → typecheck/arity failure on the second argument.

- [ ] **Step 3: Implement**

`src/salience/config.ts`: add to the interface `similarityThreshold: number // embedding resolver: min cosine similarity to merge a candidate into an existing concept` and to defaults `similarityThreshold: 0.6,`.

`src/replay/runner.ts` — createReplay becomes:

```ts
export interface CreateReplayOptions {
  resolver?: IdentityResolver
}

export function createReplay(script: FixtureScript, opts: CreateReplayOptions = {}): { session: SoundingSession; runner: ReplayRunner } {
  const config = { ...DEFAULT_SALIENCE_CONFIG, ...script.configOverrides }
  const dynamics = new ReadingDynamics(opts.resolver ?? new TokenIdentityResolver(), config)
  const session = new SoundingSession(new RecurrenceInterpreter(), dynamics, config, script.name)
  session.drop()
  const runner = new ReplayRunner(session, buildCaptureEvents(script), script.endT)
  return { session, runner }
}
```

(add `import type { IdentityResolver } from '../salience/identity'`).

- [ ] **Step 4: Run** — `npx vitest run tests/replay.test.ts && npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add src/replay/runner.ts src/salience/config.ts tests/replay.test.ts
git commit -m "feat: injectable resolver in createReplay; similarityThreshold config"
```

---

### Task 9: Local embeddings + EmbeddingIdentityResolver

**Files:**
- Create: `src/providers/embeddings.ts`, `src/providers/embedding-identity.ts`
- Test: `tests/embedding-identity.test.ts`
- Modify: `package.json` (dependency)

**Interfaces:**
- Produces:
  - `embed(text: string): Promise<Float32Array>` (L2-normalized, memoized per string)
  - `dot(a: Float32Array, b: Float32Array): number`
  - `class EmbeddingIdentityResolver implements IdentityResolver { constructor(threshold: number) }`

- [ ] **Step 1: Install the dependency**

Run: `npm install @huggingface/transformers`
Expected: installs cleanly (runtime dependency — the pure engine never imports it; only providers do).

- [ ] **Step 2: Write the failing tests**

`tests/embedding-identity.test.ts` (first test downloads ~25MB model to the local HF cache on first run — deliberate per spec; generous timeouts):

```ts
import { describe, it, expect } from 'vitest'
import { embed, dot } from '../src/providers/embeddings'
import { EmbeddingIdentityResolver } from '../src/providers/embedding-identity'
import type { Concept, ConceptCandidate } from '../src/core/types'

function concept(id: string, label: string): Concept {
  return { id, label, weight: 1, confidence: 1, firstSeenT: 0, lastSupportT: 0 }
}
function candidate(label: string): ConceptCandidate {
  return { label, strength: 1, confidence: 1, source: 'test', segmentId: 's1' }
}

describe('embeddings', () => {
  it('is deterministic and normalized', { timeout: 180_000 }, async () => {
    const a = await embed('grief')
    const b = await embed('grief')
    expect(a).toEqual(b)
    expect(dot(a, a)).toBeCloseTo(1, 3)
  })

  it('ranks related words above unrelated ones', { timeout: 60_000 }, async () => {
    const grief = await embed('grief')
    const mourning = await embed('mourning')
    const rent = await embed('rent')
    expect(dot(grief, mourning)).toBeGreaterThan(dot(grief, rent))
  })
})

describe('EmbeddingIdentityResolver', () => {
  const resolver = new EmbeddingIdentityResolver(0.6)

  it('merges close synonyms', { timeout: 60_000 }, async () => {
    expect(await resolver.resolve(candidate('mourning'), [concept('c1', 'grief')])).toBe('c1')
  })

  it('keeps unrelated concepts separate', { timeout: 60_000 }, async () => {
    expect(await resolver.resolve(candidate('car'), [concept('c1', 'rent')])).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run tests/embedding-identity.test.ts` → cannot resolve modules.

- [ ] **Step 4: Implement**

`src/providers/embeddings.ts`:

```ts
// Local sentence embeddings. Provider layer: allowed to touch network
// (one-time model download to the HF cache) and filesystem.
import { pipeline } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | null = null
const cache = new Map<string, Float32Array>()

function getExtractor() {
  extractorPromise ??= pipeline('feature-extraction', MODEL_ID)
  return extractorPromise
}

export async function embed(text: string): Promise<Float32Array> {
  const hit = cache.get(text)
  if (hit) return hit
  const extractor = await getExtractor()
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  const vec = new Float32Array(output.data as Float32Array)
  cache.set(text, vec)
  return vec
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
```

`src/providers/embedding-identity.ts`:

```ts
import { embed, dot } from './embeddings'
import { normalizeLabel, type IdentityResolver } from '../salience/identity'
import type { Concept, ConceptCandidate } from '../core/types'

/**
 * The slice-2 answer to concept identity across time: cosine similarity of
 * local sentence embeddings against every concept currently tracked. Vectors
 * are normalized, so cosine == dot.
 */
export class EmbeddingIdentityResolver implements IdentityResolver {
  private readonly conceptVecs = new Map<string, Float32Array>()

  constructor(private readonly threshold: number) {}

  async resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null> {
    const vec = await embed(normalizeLabel(candidate.label))
    let bestId: string | null = null
    let bestSim = -1
    for (const c of concepts) {
      let cv = this.conceptVecs.get(c.id)
      if (!cv) {
        cv = await embed(normalizeLabel(c.label))
        this.conceptVecs.set(c.id, cv)
      }
      const sim = dot(vec, cv)
      if (sim > bestSim) {
        bestSim = sim
        bestId = c.id
      }
    }
    return bestSim >= this.threshold ? bestId : null
  }
}
```

If the `output.data` typing from transformers.js v3 differs at typecheck, adjust the cast at that one line (`output.data as unknown as Float32Array`) rather than restructuring — the runtime shape (flat Float32Array after mean pooling) is stable.

- [ ] **Step 5: Run** — `npx vitest run tests/embedding-identity.test.ts && npm run typecheck` → green (first run slow while the model downloads).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/providers/embeddings.ts src/providers/embedding-identity.ts tests/embedding-identity.test.ts
git commit -m "feat: local MiniLM embeddings and embedding identity resolver"
```

---

### Task 10: Acceptance pair — drift collapses, contention doesn't

**Files:**
- Test: `tests/embedding-acceptance.test.ts` (new)
- Possibly modify: `src/salience/config.ts` (similarityThreshold), `src/providers/embeddings.ts` (MODEL_ID) under the tuning protocol below.

**Interfaces:**
- Consumes: `createReplay(script, {resolver})` (Task 8), `EmbeddingIdentityResolver` (Task 9), fixtures + `DEFAULT_SALIENCE_CONFIG`.

- [ ] **Step 1: Write the acceptance tests**

`tests/embedding-acceptance.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createReplay } from '../src/replay/runner'
import { synonymDrift } from '../src/replay/fixtures/synonym-drift'
import { contention } from '../src/replay/fixtures/contention'
import { EmbeddingIdentityResolver } from '../src/providers/embedding-identity'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import type { SoundingEvent } from '../src/core/events'

type ReadingEvent = Extract<SoundingEvent, { type: 'reading.changed' }>

async function runWithEmbeddings(script: typeof synonymDrift) {
  const resolver = new EmbeddingIdentityResolver(DEFAULT_SALIENCE_CONFIG.similarityThreshold)
  const { session, runner } = createReplay(script, { resolver })
  await runner.runToEnd()
  const readings = session.log.all().filter((e): e is ReadingEvent => e.type === 'reading.changed')
  return { readings, final: readings.at(-1)! }
}

describe('embedding resolver acceptance pair', () => {
  it('synonym drift collapses to exactly one mark (the slice-2 flip)', { timeout: 180_000 }, async () => {
    const { final } = await runWithEmbeddings(synonymDrift)
    const driftMarks = final.reading.marks.filter((m) =>
      synonymDrift.truth.driftGroup!.some((g) => m.label.includes(g) || g.includes(m.label)),
    )
    expect(driftMarks).toHaveLength(1)
  })

  it('contention stays distinct — no false merges', { timeout: 180_000 }, async () => {
    const { readings } = await runWithEmbeddings(contention)
    const appeared = new Set(
      readings
        .flatMap((r) => r.transitions)
        .filter((tr) => tr.kind === 'appeared')
        .map((tr) => (tr.kind === 'appeared' ? tr.label : '')),
    )
    // the nine worries must not collapse into each other
    expect(appeared.size).toBeGreaterThanOrEqual(6)
    for (const r of readings) expect(r.reading.marks.length).toBeLessThanOrEqual(4)
  })
})
```

- [ ] **Step 2: Run and tune (the empirical heart of this task)**

Run: `npx vitest run tests/embedding-acceptance.test.ts`

**Tuning protocol (in order — document every change in report + commit):**
1. If both pass at threshold 0.6: done.
2. If drift does NOT collapse to 1: write a scratch script printing pairwise `dot(embed(a), embed(b))` for the drift group (`grief`/`mourning`/`losing`/`loss`) and the contention worry words (`rent`/`car`/`insurance`/`laptop`/`vacation`/`dentist`/`tax`/`gym`/`freezer`). Find a threshold that separates max(cross-worry sim) from min(intra-drift sim). Adjust `similarityThreshold` in `DEFAULT_SALIENCE_CONFIG` accordingly.
3. If NO threshold separates them with `Xenova/all-MiniLM-L6-v2` (the likely weak pair is `losing` vs `grief`): try alternative local models by changing `MODEL_ID` — `Xenova/bge-small-en-v1.5`, then `Xenova/gte-small` — re-running the scratch matrix each time. Pick the model+threshold with the widest margin; update Task 9's tests if similarity ordering assumptions change.
4. If no local model achieves the pair: report **BLOCKED** with the measured similarity matrices — the acceptance criterion or resolver design needs a human decision. Do not weaken the exactly-1 or no-false-merge assertions yourself.

- [ ] **Step 3: Full suite** — `npm test` → green (including the token-resolver drift test, which still asserts ≥2 — both resolvers' behavior is now pinned side by side).

- [ ] **Step 4: Commit**

```bash
git add tests/embedding-acceptance.test.ts src/salience/config.ts src/providers/embeddings.ts
git commit -m "feat: embedding acceptance pair — synonym drift collapses to one mark"
```

---

### Task 11: Whisper transcription provider

**Files:**
- Create: `src/providers/whisper-transcription.ts`
- Test: `tests/whisper-transcription.test.ts`

**Interfaces:**
- Produces:
  - `whisperJsonToFixtureScript(json: WhisperJson, name: string): FixtureScript` (pure, tested)
  - `transcribeRecording(audioPath: string, modelPath: string): Promise<FixtureScript>` (spawns ffmpeg + whisper-cli; manual-tested via cast)
  - `interface WhisperJson { transcription: Array<{ offsets: { from: number; to: number }; text: string }> }`

- [ ] **Step 1: Write the failing tests**

`tests/whisper-transcription.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { whisperJsonToFixtureScript } from '../src/providers/whisper-transcription'

const sample = {
  transcription: [
    { offsets: { from: 0, to: 3200 }, text: ' So I got the offer letter yesterday.' },
    { offsets: { from: 3200, to: 3200 }, text: ' Hm.' }, // zero-length segment
    { offsets: { from: 3400, to: 7100 }, text: '   ' }, // whitespace-only
    { offsets: { from: 7200, to: 11000 }, text: ' The salary was never the problem.' },
  ],
}

describe('whisperJsonToFixtureScript', () => {
  it('maps offsets to segment times and trims text', () => {
    const script = whisperJsonToFixtureScript(sample, 'memo1')
    expect(script.name).toBe('memo1')
    expect(script.segments[0]).toEqual({ startT: 0, endT: 3200, text: 'So I got the offer letter yesterday.' })
  })

  it('drops whitespace-only segments and enforces a minimum duration', () => {
    const script = whisperJsonToFixtureScript(sample, 'memo1')
    expect(script.segments).toHaveLength(3)
    const hm = script.segments[1]
    expect(hm.text).toBe('Hm.')
    expect(hm.endT - hm.startT).toBeGreaterThanOrEqual(100)
  })

  it('pads endT past the last segment', () => {
    const script = whisperJsonToFixtureScript(sample, 'memo1')
    expect(script.endT).toBe(11000 + 2000)
  })

  it('handles an empty transcription', () => {
    const script = whisperJsonToFixtureScript({ transcription: [] }, 'empty')
    expect(script.segments).toEqual([])
    expect(script.endT).toBe(2000)
  })
})
```

- [ ] **Step 2: Run to verify failure** — cannot resolve module.

- [ ] **Step 3: Implement**

`src/providers/whisper-transcription.ts`:

```ts
// Local whisper.cpp transcription (whisper-cli via Homebrew). Chosen over
// hosted Whisper (Groq is geo-blocked from this network); ASR-measured
// timestamps are load-bearing — they are the spine of the event timeline.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { existsSync } from 'node:fs'
import type { FixtureScript } from '../replay/fixture'

export interface WhisperJson {
  transcription: Array<{ offsets: { from: number; to: number }; text: string }>
}

const MIN_SEGMENT_MS = 100
const TAIL_PAD_MS = 2000

export function whisperJsonToFixtureScript(json: WhisperJson, name: string): FixtureScript {
  const segments = json.transcription
    .map((s) => ({
      startT: s.offsets.from,
      endT: Math.max(s.offsets.to, s.offsets.from + MIN_SEGMENT_MS),
      text: s.text.trim(),
    }))
    .filter((s) => s.text.length > 0)
  const endT = (segments.at(-1)?.endT ?? 0) + TAIL_PAD_MS
  return { name, description: `transcribed from ${name}`, endT, segments, truth: {} }
}

export async function transcribeRecording(audioPath: string, modelPath: string): Promise<FixtureScript> {
  if (!existsSync(modelPath)) {
    throw new Error(
      `whisper model not found at ${modelPath}\nDownload it once with:\n` +
        `  mkdir -p models && curl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${basename(modelPath)}`,
    )
  }
  const tmp = await mkdtemp(join(tmpdir(), 'sounding-'))
  try {
    const wav = join(tmp, 'audio.wav')
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', wav])
    const outBase = join(tmp, 'out')
    await run('whisper-cli', ['-m', modelPath, '-f', wav, '-l', 'auto', '-oj', '-of', outBase, '--no-prints'])
    const json = JSON.parse(await readFile(`${outBase}.json`, 'utf8')) as WhisperJson
    return whisperJsonToFixtureScript(json, basename(audioPath).replace(/\.[^.]+$/, ''))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new Error(`${cmd} not found in PATH — install with: brew install ${cmd === 'whisper-cli' ? 'whisper-cpp' : cmd}`))
      else reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with ${code}:\n${stderr}`))
    })
  })
}
```

If `whisper-cli --help` shows the JSON flag or `--no-prints` under different names on the installed version, adapt the args to the installed binary (check `whisper-cli --help` output) and note it in the report — the parsed JSON shape (`transcription[].offsets/text`) is the stable contract.

- [ ] **Step 4: Run** — `npx vitest run tests/whisper-transcription.test.ts && npm run typecheck` → green.

- [ ] **Step 5: Commit**

```bash
git add src/providers/whisper-transcription.ts tests/whisper-transcription.test.ts
git commit -m "feat: local whisper.cpp transcription provider"
```

---

### Task 12: Audio slicer + pricing

**Files:**
- Create: `src/providers/audio-slicer.ts`, `src/providers/pricing.ts`
- Test: `tests/providers-pure.test.ts`

**Interfaces:**
- Produces:
  - `AUDIO_WINDOW_MS = 30_000`; `sliceWindow(endT: Ms): { fromMs: number; toMs: number }`
  - `makeAudioSource(audioPath: string): AudioSource`
  - `PRICING: Record<string, LlmPricing>`; `llmCost(model: string, u: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number }): number`
  - `GEMINI_MODEL` is defined in Task 14; pricing keys must match interpreter model ids.

- [ ] **Step 1: Write the failing tests**

`tests/providers-pure.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sliceWindow, AUDIO_WINDOW_MS } from '../src/providers/audio-slicer'
import { llmCost, PRICING } from '../src/providers/pricing'

describe('sliceWindow', () => {
  it('clamps the window start at zero', () => {
    expect(sliceWindow(10_000)).toEqual({ fromMs: 0, toMs: 10_000 })
  })
  it('spans AUDIO_WINDOW_MS once past it', () => {
    expect(sliceWindow(90_000)).toEqual({ fromMs: 90_000 - AUDIO_WINDOW_MS, toMs: 90_000 })
  })
})

describe('llmCost', () => {
  it('computes claude-opus-5 cost including cache tiers', () => {
    // $5/MTok in, $25/MTok out, write 1.25x, read 0.1x
    const usd = llmCost('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 100_000, cacheWriteTokens: 100_000, cacheReadTokens: 1_000_000 })
    expect(usd).toBeCloseTo(5 + 2.5 + 0.625 + 0.5, 6)
  })
  it('throws on an unknown model', () => {
    expect(() => llmCost('mystery-model', { inputTokens: 1, outputTokens: 1 })).toThrow(/pricing/)
  })
  it('has pricing for every provider model id used in this repo', () => {
    expect(PRICING['claude-opus-5']).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify failure** — cannot resolve modules.

- [ ] **Step 3: Implement**

`src/providers/pricing.ts`:

```ts
// Per-provider pricing. The insurance from BRIEF.md: when the reading feels
// right, we know whether it cost 3c/min or 30c/min.
export interface LlmPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok?: number
  cacheReadPerMTok?: number
}

export const PRICING: Record<string, LlmPricing> = {
  // Anthropic first-party rates (verified 2026-08 via claude-api skill)
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  // UPDATE-ME: verify the current Gemini model id and audio-input pricing at
  // ai.google.dev/pricing when wiring Task 14 — values below are placeholders
  // from pre-cutoff knowledge and MUST be checked.
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
}

export function llmCost(
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number },
): number {
  const p = PRICING[model]
  if (!p) throw new Error(`no pricing entry for model ${model} — add it to src/providers/pricing.ts`)
  return (
    (u.inputTokens * p.inputPerMTok +
      u.outputTokens * p.outputPerMTok +
      (u.cacheWriteTokens ?? 0) * (p.cacheWritePerMTok ?? p.inputPerMTok) +
      (u.cacheReadTokens ?? 0) * (p.cacheReadPerMTok ?? p.inputPerMTok)) /
    1_000_000
  )
}
```

`src/providers/audio-slicer.ts`:

```ts
// ffmpeg-based audio windowing for audio-native interpretation. The window
// gives the model recent prosodic context, mirroring the recurrence window.
import { spawn } from 'node:child_process'
import type { Ms } from '../core/types'
import type { AudioSegment } from '../interpret/port'
import type { AudioSource } from '../core/session'

export const AUDIO_WINDOW_MS: Ms = 30_000

export function sliceWindow(endT: Ms): { fromMs: number; toMs: number } {
  return { fromMs: Math.max(0, endT - AUDIO_WINDOW_MS), toMs: endT }
}

export function makeAudioSource(audioPath: string): AudioSource {
  return async (seg) => {
    const { fromMs, toMs } = sliceWindow(seg.endT)
    const data = await ffmpegSlice(audioPath, fromMs, toMs)
    return { kind: 'audio', segmentId: seg.segmentId, mimeType: 'audio/mpeg', data, startT: seg.startT, endT: seg.endT }
  }
}

function ffmpegSlice(audioPath: string, fromMs: number, toMs: number): Promise<Uint8Array> {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(fromMs / 1000),
    '-i', audioPath,
    '-t', String((toMs - fromMs) / 1000),
    '-ac', '1', '-f', 'mp3', 'pipe:1',
  ]
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new Error('ffmpeg not found in PATH — install with: brew install ffmpeg'))
      else reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)))
      else reject(new Error(`ffmpeg exited with ${code}:\n${stderr}`))
    })
  })
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/providers-pure.test.ts && npm run typecheck` → green.

- [ ] **Step 5: Commit**

```bash
git add src/providers/audio-slicer.ts src/providers/pricing.ts tests/providers-pure.test.ts
git commit -m "feat: ffmpeg audio windowing and provider pricing"
```

---

### Task 13: Claude extraction interpreter

**Files:**
- Create: `src/providers/candidates.ts`, `src/providers/claude-extraction.ts`
- Test: `tests/claude-extraction.test.ts`
- Modify: `package.json` (dependency)

**Interfaces:**
- Produces:
  - `mapCandidates(parsed: unknown, source: string, segmentId: string): ConceptCandidate[]` (shared with Task 14)
  - `class ClaudeExtractionInterpreter implements Interpreter` — `id` \`claude-extraction/claude-opus-5\`, `input: 'transcript'`
  - `buildUserPrompt(window: string[]): string` (exported for tests)

- [ ] **Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk`

- [ ] **Step 2: Write the failing tests**

`tests/claude-extraction.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapCandidates } from '../src/providers/candidates'
import { buildUserPrompt } from '../src/providers/claude-extraction'

describe('mapCandidates', () => {
  it('maps, clamps, and stamps provenance', () => {
    const out = mapCandidates(
      { candidates: [{ label: '  my sister  ', strength: 1.7, confidence: -0.2 }] },
      'src-x',
      'seg9',
    )
    expect(out).toEqual([{ label: 'my sister', strength: 1, confidence: 0, source: 'src-x', segmentId: 'seg9' }])
  })

  it('drops empty labels and caps at 8', () => {
    const many = { candidates: Array.from({ length: 12 }, (_, i) => ({ label: i === 0 ? '   ' : `c${i}`, strength: 0.5, confidence: 0.5 })) }
    const out = mapCandidates(many, 's', 'seg')
    expect(out).toHaveLength(8)
    expect(out.every((c) => c.label.length > 0)).toBe(true)
  })

  it('returns [] for malformed payloads', () => {
    expect(mapCandidates(null, 's', 'seg')).toEqual([])
    expect(mapCandidates({ candidates: 'nope' }, 's', 'seg')).toEqual([])
    expect(mapCandidates({}, 's', 'seg')).toEqual([])
  })
})

describe('buildUserPrompt', () => {
  it('separates prior context from the newest segment', () => {
    const p = buildUserPrompt(['old one', 'old two', 'the new segment'])
    expect(p).toContain('old one\nold two')
    expect(p).toContain('Newest segment')
    expect(p.indexOf('the new segment')).toBeGreaterThan(p.indexOf('Newest segment'))
  })
})
```

- [ ] **Step 3: Run to verify failure** — cannot resolve modules.

- [ ] **Step 4: Implement**

`src/providers/candidates.ts`:

```ts
import type { ConceptCandidate } from '../core/types'

const MAX_CANDIDATES = 8

const clamp01 = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** Defensive mapping from a model's JSON payload to ConceptCandidate[]. */
export function mapCandidates(parsed: unknown, source: string, segmentId: string): ConceptCandidate[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const raw = (parsed as { candidates?: unknown }).candidates
  if (!Array.isArray(raw)) return []
  const out: ConceptCandidate[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const label = String((item as { label?: unknown }).label ?? '').trim()
    if (label.length === 0) continue
    out.push({
      label,
      strength: clamp01((item as { strength?: unknown }).strength),
      confidence: clamp01((item as { confidence?: unknown }).confidence),
      source,
      segmentId,
    })
    if (out.length === MAX_CANDIDATES) break
  }
  return out
}
```

`src/providers/claude-extraction.ts`:

```ts
// Transcribe-then-extract interpretation: Claude reads the recent transcript
// window and reports concept candidates. Official SDK, structured outputs,
// cached system prompt. Provider layer — wall clock allowed.
import Anthropic from '@anthropic-ai/sdk'
import { mapCandidates } from './candidates'
import { llmCost } from './pricing'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../interpret/port'

const MODEL = 'claude-opus-5'
const WINDOW_SEGMENTS = 8
// Tuning constant: 'low' effort for a ~0.5Hz extraction loop (latency + cost);
// sweep against higher efforts on the replay corpus later.
const EXTRACTION_EFFORT = 'low'

const SYSTEM_PROMPT = `You listen to a person thinking aloud and report concept candidates — the things this stretch of talk is actually about or keeps returning to.

Guidance:
- Prefer what recurs or carries weight over what merely sounds like a topic. A named person, a specific memory, a repeated image, or an unresolved worry beats a tidy abstract noun. If someone talking through a job decision keeps mentioning their sister, "sister" is a candidate even though it isn't the "topic".
- Labels are short (1-4 words), in the speaker's own vocabulary where possible.
- strength (0 to 1): how strongly THIS window of talk supports the concept — recurrence, centrality, emphasis.
- confidence (0 to 1): how sure you are the concept is real and correctly labeled. Be honest: a missing candidate costs less than a wrong one.
- Return 0-8 candidates. Fewer, stronger candidates beat padding. Returning zero is fine for filler.`

const CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          strength: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['label', 'strength', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const

export function buildUserPrompt(window: string[]): string {
  const prior = window.slice(0, -1)
  const current = window.at(-1) ?? ''
  return `Recent talk (oldest first):\n${prior.join('\n')}\n\nNewest segment (interpret it in the context of the above):\n${current}`
}

export class ClaudeExtractionInterpreter implements Interpreter {
  readonly id = `claude-extraction/${MODEL}`
  readonly input = 'transcript' as const
  private readonly window: string[] = []
  private readonly client = new Anthropic()

  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    if (input.kind !== 'transcript') throw new Error(`${this.id} interprets transcript input only`)
    this.window.push(input.text)
    if (this.window.length > WINDOW_SEGMENTS) this.window.shift()
    const started = performance.now()
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        // thinking is on by default on claude-opus-5 and max_tokens caps
        // thinking + response together — 8000 leaves headroom (unused tokens
        // cost nothing). The cache_control below engages only once the system
        // prompt crosses the 512-token cacheable minimum; until then
        // cache_read_input_tokens: 0 is expected, not a bug.
        max_tokens: 8000,
        output_config: { effort: EXTRACTION_EFFORT, format: { type: 'json_schema', schema: CANDIDATES_SCHEMA } },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildUserPrompt(this.window) }],
      })
      const latencyMs = Math.round(performance.now() - started)
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
        console.error(`[${this.id}] no usable output (stop_reason=${response.stop_reason}${response.stop_details?.category ? `, ${response.stop_details.category}` : ''}); returning no candidates`)
        return { candidates: [], costUsd: 0, latencyMs }
      }
      const text = response.content.find((b) => b.type === 'text')?.text ?? '{"candidates":[]}'
      const candidates = mapCandidates(JSON.parse(text), this.id, input.segmentId)
      const costUsd = llmCost(MODEL, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      })
      return { candidates, costUsd, latencyMs }
    } catch (err) {
      // one failed call must not kill a long cast — degrade to no candidates
      console.error(`[${this.id}] call failed: ${err}`)
      return { candidates: [], costUsd: 0, latencyMs: Math.round(performance.now() - started) }
    }
  }
}
```

If the installed SDK's typings reject any field shape above (`output_config`, `stop_details`), check the SDK's own type definitions in `node_modules/@anthropic-ai/sdk` and adapt to the current names — the semantics (structured output schema, cached system, refusal check) are the contract, and they are current per the claude-api reference. Do not switch to `fetch`.

- [ ] **Step 5: Run** — `npx vitest run tests/claude-extraction.test.ts && npm run typecheck && npm test` → green. (No live API call in tests; the live path is exercised in Task 17.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/providers/candidates.ts src/providers/claude-extraction.ts tests/claude-extraction.test.ts
git commit -m "feat: Claude extraction interpreter (structured outputs, cached system prompt)"
```

---

### Task 14: Gemini audio-native interpreter

**Files:**
- Create: `src/providers/gemini-audio.ts`
- Test: `tests/gemini-audio.test.ts`
- Possibly modify: `src/providers/pricing.ts` (verified Gemini pricing/model id)

**Interfaces:**
- Produces: `class GeminiAudioInterpreter implements Interpreter` — `input: 'audio'`; `buildGeminiRequest(audio: AudioSegment): object` and `extractGeminiJson(body: unknown): unknown` exported for tests. `GEMINI_MODEL` exported; its value must have a `PRICING` entry.

- [ ] **Step 1: Verify current Gemini facts (post-cutoff)**

Before writing code, WebSearch/WebFetch the official docs (ai.google.dev) for: the current recommended audio-capable flash-tier model id, the `generateContent` REST shape for inline audio (`inline_data`/`inlineData`, `response_mime_type`, `response_schema` casing), and audio-input pricing. Update `GEMINI_MODEL` and `PRICING` accordingly; note findings in the report.

- [ ] **Step 2: Write the failing tests**

`tests/gemini-audio.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildGeminiRequest, extractGeminiJson } from '../src/providers/gemini-audio'
import type { AudioSegment } from '../src/interpret/port'

const audio: AudioSegment = { kind: 'audio', segmentId: 's1', mimeType: 'audio/mpeg', data: new Uint8Array([104, 105]), startT: 0, endT: 4000 }

describe('buildGeminiRequest', () => {
  it('inlines base64 audio and constrains the response to JSON', () => {
    const req = buildGeminiRequest(audio) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>
      generationConfig: Record<string, unknown>
    }
    const parts = req.contents[0].parts
    const inline = parts.find((p) => 'inline_data' in p || 'inlineData' in p) as Record<string, { mime_type?: string; mimeType?: string; data: string }>
    const blob = inline.inline_data ?? inline.inlineData
    expect(blob.data).toBe(Buffer.from([104, 105]).toString('base64'))
    expect(blob.mime_type ?? blob.mimeType).toBe('audio/mpeg')
    expect(parts.some((p) => typeof p.text === 'string' && (p.text as string).includes('hesitation'))).toBe(true)
    expect(JSON.stringify(req.generationConfig)).toContain('application/json')
  })
})

describe('extractGeminiJson', () => {
  it('pulls the JSON text out of a generateContent response', () => {
    const body = { candidates: [{ content: { parts: [{ text: '{"candidates":[{"label":"sister","strength":0.9,"confidence":0.8}]}' }] } }] }
    expect(extractGeminiJson(body)).toEqual({ candidates: [{ label: 'sister', strength: 0.9, confidence: 0.8 }] })
  })
  it('returns an empty payload on malformed bodies', () => {
    expect(extractGeminiJson({})).toEqual({ candidates: [] })
    expect(extractGeminiJson({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })).toEqual({ candidates: [] })
  })
})
```

- [ ] **Step 3: Run to verify failure** — cannot resolve module.

- [ ] **Step 4: Implement**

`src/providers/gemini-audio.ts`:

```ts
// Audio-native interpretation: the model hears the window — emphasis,
// hesitation, pace — instead of reading a transcript of it. This is the
// brief's central architecture bet, run behind the same port as the
// transcript path so the two can be A/B'd on identical capture events.
import { mapCandidates } from './candidates'
import { llmCost } from './pricing'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../interpret/port'
import type { AudioSegment } from '../interpret/port'

// Verified against ai.google.dev during implementation (Task 14 Step 1).
export const GEMINI_MODEL = 'gemini-2.5-flash'

const AUDIO_PROMPT = `You are listening to a stretch of one person thinking aloud. Report concept candidates — what this talk is actually about or keeps returning to.

Attend to the signals a transcript loses: emphasis, hesitation, pace changes, repetition with stress, the thing the voice keeps circling back to. Something said quickly in passing matters less than something said slowly, repeated, or stumbled over.

Rules:
- Labels are short (1-4 words), in the speaker's own vocabulary where possible.
- strength (0 to 1): how strongly this audio supports the concept (recurrence, centrality, vocal emphasis).
- confidence (0 to 1): honesty required — a missing candidate costs less than a wrong one.
- Return 0-8 candidates as JSON: {"candidates":[{"label":...,"strength":...,"confidence":...}]}`

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    candidates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          strength: { type: 'NUMBER' },
          confidence: { type: 'NUMBER' },
        },
        required: ['label', 'strength', 'confidence'],
      },
    },
  },
  required: ['candidates'],
}

export function buildGeminiRequest(audio: AudioSegment): object {
  return {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: audio.mimeType, data: Buffer.from(audio.data).toString('base64') } },
          { text: AUDIO_PROMPT },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: RESPONSE_SCHEMA,
    },
  }
}

export function extractGeminiJson(body: unknown): unknown {
  try {
    const text = (body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
      .candidates?.[0]?.content?.parts?.[0]?.text
    if (typeof text !== 'string') return { candidates: [] }
    return JSON.parse(text)
  } catch {
    return { candidates: [] }
  }
}

export class GeminiAudioInterpreter implements Interpreter {
  readonly id = `gemini-audio/${GEMINI_MODEL}`
  readonly input = 'audio' as const
  private readonly apiKey: string

  constructor(apiKey = process.env.GEMINI_API_KEY ?? '') {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set — get one at aistudio.google.com')
    this.apiKey = apiKey
  }

  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    if (input.kind !== 'audio') throw new Error(`${this.id} interprets audio input only`)
    const started = performance.now()
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${this.apiKey}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildGeminiRequest(input)) },
      )
      const latencyMs = Math.round(performance.now() - started)
      if (!res.ok) {
        console.error(`[${this.id}] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
        return { candidates: [], costUsd: 0, latencyMs }
      }
      const body = (await res.json()) as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }
      const candidates = mapCandidates(extractGeminiJson(body), this.id, input.segmentId)
      const costUsd = llmCost(GEMINI_MODEL, {
        inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      })
      return { candidates, costUsd, latencyMs }
    } catch (err) {
      console.error(`[${this.id}] call failed: ${err}`)
      return { candidates: [], costUsd: 0, latencyMs: Math.round(performance.now() - started) }
    }
  }
}
```

Adjust field casing (`inline_data` vs `inlineData`, etc.) to what Step 1's doc check found — the tests accept either casing for the inline part; keep the tests authoritative for structure.

- [ ] **Step 5: Run** — `npx vitest run tests/gemini-audio.test.ts && npm run typecheck && npm test` → green.

- [ ] **Step 6: Commit**

```bash
git add src/providers/gemini-audio.ts tests/gemini-audio.test.ts src/providers/pricing.ts
git commit -m "feat: Gemini audio-native interpreter"
```

---

### Task 15: cast CLI

**Files:**
- Create: `src/cli/cast.ts`
- Modify: `package.json` (scripts + tsx dev dep), `.gitignore`
- Test: `tests/cast-args.test.ts`

**Interfaces:**
- Produces: `npm run cast -- <audio-file> -i <recurrence|claude|gemini> [--model-path models/ggml-base.bin] [--threshold 0.6]` → writes `soundings/<base>.<interpreter>.jsonl`, prints final reading + counters. Exported for tests: `parseCastArgs(argv: string[]): CastArgs`, `loadOrTranscribe(audioPath, modelPath, transcribe?)`.

- [ ] **Step 1: Install tsx and wire scripts**

Run: `npm install -D tsx`

`package.json` scripts additions:

```json
    "cast": "tsx src/cli/cast.ts",
    "compare": "tsx src/cli/compare.ts",
```

`.gitignore` additions:

```
recordings/
soundings/
models/
.env
```

- [ ] **Step 2: Write the failing tests**

`tests/cast-args.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCastArgs, loadOrTranscribe } from '../src/cli/cast'
import type { FixtureScript } from '../src/replay/fixture'

describe('parseCastArgs', () => {
  it('parses positional audio path and interpreter flag', () => {
    expect(parseCastArgs(['recordings/memo.m4a', '-i', 'claude'])).toEqual({
      audioPath: 'recordings/memo.m4a',
      interpreter: 'claude',
      modelPath: 'models/ggml-large-v3-turbo.bin',
      threshold: undefined,
    })
  })
  it('accepts overrides', () => {
    const a = parseCastArgs(['x.m4a', '-i', 'gemini', '--model-path', 'models/ggml-base.bin', '--threshold', '0.55'])
    expect(a.modelPath).toBe('models/ggml-base.bin')
    expect(a.threshold).toBe(0.55)
  })
  it('rejects unknown interpreters and missing args', () => {
    expect(() => parseCastArgs(['x.m4a', '-i', 'gpt'])).toThrow(/interpreter/)
    expect(() => parseCastArgs([])).toThrow(/usage/i)
  })
})

describe('loadOrTranscribe', () => {
  const script: FixtureScript = { name: 'memo', description: 'd', endT: 5000, segments: [{ startT: 0, endT: 4000, text: 'hello' }], truth: {} }

  it('caches the transcript next to the recording and reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cast-'))
    const audio = join(dir, 'memo.m4a')
    writeFileSync(audio, 'fake-audio')
    let calls = 0
    const fake = async () => {
      calls += 1
      return script
    }
    const first = await loadOrTranscribe(audio, 'model.bin', fake)
    expect(first.segments).toEqual(script.segments)
    expect(existsSync(join(dir, 'memo.transcript.json'))).toBe(true)
    const second = await loadOrTranscribe(audio, 'model.bin', fake)
    expect(second.segments).toEqual(script.segments)
    expect(calls).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'memo.transcript.json'), 'utf8')).name).toBe('memo')
  })
})
```

- [ ] **Step 3: Run to verify failure** — cannot resolve module.

- [ ] **Step 4: Implement**

`src/cli/cast.ts`:

```ts
// cast: drop a recording through the pipeline and persist the sounding.
//   npm run cast -- recordings/memo.m4a -i claude
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { transcribeRecording } from '../providers/whisper-transcription'
import { ClaudeExtractionInterpreter } from '../providers/claude-extraction'
import { GeminiAudioInterpreter } from '../providers/gemini-audio'
import { makeAudioSource } from '../providers/audio-slicer'
import { EmbeddingIdentityResolver } from '../providers/embedding-identity'
import { RecurrenceInterpreter } from '../interpret/recurrence'
import { SoundingSession } from '../core/session'
import { ReadingDynamics } from '../salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../salience/config'
import { ReplayRunner } from '../replay/runner'
import { buildCaptureEvents } from '../replay/fixture'
import { summarizeCounters } from '../replay/counters'
import type { FixtureScript } from '../replay/fixture'
import type { Interpreter } from '../interpret/port'
import type { SoundingEvent } from '../core/events'

const INTERPRETERS = ['recurrence', 'claude', 'gemini'] as const
type InterpreterName = (typeof INTERPRETERS)[number]

export interface CastArgs {
  audioPath: string
  interpreter: InterpreterName
  modelPath: string
  threshold: number | undefined
}

export function parseCastArgs(argv: string[]): CastArgs {
  const args: Partial<CastArgs> = { modelPath: 'models/ggml-large-v3-turbo.bin' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-i' || a === '--interpreter') {
      const v = argv[++i]
      if (!INTERPRETERS.includes(v as InterpreterName)) throw new Error(`unknown interpreter ${v} — one of: ${INTERPRETERS.join(', ')}`)
      args.interpreter = v as InterpreterName
    } else if (a === '--model-path') args.modelPath = argv[++i]
    else if (a === '--threshold') args.threshold = Number(argv[++i])
    else if (!a.startsWith('-') && !args.audioPath) args.audioPath = a
    else throw new Error(`unrecognized argument ${a}`)
  }
  if (!args.audioPath || !args.interpreter) {
    throw new Error('usage: npm run cast -- <audio-file> -i <recurrence|claude|gemini> [--model-path <ggml>] [--threshold <n>]')
  }
  return args as CastArgs
}

export async function loadOrTranscribe(
  audioPath: string,
  modelPath: string,
  transcribe: (audioPath: string, modelPath: string) => Promise<FixtureScript> = transcribeRecording,
): Promise<FixtureScript> {
  const base = basename(audioPath).replace(/\.[^.]+$/, '')
  const cachePath = join(dirname(audioPath), `${base}.transcript.json`)
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8')) as FixtureScript
  const script = await transcribe(audioPath, modelPath)
  writeFileSync(cachePath, JSON.stringify(script, null, 2))
  return script
}

function makeInterpreter(name: InterpreterName): Interpreter {
  if (name === 'claude') return new ClaudeExtractionInterpreter()
  if (name === 'gemini') return new GeminiAudioInterpreter()
  return new RecurrenceInterpreter()
}

function formatFinalReading(events: readonly SoundingEvent[]): string {
  const last = [...events].reverse().find((e) => e.type === 'reading.changed')
  if (!last || last.type !== 'reading.changed') return '(no reading)'
  return last.reading.marks.map((m) => `  ${m.label.padEnd(28)} ${(m.prominence * 100).toFixed(1)}%`).join('\n')
}

async function main() {
  const opts = parseCastArgs(process.argv.slice(2))
  const script = await loadOrTranscribe(opts.audioPath, opts.modelPath)
  console.log(`cast: ${script.segments.length} segments, ${(script.endT / 1000).toFixed(0)}s — interpreter ${opts.interpreter}`)

  const config = { ...DEFAULT_SALIENCE_CONFIG }
  const interpreter = makeInterpreter(opts.interpreter)
  const resolver = new EmbeddingIdentityResolver(opts.threshold ?? config.similarityThreshold)
  const dynamics = new ReadingDynamics(resolver, config)
  const audioSource = interpreter.input === 'audio' ? makeAudioSource(opts.audioPath) : undefined
  const base = basename(opts.audioPath).replace(/\.[^.]+$/, '')
  const session = new SoundingSession(interpreter, dynamics, config, `${base}.${opts.interpreter}`, audioSource)
  session.drop()

  const runner = new ReplayRunner(session, buildCaptureEvents(script), script.endT)
  await runner.runToEnd()

  mkdirSync('soundings', { recursive: true })
  const outPath = join('soundings', `${base}.${opts.interpreter}.jsonl`)
  writeFileSync(outPath, session.log.toJsonl())

  const c = summarizeCounters(session.log.all())
  console.log(`\nfinal reading:\n${formatFinalReading(session.log.all())}`)
  console.log(`\n${c.callCount} interpretation calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms · max ${Math.round(c.maxLatencyMs)}ms`)
  console.log(`wrote ${outPath}`)
}

const isDirectRun = process.argv[1]?.endsWith('cast.ts')
if (isDirectRun) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  })
}
```

- [ ] **Step 5: Run** — `npx vitest run tests/cast-args.test.ts && npm run typecheck && npm test` → green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/cli/cast.ts tests/cast-args.test.ts
git commit -m "feat: cast CLI — recording to persisted sounding log"
```

---

### Task 16: compare CLI + UI log loading

**Files:**
- Create: `src/cli/compare.ts`
- Modify: `index.html`, `src/ui/main.ts`
- Test: `tests/compare.test.ts`

**Interfaces:**
- Produces: `npm run compare -- <log-a.jsonl> <log-b.jsonl>`; exported `formatComparison(a: NamedLog, b: NamedLog): string` where `NamedLog = { name: string; events: readonly SoundingEvent[] }`. UI: file input `#log-file` loads a `.jsonl` sounding and replays it with the existing controls.

- [ ] **Step 1: Write the failing test**

`tests/compare.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createReplay } from '../src/replay/runner'
import { circling } from '../src/replay/fixtures/circling'
import { formatComparison } from '../src/cli/compare'

describe('formatComparison', () => {
  it('renders readings, displacements, and counters for both logs', async () => {
    const a = createReplay(circling)
    await a.runner.runToEnd()
    const b = createReplay(circling)
    await b.runner.runToEnd()
    const out = formatComparison(
      { name: 'circling.recurrence', events: a.session.log.all() },
      { name: 'circling.recurrence-2', events: b.session.log.all() },
    )
    expect(out).toContain('FINAL READING')
    expect(out).toContain('sister')
    expect(out).toContain('DISPLACEMENTS')
    expect(out).toContain('COST / LATENCY')
    expect(out).toContain('$0.0000')
    expect(out).toContain('circling.recurrence-2')
  })
})
```

- [ ] **Step 2: Run to verify failure** — cannot resolve module.

- [ ] **Step 3: Implement compare**

`src/cli/compare.ts`:

```ts
// compare: two casts of the same recording, side by side.
//   npm run compare -- soundings/memo.claude.jsonl soundings/memo.gemini.jsonl
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { EventLog, type SoundingEvent } from '../core/events'
import { summarizeCounters } from '../replay/counters'

export interface NamedLog {
  name: string
  events: readonly SoundingEvent[]
}

const COL = 46

function finalMarks(events: readonly SoundingEvent[]): string[] {
  const last = [...events].reverse().find((e) => e.type === 'reading.changed')
  if (!last || last.type !== 'reading.changed') return ['(no reading)']
  return last.reading.marks.map((m) => `${m.label} ${(m.prominence * 100).toFixed(1)}%`)
}

function displacements(events: readonly SoundingEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.type !== 'reading.changed') continue
    for (const tr of e.transitions) {
      if (tr.kind === 'displaced') out.push(`${(e.t / 1000).toFixed(1)}s  ${tr.label} ⟶ out`)
    }
  }
  return out.length > 0 ? out : ['(none)']
}

function counters(events: readonly SoundingEvent[]): string[] {
  const c = summarizeCounters(events)
  return [`${c.callCount} calls`, `$${c.totalCostUsd.toFixed(4)}`, `mean ${Math.round(c.meanLatencyMs)}ms / max ${Math.round(c.maxLatencyMs)}ms`]
}

function twoColumns(left: string[], right: string[]): string {
  const rows = Math.max(left.length, right.length)
  const lines: string[] = []
  for (let i = 0; i < rows; i++) {
    lines.push(`  ${(left[i] ?? '').padEnd(COL)}${right[i] ?? ''}`)
  }
  return lines.join('\n')
}

export function formatComparison(a: NamedLog, b: NamedLog): string {
  const header = `  ${a.name.padEnd(COL)}${b.name}`
  return [
    'FINAL READING',
    header,
    twoColumns(finalMarks(a.events), finalMarks(b.events)),
    '',
    'DISPLACEMENTS',
    twoColumns(displacements(a.events), displacements(b.events)),
    '',
    'COST / LATENCY',
    twoColumns(counters(a.events), counters(b.events)),
  ].join('\n')
}

const isDirectRun = process.argv[1]?.endsWith('compare.ts')
if (isDirectRun) {
  const [pathA, pathB] = process.argv.slice(2)
  if (!pathA || !pathB) {
    console.error('usage: npm run compare -- <log-a.jsonl> <log-b.jsonl>')
    process.exit(1)
  }
  const load = (p: string): NamedLog => ({ name: basename(p, '.jsonl'), events: EventLog.fromJsonl(readFileSync(p, 'utf8')).all() })
  console.log(formatComparison(load(pathA), load(pathB)))
}
```

- [ ] **Step 4: UI log loading**

`index.html` — add to the header, after the fixture select:

```html
      <input type="file" id="log-file" accept=".jsonl" title="Load a saved sounding log" />
```

`src/ui/main.ts` — additions (playback source becomes either the live runner or a loaded log):

At the top, extend imports: `import { EventLog } from '../core/events'` and add state:

```ts
const logFileInput = document.getElementById('log-file') as HTMLInputElement
let loadedReadings: Array<Extract<SoundingEvent, { type: 'reading.changed' }>> | null = null
let loadedIdx = 0
let loadedEvents: readonly SoundingEvent[] = []
```

Add the loader and extend `reset()`:

```ts
logFileInput.addEventListener('change', async () => {
  const file = logFileInput.files?.[0]
  if (!file) return
  const log = EventLog.fromJsonl(await file.text())
  reset()
  loadedEvents = log.all()
  loadedReadings = loadedEvents.filter((e): e is Extract<SoundingEvent, { type: 'reading.changed' }> => e.type === 'reading.changed')
  loadedIdx = 0
  const c = summarizeCounters(loadedEvents)
  countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms`
  playPause.textContent = 'Drop'
})
```

In `reset()`, add: `loadedReadings = null; loadedIdx = 0; loadedEvents = []; logFileInput.value = ''` (keep the rest).

In `frame()`, before the live-runner branch, handle the loaded-log mode (loaded logs use the log's own end time):

```ts
  if (playing && loadedReadings) {
    const speed = Number(speedSelect.value) || 1
    const endT = loadedEvents.at(-1)?.t ?? 0
    sessionT = Math.min(sessionT + (wallT - lastFrameWallT) * speed, endT)
    lastFrameWallT = wallT
    let latest: (typeof loadedReadings)[number] | null = null
    while (loadedIdx < loadedReadings.length && loadedReadings[loadedIdx].t <= sessionT) {
      latest = loadedReadings[loadedIdx]
      for (const tr of latest.transitions) {
        const id = tr.kind === 'merged' ? tr.intoConceptId : tr.conceptId
        if (!history.has(id)) history.set(id, [])
        history.get(id)!.push({ t: latest.t, transition: tr })
      }
      loadedIdx += 1
    }
    if (latest) renderReading(latest.reading)
    clockEl.textContent = fmt(sessionT)
    if (sessionT >= endT) {
      playing = false
      playPause.textContent = 'Surfaced'
    }
    requestAnimationFrame(frame)
    return
  }
```

And in the playPause click handler's instant branch, handle loaded mode first:

```ts
  if (loadedReadings) {
    if (speedSelect.value === '0') {
      sessionT = loadedEvents.at(-1)?.t ?? 0
      loadedIdx = 0
      history.clear()
      // replay all transitions instantly
      for (const r of loadedReadings) {
        for (const tr of r.transitions) {
          const id = tr.kind === 'merged' ? tr.intoConceptId : tr.conceptId
          if (!history.has(id)) history.set(id, [])
          history.get(id)!.push({ t: r.t, transition: tr })
        }
      }
      const last = loadedReadings.at(-1)
      if (last) renderReading(last.reading)
      playPause.textContent = 'Surfaced'
      return
    }
    playing = !playing
    playPause.textContent = playing ? 'Pause' : 'Resume'
    lastFrameWallT = performance.now()
    return
  }
```

(The existing fixture path is untouched below these branches. Adapt variable placement to the file's current structure; typecheck is the arbiter.)

- [ ] **Step 5: Run + manual check**

Run: `npx vitest run tests/compare.test.ts && npm run typecheck && npm test` → green.

Generate a log to load (no keys needed):

```bash
npx tsx -e "
import { createReplay } from './src/replay/runner';
import { circling } from './src/replay/fixtures/circling';
import { mkdirSync, writeFileSync } from 'node:fs';
const { session, runner } = createReplay(circling);
await runner.runToEnd();
mkdirSync('soundings', { recursive: true });
writeFileSync('soundings/circling.recurrence.jsonl', session.log.toJsonl());
console.log('wrote soundings/circling.recurrence.jsonl');
"
```

Then `npm run dev`, load `soundings/circling.recurrence.jsonl` via the file input, press Drop at 4x: marks replay; instant works; inspector history populates; switching back to a fixture via the dropdown resets cleanly. Record pass/fail in the report.

- [ ] **Step 6: Commit**

```bash
git add src/cli/compare.ts index.html src/ui/main.ts tests/compare.test.ts
git commit -m "feat: compare CLI and sounding-log playback in the UI"
```

---

### Task 17: End-to-end integration on a real (or synthesized) memo

**Files:**
- No committed source changes expected (observations + any small fixes discovered). Working artifacts live in gitignored `recordings/`, `soundings/`, `models/`.

**Prerequisites check (record what's present):** `whisper-cli` and `ffmpeg` in PATH; `GEMINI_API_KEY` set (if absent, run all steps except gemini and note it); Anthropic auth (`ant auth status` or `ANTHROPIC_API_KEY`).

- [ ] **Step 1: Obtain a memo**

If `recordings/` contains a real voice memo, use it. Otherwise synthesize one from the circling fixture's monologue (macOS `say`):

```bash
mkdir -p recordings models
npx tsx -e "
import { circling } from './src/replay/fixtures/circling';
console.log(circling.segments.map(s => s.text).join(' ... '));
" > /tmp/memo-text.txt
say -f /tmp/memo-text.txt -o /tmp/memo.aiff
ffmpeg -y -hide_banner -loglevel error -i /tmp/memo.aiff -c:a aac recordings/synthetic-memo.m4a
```

- [ ] **Step 2: Whisper model (small model is fine for the smoke test)**

```bash
curl -L -o models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

(~148MB. `ggml-large-v3-turbo.bin` (~1.6GB) is the quality choice for real memos — optional now.)

- [ ] **Step 3: Cast all available paths**

```bash
npm run cast -- recordings/synthetic-memo.m4a -i recurrence --model-path models/ggml-base.bin
npm run cast -- recordings/synthetic-memo.m4a -i claude --model-path models/ggml-base.bin
npm run cast -- recordings/synthetic-memo.m4a -i gemini --model-path models/ggml-base.bin   # skip + note if no GEMINI_API_KEY
```

Verify per cast: transcript cached on first run (second cast reuses it, no whisper call); a `soundings/*.jsonl` written; final reading printed; counters show $0.0000 for recurrence and real dollars for claude/gemini; claude candidates look like concepts (not JSON fragments or topic-noun soup).

- [ ] **Step 4: Compare and UI**

```bash
npm run compare -- soundings/synthetic-memo.claude.jsonl soundings/synthetic-memo.recurrence.jsonl
# (or claude vs gemini when both exist)
```

Then `npm run dev` and load one of the cast logs — the reading replays.

- [ ] **Step 5: Report**

Record in the task report: per-path pass/fail, actual cost per cast, mean/max latency, notable qualitative differences between interpreters' candidates (this is the first real A/B observation — quote a few candidate labels from each), and any deviations/fixes made. If fixes touched source, run `npm test && npm run typecheck` and include them in the commit.

- [ ] **Step 6: Commit (report/fixes only — no recordings or logs)**

```bash
git add -A -- ':!recordings' ':!soundings' ':!models'
git commit -m "chore: slice-2 end-to-end integration verified on a cast memo"
```

(If nothing changed, commit `--allow-empty` with the same message so the verification is recorded in history.)

---

## Completion checklist (after Task 17)

- [ ] `npm test` — all suites green; `npm run typecheck` — clean.
- [ ] Spec success criteria (`docs/superpowers/specs/2026-08-28-sounding-slice2-design.md` → Goal):
  - three cast paths produce logs with real cost counters ✅ Tasks 13–15, 17
  - UI replays a saved log ✅ Task 16
  - compare renders the A/B ✅ Task 16–17
  - synonym-drift exactly-1 (embedding) / ≥2 (token) ✅ Task 10
  - hardening trio green ✅ Tasks 3, 5, 6
- [ ] Use superpowers:finishing-a-development-branch to decide integration.

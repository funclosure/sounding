# Sounding Slice 1 Implementation Plan — The Engine on Replay

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A synthetic monologue fixture runs through the full pipeline (segments → recurrence interpreter → salience dynamics) and the evolving reading renders in a browser, with deterministic replay and tests asserting the dynamics.

**Architecture:** Pure-TypeScript engine (event log + interpretation port + salience dynamics) with no I/O and no wall-clock reads, so it runs identically under Node (tests) and in the browser (Vite debug UI). Fixtures are scripted monologues compiled to timed capture events; a replay runner drives the same pipeline in tests (∞x) and the UI (1x). Spec: `docs/superpowers/specs/2026-08-28-sounding-slice1-design.md`.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Vite. Zero runtime dependencies.

## Global Constraints

- **No wall clock in the engine.** Nothing under `src/` except `src/ui/` may call `Date.now`, `performance.now`, or `new Date`. All engine time is session-relative milliseconds (`Ms`) from drop. A guard test enforces this (Task 13).
- **Determinism.** No `Math.random` in the engine. No `localeCompare` (locale-dependent) — sort with explicit `<`/`>` tiebreakers. Same fixture + config must produce byte-identical event streams.
- **Nautical vocabulary** in type names, comments, UI copy: a session is a `Sounding`, on-screen state is the `Reading`, sessions `drop()` and `surface()`, extended silence is `slack`. Don't invent synonyms.
- **Rate discipline:** salience ticks at 10Hz (`tickMs: 100`); segments arrive at ~0.25–0.5Hz; render is decoupled at the UI's frame rate.
- **Interpretation port input stays `AudioSegment | Transcript`** even though slice 1 only passes transcripts. Do not "simplify" the union away.
- **Zero runtime dependencies.** Dev-dependencies only: `typescript`, `vite`, `vitest`.
- Commit at the end of every task with the message given in the task.

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, index.html
src/
  core/text.ts        tokenization + normalization (shared by interpreter & resolver & nudges)
  core/types.ts       Ms, ConceptCandidate, Concept, Mark, Reading, Transition
  core/events.ts      SoundingEvent union, EventLog (append-only, JSONL round-trip)
  core/session.ts     SoundingSession — wires interpreter + dynamics + log, emits ticks
  interpret/port.ts   Interpreter interface, Transcript/AudioSegment, InterpretationResult
  interpret/recurrence.ts  RecurrenceInterpreter (sliding-window word/bigram recurrence)
  salience/config.ts  SalienceConfig + DEFAULT_SALIENCE_CONFIG
  salience/identity.ts IdentityResolver interface + TokenIdentityResolver
  salience/dynamics.ts ReadingDynamics — decay, capacity, hysteresis, nudges  ← the app
  replay/fixture.ts   FixtureScript/FixtureTruth types, buildCaptureEvents
  replay/runner.ts    ReplayRunner + createReplay (composition root for tests & UI)
  replay/counters.ts  summarizeCounters (cost/latency from the log)
  replay/fixtures/{circling,slack,topic-shift,contention,synonym-drift}.ts + index.ts
  ui/layout.ts        pure deterministic mark placement (tested)
  ui/main.ts          Vite app: chart, playback controls, inspector (manual verification)
tests/
  smoke.test.ts, text.test.ts, events.test.ts, recurrence.test.ts, identity.test.ts,
  dynamics.test.ts, hysteresis.test.ts, session.test.ts, replay.test.ts, counters.test.ts,
  fixtures-circling-slack.test.ts, fixtures-shift-contention.test.ts,
  fixtures-drift-determinism.test.ts, layout.test.ts
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit) for all later tasks.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "sounding",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
```

`.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 2: Write smoke test**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('scaffold', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 3: Install and verify**

Run: `npm install && npm test && npm run typecheck`
Expected: 1 test passes; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore tests/smoke.test.ts
git commit -m "chore: scaffold TypeScript + Vitest project"
```

---

### Task 2: Text normalization (`core/text.ts`)

**Files:**
- Create: `src/core/text.ts`
- Test: `tests/text.test.ts`

**Interfaces:**
- Produces: `normalizeToken(raw: string): string`, `tokenize(text: string): string[]`, `STOPWORDS: Set<string>`. Used by the recurrence interpreter (Task 4), identity resolver (Task 5), and fast-loop nudges (Task 7).

- [ ] **Step 1: Write failing tests**

`tests/text.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { normalizeToken, tokenize } from '../src/core/text'

describe('normalizeToken', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeToken('Sister,')).toBe('sister')
    expect(normalizeToken("don't")).toBe('dont')
  })
  it('folds simple plurals but not -ss words', () => {
    expect(normalizeToken('guests')).toBe('guest')
    expect(normalizeToken('loss')).toBe('loss')
    expect(normalizeToken('gas')).toBe('gas') // length 3: too short to fold
  })
})

describe('tokenize', () => {
  it('drops stopwords and short tokens', () => {
    expect(tokenize('I keep thinking about my sister')).toEqual(['keep', 'thinking', 'sister'])
  })
  it('returns empty for pure-stopword text', () => {
    expect(tokenize('and then I was like')).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/text.test.ts`
Expected: FAIL — cannot resolve `../src/core/text`.

- [ ] **Step 3: Implement**

`src/core/text.ts`:
```ts
// Shared tokenization. Everything downstream (recurrence counting, token
// identity, fast-loop nudges) must agree on what a "word" is, so this is
// the single definition.

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'of', 'to', 'in',
  'on', 'at', 'for', 'with', 'about', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'am', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
  'im', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
  'her', 'hers', 'they', 'them', 'their', 'what', 'which', 'who', 'when',
  'where', 'why', 'how', 'not', 'no', 'yes', 'do', 'does', 'did', 'have',
  'has', 'had', 'will', 'would', 'can', 'could', 'should', 'just', 'like',
  'really', 'actually', 'maybe', 'know', 'think', 'mean', 'get', 'got',
  'going', 'go', 'thing', 'things', 'lot', 'bit', 'well', 'okay', 'ok',
  'um', 'uh', 'yeah', 'right', 'dont', 'cant', 'thats', 'there', 'here',
  'because', 'from', 'into', 'over', 'again', 'still', 'very', 'too', 'also',
  'all', 'some', 'any', 'more', 'most', 'other', 'than', 'up', 'down', 'out',
  'off', 'now', 'one', 'two', 'time', 'back', 'every',
])

export function normalizeToken(raw: string): string {
  let t = raw.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/'/g, '')
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1)
  return t
}

export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}
```

Note: `keep`/`keeps` are deliberately NOT stopwords — "I keep coming back to" is exactly the recurrence signal the app measures, and the first tokenize test pins that decision.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/text.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/text.ts tests/text.test.ts
git commit -m "feat: shared tokenization and normalization"
```

---

### Task 3: Domain types and event log (`core/types.ts`, `core/events.ts`)

**Files:**
- Create: `src/core/types.ts`, `src/core/events.ts`
- Test: `tests/events.test.ts`

**Interfaces:**
- Produces (used by every later task — copy exactly):

`src/core/types.ts`:
```ts
/** Session-relative milliseconds from drop. The engine never sees wall clock. */
export type Ms = number

/** What an interpreter proposes from one segment. Stateless; salience owns identity. */
export interface ConceptCandidate {
  label: string
  strength: number // 0-1, how strongly this segment supports the concept
  confidence: number // 0-1, how sure the interpreter is this is real (floor gate)
  source: string // interpreter id
  segmentId: string
}

/** A concept the reading tracks (surfaced or not). */
export interface Concept {
  id: string
  label: string
  weight: number // decayed accumulation of support
  confidence: number // max confidence ever seen
  firstSeenT: Ms
  lastSupportT: Ms
}

/** One mark on the chart. prominence is field-relative (sums to 1 across marks). */
export interface Mark {
  conceptId: string
  label: string
  prominence: number
  weight: number // raw decayed weight, for the inspector and decay assertions
}

/** The on-screen state of a sounding. slack = extended silence. */
export interface Reading {
  t: Ms
  slack: boolean
  marks: Mark[] // length <= capacity K, sorted by prominence desc
}

export type Transition =
  | { kind: 'appeared'; conceptId: string; label: string }
  | { kind: 'nudged'; conceptId: string; delta: number }
  | { kind: 'displaced'; conceptId: string; label: string; byConceptId: string }
  | { kind: 'merged'; fromConceptId: string; intoConceptId: string } // unused until embedding resolver (slice 2); type reserved
```

`src/core/events.ts`:
```ts
import type { ConceptCandidate, Ms, Reading, Transition } from './types'

export type SoundingEvent =
  | { type: 'sounding.dropped'; t: Ms; soundingId: string }
  | { type: 'segment.pending'; t: Ms; text: string }
  | { type: 'segment.committed'; t: Ms; segmentId: string; transcript: string; startT: Ms; endT: Ms }
  | { type: 'candidates.emitted'; t: Ms; segmentId: string; source: string; candidates: ConceptCandidate[]; costUsd: number; latencyMs: number }
  | { type: 'reading.changed'; t: Ms; transitions: Transition[]; reading: Reading }
  | { type: 'sounding.surfaced'; t: Ms }

/** Append-only, timestamp-monotonic log. The session's spine. */
export class EventLog {
  private events: SoundingEvent[] = []

  append(e: SoundingEvent): void {
    const last = this.events[this.events.length - 1]
    if (last && e.t < last.t) {
      throw new Error(`event log must be monotonic: got t=${e.t} after t=${last.t}`)
    }
    this.events.push(e)
  }

  all(): readonly SoundingEvent[] {
    return this.events
  }

  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n')
  }

  static fromJsonl(jsonl: string): EventLog {
    const log = new EventLog()
    for (const line of jsonl.split('\n')) {
      if (line.trim().length === 0) continue
      log.append(JSON.parse(line) as SoundingEvent)
    }
    return log
  }
}
```

- [ ] **Step 1: Write failing tests**

`tests/events.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { EventLog } from '../src/core/events'

describe('EventLog', () => {
  it('appends and preserves order', () => {
    const log = new EventLog()
    log.append({ type: 'sounding.dropped', t: 0, soundingId: 's1' })
    log.append({ type: 'segment.pending', t: 100, text: 'hello' })
    expect(log.all().map((e) => e.type)).toEqual(['sounding.dropped', 'segment.pending'])
  })

  it('rejects non-monotonic timestamps', () => {
    const log = new EventLog()
    log.append({ type: 'segment.pending', t: 200, text: 'a' })
    expect(() => log.append({ type: 'segment.pending', t: 100, text: 'b' })).toThrow(/monotonic/)
  })

  it('allows equal timestamps', () => {
    const log = new EventLog()
    log.append({ type: 'segment.pending', t: 100, text: 'a' })
    expect(() => log.append({ type: 'segment.pending', t: 100, text: 'b' })).not.toThrow()
  })

  it('round-trips through JSONL byte-identically', () => {
    const log = new EventLog()
    log.append({ type: 'sounding.dropped', t: 0, soundingId: 's1' })
    log.append({
      type: 'reading.changed', t: 100, transitions: [{ kind: 'appeared', conceptId: 'c1', label: 'sister' }],
      reading: { t: 100, slack: false, marks: [{ conceptId: 'c1', label: 'sister', prominence: 1, weight: 0.5 }] },
    })
    log.append({ type: 'sounding.surfaced', t: 200 })
    const jsonl = log.toJsonl()
    expect(EventLog.fromJsonl(jsonl).toJsonl()).toBe(jsonl)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/events.test.ts`
Expected: FAIL — cannot resolve `../src/core/events`.

- [ ] **Step 3: Implement** — create `src/core/types.ts` and `src/core/events.ts` exactly as shown in the Interfaces block above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/events.test.ts && npm run typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/events.ts tests/events.test.ts
git commit -m "feat: domain types and append-only event log with JSONL round-trip"
```

---

### Task 4: Interpretation port + recurrence interpreter

**Files:**
- Create: `src/interpret/port.ts`, `src/interpret/recurrence.ts`
- Test: `tests/recurrence.test.ts`

**Interfaces:**
- Consumes: `tokenize` (Task 2), `ConceptCandidate` (Task 3).
- Produces:

`src/interpret/port.ts`:
```ts
import type { ConceptCandidate, Ms } from '../core/types'

export interface Transcript {
  kind: 'transcript'
  segmentId: string
  text: string
  startT: Ms
  endT: Ms
}

export interface AudioSegment {
  kind: 'audio'
  segmentId: string
  samples: Float32Array
  sampleRate: number
  startT: Ms
  endT: Ms
}

/**
 * The port. Input stays (AudioSegment | Transcript) even while only
 * transcripts flow through it — collapsing the union would weld shut the
 * audio-native question (see BRIEF.md, Unresolved).
 */
export type InterpreterInput = AudioSegment | Transcript

export interface InterpretationResult {
  candidates: ConceptCandidate[]
  costUsd: number
  latencyMs: number
}

export interface Interpreter {
  readonly id: string
  interpret(input: InterpreterInput): Promise<InterpretationResult>
}
```

- Produces: `class RecurrenceInterpreter implements Interpreter` with `constructor(opts?: { windowSegments?: number; minCount?: number })`, `id = 'recurrence-v0'`.

- [ ] **Step 1: Write failing tests**

`tests/recurrence.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { RecurrenceInterpreter } from '../src/interpret/recurrence'
import type { Transcript } from '../src/interpret/port'

function seg(id: string, text: string): Transcript {
  return { kind: 'transcript', segmentId: id, text, startT: 0, endT: 4000 }
}

describe('RecurrenceInterpreter', () => {
  it('emits no candidates below minCount', async () => {
    const interp = new RecurrenceInterpreter()
    const r = await interp.interpret(seg('s1', 'the garden needs water'))
    expect(r.candidates).toEqual([])
    expect(r.costUsd).toBe(0)
    expect(r.latencyMs).toBe(0)
  })

  it('surfaces recurring words across the window', async () => {
    const interp = new RecurrenceInterpreter()
    await interp.interpret(seg('s1', 'my sister called about the offer'))
    const r = await interp.interpret(seg('s2', 'my sister thinks the offer is fine'))
    const labels = r.candidates.map((c) => c.label)
    expect(labels).toContain('sister')
    expect(labels).toContain('offer')
  })

  it('counts recurrence within a single segment', async () => {
    const interp = new RecurrenceInterpreter()
    const r = await interp.interpret(seg('s1', 'the rent went up and the rent was already high'))
    expect(r.candidates.map((c) => c.label)).toContain('rent')
  })

  it('emits bigrams for adjacent recurring pairs', async () => {
    const interp = new RecurrenceInterpreter()
    await interp.interpret(seg('s1', 'the job offer arrived, the job offer looks good'))
    const r = await interp.interpret(seg('s2', 'signing the job offer today'))
    expect(r.candidates.map((c) => c.label)).toContain('job offer')
  })

  it('forgets segments outside the window', async () => {
    const interp = new RecurrenceInterpreter({ windowSegments: 2 })
    await interp.interpret(seg('s1', 'sister sister sister'))
    await interp.interpret(seg('s2', 'garden fence shade'))
    const r = await interp.interpret(seg('s3', 'tomato basil sun'))
    expect(r.candidates.map((c) => c.label)).not.toContain('sister')
  })

  it('is deterministic: candidates sorted by strength then label', async () => {
    const a = new RecurrenceInterpreter()
    const b = new RecurrenceInterpreter()
    const texts = ['the offer and my sister', 'the offer and my sister again today']
    let ra, rb
    for (const t of texts) {
      ra = await a.interpret(seg('x', t))
      rb = await b.interpret(seg('x', t))
    }
    expect(ra).toEqual(rb)
  })

  it('rejects audio input for now', async () => {
    const interp = new RecurrenceInterpreter()
    const audio = { kind: 'audio' as const, segmentId: 'a1', samples: new Float32Array(0), sampleRate: 16000, startT: 0, endT: 0 }
    await expect(interp.interpret(audio)).rejects.toThrow(/transcript/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/recurrence.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Implement**

Create `src/interpret/port.ts` exactly as in the Interfaces block. Then `src/interpret/recurrence.ts`:
```ts
import { tokenize } from '../core/text'
import type { Interpreter, InterpreterInput, InterpretationResult } from './port'

export interface RecurrenceOptions {
  windowSegments: number // how many committed segments the sliding window holds
  minCount: number // occurrences required before a term becomes a candidate
}

const DEFAULTS: RecurrenceOptions = { windowSegments: 8, minCount: 2 }

/**
 * Slice-1 interpreter: word/bigram recurrence over a sliding window of
 * committed segments. No network, no cost. Recurrence is a real salience
 * signal (BRIEF.md), but it cannot do synonymy — that is the embedding
 * resolver's job in slice 2.
 */
export class RecurrenceInterpreter implements Interpreter {
  readonly id = 'recurrence-v0'
  private window: string[][] = []
  private readonly opts: RecurrenceOptions

  constructor(opts?: Partial<RecurrenceOptions>) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    if (input.kind !== 'transcript') {
      throw new Error('recurrence-v0 interprets transcript input only')
    }
    this.window.push(tokenize(input.text))
    if (this.window.length > this.opts.windowSegments) this.window.shift()

    const counts = new Map<string, number>()
    for (const tokens of this.window) {
      for (const tok of tokens) counts.set(tok, (counts.get(tok) ?? 0) + 1)
      for (let i = 0; i < tokens.length - 1; i++) {
        const bigram = `${tokens[i]} ${tokens[i + 1]}`
        counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
      }
    }

    let max = 1
    for (const c of counts.values()) if (c > max) max = c

    const candidates = [...counts.entries()]
      .filter(([, c]) => c >= this.opts.minCount)
      .map(([label, c]) => ({
        label,
        strength: c / max,
        confidence: Math.min(1, c / (this.opts.minCount + 2)),
        source: this.id,
        segmentId: input.segmentId,
      }))
      .sort((a, b) => (b.strength - a.strength) || (a.label < b.label ? -1 : 1))
      .slice(0, 12)

    return { candidates, costUsd: 0, latencyMs: 0 }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/recurrence.test.ts && npm run typecheck`
Expected: PASS (7 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/interpret/port.ts src/interpret/recurrence.ts tests/recurrence.test.ts
git commit -m "feat: interpretation port and recurrence interpreter"
```

---

### Task 5: Identity resolution (`salience/identity.ts`)

**Files:**
- Create: `src/salience/identity.ts`
- Test: `tests/identity.test.ts`

**Interfaces:**
- Consumes: `ConceptCandidate`, `Concept` (Task 3), `normalizeToken` (Task 2).
- Produces:

```ts
export interface IdentityResolver {
  /** Returns the id of the existing concept this candidate is, or null if new. */
  resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): string | null
}
export class TokenIdentityResolver implements IdentityResolver { ... }
```

- [ ] **Step 1: Write failing tests**

`tests/identity.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { Concept, ConceptCandidate } from '../src/core/types'

function concept(id: string, label: string): Concept {
  return { id, label, weight: 1, confidence: 1, firstSeenT: 0, lastSupportT: 0 }
}
function candidate(label: string): ConceptCandidate {
  return { label, strength: 1, confidence: 1, source: 'test', segmentId: 's1' }
}

describe('TokenIdentityResolver', () => {
  const resolver = new TokenIdentityResolver()

  it('matches identical normalized labels', () => {
    expect(resolver.resolve(candidate('sister'), [concept('c1', 'sister')])).toBe('c1')
  })

  it('matches across plural folding', () => {
    expect(resolver.resolve(candidate('guests'), [concept('c1', 'guest')])).toBe('c1')
  })

  it('matches multi-word labels token-wise', () => {
    expect(resolver.resolve(candidate('job offers'), [concept('c1', 'job offer')])).toBe('c1')
  })

  it('returns null for unknown labels — synonymy is NOT its job', () => {
    expect(resolver.resolve(candidate('mourning'), [concept('c1', 'grief')])).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/identity.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

`src/salience/identity.ts`:
```ts
import { normalizeToken } from '../core/text'
import type { Concept, ConceptCandidate } from '../core/types'

/**
 * Candidate → existing-concept-or-new. Swappable: the embedding-similarity
 * resolver (slice 2) implements this same interface and takes over the
 * "grief"/"mourning"/"losing her" problem. v0 does normalized-token equality
 * only, which matches what the recurrence interpreter emits.
 */
export interface IdentityResolver {
  resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): string | null
}

function normalizeLabel(label: string): string {
  return label.split(' ').map(normalizeToken).join(' ')
}

export class TokenIdentityResolver implements IdentityResolver {
  resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): string | null {
    const key = normalizeLabel(candidate.label)
    for (const c of concepts) {
      if (normalizeLabel(c.label) === key) return c.id
    }
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/identity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/salience/identity.ts tests/identity.test.ts
git commit -m "feat: identity resolver interface with token-matching v0"
```

---

### Task 6: Salience config + reading dynamics core (`salience/config.ts`, `salience/dynamics.ts`)

Decay, candidate application, capacity fill, confidence floor, field-relative marks, slack. Hysteresis displacement and nudges come in Task 7 on top of this file.

**Files:**
- Create: `src/salience/config.ts`, `src/salience/dynamics.ts`
- Test: `tests/dynamics.test.ts`

**Interfaces:**
- Consumes: types (Task 3), `IdentityResolver` (Task 5), `tokenize` (Task 2).
- Produces:

`src/salience/config.ts`:
```ts
/** Every tuning constant in one place so replay-based sweeps are trivial. */
export interface SalienceConfig {
  capacity: number // K — marks the chart can hold. A constant, not an output.
  halfLifeMs: number // exponential decay half-life for concept weight
  confidenceFloor: number // candidates below this never surface (a missing mark costs less than a wrong one)
  hysteresisMargin: number // challenger must exceed weakest incumbent's weight by this fraction
  hysteresisTicks: number // ...sustained for this many consecutive ticks
  tickMs: number // 10Hz state rate
  nudgeFactor: number // fast-loop weight nudge per pending-text recurrence hit
  slackAfterMs: number // silence longer than this is slack
}

export const DEFAULT_SALIENCE_CONFIG: SalienceConfig = {
  capacity: 7,
  halfLifeMs: 45_000,
  confidenceFloor: 0.3,
  hysteresisMargin: 0.15,
  hysteresisTicks: 5,
  tickMs: 100,
  nudgeFactor: 0.05,
  slackAfterMs: 5_000,
}
```

- Produces: `class ReadingDynamics` with:
  - `constructor(resolver: IdentityResolver, config: SalienceConfig)`
  - `applyCandidates(t: Ms, candidates: ConceptCandidate[]): void`
  - `nudge(t: Ms, pendingText: string): void` (Task 7 — stub `{}` body in this task)
  - `tick(t: Ms): { transitions: Transition[]; reading: Reading }`

- [ ] **Step 1: Write failing tests**

`tests/dynamics.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { ConceptCandidate } from '../src/core/types'

function cand(label: string, strength = 1, confidence = 1): ConceptCandidate {
  return { label, strength, confidence, source: 'test', segmentId: 's1' }
}
function makeDynamics(overrides: Partial<typeof DEFAULT_SALIENCE_CONFIG> = {}) {
  return new ReadingDynamics(new TokenIdentityResolver(), { ...DEFAULT_SALIENCE_CONFIG, ...overrides })
}

describe('ReadingDynamics core', () => {
  it('surfaces a new concept with an appeared transition', () => {
    const d = makeDynamics()
    d.applyCandidates(1000, [cand('sister')])
    const { transitions, reading } = d.tick(1100)
    expect(transitions).toContainEqual({ kind: 'appeared', conceptId: 'c1', label: 'sister' })
    expect(reading.marks.map((m) => m.label)).toEqual(['sister'])
  })

  it('accumulates weight into the same concept via the resolver', () => {
    const d = makeDynamics()
    d.applyCandidates(1000, [cand('sister')])
    d.applyCandidates(2000, [cand('sisters')]) // plural folds to same concept
    const { reading } = d.tick(2100)
    expect(reading.marks).toHaveLength(1)
    expect(reading.marks[0].weight).toBeGreaterThan(1)
  })

  it('never surfaces more than capacity', () => {
    const d = makeDynamics({ capacity: 3 })
    d.applyCandidates(1000, ['a1', 'b2', 'c3', 'd4', 'e5'].map((l) => cand(l)))
    const { reading } = d.tick(1100)
    expect(reading.marks).toHaveLength(3)
  })

  it('never surfaces a concept below the confidence floor', () => {
    const d = makeDynamics({ confidenceFloor: 0.5 })
    d.applyCandidates(1000, [cand('whisper', 1, 0.2), cand('solid', 1, 0.9)])
    const { reading } = d.tick(1100)
    expect(reading.marks.map((m) => m.label)).toEqual(['solid'])
  })

  it('decays weight exponentially with the configured half-life', () => {
    const d = makeDynamics({ halfLifeMs: 10_000 })
    d.applyCandidates(0, [cand('fading')])
    const w0 = d.tick(100).reading.marks[0].weight
    const w1 = d.tick(10_100).reading.marks[0].weight
    expect(w1).toBeCloseTo(w0 / 2, 5)
  })

  it('prominence is field-relative and sums to 1', () => {
    const d = makeDynamics()
    d.applyCandidates(1000, [cand('big', 1, 1), cand('small', 0.25, 1)])
    const { reading } = d.tick(1100)
    const total = reading.marks.reduce((s, m) => s + m.prominence, 0)
    expect(total).toBeCloseTo(1, 9)
    expect(reading.marks[0].label).toBe('big')
    expect(reading.marks[0].prominence).toBeGreaterThan(reading.marks[1].prominence)
  })

  it('reports slack after silence and not before', () => {
    const d = makeDynamics({ slackAfterMs: 5000 })
    d.applyCandidates(1000, [cand('sister')])
    expect(d.tick(2000).reading.slack).toBe(false)
    expect(d.tick(7000).reading.slack).toBe(true)
  })

  it('is deterministic across identical runs', () => {
    const run = () => {
      const d = makeDynamics()
      d.applyCandidates(1000, [cand('a1'), cand('b2')])
      d.applyCandidates(2000, [cand('b2'), cand('c3')])
      return JSON.stringify(d.tick(2100))
    }
    expect(run()).toBe(run())
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dynamics.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Implement**

Create `src/salience/config.ts` exactly as in the Interfaces block. Then `src/salience/dynamics.ts`:
```ts
import type { Concept, ConceptCandidate, Ms, Reading, Transition } from '../core/types'
import type { IdentityResolver } from './identity'
import type { SalienceConfig } from './config'

/**
 * The app. Owns promotion and demotion under contention: decay, fixed
 * capacity, confidence floor, hysteresis (Task 7), fast-loop nudges (Task 7).
 * Pure function of the event stream — advances only via the timestamps it is
 * handed, never wall clock.
 */
export class ReadingDynamics {
  private concepts = new Map<string, Concept>()
  private surfaced: string[] = []
  private streaks = new Map<string, number>() // challenger conceptId -> consecutive qualifying ticks
  private pendingTransitions: Transition[] = []
  private lastT: Ms = 0
  private lastSpeechT: Ms = 0
  private nextConceptSeq = 1

  constructor(
    private readonly resolver: IdentityResolver,
    private readonly config: SalienceConfig,
  ) {}

  applyCandidates(t: Ms, candidates: ConceptCandidate[]): void {
    this.decayTo(t)
    this.lastSpeechT = t
    for (const cand of candidates) {
      const support = cand.strength * cand.confidence
      const existingId = this.resolver.resolve(cand, [...this.concepts.values()])
      if (existingId !== null) {
        const c = this.concepts.get(existingId)!
        c.weight += support
        c.confidence = Math.max(c.confidence, cand.confidence)
        c.lastSupportT = t
      } else {
        const id = `c${this.nextConceptSeq++}`
        this.concepts.set(id, {
          id, label: cand.label, weight: support,
          confidence: cand.confidence, firstSeenT: t, lastSupportT: t,
        })
      }
    }
  }

  nudge(_t: Ms, _pendingText: string): void {
    // fast-loop weight nudges — implemented in the hysteresis/nudge task
  }

  tick(t: Ms): { transitions: Transition[]; reading: Reading } {
    this.decayTo(t)
    const transitions = this.pendingTransitions
    this.pendingTransitions = []

    const surfacedSet = new Set(this.surfaced)
    const eligible = [...this.concepts.values()]
      .filter((c) => c.confidence >= this.config.confidenceFloor)
      .sort((a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : 1))

    // Fill free slots — appearing into an empty slot needs no hysteresis.
    for (const c of eligible) {
      if (this.surfaced.length >= this.config.capacity) break
      if (!surfacedSet.has(c.id)) {
        this.surfaced.push(c.id)
        surfacedSet.add(c.id)
        transitions.push({ kind: 'appeared', conceptId: c.id, label: c.label })
      }
    }

    this.contest(transitions, eligible, surfacedSet)

    const surfacedConcepts = this.surfaced.map((id) => this.concepts.get(id)!)
    const total = surfacedConcepts.reduce((s, c) => s + c.weight, 0) || 1
    const marks = surfacedConcepts
      .map((c) => ({ conceptId: c.id, label: c.label, prominence: c.weight / total, weight: c.weight }))
      .sort((a, b) => (b.prominence - a.prominence) || (a.conceptId < b.conceptId ? -1 : 1))

    return {
      transitions,
      reading: { t, slack: t - this.lastSpeechT > this.config.slackAfterMs, marks },
    }
  }

  private contest(_transitions: Transition[], _eligible: Concept[], _surfacedSet: Set<string>): void {
    // displacement under contention with hysteresis — implemented in Task 7
  }

  private decayTo(t: Ms): void {
    const dt = t - this.lastT
    if (dt <= 0) return
    const factor = Math.pow(2, -dt / this.config.halfLifeMs)
    for (const c of this.concepts.values()) c.weight *= factor
    this.lastT = t
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dynamics.test.ts && npm run typecheck`
Expected: PASS (8 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/salience/config.ts src/salience/dynamics.ts tests/dynamics.test.ts
git commit -m "feat: salience config and reading dynamics core (decay, capacity, floor, slack)"
```

---

### Task 7: Hysteresis displacement + fast-loop nudges

**Files:**
- Modify: `src/salience/dynamics.ts` (fill in `contest` and `nudge`)
- Test: `tests/hysteresis.test.ts`

**Interfaces:**
- Consumes/Produces: same `ReadingDynamics` API as Task 6 — no signature changes, only behavior.

- [ ] **Step 1: Write failing tests**

`tests/hysteresis.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { ConceptCandidate, Transition } from '../src/core/types'

function cand(label: string, strength = 1, confidence = 1): ConceptCandidate {
  return { label, strength, confidence, source: 'test', segmentId: 's1' }
}
const CFG = { ...DEFAULT_SALIENCE_CONFIG, capacity: 2, hysteresisMargin: 0.15, hysteresisTicks: 3, tickMs: 100 }

function makeFull() {
  const d = new ReadingDynamics(new TokenIdentityResolver(), CFG)
  d.applyCandidates(1000, [cand('alpha', 1), cand('beta', 0.4)])
  d.tick(1100) // alpha and beta fill both slots
  return d
}

describe('hysteresis displacement', () => {
  it('a challenger below the margin never displaces', () => {
    const d = makeFull()
    // gamma's weight ends up between beta and beta * 1.15
    d.applyCandidates(1200, [cand('gamma', 0.42)])
    const all: Transition[] = []
    for (let t = 1300; t <= 3000; t += 100) all.push(...d.tick(t).transitions)
    expect(all.filter((tr) => tr.kind === 'displaced')).toEqual([])
  })

  it('a challenger above the margin displaces only after the streak completes', () => {
    const d = makeFull()
    d.applyCandidates(1200, [cand('gamma', 0.9)]) // well above beta * 1.15
    const t1 = d.tick(1300).transitions
    const t2 = d.tick(1400).transitions
    const t3 = d.tick(1500).transitions // 3rd qualifying tick -> displacement
    expect([...t1, ...t2].filter((tr) => tr.kind === 'displaced')).toEqual([])
    const displaced = t3.filter((tr) => tr.kind === 'displaced')
    expect(displaced).toHaveLength(1)
    expect(displaced[0]).toMatchObject({ kind: 'displaced', label: 'beta' })
    expect(t3).toContainEqual(expect.objectContaining({ kind: 'appeared', label: 'gamma' }))
  })

  it('an interrupted streak resets', () => {
    const d = makeFull()
    d.applyCandidates(1200, [cand('gamma', 0.9)])
    d.tick(1300); d.tick(1400) // 2 qualifying ticks
    d.applyCandidates(1450, [cand('beta', 1)]) // beta re-supported, gamma no longer qualifies
    d.tick(1500) // streak resets
    d.applyCandidates(1550, [cand('gamma', 0.2)])
    const all: Transition[] = []
    for (let t = 1600; t <= 1800; t += 100) all.push(...d.tick(t).transitions)
    expect(all.filter((tr) => tr.kind === 'displaced')).toEqual([])
  })

  it('at most one displacement per tick', () => {
    const d = makeFull()
    d.applyCandidates(1200, [cand('gamma', 0.9), cand('delta', 0.95)])
    for (let t = 1300; t <= 2000; t += 100) {
      const displaced = d.tick(t).transitions.filter((tr) => tr.kind === 'displaced')
      expect(displaced.length).toBeLessThanOrEqual(1)
    }
  })
})

describe('fast-loop nudges', () => {
  it('pending text mentioning a surfaced concept nudges its weight', () => {
    const d = makeFull()
    const before = d.tick(1200).reading.marks.find((m) => m.label === 'alpha')!.weight
    d.nudge(1250, 'talking about alpha again right now')
    const res = d.tick(1300)
    const after = res.reading.marks.find((m) => m.label === 'alpha')!.weight
    expect(after).toBeGreaterThan(before * Math.pow(2, -100 / CFG.halfLifeMs)) // grew despite decay
    expect(res.transitions).toContainEqual(
      expect.objectContaining({ kind: 'nudged', delta: CFG.nudgeFactor }),
    )
  })

  it('pending text does NOT create new concepts', () => {
    const d = makeFull()
    d.nudge(1250, 'something entirely new like zeppelins')
    const { reading } = d.tick(1300)
    expect(reading.marks.map((m) => m.label).sort()).toEqual(['alpha', 'beta'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hysteresis.test.ts`
Expected: FAIL — no displacements occur, no nudges occur.

- [ ] **Step 3: Implement**

In `src/salience/dynamics.ts`, replace the `nudge` and `contest` bodies:

```ts
  nudge(t: Ms, pendingText: string): void {
    this.decayTo(t)
    this.lastSpeechT = t
    const pendingTokens = new Set(tokenize(pendingText))
    for (const id of this.surfaced) {
      const c = this.concepts.get(id)!
      const labelTokens = c.label.split(' ')
      if (labelTokens.every((tok) => pendingTokens.has(tok))) {
        c.weight += this.config.nudgeFactor
        this.pendingTransitions.push({ kind: 'nudged', conceptId: id, delta: this.config.nudgeFactor })
      }
    }
  }

  private contest(transitions: Transition[], eligible: Concept[], surfacedSet: Set<string>): void {
    if (this.surfaced.length < this.config.capacity) return
    const incumbents = this.surfaced
      .map((id) => this.concepts.get(id)!)
      .sort((a, b) => (a.weight - b.weight) || (a.id < b.id ? -1 : 1))
    const weakest = incumbents[0]
    const bar = weakest.weight * (1 + this.config.hysteresisMargin)

    const challengers = eligible.filter((c) => !surfacedSet.has(c.id))
    for (const ch of challengers) {
      if (ch.weight > bar) {
        this.streaks.set(ch.id, (this.streaks.get(ch.id) ?? 0) + 1)
      } else {
        this.streaks.delete(ch.id)
      }
    }
    for (const id of [...this.streaks.keys()]) {
      if (!this.concepts.has(id) || surfacedSet.has(id)) this.streaks.delete(id)
    }

    // One displacement per tick: the strongest challenger with a full streak.
    // (challengers is already sorted by weight desc — it derives from eligible.)
    const ready = challengers.find((ch) => (this.streaks.get(ch.id) ?? 0) >= this.config.hysteresisTicks)
    if (ready) {
      this.surfaced = this.surfaced.filter((id) => id !== weakest.id)
      this.surfaced.push(ready.id)
      surfacedSet.delete(weakest.id)
      surfacedSet.add(ready.id)
      this.streaks.delete(ready.id)
      transitions.push({ kind: 'displaced', conceptId: weakest.id, label: weakest.label, byConceptId: ready.id })
      transitions.push({ kind: 'appeared', conceptId: ready.id, label: ready.label })
    }
  }
```

Add the import at the top of the file:
```ts
import { tokenize } from '../core/text'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/hysteresis.test.ts tests/dynamics.test.ts`
Expected: PASS — both new tests and all Task 6 tests (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/salience/dynamics.ts tests/hysteresis.test.ts
git commit -m "feat: hysteresis displacement and fast-loop nudges"
```

---

### Task 8: SoundingSession (`core/session.ts`)

**Files:**
- Create: `src/core/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `EventLog`, `SoundingEvent` (Task 3), `Interpreter`, `Transcript` (Task 4), `ReadingDynamics` (Tasks 6–7), `SalienceConfig` (Task 6).
- Produces:

```ts
export class SoundingSession {
  readonly log: EventLog
  constructor(interpreter: Interpreter, dynamics: ReadingDynamics, config: SalienceConfig, soundingId: string)
  drop(): void                       // appends sounding.dropped at t=0
  advanceTo(t: Ms): void             // emits reading.changed ticks up to t
  feedPending(t: Ms, text: string): void
  feedCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void>
  surface(t: Ms): void               // final ticks + sounding.surfaced
}
```

- [ ] **Step 1: Write failing tests**

`tests/session.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import { RecurrenceInterpreter } from '../src/interpret/recurrence'

function makeSession() {
  const config = DEFAULT_SALIENCE_CONFIG
  const dynamics = new ReadingDynamics(new TokenIdentityResolver(), config)
  return new SoundingSession(new RecurrenceInterpreter(), dynamics, config, 'test-sounding')
}

describe('SoundingSession', () => {
  it('drop appends sounding.dropped at t=0', () => {
    const s = makeSession()
    s.drop()
    expect(s.log.all()).toEqual([{ type: 'sounding.dropped', t: 0, soundingId: 'test-sounding' }])
  })

  it('advanceTo emits one reading.changed per tick interval', () => {
    const s = makeSession()
    s.drop()
    s.advanceTo(550) // tickMs=100 -> ticks at 100..500
    const ticks = s.log.all().filter((e) => e.type === 'reading.changed')
    expect(ticks.map((e) => e.t)).toEqual([100, 200, 300, 400, 500])
  })

  it('feedCommitted appends segment, then candidates, and feeds dynamics', async () => {
    const s = makeSession()
    s.drop()
    await s.feedCommitted(4000, { segmentId: 'seg1', transcript: 'my sister and the offer', startT: 0, endT: 4000 })
    await s.feedCommitted(8000, { segmentId: 'seg2', transcript: 'my sister likes the offer', startT: 4000, endT: 8000 })
    const types = s.log.all().map((e) => e.type)
    expect(types.filter((t) => t === 'segment.committed')).toHaveLength(2)
    expect(types.filter((t) => t === 'candidates.emitted')).toHaveLength(2)
    // ticks precede the event that shares/exceeds their timestamp
    expect(types.indexOf('segment.committed')).toBeGreaterThan(types.indexOf('reading.changed'))
    s.advanceTo(8200)
    const last = s.log.all().at(-1)!
    expect(last.type).toBe('reading.changed')
    if (last.type === 'reading.changed') {
      expect(last.reading.marks.map((m) => m.label)).toContain('sister')
    }
  })

  it('feedPending appends the event and timestamps stay monotonic', async () => {
    const s = makeSession()
    s.drop()
    s.feedPending(300, 'my sister')
    await s.feedCommitted(4000, { segmentId: 'seg1', transcript: 'my sister called', startT: 0, endT: 4000 })
    const ts = s.log.all().map((e) => e.t)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
  })

  it('surface finishes the log', () => {
    const s = makeSession()
    s.drop()
    s.surface(1000)
    expect(s.log.all().at(-1)).toEqual({ type: 'sounding.surfaced', t: 1000 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — cannot resolve `../src/core/session`.

- [ ] **Step 3: Implement**

`src/core/session.ts`:
```ts
import { EventLog } from './events'
import type { Ms } from './types'
import type { Interpreter } from '../interpret/port'
import type { ReadingDynamics } from '../salience/dynamics'
import type { SalienceConfig } from '../salience/config'

/**
 * One sounding, from drop to surface. Wires segmentation output through the
 * interpretation port into the reading dynamics, and owns the 10Hz tick.
 * Time only moves when the caller hands it a timestamp — replay and live
 * mode are indistinguishable from here down.
 */
export class SoundingSession {
  readonly log = new EventLog()
  private lastTick: Ms = 0

  constructor(
    private readonly interpreter: Interpreter,
    private readonly dynamics: ReadingDynamics,
    private readonly config: SalienceConfig,
    private readonly soundingId: string,
  ) {}

  drop(): void {
    this.log.append({ type: 'sounding.dropped', t: 0, soundingId: this.soundingId })
  }

  advanceTo(t: Ms): void {
    while (this.lastTick + this.config.tickMs <= t) {
      this.lastTick += this.config.tickMs
      const { transitions, reading } = this.dynamics.tick(this.lastTick)
      this.log.append({ type: 'reading.changed', t: this.lastTick, transitions, reading })
    }
  }

  feedPending(t: Ms, text: string): void {
    this.advanceTo(t)
    this.log.append({ type: 'segment.pending', t, text })
    this.dynamics.nudge(t, text)
  }

  async feedCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void> {
    this.advanceTo(t)
    this.log.append({ type: 'segment.committed', t, ...seg })
    const result = await this.interpreter.interpret({
      kind: 'transcript', segmentId: seg.segmentId, text: seg.transcript,
      startT: seg.startT, endT: seg.endT,
    })
    this.log.append({
      type: 'candidates.emitted', t, segmentId: seg.segmentId, source: this.interpreter.id,
      candidates: result.candidates, costUsd: result.costUsd, latencyMs: result.latencyMs,
    })
    this.dynamics.applyCandidates(t, result.candidates)
  }

  surface(t: Ms): void {
    this.advanceTo(t)
    this.log.append({ type: 'sounding.surfaced', t })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session.test.ts && npm run typecheck`
Expected: PASS (5 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts tests/session.test.ts
git commit -m "feat: SoundingSession wires interpreter and dynamics over the event log"
```

---

### Task 9: Fixture builder + replay runner

**Files:**
- Create: `src/replay/fixture.ts`, `src/replay/runner.ts`
- Test: `tests/replay.test.ts`

**Interfaces:**
- Consumes: `SoundingSession` (Task 8), `RecurrenceInterpreter` (Task 4), `TokenIdentityResolver` (Task 5), `ReadingDynamics` (Tasks 6–7), `DEFAULT_SALIENCE_CONFIG` (Task 6).
- Produces:

`src/replay/fixture.ts` types:
```ts
export interface FixtureSegment { startT: Ms; endT: Ms; text: string }

export interface FixtureTruth {
  /** normalized labels this monologue circles; must surface and persist */
  circles?: string[]
  /** label -> latest acceptable surfacing time */
  surfacesBy?: Record<string, Ms>
  topicShiftAt?: Ms
  /** labels that are the same concept but differently worded (v0 known-failure group) */
  driftGroup?: string[]
  notes?: string
}

export interface FixtureScript {
  name: string
  description: string
  endT: Ms
  configOverrides?: Partial<SalienceConfig>
  segments: FixtureSegment[]
  truth: FixtureTruth
}

export type CaptureEvent =
  | { type: 'segment.pending'; t: Ms; text: string }
  | { type: 'segment.committed'; t: Ms; segmentId: string; transcript: string; startT: Ms; endT: Ms }

export const PENDING_INTERVAL_MS = 300

/** Derive word-cadence pending events + committed events from a script. Deterministic. */
export function buildCaptureEvents(script: FixtureScript): CaptureEvent[]
```

`src/replay/runner.ts`:
```ts
export class ReplayRunner {
  constructor(session: SoundingSession, events: CaptureEvent[], endT: Ms)
  advanceTo(t: Ms): Promise<void>  // feed all events with t' <= t, then tick to min(t, endT)
  runToEnd(): Promise<void>        // advanceTo(endT) then session.surface(endT)
}

/** Composition root shared by tests and the UI. */
export function createReplay(script: FixtureScript): { session: SoundingSession; runner: ReplayRunner }
```

- [ ] **Step 1: Write failing tests**

`tests/replay.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildCaptureEvents, PENDING_INTERVAL_MS } from '../src/replay/fixture'
import { createReplay } from '../src/replay/runner'
import type { FixtureScript } from '../src/replay/fixture'

const tiny: FixtureScript = {
  name: 'tiny',
  description: 'two segments about a sister',
  endT: 10_000,
  segments: [
    { startT: 0, endT: 4000, text: 'my sister called about the offer' },
    { startT: 5000, endT: 9000, text: 'my sister thinks the offer is right' },
  ],
  truth: {},
}

describe('buildCaptureEvents', () => {
  it('emits accumulating pending text at the pending cadence, then the committed segment', () => {
    const events = buildCaptureEvents(tiny)
    const first = events.filter((e) => e.t <= 4000)
    const pendings = first.filter((e) => e.type === 'segment.pending')
    expect(pendings.length).toBeGreaterThan(4) // 4000ms / 300ms cadence
    expect(pendings[0].t).toBe(PENDING_INTERVAL_MS)
    // pending text accumulates
    const texts = pendings.map((e) => (e.type === 'segment.pending' ? e.text : ''))
    expect(texts[texts.length - 1].split(' ').length).toBeGreaterThanOrEqual(texts[0].split(' ').length)
    const committed = first.at(-1)!
    expect(committed).toMatchObject({ type: 'segment.committed', t: 4000, transcript: tiny.segments[0].text })
  })

  it('is sorted by t and deterministic', () => {
    const a = buildCaptureEvents(tiny)
    const b = buildCaptureEvents(tiny)
    expect(a).toEqual(b)
    const ts = a.map((e) => e.t)
    expect([...ts].sort((x, y) => x - y)).toEqual(ts)
  })

  it('gives segments sequential ids', () => {
    const ids = buildCaptureEvents(tiny)
      .filter((e) => e.type === 'segment.committed')
      .map((e) => (e.type === 'segment.committed' ? e.segmentId : ''))
    expect(ids).toEqual(['seg1', 'seg2'])
  })
})

describe('ReplayRunner', () => {
  it('runToEnd produces a complete log: dropped ... surfaced', async () => {
    const { session, runner } = createReplay(tiny)
    await runner.runToEnd()
    const types = session.log.all().map((e) => e.type)
    expect(types[0]).toBe('sounding.dropped')
    expect(types.at(-1)).toBe('sounding.surfaced')
    expect(types).toContain('segment.committed')
    expect(types).toContain('candidates.emitted')
    expect(types).toContain('reading.changed')
  })

  it('advanceTo is incremental: partial advance then rest equals one full run', async () => {
    const a = createReplay(tiny)
    await a.runner.advanceTo(6000)
    await a.runner.runToEnd()
    const b = createReplay(tiny)
    await b.runner.runToEnd()
    expect(a.session.log.toJsonl()).toBe(b.session.log.toJsonl())
  })

  it('the recurring concept surfaces in the reading', async () => {
    const { session, runner } = createReplay(tiny)
    await runner.runToEnd()
    const readings = session.log.all().filter((e) => e.type === 'reading.changed')
    const last = readings.at(-1)!
    if (last.type === 'reading.changed') {
      expect(last.reading.marks.map((m) => m.label)).toContain('sister')
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/replay.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Implement**

`src/replay/fixture.ts`:
```ts
import type { Ms } from '../core/types'
import type { SalienceConfig } from '../salience/config'

export interface FixtureSegment { startT: Ms; endT: Ms; text: string }

export interface FixtureTruth {
  circles?: string[]
  surfacesBy?: Record<string, Ms>
  topicShiftAt?: Ms
  driftGroup?: string[]
  notes?: string
}

export interface FixtureScript {
  name: string
  description: string
  endT: Ms
  configOverrides?: Partial<SalienceConfig>
  segments: FixtureSegment[]
  truth: FixtureTruth
}

export type CaptureEvent =
  | { type: 'segment.pending'; t: Ms; text: string }
  | { type: 'segment.committed'; t: Ms; segmentId: string; transcript: string; startT: Ms; endT: Ms }

export const PENDING_INTERVAL_MS = 300

/**
 * A fixture script is the monologue as authored; this derives the capture
 * events a live segmenter would have produced: accumulating pending text at
 * a fixed cadence (words spread evenly across the segment), then the commit.
 */
export function buildCaptureEvents(script: FixtureScript): CaptureEvent[] {
  const events: CaptureEvent[] = []
  script.segments.forEach((seg, i) => {
    const words = seg.text.split(/\s+/)
    const duration = seg.endT - seg.startT
    for (let t = seg.startT + PENDING_INTERVAL_MS; t < seg.endT; t += PENDING_INTERVAL_MS) {
      const progress = (t - seg.startT) / duration
      const wordCount = Math.max(1, Math.floor(words.length * progress))
      events.push({ type: 'segment.pending', t, text: words.slice(0, wordCount).join(' ') })
    }
    events.push({
      type: 'segment.committed', t: seg.endT, segmentId: `seg${i + 1}`,
      transcript: seg.text, startT: seg.startT, endT: seg.endT,
    })
  })
  return events.sort((a, b) => a.t - b.t)
}
```

`src/replay/runner.ts`:
```ts
import { SoundingSession } from '../core/session'
import { ReadingDynamics } from '../salience/dynamics'
import { TokenIdentityResolver } from '../salience/identity'
import { DEFAULT_SALIENCE_CONFIG } from '../salience/config'
import { RecurrenceInterpreter } from '../interpret/recurrence'
import { buildCaptureEvents } from './fixture'
import type { CaptureEvent, FixtureScript } from './fixture'
import type { Ms } from '../core/types'

/**
 * Drives capture events through a session. The only difference between a
 * test (∞x) and the UI (1x) is how often advanceTo is called and with what
 * timestamps — the pipeline underneath is identical.
 */
export class ReplayRunner {
  private idx = 0

  constructor(
    private readonly session: SoundingSession,
    private readonly events: CaptureEvent[],
    private readonly endT: Ms,
  ) {}

  async advanceTo(t: Ms): Promise<void> {
    const target = Math.min(t, this.endT)
    while (this.idx < this.events.length && this.events[this.idx].t <= target) {
      const e = this.events[this.idx++]
      if (e.type === 'segment.pending') {
        this.session.feedPending(e.t, e.text)
      } else {
        await this.session.feedCommitted(e.t, {
          segmentId: e.segmentId, transcript: e.transcript, startT: e.startT, endT: e.endT,
        })
      }
    }
    this.session.advanceTo(target)
  }

  async runToEnd(): Promise<void> {
    await this.advanceTo(this.endT)
    this.session.surface(this.endT)
  }
}

export function createReplay(script: FixtureScript): { session: SoundingSession; runner: ReplayRunner } {
  const config = { ...DEFAULT_SALIENCE_CONFIG, ...script.configOverrides }
  const dynamics = new ReadingDynamics(new TokenIdentityResolver(), config)
  const session = new SoundingSession(new RecurrenceInterpreter(), dynamics, config, script.name)
  session.drop()
  const runner = new ReplayRunner(session, buildCaptureEvents(script), script.endT)
  return { session, runner }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/replay.test.ts && npm run typecheck`
Expected: PASS (6 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/replay/fixture.ts src/replay/runner.ts tests/replay.test.ts
git commit -m "feat: fixture builder and replay runner with shared composition root"
```

---

### Task 10: Cost/latency counters (`replay/counters.ts`)

**Files:**
- Create: `src/replay/counters.ts`
- Test: `tests/counters.test.ts`

**Interfaces:**
- Consumes: `SoundingEvent` (Task 3).
- Produces: `summarizeCounters(events: readonly SoundingEvent[]): CounterSummary` where `CounterSummary = { callCount: number; totalCostUsd: number; meanLatencyMs: number; maxLatencyMs: number }`.

- [ ] **Step 1: Write failing tests**

`tests/counters.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { summarizeCounters } from '../src/replay/counters'
import type { SoundingEvent } from '../src/core/events'

function call(costUsd: number, latencyMs: number): SoundingEvent {
  return { type: 'candidates.emitted', t: 0, segmentId: 's', source: 'x', candidates: [], costUsd, latencyMs }
}

describe('summarizeCounters', () => {
  it('aggregates cost and latency across interpretation calls', () => {
    const events: SoundingEvent[] = [
      { type: 'sounding.dropped', t: 0, soundingId: 's1' },
      call(0.001, 200), call(0.002, 400), call(0, 0),
    ]
    expect(summarizeCounters(events)).toEqual({
      callCount: 3, totalCostUsd: 0.003, meanLatencyMs: 200, maxLatencyMs: 400,
    })
  })

  it('handles an empty log', () => {
    expect(summarizeCounters([])).toEqual({ callCount: 0, totalCostUsd: 0, meanLatencyMs: 0, maxLatencyMs: 0 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/counters.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

`src/replay/counters.ts`:
```ts
import type { SoundingEvent } from '../core/events'

export interface CounterSummary {
  callCount: number
  totalCostUsd: number
  meanLatencyMs: number
  maxLatencyMs: number
}

/**
 * The day-one insurance from the brief: when the reading finally feels
 * right, these say whether it happened at 3c/min or 30c/min.
 */
export function summarizeCounters(events: readonly SoundingEvent[]): CounterSummary {
  const calls = events.filter((e) => e.type === 'candidates.emitted')
  if (calls.length === 0) return { callCount: 0, totalCostUsd: 0, meanLatencyMs: 0, maxLatencyMs: 0 }
  let totalCost = 0
  let totalLatency = 0
  let maxLatency = 0
  for (const c of calls) {
    if (c.type !== 'candidates.emitted') continue
    totalCost += c.costUsd
    totalLatency += c.latencyMs
    if (c.latencyMs > maxLatency) maxLatency = c.latencyMs
  }
  return {
    callCount: calls.length,
    totalCostUsd: Number(totalCost.toFixed(6)),
    meanLatencyMs: totalLatency / calls.length,
    maxLatencyMs: maxLatency,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/counters.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/replay/counters.ts tests/counters.test.ts
git commit -m "feat: cost and latency counters over the event log"
```

---

### Task 11: Fixtures — circling + slack, with dynamics assertions

**Files:**
- Create: `src/replay/fixtures/circling.ts`, `src/replay/fixtures/slack.ts`, `src/replay/fixtures/index.ts`
- Test: `tests/fixtures-circling-slack.test.ts`

**Interfaces:**
- Consumes: `FixtureScript` (Task 9), `createReplay` (Task 9).
- Produces: `export const circling: FixtureScript`, `export const slack: FixtureScript`; `src/replay/fixtures/index.ts` exports `FIXTURES: FixtureScript[]` (extended by Tasks 12–13; each task appends its fixtures to the array).

**Note on assertion tuning:** the dynamics assertions in Tasks 11–13 encode the *intent* in `truth`; if an assertion fails, first check whether the engine is wrong (fix the engine) — only if the engine is behaving as specified may the fixture's threshold constants (times, ranks) be adjusted, and the adjustment must be noted in the commit message. Do not weaken `marks.length <= capacity` or determinism assertions ever.

- [ ] **Step 1: Write the fixtures**

`src/replay/fixtures/circling.ts`:
```ts
import type { FixtureScript } from '../fixture'

/**
 * A job decision where the expected concepts are salary/commute/offer —
 * and what the talking actually circles is the sister. The reading must
 * show that (BRIEF.md: "that is not a failure of extraction, that is the
 * reading").
 */
export const circling: FixtureScript = {
  name: 'circling',
  description: 'Job-offer decision that keeps returning to the sister',
  endT: 82_000,
  segments: [
    { startT: 0, endT: 4000, text: 'So I got the offer letter yesterday and I keep staring at it instead of signing it' },
    { startT: 5000, endT: 9000, text: 'The salary is fine, honestly the salary was never the problem here' },
    { startT: 10_000, endT: 14_000, text: 'My sister called last night and we talked about the offer for an hour' },
    { startT: 15_000, endT: 19_000, text: 'She said something about how I always stall when things get real' },
    { startT: 20_000, endT: 24_000, text: 'The commute would be longer but people survive commutes, that part is fine' },
    { startT: 25_000, endT: 29_000, text: 'My sister went through the same thing two years ago when she moved to Denver' },
    { startT: 30_000, endT: 34_000, text: 'I keep coming back to what my sister said about stalling' },
    { startT: 35_000, endT: 39_000, text: 'The team seems good, the manager seems good, the work seems fine' },
    { startT: 40_000, endT: 44_000, text: 'Maybe this is not about the job at all, maybe it is about my sister being the brave one' },
    { startT: 45_000, endT: 49_000, text: 'She took her offer in a week and never looked back' },
    { startT: 50_000, endT: 54_000, text: 'I have been comparing myself to my sister since we were kids' },
    { startT: 55_000, endT: 59_000, text: 'The offer expires Friday and I still have not signed it' },
    { startT: 60_000, endT: 64_000, text: 'Every time I think about signing I think about calling my sister first' },
    { startT: 65_000, endT: 69_000, text: 'That is the pattern, I cannot decide anything without her blessing' },
    { startT: 70_000, endT: 74_000, text: 'The job is fine, the offer is fine, the salary is fine' },
    { startT: 75_000, endT: 79_000, text: 'It was never about the offer, it was about my sister' },
  ],
  truth: {
    circles: ['sister'],
    surfacesBy: { sister: 40_000 },
    notes: 'sister must surface by 40s, persist to the end, and finish in the top 3 by prominence',
  },
}
```

`src/replay/fixtures/slack.ts`:
```ts
import type { FixtureScript } from '../fixture'

/** Five segments of garden planning, then 45 seconds of silence. */
export const slack: FixtureScript = {
  name: 'slack',
  description: 'Short think about the garden, then extended silence',
  endT: 70_000,
  segments: [
    { startT: 0, endT: 4000, text: 'I want to plan the garden this spring, what to plant where' },
    { startT: 5000, endT: 9000, text: 'Tomatoes failed last year because the shade from the fence got worse' },
    { startT: 10_000, endT: 14_000, text: 'Maybe tomatoes belong on the south bed this year' },
    { startT: 15_000, endT: 19_000, text: 'The south bed gets sun until four at least' },
    { startT: 20_000, endT: 24_000, text: 'Tomatoes and basil on the south bed, that could work' },
  ],
  truth: {
    circles: ['tomatoe'],
    notes: 'after 24s nothing new appears; weights decay; slack flag turns on. (normalizeToken folds "tomatoes" -> "tomatoe")',
  },
}
```

`src/replay/fixtures/index.ts`:
```ts
import type { FixtureScript } from '../fixture'
import { circling } from './circling'
import { slack } from './slack'

export const FIXTURES: FixtureScript[] = [circling, slack]
```

- [ ] **Step 2: Write the dynamics tests**

`tests/fixtures-circling-slack.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createReplay } from '../src/replay/runner'
import { circling } from '../src/replay/fixtures/circling'
import { slack } from '../src/replay/fixtures/slack'
import type { SoundingEvent } from '../src/core/events'

type ReadingEvent = Extract<SoundingEvent, { type: 'reading.changed' }>

async function run(script: typeof circling) {
  const { session, runner } = createReplay(script)
  await runner.runToEnd()
  const events = session.log.all()
  const readings = events.filter((e): e is ReadingEvent => e.type === 'reading.changed')
  return { events, readings, final: readings.at(-1)! }
}

describe('circling fixture', () => {
  it('sister surfaces by the truth deadline and persists to the end', async () => {
    const { readings, final } = await run(circling)
    const firstWithSister = readings.find((r) => r.reading.marks.some((m) => m.label === 'sister'))
    expect(firstWithSister).toBeDefined()
    expect(firstWithSister!.t).toBeLessThanOrEqual(circling.truth.surfacesBy!.sister)
    // persists: every reading after first appearance contains sister
    const after = readings.filter((r) => r.t >= firstWithSister!.t)
    for (const r of after) {
      expect(r.reading.marks.map((m) => m.label)).toContain('sister')
    }
    // finishes in the top 3 by prominence
    const rank = final.reading.marks.findIndex((m) => m.label === 'sister')
    expect(rank).toBeGreaterThanOrEqual(0)
    expect(rank).toBeLessThan(3)
  })

  it('capacity is never exceeded', async () => {
    const { readings } = await run(circling)
    for (const r of readings) expect(r.reading.marks.length).toBeLessThanOrEqual(7)
  })
})

describe('slack fixture', () => {
  it('nothing new appears during the silence', async () => {
    const { readings } = await run(slack)
    const appearedLate = readings
      .filter((r) => r.t > 26_000)
      .flatMap((r) => r.transitions)
      .filter((tr) => tr.kind === 'appeared')
    expect(appearedLate).toEqual([])
  })

  it('weights decay through the silence', async () => {
    const { readings } = await run(slack)
    const at25 = readings.find((r) => r.t === 25_000)!
    const atEnd = readings.at(-1)!
    const weightOf = (r: ReadingEvent, label: string) =>
      r.reading.marks.find((m) => m.label === label)?.weight ?? 0
    // 45s of silence at a 45s half-life halves the weight; 0.6 margin keeps
    // the assertion off the exact floating-point boundary.
    expect(weightOf(atEnd, 'tomatoe')).toBeLessThan(weightOf(at25, 'tomatoe') * 0.6)
  })

  it('slack turns on after the configured silence and was off during speech', async () => {
    const { readings } = await run(slack)
    expect(readings.find((r) => r.t === 20_000)!.reading.slack).toBe(false)
    expect(readings.at(-1)!.reading.slack).toBe(true)
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/fixtures-circling-slack.test.ts`
Expected: PASS. These tests are written against already-implemented behavior — they are acceptance tests, not unit TDD. If any fail, apply the assertion-tuning note above: engine bug → fix engine; correct-but-mistuned threshold → adjust the truth constant and say so in the commit.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/replay/fixtures/ tests/fixtures-circling-slack.test.ts
git commit -m "feat: circling and slack fixtures with dynamics acceptance tests"
```

---

### Task 12: Fixtures — topic shift + contention

**Files:**
- Create: `src/replay/fixtures/topic-shift.ts`, `src/replay/fixtures/contention.ts`
- Modify: `src/replay/fixtures/index.ts` (append both to `FIXTURES`)
- Test: `tests/fixtures-shift-contention.test.ts`

**Interfaces:**
- Consumes: same as Task 11.
- Produces: `export const topicShift: FixtureScript`, `export const contention: FixtureScript`.

- [ ] **Step 1: Write the fixtures**

`src/replay/fixtures/topic-shift.ts`:
```ts
import type { FixtureScript } from '../fixture'

/**
 * Wedding planning for 60s, then a hard shift to a job offer. Old concepts
 * must be displaced within a bounded interval after the shift, with zero
 * displacement churn before it (Word Cloud for Meeting finding).
 * capacity 4 so the shift forces contention rather than slot-filling.
 */
export const topicShift: FixtureScript = {
  name: 'topic-shift',
  description: 'Wedding planning, then a hard shift to a job offer',
  endT: 108_000,
  configOverrides: { capacity: 4 },
  segments: [
    { startT: 0, endT: 4000, text: 'The venue question is the first decision we have to settle' },
    { startT: 4500, endT: 8500, text: 'Everything else about the wedding waits on the venue' },
    { startT: 9000, endT: 13_000, text: 'The barn venue was beautiful but the catering rules were strict' },
    { startT: 13_500, endT: 17_500, text: 'Outside catering is not allowed there which changes the budget' },
    { startT: 18_000, endT: 22_000, text: 'The budget was already tight before we counted the guests' },
    { startT: 22_500, endT: 26_500, text: 'A hundred and forty guests if we invite every cousin' },
    { startT: 27_000, endT: 31_000, text: 'Catering per guest is where the budget actually explodes' },
    { startT: 31_500, endT: 35_500, text: 'We could trim the guests or trim the catering' },
    { startT: 36_000, endT: 40_000, text: 'The venue deposit is due before we know the guest count' },
    { startT: 40_500, endT: 44_500, text: 'A smaller venue caps the guests which caps the catering' },
    { startT: 45_000, endT: 49_000, text: 'So the venue decision is really the budget decision' },
    { startT: 49_500, endT: 53_500, text: 'The garden venue allows outside catering at least' },
    { startT: 54_000, endT: 58_000, text: 'Venue first, then guests, then catering, then the budget falls out' },
    // ---- shift at 60s ----
    { startT: 60_000, endT: 64_000, text: 'Completely different subject, the offer came through this morning' },
    { startT: 64_500, endT: 68_500, text: 'The offer means relocation by January' },
    { startT: 69_000, endT: 73_000, text: 'Relocation in the middle of wedding planning is absurd' },
    { startT: 73_500, endT: 77_500, text: 'The team is the reason to say yes, the team is genuinely great' },
    { startT: 78_000, endT: 82_000, text: 'The deadline on the offer is next Friday' },
    { startT: 82_500, endT: 86_500, text: 'Relocation costs would eat into savings fast' },
    { startT: 87_000, endT: 91_000, text: 'The team lead called me herself about the offer' },
    { startT: 91_500, endT: 95_500, text: 'The deadline is what makes it real, one week to decide on relocation' },
    { startT: 96_000, endT: 100_000, text: 'If the offer is the future the deadline should not scare me' },
    { startT: 100_500, endT: 104_500, text: 'The team, the relocation, the deadline, that is the whole decision' },
  ],
  truth: {
    topicShiftAt: 60_000,
    notes: 'phase 1 concepts: venue/catering/budget/guest; phase 2: offer/relocation/team/deadline. No displacements before the shift; at least 2 after it; final reading majority phase-2.',
  },
}
```

`src/replay/fixtures/contention.ts`:
```ts
import type { FixtureScript } from '../fixture'

/**
 * Nine distinct worries against capacity 4: the reading must stay at 4
 * marks, and later worries must displace earlier ones deterministically.
 */
export const contention: FixtureScript = {
  name: 'contention',
  description: 'Nine money worries contending for four slots',
  endT: 60_000,
  configOverrides: { capacity: 4 },
  segments: [
    { startT: 0, endT: 4000, text: 'The rent is going up again and the rent was already most of my paycheck' },
    { startT: 4500, endT: 8500, text: 'Rent aside, the car is making that noise again' },
    { startT: 9000, endT: 13_000, text: 'The car needs a timing belt and the car shop quoted nine hundred' },
    { startT: 13_500, endT: 17_500, text: 'Insurance renewal is this month too, the insurance went up forty dollars' },
    { startT: 18_000, endT: 22_000, text: 'My laptop is six years old and the laptop battery is done' },
    { startT: 22_500, endT: 26_500, text: 'The vacation fund is what loses, the vacation moves to next year' },
    { startT: 27_000, endT: 31_000, text: 'The dentist appointment I cancelled twice, the dentist will fire me' },
    { startT: 31_500, endT: 35_500, text: 'The tax filing is due in six weeks and the tax folder is empty' },
    { startT: 36_000, endT: 40_000, text: 'The gym membership I never use, the gym is forty a month' },
    { startT: 40_500, endT: 44_500, text: 'The freezer died on Tuesday, the freezer was full of food' },
    { startT: 45_000, endT: 49_000, text: 'So rent, car, insurance, laptop, all landing in the same month' },
    { startT: 49_500, endT: 53_500, text: 'The vacation is cancelled again obviously, the dentist can wait' },
    { startT: 54_000, endT: 58_000, text: 'The tax filing cannot wait, the gym can go, the freezer cannot wait either' },
  ],
  truth: {
    notes: 'capacity 4 with 9+ recurring concepts: >=6 distinct concepts appear over the session, >=2 displacements occur, marks never exceed 4.',
  },
}
```

Update `src/replay/fixtures/index.ts`:
```ts
import type { FixtureScript } from '../fixture'
import { circling } from './circling'
import { slack } from './slack'
import { topicShift } from './topic-shift'
import { contention } from './contention'

export const FIXTURES: FixtureScript[] = [circling, slack, topicShift, contention]
```

- [ ] **Step 2: Write the dynamics tests**

`tests/fixtures-shift-contention.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createReplay } from '../src/replay/runner'
import { topicShift } from '../src/replay/fixtures/topic-shift'
import { contention } from '../src/replay/fixtures/contention'
import type { SoundingEvent } from '../src/core/events'
import type { FixtureScript } from '../src/replay/fixture'

type ReadingEvent = Extract<SoundingEvent, { type: 'reading.changed' }>

async function run(script: FixtureScript) {
  const { session, runner } = createReplay(script)
  await runner.runToEnd()
  const readings = session.log.all().filter((e): e is ReadingEvent => e.type === 'reading.changed')
  return { readings, final: readings.at(-1)! }
}

describe('topic-shift fixture', () => {
  it('no displacements before the shift', async () => {
    const { readings } = await run(topicShift)
    const before = readings
      .filter((r) => r.t < topicShift.truth.topicShiftAt!)
      .flatMap((r) => r.transitions)
      .filter((tr) => tr.kind === 'displaced')
    expect(before).toEqual([])
  })

  it('the new topic displaces the old one after the shift', async () => {
    const { readings, final } = await run(topicShift)
    const after = readings
      .filter((r) => r.t >= topicShift.truth.topicShiftAt!)
      .flatMap((r) => r.transitions)
      .filter((tr) => tr.kind === 'displaced')
    expect(after.length).toBeGreaterThanOrEqual(2)
    const phase2 = ['offer', 'relocation', 'team', 'deadline']
    const finalLabels = final.reading.marks.map((m) => m.label)
    const phase2OnChart = finalLabels.filter((l) => phase2.includes(l))
    expect(phase2OnChart.length).toBeGreaterThanOrEqual(2)
  })
})

describe('contention fixture', () => {
  it('marks never exceed capacity 4', async () => {
    const { readings } = await run(contention)
    for (const r of readings) expect(r.reading.marks.length).toBeLessThanOrEqual(4)
  })

  it('at least 6 distinct concepts appear over the session', async () => {
    const { readings } = await run(contention)
    const appeared = new Set(
      readings.flatMap((r) => r.transitions).filter((tr) => tr.kind === 'appeared')
        .map((tr) => (tr.kind === 'appeared' ? tr.label : '')),
    )
    expect(appeared.size).toBeGreaterThanOrEqual(6)
  })

  it('displacement happens under contention', async () => {
    const { readings } = await run(contention)
    const displaced = readings.flatMap((r) => r.transitions).filter((tr) => tr.kind === 'displaced')
    expect(displaced.length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/fixtures-shift-contention.test.ts`
Expected: PASS, subject to the Task 11 assertion-tuning note (engine bug → fix engine; mistuned threshold → adjust constant, note in commit).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/replay/fixtures/ tests/fixtures-shift-contention.test.ts
git commit -m "feat: topic-shift and contention fixtures with displacement acceptance tests"
```

---

### Task 13: Synonym-drift fixture + determinism + wall-clock guard

**Files:**
- Create: `src/replay/fixtures/synonym-drift.ts`
- Modify: `src/replay/fixtures/index.ts` (append `synonymDrift`)
- Test: `tests/fixtures-drift-determinism.test.ts`

**Interfaces:**
- Consumes: same as Task 11, plus Node `fs`/`path` (test only) for the wall-clock guard.
- Produces: `export const synonymDrift: FixtureScript`; final `FIXTURES` array of 5.

- [ ] **Step 1: Write the fixture**

`src/replay/fixtures/synonym-drift.ts`:
```ts
import type { FixtureScript } from '../fixture'

/**
 * One concept under four labels: grief / mourning / losing / loss.
 * v0 token identity CANNOT merge these — the truth block documents the
 * expected failure (multiple marks), and the test pins it. Slice 2's
 * embedding resolver flips this fixture's expectation to a single mark:
 * that flip is the slice-2 acceptance test.
 */
export const synonymDrift: FixtureScript = {
  name: 'synonym-drift',
  description: 'Grief under four different labels',
  endT: 38_000,
  segments: [
    { startT: 0, endT: 4000, text: 'It has been a year and the grief still shows up unannounced' },
    { startT: 4500, endT: 8500, text: 'Grief is not what I expected, it is quieter' },
    { startT: 9000, endT: 13_000, text: 'The mourning part everyone understands, the casseroles, the cards' },
    { startT: 13_500, endT: 17_500, text: 'But mourning ends for everyone else and continues for you' },
    { startT: 18_000, endT: 22_000, text: 'Losing her rearranged the furniture of every single day' },
    { startT: 22_500, endT: 26_500, text: 'Losing her is present tense, that is what nobody says' },
    { startT: 27_000, endT: 31_000, text: 'The grief and the mourning are the same animal wearing different coats' },
    { startT: 31_500, endT: 35_500, text: 'I circle the loss the way a tongue finds a missing tooth' },
  ],
  truth: {
    driftGroup: ['grief', 'mourning', 'losing', 'loss'],
    notes: 'KNOWN v0 FAILURE, pinned: token identity produces >=2 separate marks for one concept. Slice-2 embedding resolver must reduce this to 1.',
  },
}
```

Update `src/replay/fixtures/index.ts`:
```ts
import type { FixtureScript } from '../fixture'
import { circling } from './circling'
import { slack } from './slack'
import { topicShift } from './topic-shift'
import { contention } from './contention'
import { synonymDrift } from './synonym-drift'

export const FIXTURES: FixtureScript[] = [circling, slack, topicShift, contention, synonymDrift]
```

- [ ] **Step 2: Write the tests**

`tests/fixtures-drift-determinism.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createReplay } from '../src/replay/runner'
import { circling } from '../src/replay/fixtures/circling'
import { synonymDrift } from '../src/replay/fixtures/synonym-drift'
import { FIXTURES } from '../src/replay/fixtures/index'

describe('synonym-drift fixture (pinned v0 limitation)', () => {
  it('token identity splits one concept into multiple marks', async () => {
    const { session, runner } = createReplay(synonymDrift)
    await runner.runToEnd()
    const readings = session.log.all().filter((e) => e.type === 'reading.changed')
    const last = readings.at(-1)!
    if (last.type !== 'reading.changed') throw new Error('unreachable')
    const driftLabels = last.reading.marks
      .map((m) => m.label)
      .filter((l) => synonymDrift.truth.driftGroup!.includes(l))
    // v0 failure, documented: the same concept occupies >= 2 marks.
    // Slice 2 (embedding resolver) must flip this assertion to exactly 1.
    expect(driftLabels.length).toBeGreaterThanOrEqual(2)
  })
})

describe('determinism', () => {
  it('replaying the same fixture twice produces byte-identical logs', async () => {
    const a = createReplay(circling)
    await a.runner.runToEnd()
    const b = createReplay(circling)
    await b.runner.runToEnd()
    expect(a.session.log.toJsonl()).toBe(b.session.log.toJsonl())
  })

  it('registry holds all five fixtures', () => {
    expect(FIXTURES.map((f) => f.name).sort()).toEqual(
      ['circling', 'contention', 'slack', 'synonym-drift', 'topic-shift'],
    )
  })
})

describe('wall-clock guard', () => {
  it('the engine never reads wall clock or randomness', () => {
    const banned = /Date\.now|performance\.now|new Date\(|Math\.random/
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          if (name === 'ui') continue // wall clock is allowed in the UI layer only
          walk(p)
        } else if (p.endsWith('.ts') && banned.test(readFileSync(p, 'utf8'))) {
          offenders.push(p)
        }
      }
    }
    walk('src')
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/fixtures-drift-determinism.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/replay/fixtures/ tests/fixtures-drift-determinism.test.ts
git commit -m "feat: synonym-drift fixture (pinned v0 limitation), determinism and wall-clock guards"
```

---

### Task 14: Deterministic mark layout (`ui/layout.ts`)

**Files:**
- Create: `src/ui/layout.ts`
- Test: `tests/layout.test.ts`

**Interfaces:**
- Consumes: `Reading`, `Mark` (Task 3).
- Produces:

```ts
export interface PlacedMark { conceptId: string; label: string; x: number; y: number; r: number }
export function hashString(s: string): number // FNV-1a, unsigned 32-bit
export function layoutReading(reading: Reading, width: number, height: number): PlacedMark[]
```

Chart-plan view per the spec: marks scattered on a plane, **size alone carries weight, no depth axis**. Position is a deterministic function of `conceptId` (hash → angle + radius from center), then a fixed number of collision-relax iterations. A concept keeps its position for the whole sounding — only its size changes.

- [ ] **Step 1: Write failing tests**

`tests/layout.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { hashString, layoutReading } from '../src/ui/layout'
import type { Reading } from '../src/core/types'

function reading(marks: Array<[string, number]>): Reading {
  const total = marks.reduce((s, [, w]) => s + w, 0) || 1
  return {
    t: 1000, slack: false,
    marks: marks.map(([label, w], i) => ({
      conceptId: `c${i + 1}`, label, prominence: w / total, weight: w,
    })),
  }
}

describe('hashString', () => {
  it('is deterministic and spreads values', () => {
    expect(hashString('sister')).toBe(hashString('sister'))
    expect(hashString('sister')).not.toBe(hashString('offer'))
  })
})

describe('layoutReading', () => {
  const W = 1200, H = 800

  it('is deterministic', () => {
    const r = reading([['sister', 2], ['offer', 1], ['salary', 0.5]])
    expect(layoutReading(r, W, H)).toEqual(layoutReading(r, W, H))
  })

  it('radius increases with prominence', () => {
    const placed = layoutReading(reading([['big', 4], ['small', 1]]), W, H)
    const big = placed.find((p) => p.label === 'big')!
    const small = placed.find((p) => p.label === 'small')!
    expect(big.r).toBeGreaterThan(small.r)
  })

  it('keeps marks inside the viewport', () => {
    const placed = layoutReading(reading([['a1', 1], ['b2', 1], ['c3', 1], ['d4', 1], ['e5', 1], ['f6', 1], ['g7', 1]]), W, H)
    for (const p of placed) {
      expect(p.x - p.r).toBeGreaterThanOrEqual(0)
      expect(p.x + p.r).toBeLessThanOrEqual(W)
      expect(p.y - p.r).toBeGreaterThanOrEqual(0)
      expect(p.y + p.r).toBeLessThanOrEqual(H)
    }
  })

  it('pushes overlapping marks apart', () => {
    const placed = layoutReading(reading([['a1', 1], ['b2', 1], ['c3', 1], ['d4', 1], ['e5', 1], ['f6', 1], ['g7', 1]]), W, H)
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        expect(dist).toBeGreaterThanOrEqual((a.r + b.r) * 0.5)
      }
    }
  })

  it('a concept keeps its position as its size changes', () => {
    const before = layoutReading(reading([['sister', 1]]), W, H)[0]
    const after = layoutReading(reading([['sister', 3]]), W, H)[0]
    expect(after.x).toBeCloseTo(before.x, 5)
    expect(after.y).toBeCloseTo(before.y, 5)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/layout.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

`src/ui/layout.ts`:
```ts
import type { Reading } from '../core/types'

export interface PlacedMark {
  conceptId: string
  label: string
  x: number
  y: number
  r: number
}

/** FNV-1a, unsigned 32-bit. Position must be a pure function of conceptId. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const RELAX_ITERATIONS = 40

/**
 * Chart-plan view: marks scattered on a plane, size alone carrying weight
 * (BRIEF.md visual-direction caution: no depth axis). Anchor position derives
 * from the conceptId hash so a concept stays put across readings; collision
 * relaxation nudges from the anchor deterministically.
 */
export function layoutReading(reading: Reading, width: number, height: number): PlacedMark[] {
  const cx = width / 2
  const cy = height / 2
  const scale = Math.min(width, height)

  const placed: PlacedMark[] = reading.marks.map((m) => {
    const h = hashString(m.conceptId)
    const angle = ((h % 3600) / 3600) * Math.PI * 2
    const dist = (0.15 + (((h >>> 12) % 1000) / 1000) * 0.3) * scale
    return {
      conceptId: m.conceptId,
      label: m.label,
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      r: (0.03 + 0.11 * m.prominence) * scale,
    }
  })

  // Deterministic collision relaxation: push overlapping pairs apart along
  // their center line, then clamp to the viewport.
  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 1
        const overlap = a.r + b.r - dist
        if (overlap > 0) {
          const push = overlap / 2 + 1
          const ux = dx / dist
          const uy = dy / dist
          a.x -= ux * push; a.y -= uy * push
          b.x += ux * push; b.y += uy * push
        }
      }
    }
  }
  for (const p of placed) {
    p.x = Math.min(Math.max(p.x, p.r), width - p.r)
    p.y = Math.min(Math.max(p.y, p.r), height - p.r)
  }
  return placed
}
```

Note: relaxation moves marks off their anchors only while overlapping; the "keeps its position" test uses a single mark, which never relaxes, so anchors hold exactly. With multiple marks positions shift slightly but deterministically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/layout.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/layout.ts tests/layout.test.ts
git commit -m "feat: deterministic chart-plan mark layout"
```

---

### Task 15: Debug UI — chart, playback, inspector

**Files:**
- Create: `index.html`, `src/ui/main.ts`, `src/ui/style.css`

**Interfaces:**
- Consumes: `createReplay` (Task 9), `FIXTURES` (Task 13), `layoutReading` (Task 14), `summarizeCounters` (Task 10), `SoundingEvent` types (Task 3).
- Produces: `npm run dev` — an instrument for tuning, not the product screen. Wall clock is permitted here (UI layer only).

- [ ] **Step 1: Write the page shell**

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sounding — replay instrument</title>
    <link rel="stylesheet" href="/src/ui/style.css" />
  </head>
  <body>
    <header>
      <select id="fixture-select"></select>
      <button id="play-pause">Drop</button>
      <select id="speed">
        <option value="1">1x</option>
        <option value="4">4x</option>
        <option value="0">instant</option>
      </select>
      <span id="clock">0:00</span>
      <span id="slack-indicator" hidden>slack</span>
      <span id="counters"></span>
    </header>
    <main>
      <svg id="chart"></svg>
      <aside id="inspector"><p>Click a mark to see its transition history.</p></aside>
    </main>
    <script type="module" src="/src/ui/main.ts"></script>
  </body>
</html>
```

`src/ui/style.css`:
```css
* { box-sizing: border-box; margin: 0; }
body { font: 14px/1.4 system-ui, sans-serif; background: #eef4f8; color: #1c3a4a; height: 100vh; display: flex; flex-direction: column; }
header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: #dce8f0; }
main { flex: 1; display: flex; min-height: 0; }
#chart { flex: 1; height: 100%; }
#inspector { width: 320px; overflow-y: auto; padding: 12px; background: #f6fafc; border-left: 1px solid #c8d8e2; font-size: 12px; }
#inspector h2 { font-size: 14px; margin-bottom: 8px; }
#inspector li { list-style: none; margin-bottom: 4px; }
#slack-indicator { color: #7a95a5; font-style: italic; }
#counters { margin-left: auto; color: #55707f; font-size: 12px; }
.mark circle { fill: #3d7ea6; fill-opacity: 0.55; stroke: none; cursor: pointer; }
.mark.selected circle { fill-opacity: 0.85; }
.mark text { fill: #12303f; text-anchor: middle; pointer-events: none; }
```

- [ ] **Step 2: Write the app**

`src/ui/main.ts`:
```ts
// The replay instrument. This is the only file allowed to read wall clock.
import { createReplay } from '../replay/runner'
import { FIXTURES } from '../replay/fixtures/index'
import { summarizeCounters } from '../replay/counters'
import { layoutReading } from './layout'
import type { Reading, Transition, Ms } from '../core/types'
import type { SoundingEvent } from '../core/events'

const fixtureSelect = document.getElementById('fixture-select') as HTMLSelectElement
const playPause = document.getElementById('play-pause') as HTMLButtonElement
const speedSelect = document.getElementById('speed') as HTMLSelectElement
const clockEl = document.getElementById('clock')!
const slackEl = document.getElementById('slack-indicator')!
const countersEl = document.getElementById('counters')!
const chart = document.getElementById('chart') as unknown as SVGSVGElement
const inspector = document.getElementById('inspector')!

for (const f of FIXTURES) {
  const opt = document.createElement('option')
  opt.value = f.name
  opt.textContent = `${f.name} — ${f.description}`
  fixtureSelect.appendChild(opt)
}

let replay = createReplay(FIXTURES[0])
let script = FIXTURES[0]
let sessionT: Ms = 0
let playing = false
let lastFrameWallT = 0
let advancing = false
let renderedThrough = 0
let selectedConceptId: string | null = null
const history = new Map<string, Array<{ t: Ms; transition: Transition }>>()

function reset() {
  script = FIXTURES.find((f) => f.name === fixtureSelect.value) ?? FIXTURES[0]
  replay = createReplay(script)
  sessionT = 0
  playing = false
  renderedThrough = 0
  selectedConceptId = null
  history.clear()
  playPause.textContent = 'Drop'
  inspector.innerHTML = '<p>Click a mark to see its transition history.</p>'
  chart.innerHTML = ''
  clockEl.textContent = '0:00'
}

fixtureSelect.addEventListener('change', reset)

playPause.addEventListener('click', async () => {
  if (speedSelect.value === '0') {
    await replay.runner.runToEnd()
    sessionT = script.endT
    consumeAndRender()
    playPause.textContent = 'Surfaced'
    return
  }
  playing = !playing
  playPause.textContent = playing ? 'Pause' : 'Resume'
  lastFrameWallT = performance.now()
})

function fmt(t: Ms): string {
  const s = Math.floor(t / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function consumeAndRender() {
  const events = replay.session.log.all()
  let latest: Extract<SoundingEvent, { type: 'reading.changed' }> | null = null
  for (let i = renderedThrough; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'reading.changed') {
      latest = e
      for (const tr of e.transitions) {
        const id = tr.kind === 'merged' ? tr.intoConceptId : tr.conceptId
        if (!history.has(id)) history.set(id, [])
        history.get(id)!.push({ t: e.t, transition: tr })
      }
    }
  }
  renderedThrough = events.length
  if (latest) renderReading(latest.reading)
  const c = summarizeCounters(events)
  countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms`
  clockEl.textContent = fmt(sessionT)
}

function renderReading(reading: Reading) {
  slackEl.hidden = !reading.slack
  const { width, height } = chart.getBoundingClientRect()
  const placed = layoutReading(reading, Math.max(width, 200), Math.max(height, 200))
  chart.innerHTML = ''
  for (const p of placed) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', p.conceptId === selectedConceptId ? 'mark selected' : 'mark')
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', String(p.x))
    circle.setAttribute('cy', String(p.y))
    circle.setAttribute('r', String(p.r))
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    text.setAttribute('x', String(p.x))
    text.setAttribute('y', String(p.y + 4))
    text.setAttribute('font-size', String(Math.max(11, p.r / 3)))
    text.textContent = p.label
    g.appendChild(circle)
    g.appendChild(text)
    g.addEventListener('click', () => {
      selectedConceptId = p.conceptId
      renderInspector(p.conceptId, p.label)
      renderReading(reading)
    })
    chart.appendChild(g)
  }
}

function describe(tr: Transition): string {
  switch (tr.kind) {
    case 'appeared': return 'appeared'
    case 'nudged': return `nudged +${tr.delta}`
    case 'displaced': return `displaced by ${tr.byConceptId}`
    case 'merged': return `absorbed ${tr.fromConceptId}`
  }
}

function renderInspector(conceptId: string, label: string) {
  const entries = history.get(conceptId) ?? []
  inspector.innerHTML = `<h2>${label} <small>(${conceptId})</small></h2>`
  const ul = document.createElement('ul')
  for (const { t, transition } of entries) {
    const li = document.createElement('li')
    li.textContent = `${fmt(t)} — ${describe(transition)}`
    ul.appendChild(li)
  }
  inspector.appendChild(ul)
}

async function frame(wallT: number) {
  if (playing && !advancing) {
    const speed = Number(speedSelect.value) || 1
    sessionT = Math.min(sessionT + (wallT - lastFrameWallT) * speed, script.endT)
    lastFrameWallT = wallT
    advancing = true
    await replay.runner.advanceTo(sessionT)
    advancing = false
    consumeAndRender()
    if (sessionT >= script.endT) {
      playing = false
      playPause.textContent = 'Surfaced'
    }
  } else {
    lastFrameWallT = wallT
  }
  requestAnimationFrame(frame)
}

reset()
requestAnimationFrame(frame)
```

- [ ] **Step 3: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests still pass.

- [ ] **Step 4: Manual verification**

Run: `npm run dev` and open the printed URL. Verify each:
1. The fixture dropdown lists all five fixtures with descriptions.
2. Select **circling**, press **Drop**: marks appear within a few seconds; by ~0:40 a `sister` mark exists and grows; the clock advances; pause/resume works.
3. Select **instant** speed on **contention**, press Drop: the final reading renders immediately with ≤4 marks.
4. Click the `sister` mark on circling: the inspector lists its transition history (`appeared`, `nudged …` entries with timestamps).
5. Select **slack**, play at 4x: after ~0:29 the *slack* indicator shows and marks shrink slowly.
6. The counters read `N calls · $0.0000 · mean 0ms` (local interpreter is free).

Record the outcome of each check in the task notes (pass/fail + what was seen).

- [ ] **Step 5: Commit**

```bash
git add index.html src/ui/main.ts src/ui/style.css
git commit -m "feat: replay instrument UI — chart, playback, inspector, counters"
```

---

## Completion checklist (after Task 15)

- [ ] `npm test` — all suites green.
- [ ] `npm run typecheck` — clean.
- [ ] Manual verification of Task 15 recorded.
- [ ] Spec success criteria (`docs/superpowers/specs/2026-08-28-sounding-slice1-design.md` → Goal) each verified:
  - fixtures replay headlessly with dynamics assertions ✅ Tasks 11–13
  - browser replays a fixture at 1x ✅ Task 15
  - byte-identical replays ✅ Task 13
  - cost/latency counters ✅ Tasks 10, 15
- [ ] Use superpowers:finishing-a-development-branch to decide integration.

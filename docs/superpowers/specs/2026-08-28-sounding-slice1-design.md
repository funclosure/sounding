# Sounding — Slice 1 Design: The Engine on Replay

**Date:** 2026-08-28
**Status:** Approved
**Context:** `docs/BRIEF.md` is the authoritative product brief. This spec covers only the first buildable slice. Product-level decisions made there (extract-and-merge, two loops, fixed capacity, event log, Mac-first, files-before-mic) are inputs here, not open questions.

## Goal

At the end of slice 1, a synthetic monologue fixture runs through the full pipeline and the reading evolves in a browser — concepts appearing, growing, being displaced — with deterministic replay and tests asserting the dynamics.

**Success criteria:**

- `npm test` replays fixtures headlessly and asserts dynamics against ground truth.
- `npm run dev` opens a browser page that replays a chosen fixture at 1x and renders the reading live.
- Replaying the same fixture twice produces byte-identical event streams.
- Cost and latency counters report per-interpretation-call figures (zero cost for the local interpreter, but the plumbing is real).

**Non-goals for this slice:** microphone, model calls, API keys, visual design (the renderer is a functional debug view; the designed screen is a later slice), persistence beyond fixture files, mobile.

## Stack

TypeScript throughout, strict mode, ESM. Single package. Node for tests and headless replay; Vite for the web UI. The engine (`core`, `interpret`, `salience`, `replay` minus file I/O) is pure TS with no I/O dependencies, so it runs identically in Node and the browser.

## Module layout

```
src/
  core/        event log + domain types
  interpret/   interpretation port + recurrence interpreter
  salience/    identity resolution + reading dynamics  ← the app
  replay/      fixture format, replay driver, counters
  ui/          Vite app: chart-plan debug view
```

Nautical vocabulary in type names, UI copy, and comments, per the brief's vocabulary table: a session is a `Sounding`, the on-screen state is the `Reading`, sessions `drop()` and `surface()`, extended silence is `slack`.

## Core: the event log

Append-only log of timestamped events; the session's spine. All timestamps are **session-relative milliseconds from drop** — never wall clock, never `Date.now()` inside the engine. The engine is a pure function of the event stream; this is what makes replay deterministic and the whole tuning strategy viable.

Event types (discriminated union `SoundingEvent`):

| Event | Emitted by | Payload |
|---|---|---|
| `sounding.dropped` | session | `soundingId` |
| `segment.pending` | segmentation (fast feed) | provisional text, running |
| `segment.committed` | segmentation | `segmentId`, transcript, `startT`, `endT` |
| `candidates.emitted` | interpretation | `segmentId`, source id, `ConceptCandidate[]`, cost, latency |
| `reading.changed` | salience | transitions + full `Reading` snapshot |
| `sounding.surfaced` | session | — |

`reading.changed` carries explicit transitions — `appeared`, `nudged`, `displaced`, `merged` — so "why did that vanish" is always answerable from the log, and the displacement moment (the product's most meaningful event) is a first-class datum the UI can choose how loudly to render.

Logs serialize to JSONL. A fixture is a log prefix (capture- and segmentation-layer events — pending and committed segments — since slice 1 starts from pre-segmented transcripts). The UI consumes `reading.changed` events exclusively — live mode and replay mode are indistinguishable to everything downstream of capture.

**Rate discipline (from the brief):** segments ~0.5Hz → candidates ~0.5Hz → state ticks 10Hz → render 60Hz. No layer may leak a higher rate upward.

## Interpretation port

```ts
interface Interpreter {
  readonly id: string
  interpret(input: AudioSegment | Transcript): Promise<InterpretationResult>
}
interface InterpretationResult {
  candidates: ConceptCandidate[]
  costUsd: number
  latencyMs: number
}
```

The input union **must** remain `AudioSegment | Transcript` even though slice 1 only passes transcripts. Collapsing it to transcript-only would weld shut the brief's top unresolved question (audio-native interpretation). Salience never knows which interpreter produced a candidate beyond its `source` id.

`ConceptCandidate`: label, strength (0–1), confidence (0–1), source id, segment ref.

**Slice-1 implementation — recurrence interpreter:** normalized word/phrase recurrence over a sliding window of committed segments. Stopword removal, basic normalization (case, plural folding), unigrams and bigrams. No network. It exists to exercise the pipeline, and recurrence is a legitimate salience signal in its own right (per the brief) — its known limitation is synonymy, which is the embedding resolver's job later.

## Salience

Two separately swappable sub-parts.

### Identity resolution (own interface)

`resolve(candidate, concepts: Concept[]) → conceptId | 'new'`. v0 is normalized-token matching — sufficient because the recurrence interpreter emits literal words. The embedding-similarity resolver drops in behind this interface when a model interpreter arrives (slice 2); the concept-identity-across-time problem ("grief" / "mourning" / "losing her") is explicitly deferred to that resolver, not solved by v0.

### Reading dynamics

Owns promotion and demotion under contention. Advances on a 10Hz tick driven by the replay clock (not wall clock). Rules:

- **Fixed capacity** `K` (default 7). A tuning constant, not an output.
- **Decay:** concept weight decays exponentially with configurable half-life; slack (no committed segments for `slackAfterMs`) does not pause decay.
- **Field-relative weight:** displayed prominence is normalized against the current chart, not an absolute threshold (salience is a property of the field — brief).
- **Confidence floor:** candidates below `confidenceFloor` never surface. A missing mark costs less than a wrong one (TalkTraces finding 2).
- **Hysteresis:** a challenger displaces the weakest incumbent only after exceeding its weight by margin `hysteresisMargin`, sustained for `hysteresisTicks` consecutive ticks. Prevents churn (Word Cloud for Meeting finding).
- **Fast-loop nudges:** `segment.pending` text feeds small weight nudges (recurrence of words already on the chart) between slow-loop updates, so the two-loop structure is real from day one.

All tuning constants live in one `SalienceConfig` object with defaults, so replay-based tuning sweeps are trivial.

## Replay and fixtures

**Fixture format:** JSONL capture events (timed `segment.pending` word-cadence text + `segment.committed` transcripts) plus a ground-truth annotation block: what the fixture circles, where synonyms drift, where the topic shifts, and what a good reading should show by when.

**Initial corpus (synthetic, authored in-repo):** at minimum —

1. *Circling* — one concept recurring irregularly amid noise; must surface and stay.
2. *Synonym drift* — same concept under changing labels; documents v0's known-failure (three marks) as the slice-2 acceptance test.
3. *Topic shift* — clean shift at a known time; old concepts must be displaced within a bounded interval, without churn before the shift.
4. *Slack* — long silence; weights decay, nothing new appears.
5. *Contention* — more simultaneous concepts than K; capacity and hysteresis rules decide, deterministically.

**Replay driver:** consumes a fixture, drives the pipeline at ∞x (tests, tuning) or 1x (UI watching). Same code path both ways.

**Counters:** running cost (USD) and latency aggregates per sounding, from day one (brief's "insurance").

## UI (debug view)

Vite app. Chart-plan view per the brief's caution: marks scattered on a plane, **size alone carries weight** — no depth axis. v0 placement is deterministic (hash-seeded, collision-avoided), not semantic. Displacements render legibly but unpolished. A fixture picker, play/pause, replay speed, and an event-log inspector pane (click a mark → its transition history). This is an instrument for tuning, not the product screen.

## Testing

- **Determinism:** same fixture + config → byte-identical event stream.
- **Invariants:** reading size ≤ K; no sub-floor concept ever surfaces; timestamps monotonic; no wall-clock reads in the engine (lint rule or grep test for `Date.now`).
- **Dynamics per fixture:** assertions from ground-truth annotations, e.g. "circled concept on chart by t=40s and never displaced", "topic-shift fixture: ≥3 of 4 old concepts displaced within 15s of shift, zero displacements in the 30s before it".

## Deferred (named so they are neither reopened nor lost)

- Audio-native interpretation (ranked above vendor choice — architecture question)
- Model-backed interpreter (Groq Whisper for transcription, LLM extraction)
- Embedding-based identity resolution
- Live microphone capture + segmentation (LocalAgreement-style commit/pending)
- The designed screen (frontend-design pass; displacement-moment legibility problem)
- Encrypted persistence; never persist raw audio
- Backend key proxy
- Mobile (Expo + local Swift module, per brief)
- The chart (session history); multi-source interpretation; async second person

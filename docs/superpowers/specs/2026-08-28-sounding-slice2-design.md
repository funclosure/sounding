# Sounding — Slice 2 Design: Model Interpretation, Both Paths, A/B on Real Recordings

**Date:** 2026-08-28
**Status:** Approved
**Context:** Builds on slice 1 (`docs/superpowers/specs/2026-08-28-sounding-slice1-design.md`, merged to main). `docs/BRIEF.md` remains the authoritative product brief. Decisions made here: both interpretation architectures (transcribe-then-extract AND audio-native) built behind the port this slice and A/B'd on identical input; Claude Opus 5 for extraction (model sweep deferred — replay makes it a one-command experiment later); real voice-memo corpus; local embeddings.

## Goal

At the end of slice 2:

- `npm run cast -- recordings/<memo>.m4a -i claude` (or `-i gemini`, `-i recurrence`) runs a real recording through the full pipeline and writes the complete event log to `soundings/<memo>.<interpreter>.jsonl`, printing a cost/latency summary.
- The UI loads any saved sounding log and replays the reading (no engine, no keys in the browser — it consumes the `reading.changed` stream).
- `npm run compare -- <log-a> <log-b>` prints two casts side by side: final readings, displacement timelines, per-interpreter cost and latency.
- The synonym-drift fixture produces **exactly one mark** under the embedding resolver (the slice-1 pinned limitation flips), while contention's nine worries stay distinct under the same threshold.
- `feedCommitted` is serialized inside the session; fast-loop nudges fire for natural-language model labels; topic-shift carries a bounded displacement-latency assertion.

**Non-goals:** live microphone, LocalAgreement segmentation, backend key proxy, designed screen, retro-merging of split concepts, model sweep, mobile, the chart.

## Layer layout — the purity boundary moves, the port stays

```
src/
  core/ salience/ interpret/ replay/   ← pure engine (wall-clock guard applies)
  providers/                           ← I/O: network, filesystem, wall-clock (guard-exempt)
    whisper-transcription.ts           local whisper.cpp transcription → FixtureScript
    claude-extraction.ts               Interpreter (input: 'transcript'), claude-opus-5
    gemini-audio.ts                    Interpreter (input: 'audio'), audio-native
    audio-slicer.ts                    ffmpeg window slicing → AudioSegment
    embeddings.ts                      local MiniLM embedder (transformers.js)
    pricing.ts                         per-provider pricing constants (marked update-me)
  cli/
    cast.ts                            recording → event log
    compare.ts                         two logs → side-by-side report
  ui/                                  guard-exempt (unchanged status)
```

The wall-clock/randomness guard test narrows its walk to `src/core`, `src/salience`, `src/interpret`, `src/replay`. `RecurrenceInterpreter` stays pure in `src/interpret`. Model interpreters live in `src/providers` and implement the same `Interpreter` port — salience still never knows which interpreter produced a candidate.

## Segmentation is transcription-driven in both paths

Whisper runs once per recording, in both architectures — segmentation is a separate layer from interpretation (brief: segmentation sets the latency floor; interpretation is swappable).

- **Transcription:** **local whisper.cpp** (`whisper-cli`, already installed via Homebrew; Metal-accelerated on Apple Silicon). The provider shells out with `--output-json` for measured segment timestamps; model file `ggml-large-v3-turbo` (~1.6GB, multilingual), downloaded once from the whisper.cpp model repo — the CLI checks for it and prints the download command if missing. Cost: $0, offline, no key. (Groq's hosted Whisper was the original plan but is geo-blocked from this network; hosted transcription can swap in behind the same provider interface later — it's exactly the kind of substitution the port design anticipates. Whisper timestamps are ASR-measured, which is why generative transcription — e.g. Gemini — is not used for segmentation: estimated timestamps would distort the event timeline that everything downstream trusts.)
- **Caching:** the result is saved as `recordings/<memo>.transcript.json` — a `FixtureScript` (name, segments with startT/endT/text, endT, empty truth). Subsequent casts of the same recording skip Groq. The transcript IS a fixture: the entire slice-1 replay machinery (pending-word synthesis, capture events, runner) works on real recordings unchanged.
- **A/B validity:** because both paths consume the same capture events, two casts of one recording differ only in `candidates.emitted` and everything downstream — a clean experiment on identical input.

## Port evolution

```ts
export interface Interpreter {
  readonly id: string
  readonly input: 'transcript' | 'audio'   // NEW: what the session should hand it
  interpret(input: InterpreterInput): Promise<InterpretationResult>
}

export interface AudioSegment {           // evolved from the unused PCM placeholder
  kind: 'audio'
  segmentId: string
  mimeType: string                        // e.g. 'audio/mp4'
  data: Uint8Array                        // encoded bytes of the window
  startT: Ms
  endT: Ms
}
```

`SoundingSession` gains an optional `audioSource?: (seg: {segmentId, startT, endT}) => Promise<AudioSegment>` constructor argument. When the interpreter declares `input: 'audio'`, `feedCommitted` calls `audioSource` instead of building a `Transcript`. `cast` wires the ffmpeg slicer as the audioSource; the slicer extracts the window `[max(0, endT − AUDIO_WINDOW_MS), endT]` (AUDIO_WINDOW_MS = 30_000, a tuning constant) so the audio-native model hears recent prosodic context, mirroring the recurrence window's span. ffmpeg is a documented dev prerequisite (`brew install ffmpeg`); the CLI checks for it and fails with a clear message.

## The two model interpreters

**Claude extraction** (`src/providers/claude-extraction.ts`, `input: 'transcript'`):
- Official `@anthropic-ai/sdk` (new runtime dependency), model `claude-opus-5`, zero-arg client (resolves the `ant` profile or `ANTHROPIC_API_KEY`).
- Structured outputs (`output_config.format` with a strict JSON schema for `{candidates: [{label, strength, confidence}]}`) — no parsing fragility.
- System prompt is stable and `cache_control`-marked (prompt caching across the ~450 calls/hr cadence); the sliding transcript window goes in the user turn. The prompt targets the brief's design consequence head-on: surface what the talking keeps returning to — named people, specific moments, recurring images — NOT tidy topic nouns; a missing candidate costs less than a wrong one (confidence honesty).
- `costUsd` computed from `response.usage` × pricing constants; `latencyMs` wall-clock around the call.

**Gemini audio-native** (`src/providers/gemini-audio.ts`, `input: 'audio'`):
- REST `generateContent` with inline base64 audio (plain `fetch`, no SDK dependency), JSON-mode response constrained to the same candidate schema. Model and pricing constants verified against current Google docs at implementation time (post-cutoff drift expected; `pricing.ts` values are marked update-me).
- Prompt directs attention to the signals text discards: emphasis, hesitation, repetition-with-stress, returns-to — the brief's core bet for this path.
- `GEMINI_API_KEY` env var.

Both report real cost and latency into the existing `candidates.emitted` events and counters. **Keys never reach the browser**: model calls happen only in the CLI; the UI consumes saved logs.

## Embedding identity resolver

- `IdentityResolver.resolve` becomes **async** (`Promise<string | null>`); `ReadingDynamics.applyCandidates` and `SoundingSession.feedCommitted` become async accordingly (serialization below makes this safe). `TokenIdentityResolver` is unchanged in behavior.
- New `EmbeddingIdentityResolver` (`src/providers/embeddings.ts` + a resolver class): local **all-MiniLM-L6-v2** via `@huggingface/transformers` (ONNX, runs in Node, no API, no key — new runtime dependency). Cosine similarity between the candidate label's embedding and each existing concept's; max similarity ≥ `config.similarityThreshold` → that concept, else new. Embeddings memoized per normalized label in-process.
- `similarityThreshold` joins `SalienceConfig` (initial 0.6, tuned by the acceptance pair below).
- **Acceptance is a pair:** synonym-drift (grief/mourning/losing/loss) collapses to exactly **1** mark, AND contention's nine worries produce **no** false merges. The threshold is tuned between those constraints; both assertions live in the same test file so a threshold change confronts both.
- Resolver defaults: the synthetic-fixture suite keeps `TokenIdentityResolver` (its dynamics assertions stay calibrated); `createReplay` gains an options parameter (`{resolver?}`); `cast` uses the embedding resolver. The synonym-drift test runs both: token → ≥2 marks (documented limitation, retained), embedding → exactly 1 (the slice-2 flip).
- **Determinism note (explicit relaxation):** embedding floats are deterministic within a machine/runtime, so in-process determinism tests stand; byte-identical replay **across machines** is not guaranteed for embedding-resolver runs. Cast logs are recordings — replaying a saved log is always exact regardless.

## Persistence and A/B

- **Log format:** `EventLog.toJsonl()` output, one file per cast: `soundings/<memo>.<interpreter>.jsonl`. `EventLog.fromJsonl` gains **schema validation** (event type whitelist, required fields, monotonic t) now that it consumes untrusted disk input — resolving the slice-1 deferred finding.
- **UI:** a "load sounding log" file input beside the fixture picker; replaying a log iterates its `reading.changed` events on the existing render path (no engine, no interpreters, no keys in the browser). Counters render from the log's `candidates.emitted` events.
- **compare CLI:** reads two logs, prints final readings side by side (labels + prominence), displacement timelines (time, displaced label, displacing label), and per-log totals (calls, cost, mean/max latency). Text output; no metrics beyond that in this slice.
- **Privacy default:** `recordings/` and `soundings/` are gitignored (they contain real thinking-out-loud); individual files can be force-added deliberately. Synthetic fixtures remain the committed test corpus.

## Engine hardening

1. **Serialize `feedCommitted`:** an internal promise chain in `SoundingSession` — each call awaits the previous one's completion before appending events, so interleaved calls cannot corrupt segment↔candidates pairing. Test: fire two feedCommitted calls without awaiting; log ordering is correct.
2. **Unify nudge identity:** `nudge` tokenizes the concept label through the shared `tokenize` (normalization included) and fires on **any** non-stopword token overlap with pending tokens (the slice-1 all-tokens-must-match rule breaks on natural-language labels like "her sister's judgment"). Test: a surfaced concept with a multi-word natural label gets nudged by pending text containing one of its content words.
3. **Bounded displacement latency:** topic-shift gains `expect(firstDisplacementT - topicShiftAt).toBeLessThanOrEqual(30_000)`. If defaults fail, tune `halfLifeMs`/`hysteresisMargin` via the replay instrument until the bound holds at a defensible value, and document the chosen constants in the commit.

## Corpus

Victor records 3–5 voice memos (5–10 min each, genuine thinking-aloud on real questions) into `recordings/`. First cast of each caches its transcription. The memos also become the audio-native A/B corpus — that is why both paths shipping this slice is coherent: the corpus and the comparison harness arrive together.

## Environment / prerequisites

- `GEMINI_API_KEY` (Google AI Studio — verified reachable from this network); Anthropic via existing `ant auth login` profile or `ANTHROPIC_API_KEY`. No Groq key (geo-blocked; replaced by local whisper.cpp).
- `whisper-cli` and `ffmpeg` in PATH (both already installed via Homebrew) plus the ggml-large-v3-turbo model file (one-time ~1.6GB download).
- New runtime dependencies: `@anthropic-ai/sdk`, `@huggingface/transformers`. Groq and Gemini via `fetch`. (Slice 1's zero-runtime-dependency constraint retires with the slice that needed it; the pure engine still imports nothing.)

## Testing

- Unit: serialization, nudge overlap, async resolver plumbing, JSONL schema validation (reject malformed lines), compare-report formatting on synthetic logs.
- Acceptance: synonym-drift dual-resolver pair; displacement-latency bound; all slice-1 suites stay green.
- Provider modules: tested with recorded/stubbed HTTP fixtures (no live keys in `npm test`); a separate `npm run cast` against a real memo is the manual integration check, with observations recorded.
- Exception to "no network in tests": the embedding-resolver tests use the real local MiniLM model, which transformers.js downloads (~25MB) from the Hugging Face hub on first run and caches locally thereafter. No key involved; this is deliberate — stubbing embeddings would make the threshold acceptance pair meaningless.
- Wall-clock guard: updated to the narrowed pure-engine scope; still bans `Date.now`/`performance.now`/`new Date(`/`Math.random` there.

## Success criteria (recap)

1. Three cast paths produce logs from a real recording; counters report real dollars.
2. UI replays a saved log.
3. compare renders a side-by-side A/B of claude vs gemini on the same memo.
4. Synonym-drift: exactly 1 mark (embedding) / ≥2 (token, documented).
5. Hardening trio: serialization test, nudge-overlap test, displacement bound — all green; full suite green.

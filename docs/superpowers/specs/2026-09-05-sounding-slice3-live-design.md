# Sounding — slice 3: live mode (design)

Date: 2026-09-05. Status: approved by Victor in conversation.

## Goal

See your thoughts while you talk. The page opens the mic, and within a
second the words it hears flash up large and shrink away; within a few
seconds of finishing a thought, the reading on the chart moves. Nothing is
recorded to disk except the event log.

This is the product the brief describes. The file-based flow (cast CLI, mic
Record button) stays as the tuning and replay instrument.

## Non-goals

- Mobile / iOS (this UI is a proof of concept; the iOS app comes later and
  will either speak this wire protocol or embed the engine).
- Transcript display. Heard words are a liveness signal, not a transcript.
- Diarization, multiple speakers, shared sessions.
- Persisting audio in live mode (brief rule: never persist raw audio).

## Facts that shape the design (verified 2026-09-05)

**Gemini 3.5 Transcribe Live** (`models/gemini-3.5-transcribe-live`, public
preview) over the Live API WebSocket:

- Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<GEMINI_API_KEY>`.
  The key is in the URL, so this connection must be made from the local
  Node process, never the browser.
- Setup message: `{"setup":{"model":"models/gemini-3.5-transcribe-live","generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"languageCodes":[],"mode":"VERBATIM"}}}`
  → server replies `{"setupComplete":{}}`.
- Audio in: `{"realtimeInput":{"audio":{"data":"<base64>","mimeType":"audio/pcm;rate=16000"}}}`,
  16 kHz, 16-bit signed little-endian, mono, 100 ms chunks (3200 bytes).
  End with `{"realtimeInput":{"audioStreamEnd":true}}`.
- Messages out, all under `serverContent`:
  - `interimInputTranscription: { text }` — roughly every 0.5 s, **cumulative
    for the current utterance** (the text grows; earlier words may be revised).
  - `inputTranscription: { text }` — the final for the utterance. **During
    continuous talk no final arrives**: 40 s of uninterrupted speech produced
    81 interims and one final, at stream end. Finals come on pauses / turn end.
  - `voiceActivity: { type: 'ACTIVITY_START' | 'ACTIVITY_END', audioOffset: '0.880s' }`
    (sibling of `serverContent`, with an empty `serverContent`).
  - `generationComplete: true` after a final.
- Interim latency observed: first word ~1.3 s after speech start, then ~0.5 s cadence.
- No word-level timestamps over Live. Sessions cap at 10 minutes.
- Price: $3.50/MTok audio in ≈ $0.005/min, plus text out ≈ $0.004/min.

**Engine:** `SoundingSession` already accepts `feedPending(t, text)`,
`feedCommitted(t, seg)`, `advanceTo(t)`, `surface(t)`; time moves only via
caller timestamps, so live and replay are indistinguishable below the
session. An audio interpreter needs an `AudioSource` returning an
`AudioSegment { kind:'audio', segmentId, mimeType, data, startT, endT }`.

**Tuning evidence (today's 2.5-minute memo, Gemini audio-native):** opening
filler ("what I'm thinking", "this afternoon") held 10–16 % of the chart for
90 s; a topic abandoned at 0:50 stayed on top until 2:00; a new topic first
spoken at 1:11 reached the chart at 1:35. Half-life 45 s is too slow for
live, and the prompts label discourse filler as concepts.

## Architecture

```
 browser (src/ui/live.ts)                   node (src/live/, `npm run live`)                 Google
 ┌──────────────────────────┐   PCM 100ms   ┌──────────────────────────────────────┐   PCM   ┌──────────────┐
 │ mic → AudioWorklet 16kHz ├──────────────►│ LiveServer                           ├────────►│ Transcribe   │
 │                          │  binary frame │  ├─ TranscribeLiveClient             │◄────────┤ Live (WS)    │
 │ heard-words layer        │◄──────────────┤  ├─ Segmenter (interim→pending,      │ interim └──────────────┘
 │ reading (chart)          │  JSON events  │  │              cut→committed)        │ / final
 │                          │               │  ├─ PcmRingBuffer (30s, memory only)  │         ┌──────────────┐
 └──────────────────────────┘               │  ├─ SoundingSession + interpreter ────┼────────►│ Gemini 3.7   │
                                            │  │   (audio-native default)           │  wav    │ (or Claude)  │
                                            │  └─ 100ms clock → advanceTo(now)      │         └──────────────┘
                                            │  log → soundings/live-<stamp>.jsonl   │
                                            └──────────────────────────────────────┘
```

The wire protocol server→browser is the event log itself. The browser is a
renderer of `SoundingEvent`s, which is exactly what log playback already is.

### Components

**`src/live/segmenter.ts` (pure).** Turns the interim/final stream into the
two loops. State: `committedPrefix` (text already committed from the current
utterance), `lastInterim`, `lastCommitT`, `utteranceStartT`.

- `onInterim(t, text)` → `{ pendingDelta: string }` — the new words since the
  previous interim (suffix diff; if the interim revised earlier words, the
  delta is the whole tail after the longest common prefix). Emitted as
  `feedPending(t, pendingDelta)` when non-empty.
- Commit decisions, checked on every interim and on a 1 s idle timer:
  - a **final** arrived → commit `final.text` minus `committedPrefix` as one
    segment; reset utterance state;
  - or `t − lastCommitT ≥ maxSegmentMs` (default 8000) and the interim has
    grown by at least `minSegmentWords` (default 4) beyond `committedPrefix`
    → commit the interim tail as a segment and set `committedPrefix` to the
    interim text. Continuous talk is thus cut every ~8 s; the interim text is
    good enough for the Claude path and for nudges, and the audio path does
    not read it at all.
- `onFinal(t, text)` → `{ commit: Segment | null }`.
- Segment: `{ segmentId, transcript, startT, endT }` with `startT` = the
  commit time of the previous segment (or utterance start), `endT` = now.
  Timestamps are session-relative ms.

**`src/live/pcm-ring.ts` (pure).** Fixed 30 s ring of 16 kHz s16le frames.
`push(chunk, tEnd)`, `slice(fromT, toT): Int16Array` (clamped to what is
held), `toWav(samples): Uint8Array` (44-byte RIFF header + PCM). The
`AudioSource` for the live session returns `{ mimeType:'audio/wav', data:
toWav(slice(endT − 30000, endT)) }`. Never touches disk.

**`src/live/heard-words.ts` (pure).** From a pending delta, the content words
to flash: `tokenize()` from `src/core/text.ts` already drops stopwords and
normalizes; here keep the original surface form (so "Dalio" flashes as
"Dalio", not "dalio") by mapping normalized tokens back to the raw words.
Returns `string[]`.

**`src/live/transcribe-live.ts`.** Thin client over Node 22's built-in
`WebSocket`: `connect()` (setup → setupComplete), `sendAudio(chunk)`,
`end()`, callbacks `onInterim(text)`, `onFinal(text)`, `onActivity(type)`,
`onError`. Reconnects transparently at 9.5 minutes (`SESSION_LIMIT_MS`):
opens a new socket, sends setup, and switches `sendAudio` to it; the old one
gets `audioStreamEnd` and is closed after its final arrives or 3 s. Audio
chunks during the swap are sent to the new socket only.

**`src/live/server.ts`** (`npm run live -- [-i gemini|claude|recurrence] [--from <audio>] [--port 8787]`).
Uses the `ws` package for the server side. One live sounding per
connection:

- On a browser JSON `{type:'start'}`: create `SoundingSession` (interpreter
  from `-i`, `EmbeddingIdentityResolver`, `ReadingDynamics`, `DEFAULT_SALIENCE_CONFIG`),
  `drop()`, connect Transcribe Live, start the 100 ms clock (`advanceTo(now)`),
  start forwarding events.
- Binary frames from the browser are PCM chunks → ring buffer + Transcribe Live.
- Segmenter output → `feedPending` / `feedCommitted` (committed → interpreter
  call via the session; audio-native reads the ring buffer).
- Every new `SoundingEvent` appended to `session.log` is sent to the browser
  as a JSON text frame, in order. Additionally two live-only messages that
  are not part of the log: `{type:'live.heard', t, words}` (from
  heard-words on each pending delta) and `{type:'live.status', state:
  'connecting'|'listening'|'reconnecting'|'stopped'|'error', message?}`.
- On `{type:'stop'}` or socket close: `audioStreamEnd`, drain the final,
  `surface(now)`, write `soundings/live-<YYYYMMDD-HHmmss>.<interp>.jsonl`,
  print the same cost/latency summary the cast CLI prints.
- `--from <audio>`: fake mic. ffmpeg decodes the file to 16 kHz s16le and the
  server feeds 100 ms chunks on the real-time clock as if they came from the
  browser; the browser (if connected) still receives events, so live mode
  can be watched and tuned without talking. With `--from` and no browser,
  the server runs headless and exits at end of file.
- Session clock: `t = performance.now() − t0` at `start`. `src/live/` is the
  wall-clock boundary (like `src/ui/main.ts`); the engine never reads it.
- The `.env` loader from `src/cli/env.ts` runs at startup. Keys never leave
  this process.

**`src/ui/live.ts` + `live.html`.** A second page (`/live.html`), not a mode
of the replay instrument, so the two proofs of concept don't entangle:

- Controls: interpreter select (gemini default), **Listen / Stop** button,
  status text, clock, counters (same format as the replay page).
- Capture: `getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true}})`
  → `AudioContext({sampleRate:16000})` → `AudioWorkletNode` that batches 1600
  samples (100 ms) as Int16 and posts them → sent as binary WebSocket
  frames. (If the context refuses 16 kHz, the worklet downsamples by
  linear decimation from the context rate.)
- Rendering: `reading.changed` → the same `layoutReading` + mark rendering
  as the replay page (share `src/ui/chart.ts`, extracted from `main.ts`).
  `live.heard` → for each word, append an absolutely positioned `<span>` at
  a random position within the chart area, start large (`font-size` ≈ 48 px)
  and animate to small + transparent over 1.5 s (CSS transition), then
  remove. Words never overlap marks' labels intentionally; they float over.
  Slack indicator as on the replay page.
- The WebSocket URL is `ws://localhost:8787` (port from a query param
  `?port=`), so the Vite dev server and the live server are independent.

### Tuning changes (first task of the slice)

- `DEFAULT_SALIENCE_CONFIG.halfLifeMs`: 45 000 → 20 000. Expected effect:
  displacement of a dropped topic in ~15–20 s instead of ~36 s. The
  topic-shift fixture's local override (15 000) and any fixture expectations
  that encode the old latency are re-derived, not hand-edited: run the
  fixtures, read the new latencies, and record them.
- Both interpreter prompts gain: *"Do not report discourse or framing —
  'what I'm thinking', 'this afternoon', 'let me talk about', time-of-day,
  or the act of talking itself. Report only the content being thought
  about."* Verified by re-casting today's memo (cached transcript; Gemini
  calls only): the opening filler must not appear as marks.

## Error handling

- Mic denied → status `error: microphone access denied`.
- Live server not running → status `error: cannot reach live server at
  ws://localhost:8787` with the command to start it.
- Transcribe Live setup error / socket error → `live.status error` with the
  message; the session is surfaced and its log written so nothing is lost.
- Interpreter call failure → already handled inside the providers (empty
  candidates, `costUsd 0`, stderr line); the session continues.
- Missing `GEMINI_API_KEY` → server exits at startup with the same message
  the cast CLI prints.

## Testing

- Pure units (`tests/live-*.test.ts`): segmenter (delta on growth, delta on
  revision, time-based cut at 8 s with ≥4 new words, no cut below 4 words,
  final commits the remainder and resets, segment timestamps monotonic);
  ring buffer (push/slice across the wrap, clamp, wav header bytes);
  heard-words (stopwords dropped, surface form kept).
- Transcribe client: a fake `WebSocket` class injected via constructor;
  asserts setup message, chunk framing, interim/final dispatch, and the
  9.5-minute reconnect swap (fake timers).
- End to end without a key: `npm run live -- --from recordings/synthetic-memo.m4a -i recurrence`
  headless, with Transcribe Live replaced by a **fake transcriber** that
  replays the file's cached `.transcript.json` as interims/finals on the
  real-time clock (`--fake-transcriber`, dev-only). Produces
  `soundings/live-*.recurrence.jsonl`; a test asserts the log validates,
  has `sounding.dropped` … `sounding.surfaced`, ≥1 committed segment, and
  `reading.changed` ticks at 100 ms.
- Determinism guard unchanged: `src/live/` and `src/ui/` are outside it.
- Manual: `npm run dev` + `npm run live`, open `/live.html`, Listen, talk for
  a minute, watch heard words flash and marks move; Stop; confirm
  `soundings/live-*.gemini.jsonl` exists and loads in the replay page.
  Then `npm run live -- --from recordings/mic-20260905-145437.m4a` with the
  browser open, to watch today's memo as if live.

## Out of scope for this slice

Ephemeral tokens, iOS, prosody features beyond what Gemini audio-native
hears, pause/resume, multiple concurrent browsers, saving audio.

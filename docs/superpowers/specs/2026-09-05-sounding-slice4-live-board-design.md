# Sounding — slice 4: the live board on the web (design)

Date: 2026-09-05. Status: approved direction (Victor: "display-only first"; the
phone prototype targets the later iOS app, the web page gets the same upgrade).

## Goal

Talking to Sounding in the browser should look and feel like the approved
prototype (`docs/design/sounding-phone.template.html`), and the board must
keep moving while the model is thinking. Concretely:

1. The live page (`/live.html`) becomes **the board**: the reading fills the
   window; heard words flash; a round control drops and surfaces; a bottom
   sheet with peek / medium / large detents holds Context, Transcript, Chart.
2. The engine no longer stalls the reading during an interpreter call.
3. Context and Follow exist as UI state only (ghost marks; orange highlight).
   Wiring them into the interpreter is the next slice.

## Non-goals

- iOS. The phone prototype stays a design artifact; this slice is the web.
- Context or Follow influencing the model.
- Changing the replay instrument (`/index.html`); it remains the desktop
  tuning tool. It may pick up the shared board renderer later.
- Persisting anything new. Live mode still writes only the event log.

## Facts that shape the design

- **The stall.** `SoundingSession.processCommitted` awaits the interpreter
  *inside* the op queue (`src/core/session.ts`). Every `advanceTo` tick
  queued during a 3–5 s call waits, then runs in a burst. Timestamps are
  correct, so logs are unaffected; only liveness suffers.
- **Determinism.** `tests/fixtures-drift-determinism.test.ts` replays each
  fixture twice and requires byte-identical logs. `ReplayRunner.advanceTo`
  awaits `feedCommitted` before moving time, so in replay the session clock
  does not advance while an interpretation is pending.
- **Field-relative prominence is static between events**: uniform decay
  leaves ratios unchanged, so the board only moves on nudges and candidates.
  The prototype's 52 snapshots for a 151 s log were the complete truth.
- The live page already receives every `SoundingEvent` plus `live.heard`
  and `live.status`; the prototype consumes exactly the same shapes (it was
  built from a live log). `src/ui/chart.ts` is the current shared renderer.
- Transcribe Live's language auto-detect produced Portuguese interims once
  in an English memo.

## Design

### 1. Engine: interpret outside the queue, apply inside it

`feedCommitted(t, seg)` becomes two queued ops around an unqueued await:

```
op A (queued):  advanceNow(t); append segment.committed; input = buildInput(seg)
                (returns input)
(unqueued):     result = await interpreter.interpret(input)
op B (queued):  tA = max(t, latestT); advanceNow(tA);
                append candidates.emitted { t: tA, … }; await dynamics.applyCandidates(tA, …)
```

`latestT` is the largest timestamp the session has been asked to advance to
(`advanceTo`, `feedPending`, `feedCommitted`, `surface` all raise it).
`feedCommitted` still returns a promise that resolves after op B, so callers
that await it (the replay runner, tests) see no behaviour change, and because
the runner does not advance time while awaiting, `tA === t` in replay — the
logs stay byte-identical. In live mode the clock keeps calling `advanceTo`
during the await, so ticks flow, and the candidates land at their real
arrival time. `surface(t)` must wait for in-flight interpretations before
appending `sounding.surfaced` (track outstanding promises; `surface` awaits
them first, then enqueues). `EventLog` monotonicity is preserved because
op B's timestamp is never below the last appended `t`.

Semantics note, recorded in the code: `candidates.emitted.t` now means
"applied at", which in replay equals the segment time and in live mode is
the arrival time; `latencyMs` on the event still measures the call.

### 2. Live page = the board

`live.html` + `src/ui/live.ts` + `src/ui/live.css` are rebuilt from the
prototype. The page is a renderer of `LiveMessage`s, exactly as today, with
the prototype's presentation:

- **Layout.** No phone frame. The board is the viewport (min-height 100vh),
  status strip at the top (state dot, clock, cost/calls in small mono),
  round control centred at the bottom above the sheet's peek. On wide
  screens the sheet content is centred with `max-width: 760px`; the board
  uses the full width so marks have room. Themes as in the prototype
  (paper chart / deep water) via the same tokens.
- **Board.** Marks are words in Fraunces, size and weight from prominence,
  sunflower slots by first appearance, labels clamped inside; arrival =
  rise + orange buoy line; displacement = sink; slack dims; `.instant` class
  for rebuilds. Ghost marks for Context seeds; `.lit` for Follow.
- **Heard words.** From `live.heard`: italic, large, lower half, shrink and
  fade over 1.5 s.
- **Control.** Round button: dot → square while listening, breathing ring.
  Idle: connects, opens the mic, sends `start` (as today). Listening: sends
  `stop`. Surfaced: drop again. All existing error paths and `finish()`
  semantics are preserved; the status strip shows the state words
  (ready / connecting / listening / slack / paused / surfaced / error…).
- **Sheet.** Peek / medium / large, grabber + tabs, drag or flick or tap.
  Tabs: **Context** (textarea, chips, "Seed the board" — seeds ghost marks by
  matching against labels as they arrive; nothing is sent to the server),
  **Transcript** (committed segments as flowing text with a stamp every
  30 s; the pending tail in italic; auto-scroll while live), **Chart** (one
  lane per concept ordered by first appearance, area = prominence; a
  playhead; drag to scrub).
- **Scrubbing while live.** The page keeps every received event. Dragging
  the chart pauses the *display* (not the session): the board rebuilds from
  readings ≤ t with `.instant`, transcript and clock follow. A "Back to
  live" affordance (the status word becomes `replaying · tap to return`,
  and the round control's ring stops) returns to the head. New events keep
  accumulating while replaying, so returning shows the current reading.
  The server is untouched by scrubbing.
- **Follow.** Tap a mark or a lane name: orange on both, "following X" in
  the caption. Display only.
- **Surface.** After `live.status stopped`, the sheet opens at medium on
  Chart with the ranked final reading above the lanes, as in the prototype.

Shared code: the board renderer (`marks`, positions, arrival/sink),
the heard-word layer, the transcript and chart builders, and the sheet are
written as small TypeScript modules under `src/ui/board/` so the replay
instrument can adopt them later. `src/ui/chart.ts` (the old circle
renderer) stays for `/index.html` untouched.

### 3. Transcribe Live language

`--lang en-US` (default) on the live server sets `languageCodes: ['en-US']`
in the Live API setup; `--lang auto` restores `[]`.

## Error handling

Unchanged from slice 3 (`finish()` is the single exit). New: a scrub with no
events yet is a no-op; leaving replay after the session surfaced shows the
final reading.

## Testing

- Engine: a test that a slow interpreter (fake, 9 s of session time) does
  not delay ticks — with a `Clock`-driven loop, `reading.changed` events
  keep arriving at 100 ms spacing while the call is pending — and that the
  candidates land at the arrival time; the determinism test stays green
  (byte-identical replay); a test that `surface` waits for in-flight
  interpretations.
- Board modules: pure functions unit-tested (slot layout clamps labels
  inside a given box; reading diff → arrivals/departures/updates; transcript
  model from events; chart series from readings; heard-word extraction
  reuses `src/live/heard-words.ts`).
- Browser (Playwright, fake transcriber + headless-free server): drop →
  listening → words flash → marks appear → sheet detents → transcript fills
  → chart scrub rebuilds the board → back to live → stop → surfaced sheet.
- Manual: Victor talks to it.

## Out of scope

Wiring Context/Follow to the interpreter; iOS; replay-instrument restyle;
tuning changes.

# Sounding — slice 5: Context and Follow reach the interpreter (design)

Date: 2026-09-06. Status: Victor asked to "start with the Context and Follow
wiring" after the first real session on the live board.

## Goal

What you bring and what you tap should change what the model hears and
reports, without changing what the reading *is*.

- **Context** (the text in the Context tab / popover): names and terms in it
  are transcribed with their spelling ("Sounding", not "sound thing";
  "Trust Wallet" from the first mention) and the interpreter labels them
  exactly. Context is never evidence: it adds no weight to any mark.
- **Follow** (tapping a mark): the interpreter is told the speaker is
  drilling into that concept and reports its evidence more attentively,
  with the same honesty rule (no invented support). Follow does not protect
  a mark from decay or displacement — the reading stays a mirror of the
  talk, not of the tap.

Both are recorded in the event log so replay and compare see them.

## Non-goals

- Seeding weight into the reading from context (the brief: salience is
  where attention lands without deciding to).
- Pinning a followed mark on the chart.
- Diarization, multiple speakers.

## Facts

- Transcribe Live's setup message accepts `inputAudioTranscription.customVocabulary: string[]`
  (verified shape from the live-transcribe docs; sent at connect, so it
  applies to the session from `start`). Word-level timestamps and
  diarization can't combine with custom vocabulary; live mode uses neither.
- `InterpreterInput` is `AudioSegment | Transcript`; both providers build
  their prompt from a constant plus the window/audio. The Claude system
  prompt is cache-controlled, so hints go in the **user** turn.
- The session's `buildInput(seg)` is the one place inputs are made.
- The page already keeps `contextText` and the followed concept id; the
  server maps ids to labels from `reading.changed`.

## Design

### 1. Hints on the port and in the log

```ts
export interface InterpretationHints { context?: string; follow?: string }   // follow = the followed concept's label
export interface Transcript   { …; hints?: InterpretationHints }
export interface AudioSegment { …; hints?: InterpretationHints }
```

New log events (both optional, monotonic like the rest):

```ts
| { type: 'context.brought'; t: Ms; text: string }
| { type: 'mark.followed';  t: Ms; conceptId: string | null; label: string | null }
```

`SoundingSession` gains `setContext(t, text)` and `setFollow(t, conceptId, label)`;
each is a queued op that advances to `t`, appends its event, and updates
the session's current hints. `buildInput` attaches the current hints to
every input. Replay determinism is unaffected (no new time source); the
existing fixtures carry no hints, so their logs are byte-identical.

### 2. Prompts

Both providers append, after their existing prompt text and only when the
hint is present:

```
Context the speaker brought before talking. Names and terms here are likely
to recur: use their exact spelling as labels. This context is NOT evidence
of anything said — never report a concept only because it appears here.
<context text, trimmed to 1200 characters>

The speaker is following "<label>". If the talk touches it, report it and
its evidence attentively. Do not invent support for it.
```

Claude: appended to `buildUserPrompt` (system prompt untouched, so the
cache still applies). Gemini: appended to the `AUDIO_PROMPT` text part.
Also, one more discourse example in both prompts' filler rule: *"the language
being spoken, or whether the listener understands it"*.

### 3. Vocabulary from context

`src/live/vocabulary.ts` (pure): `vocabularyFrom(text): string[]` — runs of
Capitalised tokens (allowing inner "of/the/and"), quoted phrases, and
`CamelCase`/`ALLCAPS` tokens; de-duplicated, order of first appearance,
max 50, each ≤ 40 chars. `TranscribeLiveClient` takes `customVocabulary`
and puts it in the setup message. `--from`/fixture paths ignore it.

### 4. Wire protocol

Browser → server:
- `{type:'start', interpreter?, context?}` — context text at start (feeds
  vocabulary + the hint from the first call).
- `{type:'context', text}` — update the hint mid-session (vocabulary is
  fixed for the session; documented in the Context pane's note).
- `{type:'follow', conceptId: string | null}` — follow / let go.

Server: on `start` with context → `session.setContext(now, text)` before
connecting, and `customVocabulary = vocabularyFrom(text)`; on `context` →
`setContext(now, text)`; on `follow` → look up the label from the latest
reading (`null` if unknown), `setFollow(now, id, label)`. All three are
validated (strings, length caps: context ≤ 4000 chars) and ignored when no
session is live except `start`.

Server → browser: unchanged; the two new events arrive through the normal
log forwarding, so the page can show a small "brought" / "following" note
from the log itself (display already exists; it just also sends).

### 5. Page

- Seed the board (button) → also `send({type:'context', text})` if live, and
  remembers the text so the next `start` includes it.
- Tap to follow / let go → `send({type:'follow', conceptId})`.
- The Context pane note gains: "Names here are also used to help the
  transcriber from the next drop."

### 6. Cast CLI

`--context <file>`: reads the file, calls `session.setContext(0, text)`
before running, so tuning on recordings can use the same hints.

## Error handling

Bad `context`/`follow` payloads → `live.status warning` with the reason, no
session change. A follow for an unknown id → `setFollow(now, null, null)`
(let go) and a warning.

## Testing

- Session: `setContext`/`setFollow` append events in order and `buildInput`
  carries the current hints (unit, gated interpreter).
- Prompt builders: hints present → block appended verbatim; absent →
  unchanged strings (snapshot-free equality on the appended part).
- `vocabularyFrom`: capitalised runs, quoted phrases, CamelCase, cap, dedupe.
- Transcribe client: setup carries `customVocabulary`.
- Server/LiveSounding: with a stub transcriber, `start` with context yields
  `context.brought` first in the log and hints on the interpreter input;
  `follow` yields `mark.followed` with the right label.
- Determinism fixtures byte-identical.
- Browser (fake transcriber): seed → follow → stop → the saved log contains
  both events.

## Out of scope

Weighting from context; follow affecting dynamics; identity-resolver
pre-registration of context terms (revisit if spelling hints prove weak).

# Sounding — mic recording in the replay UI (design)

Date: 2026-09-05. Status: approved by Victor in conversation.

## Goal

Let Victor speak into the browser and see the reading without leaving the UI.
This is **not** live streaming (that remains slice 3). It is: record → save →
cast → auto-load, one click from speaking to seeing. Latency is the cast time
(roughly 3s per committed segment, so a 3-minute memo shows up in 1–2 minutes).

## Facts that shape the design

- The cast CLI transcribes with whisper first for **every** interpreter, because
  segment boundaries come from the transcript. The Gemini path therefore still
  runs whisper locally before the audio-native calls. Accepted for this step.
- Browser `MediaRecorder` emits a streamed WebM/Opus file without a seek index;
  ffmpeg's `-ss` slicing (used by the Gemini audio window) is unreliable on it.
  The server transcodes uploads to `.m4a` (AAC), the same container Voice Memos
  produces, before anything else touches the file.
- API keys never reach the browser (brief rule). All model calls stay in the
  cast CLI process, which loads `.env` itself.

## Components

### 1. Dev-server API — `vite.config.ts` plugin `soundingDevApi`

Dev-only (`configureServer`), bound to Vite's localhost listener. Three routes:

- `POST /api/recordings` — body is raw audio bytes (`content-type: audio/webm`
  or whatever the browser produced). Server writes a temp file, runs
  `ffmpeg -i tmp -c:a aac recordings/mic-<YYYYMMDD-HHmmss>.m4a`, deletes the
  temp file, responds `{ "name": "mic-<stamp>" }`. Creates `recordings/` if
  missing. Non-2xx with the ffmpeg stderr on failure.
- `POST /api/cast` — JSON `{ "name": string, "interpreter": "gemini"|"claude"|"recurrence" }`.
  Spawns `npx tsx src/cli/cast.ts recordings/<name>.m4a -i <interpreter>` as a
  child process with the project root as cwd, waits for exit, responds
  `{ "log": "soundings/<name>.<interpreter>.jsonl", "stdout": string }`.
  Non-2xx with stderr + exit code on failure. No response timeout is imposed;
  Vite/Node do not time out a slow response body by default.
- `GET /soundings/<file>.jsonl` — already served by Vite's static file handling
  in dev (project root is inside `server.fs.allow`). No code needed; the UI
  fetches the log path returned by `/api/cast`.

Path safety: `name` must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/` and must
not contain `..`; `interpreter` must be one of the three literals. Anything else
is a 400. These two validators live in `src/devserver/paths.ts` (pure, unit
tested); the plugin imports them.

### 2. UI — `index.html`, `src/ui/main.ts`, `src/ui/style.css`

Header gains, after the log file input:

- `<select id="mic-interp">` with options gemini (default), claude, recurrence.
- `<button id="record">Record</button>`.
- `<span id="mic-status"></span>` for state/elapsed/error text.

State machine (single `micState` variable):

| state     | button  | status text                         | on click        |
|-----------|---------|-------------------------------------|-----------------|
| idle      | Record  | (empty)                             | start recording |
| recording | Stop    | `● 0:42`                            | stop            |
| saving    | (disabled) | `saving…`                        | —               |
| casting   | (disabled) | `casting gemini… 0:37`           | —               |
| idle      | Record  | `loaded mic-<stamp>.gemini` or `error: …` | start again |

Recording uses `navigator.mediaDevices.getUserMedia({ audio: true })` and
`MediaRecorder` with the browser's default audio mime type; chunks are
collected and uploaded as one Blob on stop. Mic tracks are stopped after
upload so the browser's recording indicator clears.

On successful cast the UI fetches the returned log path and calls
`loadLogText(text, label)`, the same function the file picker uses; the chart
is then in the loaded-log state, ready to Drop, exactly as if the file had been
picked. Errors from any step land in `#mic-status` (first line of the
server's message) and return the state to idle.

Refactor: the current `logFileInput` change handler is split into
`loadLogText(text: string, label: string)` plus a thin handler that reads the
file and calls it.

### 3. Unchanged

Engine, salience, providers, CLIs, event schema, tests for all of those.
`.gitignore` already excludes `recordings/` and `soundings/`.

## Error handling

- Mic permission denied → status `error: microphone access denied`, idle.
- ffmpeg missing or failing → 500 with stderr; status shows first line.
- cast failing (bad key, model error) → 500 with the CLI's stderr; status shows
  first line. The recording is kept on disk so it can be re-cast from the CLI.
- Invalid name/interpreter → 400 (only reachable by hand-crafted requests).

## Testing

- `tests/devserver-paths.test.ts`: validator accepts `mic-20260905-113000`,
  rejects `../x`, `a/b`, empty, over-long, and non-listed interpreters; path
  builders return `recordings/<name>.m4a` and `soundings/<name>.<interp>.jsonl`.
- Existing 107 tests unchanged and green. `vite.config.ts` and
  `src/devserver/` sit outside the wall-clock guard's scope (`src/core`,
  `src/salience`, `src/interpret`, `src/replay`), and the guard test must still
  pass.
- Manual end-to-end in the browser: record ~30s, Stop, watch status move
  through saving → casting → loaded, Drop plays the reading; confirm
  `recordings/mic-*.m4a` and `soundings/mic-*.gemini.jsonl` exist and
  `npm run compare` works on the produced log.

## Out of scope

Live streaming, VAD, pending-word fast loop from the mic, deleting recordings
from the UI, progress percentage during cast.

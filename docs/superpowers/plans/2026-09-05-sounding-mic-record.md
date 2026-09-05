# Mic Recording in the Replay UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Record button in the replay UI that captures the mic, saves the audio into `recordings/`, runs the existing cast CLI, and auto-loads the resulting sounding log — one click from speaking to seeing.

**Architecture:** A dev-only Vite plugin (`src/devserver/api.ts`, registered from a new `vite.config.ts`) exposes two localhost routes: `POST /api/recordings` (transcode the browser's WebM upload to `.m4a` via ffmpeg) and `POST /api/cast` (spawn `tsx src/cli/cast.ts` as a child process and wait). The UI (`src/ui/main.ts`) gains a small record state machine and reuses its log-loading path for the fetched log. API keys stay in the CLI process; the browser never sees them.

**Tech Stack:** TypeScript, Vite 6 dev-server plugin API (`configureServer`), Node `child_process.spawn`, ffmpeg (already installed), browser `MediaRecorder`, vitest.

Spec: `docs/superpowers/specs/2026-09-05-sounding-mic-record-design.md`.

## Global Constraints

- API keys never reach the browser. All model calls happen inside the cast CLI child process, which loads `.env` itself (`src/cli/env.ts`). Do not read `process.env.GEMINI_API_KEY` / `ANTHROPIC_API_KEY` anywhere in the dev-server plugin or UI.
- `recordings/` and `soundings/` are gitignored and must stay so. Never `git add` anything under them.
- The wall-clock guard test (`tests/fixtures-drift-determinism.test.ts`) walks `src/core`, `src/salience`, `src/interpret`, `src/replay`. New code lives in `src/devserver/` and `src/ui/`, outside that scope. Do not touch the guarded directories.
- Recording name validator: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/` and no `..` substring. Interpreter literals: `'gemini' | 'claude' | 'recurrence'`.
- Uploaded audio is transcoded to `recordings/mic-<YYYYMMDD-HHmmss>.m4a` (AAC) before any other use.
- Run tests with `npm test` (vitest run). Type-check with `npx tsc --noEmit -p .`. Existing 107 tests must stay green.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `src/devserver/paths.ts` (create) | Pure validators and path builders. No I/O. |
| `src/devserver/api.ts` (create) | Vite plugin `soundingDevApi()`: request body reading, ffmpeg transcode, cast child process, JSON responses. |
| `vite.config.ts` (create) | Registers the plugin. Nothing else. |
| `index.html` (modify) | Header gains interpreter select, Record button, status span. |
| `src/ui/main.ts` (modify) | Extract `loadLogText()`; add record state machine. |
| `src/ui/style.css` (modify) | Status span and recording indicator styles. |
| `tests/devserver-paths.test.ts` (create) | Validator/path-builder tests. |
| `tests/devserver-api.test.ts` (create) | Cast argv builder and timestamp-name tests. |

---

### Task 1: Path validators and builders

**Files:**
- Create: `src/devserver/paths.ts`
- Test: `tests/devserver-paths.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const INTERPRETERS: readonly ['gemini', 'claude', 'recurrence']
  export type InterpreterName = (typeof INTERPRETERS)[number]
  export function isValidRecordingName(name: unknown): name is string
  export function isInterpreterName(x: unknown): x is InterpreterName
  export function recordingPath(name: string): string      // `recordings/${name}.m4a`
  export function soundingPath(name: string, interp: InterpreterName): string // `soundings/${name}.${interp}.jsonl`
  export function stampName(d: Date): string               // `mic-YYYYMMDD-HHmmss` (local time)
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/devserver-paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  isValidRecordingName,
  isInterpreterName,
  recordingPath,
  soundingPath,
  stampName,
} from '../src/devserver/paths'

describe('isValidRecordingName', () => {
  it('accepts stamp-style and plain names', () => {
    expect(isValidRecordingName('mic-20260905-113000')).toBe(true)
    expect(isValidRecordingName('synthetic-memo')).toBe(true)
    expect(isValidRecordingName('a')).toBe(true)
  })
  it('rejects traversal, separators, leading dots, empty, non-strings, over-long', () => {
    expect(isValidRecordingName('../x')).toBe(false)
    expect(isValidRecordingName('a/b')).toBe(false)
    expect(isValidRecordingName('a\\b')).toBe(false)
    expect(isValidRecordingName('.hidden')).toBe(false)
    expect(isValidRecordingName('a..b')).toBe(false)
    expect(isValidRecordingName('')).toBe(false)
    expect(isValidRecordingName(undefined)).toBe(false)
    expect(isValidRecordingName(42)).toBe(false)
    expect(isValidRecordingName('a'.repeat(82))).toBe(false)
  })
})

describe('isInterpreterName', () => {
  it('accepts the three interpreters and nothing else', () => {
    expect(isInterpreterName('gemini')).toBe(true)
    expect(isInterpreterName('claude')).toBe(true)
    expect(isInterpreterName('recurrence')).toBe(true)
    expect(isInterpreterName('whisper')).toBe(false)
    expect(isInterpreterName('')).toBe(false)
    expect(isInterpreterName(null)).toBe(false)
  })
})

describe('path builders', () => {
  it('build relative paths inside recordings/ and soundings/', () => {
    expect(recordingPath('mic-1')).toBe('recordings/mic-1.m4a')
    expect(soundingPath('mic-1', 'gemini')).toBe('soundings/mic-1.gemini.jsonl')
  })
})

describe('stampName', () => {
  it('formats local time as mic-YYYYMMDD-HHmmss', () => {
    const d = new Date(2026, 8, 5, 11, 30, 7) // local: 2026-09-05 11:30:07
    expect(stampName(d)).toBe('mic-20260905-113007')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/devserver-paths.test.ts`
Expected: FAIL — `Cannot find module '../src/devserver/paths'`

- [ ] **Step 3: Implement**

Create `src/devserver/paths.ts`:

```ts
// Pure name validation and path building for the dev-server API.
// No I/O here; the plugin (api.ts) does the reading and spawning.

export const INTERPRETERS = ['gemini', 'claude', 'recurrence'] as const
export type InterpreterName = (typeof INTERPRETERS)[number]

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

export function isValidRecordingName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..')
}

export function isInterpreterName(x: unknown): x is InterpreterName {
  return typeof x === 'string' && (INTERPRETERS as readonly string[]).includes(x)
}

export function recordingPath(name: string): string {
  return `recordings/${name}.m4a`
}

export function soundingPath(name: string, interp: InterpreterName): string {
  return `soundings/${name}.${interp}.jsonl`
}

export function stampName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `mic-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/devserver-paths.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/devserver/paths.ts tests/devserver-paths.test.ts
git commit -m "feat(devserver): recording name validation and path builders

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

### Task 2: Dev-server API plugin

**Files:**
- Create: `src/devserver/api.ts`
- Create: `vite.config.ts`
- Test: `tests/devserver-api.test.ts`

**Interfaces:**
- Consumes (Task 1): `isValidRecordingName`, `isInterpreterName`, `recordingPath`, `soundingPath`, `stampName`, `InterpreterName`.
- Produces:
  ```ts
  export function castArgv(name: string, interp: InterpreterName): string[]
  // ['tsx', 'src/cli/cast.ts', 'recordings/<name>.m4a', '-i', '<interp>']  (spawned via npx)
  export function soundingDevApi(): Plugin   // Vite plugin
  ```
  HTTP contract (consumed by Task 3):
  - `POST /api/recordings`, body = raw audio bytes → `200 { "name": "mic-…" }` or `500 { "error": "<ffmpeg stderr>" }`
  - `POST /api/cast`, JSON `{ "name", "interpreter" }` → `200 { "log": "soundings/<name>.<interp>.jsonl", "stdout": "…" }`, `400 { "error" }` on bad input, `500 { "error": "<stderr>\nexit <code>" }` on failure.

Notes for the implementer:
- Vite's dev server is a Connect app; `server.middlewares.use((req, res, next) => …)` runs before Vite's own handlers. Only handle the two paths above; call `next()` for everything else.
- Request bodies must be read manually from the `IncomingMessage` stream (Connect adds no body parser).
- Spawn `npx` with `['tsx', 'src/cli/cast.ts', …]` so the CLI runs the same way `npm run cast` does. `cwd` is the project root (`process.cwd()` under `vite`), which is where `.env`, `recordings/`, and `soundings/` live.
- The `.env` loader is inside the cast CLI. Do not load it in the plugin.

- [ ] **Step 1: Write the failing test**

Create `tests/devserver-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { castArgv, soundingDevApi } from '../src/devserver/api'

describe('castArgv', () => {
  it('runs the cast CLI through tsx with the recording path and interpreter', () => {
    expect(castArgv('mic-20260905-113007', 'gemini')).toEqual([
      'tsx', 'src/cli/cast.ts', 'recordings/mic-20260905-113007.m4a', '-i', 'gemini',
    ])
  })
})

describe('soundingDevApi', () => {
  it('is a dev-only Vite plugin', () => {
    const p = soundingDevApi()
    expect(p.name).toBe('sounding-dev-api')
    expect(p.apply).toBe('serve')
    expect(typeof p.configureServer).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/devserver-api.test.ts`
Expected: FAIL — `Cannot find module '../src/devserver/api'`

- [ ] **Step 3: Implement the plugin**

Create `src/devserver/api.ts`:

```ts
// Dev-only Vite plugin: lets the replay UI save a mic recording and cast it.
// Localhost only (Vite's default listener). API keys never pass through here —
// the cast CLI child process loads .env itself.
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import {
  isValidRecordingName,
  isInterpreterName,
  recordingPath,
  soundingPath,
  stampName,
  type InterpreterName,
} from './paths'

export function castArgv(name: string, interp: InterpreterName): string[] {
  return ['tsx', 'src/cli/cast.ts', recordingPath(name), '-i', interp]
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

interface RunResult { code: number | null; stdout: string; stderr: string }

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function handleRecordingUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bytes = await readBody(req)
  if (bytes.length === 0) return sendJson(res, 400, { error: 'empty upload' })
  const name = stampName(new Date())
  const tmp = join(tmpdir(), `${name}.upload`)
  writeFileSync(tmp, bytes)
  try {
    mkdirSync('recordings', { recursive: true })
    // MediaRecorder's streamed WebM has no seek index; transcode to a seekable
    // AAC .m4a (the same container Voice Memos produces) before anything else
    // touches the file — the Gemini audio window relies on ffmpeg -ss seeking.
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-vn', '-c:a', 'aac', recordingPath(name)])
    if (r.code !== 0) return sendJson(res, 500, { error: r.stderr || `ffmpeg exited ${r.code}` })
    sendJson(res, 200, { name })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  } finally {
    try { unlinkSync(tmp) } catch { /* already gone */ }
  }
}

async function handleCast(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { name?: unknown; interpreter?: unknown }
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'))
  } catch {
    return sendJson(res, 400, { error: 'body must be JSON' })
  }
  if (!isValidRecordingName(body.name)) return sendJson(res, 400, { error: 'invalid name' })
  if (!isInterpreterName(body.interpreter)) return sendJson(res, 400, { error: 'invalid interpreter' })
  try {
    const r = await run('npx', castArgv(body.name, body.interpreter))
    if (r.code !== 0) return sendJson(res, 500, { error: `${r.stderr.trim()}\nexit ${r.code}` })
    sendJson(res, 200, { log: soundingPath(body.name, body.interpreter), stdout: r.stdout })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

export function soundingDevApi(): Plugin {
  return {
    name: 'sounding-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST') return next()
        if (req.url === '/api/recordings') return void handleRecordingUpload(req, res)
        if (req.url === '/api/cast') return void handleCast(req, res)
        next()
      })
    },
  }
}
```

Create `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import { soundingDevApi } from './src/devserver/api'

export default defineConfig({
  plugins: [soundingDevApi()],
})
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run tests/devserver-api.test.ts && npx tsc --noEmit -p . && npm test`
Expected: the new file passes (2 tests); tsc clean; full suite green (107 + 6 new).

If `tsc` complains that `vite.config.ts` is outside the `include` of `tsconfig.json`, that is fine — leave it out; Vite compiles it itself. Do not widen `tsconfig.json` `include` unless it already covers the project root.

- [ ] **Step 5: Smoke-test the routes with curl**

Start the dev server in the background and hit both routes:

```bash
npm run dev > /tmp/vite-smoke.log 2>&1 &
sleep 3
# invalid inputs → 400
curl -s -X POST localhost:5173/api/cast -H 'content-type: application/json' -d '{"name":"../x","interpreter":"gemini"}'
curl -s -X POST localhost:5173/api/cast -H 'content-type: application/json' -d '{"name":"synthetic-memo","interpreter":"whisper"}'
# real upload: transcode the synthetic memo through the upload route
curl -s -X POST localhost:5173/api/recordings -H 'content-type: audio/mp4' --data-binary @recordings/synthetic-memo.m4a
ls recordings/mic-*.m4a
# cast the upload with the free interpreter (no key, fast)
NAME=$(ls recordings/mic-*.m4a | tail -1 | xargs basename | sed 's/\.m4a$//')
curl -s -X POST localhost:5173/api/cast -H 'content-type: application/json' -d "{\"name\":\"$NAME\",\"interpreter\":\"recurrence\"}" | head -c 400
ls soundings/$NAME.recurrence.jsonl
kill %1
```

Expected: two `{"error":…}` lines with status 400; `{"name":"mic-…"}`; the `.m4a` exists; the cast response contains `"log":"soundings/mic-….recurrence.jsonl"` and the file exists.

Clean up the smoke artifacts afterwards: `rm recordings/mic-*.m4a recordings/mic-*.transcript.json soundings/mic-*.jsonl`.

- [ ] **Step 6: Commit**

```bash
git add src/devserver/api.ts vite.config.ts tests/devserver-api.test.ts
git commit -m "feat(devserver): /api/recordings and /api/cast for the replay UI

Dev-only Vite plugin. Uploads are transcoded to seekable .m4a with ffmpeg;
casts spawn the existing CLI as a child process so .env and all key
handling stay out of the browser and the dev server.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

### Task 3: Record button in the UI

**Files:**
- Modify: `index.html` (header)
- Modify: `src/ui/main.ts` (extract `loadLogText`, add record state machine)
- Modify: `src/ui/style.css`

**Interfaces:**
- Consumes (Task 2 HTTP contract): `POST /api/recordings` → `{ name }`; `POST /api/cast` `{ name, interpreter }` → `{ log }`; `GET /<log>` served by Vite.
- Produces: `loadLogText(text: string, label: string): boolean` (internal to main.ts).

There is no unit-test harness for the browser UI in this repo (main.ts touches DOM and wall clock). Verification is the browser check in Step 5.

- [ ] **Step 1: Add the controls to `index.html`**

Replace the header's `<input type="file" …>` line with these three lines (keep everything else):

```html
      <input type="file" id="log-file" accept=".jsonl" title="Load a saved sounding log" />
      <select id="mic-interp" title="Interpreter for mic recordings">
        <option value="gemini">gemini</option>
        <option value="claude">claude</option>
        <option value="recurrence">recurrence</option>
      </select>
      <button id="record">Record</button>
      <span id="mic-status"></span>
```

- [ ] **Step 2: Extract `loadLogText` in `src/ui/main.ts`**

Replace the whole `logFileInput.addEventListener('change', …)` block with:

```ts
/** Load a sounding log (jsonl text) into the loaded-log playback mode. Returns false on parse failure. */
function loadLogText(text: string, label: string): boolean {
  let log: EventLog
  try {
    log = EventLog.fromJsonl(text)
  } catch (err) {
    console.error(err)
    inspector.innerHTML = `<p>Failed to load ${label}: ${err instanceof Error ? err.message : String(err)}</p>`
    return false
  }
  reset()
  loadedEvents = log.all()
  loadedReadings = loadedEvents.filter((e): e is Extract<SoundingEvent, { type: 'reading.changed' }> => e.type === 'reading.changed')
  loadedIdx = 0
  const c = summarizeCounters(loadedEvents)
  countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms`
  playPause.textContent = 'Drop'
  return true
}

logFileInput.addEventListener('change', async () => {
  const file = logFileInput.files?.[0]
  if (!file) return
  const ok = loadLogText(await file.text(), file.name)
  if (!ok) logFileInput.value = ''
})
```

- [ ] **Step 3: Add the record state machine to `src/ui/main.ts`**

Add these element lookups next to the existing ones at the top:

```ts
const micInterp = document.getElementById('mic-interp') as HTMLSelectElement
const recordBtn = document.getElementById('record') as HTMLButtonElement
const micStatus = document.getElementById('mic-status')!
```

Append this block at the end of the file, just above `reset()` / `requestAnimationFrame(frame)`:

```ts
// ---- Mic recording: record → save → cast → load. Not live; the cast runs
// after Stop, and the reading appears when it finishes.
type MicState = 'idle' | 'recording' | 'saving' | 'casting'
let micState: MicState = 'idle'
let recorder: MediaRecorder | null = null
let micChunks: Blob[] = []
let micStartedWallT = 0
let micTimer: number | null = null

function setMic(state: MicState, status = '') {
  micState = state
  micStatus.textContent = status
  micStatus.classList.toggle('recording', state === 'recording')
  recordBtn.textContent = state === 'recording' ? 'Stop' : 'Record'
  recordBtn.disabled = state === 'saving' || state === 'casting'
  micInterp.disabled = state !== 'idle'
}

function startMicTimer(prefix: string) {
  micStartedWallT = performance.now()
  const tick = () => { micStatus.textContent = `${prefix} ${fmt(performance.now() - micStartedWallT)}` }
  tick()
  micTimer = window.setInterval(tick, 500)
}

function stopMicTimer() {
  if (micTimer !== null) window.clearInterval(micTimer)
  micTimer = null
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0) ?? s
}

async function postJson<T>(url: string, body: BodyInit, contentType: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

async function startRecording() {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    setMic('idle', 'error: microphone access denied')
    return
  }
  micChunks = []
  recorder = new MediaRecorder(stream)
  recorder.ondataavailable = (e) => { if (e.data.size > 0) micChunks.push(e.data) }
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop()) // clears the browser's recording indicator
    void saveAndCast(new Blob(micChunks, { type: recorder?.mimeType || 'audio/webm' }))
  }
  recorder.start(1000)
  setMic('recording')
  startMicTimer('●')
}

async function saveAndCast(blob: Blob) {
  stopMicTimer()
  const interpreter = micInterp.value
  try {
    setMic('saving', 'saving…')
    const { name } = await postJson<{ name: string }>('/api/recordings', blob, blob.type || 'application/octet-stream')
    setMic('casting')
    startMicTimer(`casting ${interpreter}…`)
    const { log } = await postJson<{ log: string }>(
      '/api/cast',
      JSON.stringify({ name, interpreter }),
      'application/json',
    )
    stopMicTimer()
    const res = await fetch(`/${log}`)
    if (!res.ok) throw new Error(`could not fetch ${log} (HTTP ${res.status})`)
    const ok = loadLogText(await res.text(), log)
    setMic('idle', ok ? `loaded ${name}.${interpreter}` : `error: ${log} did not parse`)
  } catch (err) {
    stopMicTimer()
    setMic('idle', `error: ${firstLine(err instanceof Error ? err.message : String(err))}`)
  }
}

recordBtn.addEventListener('click', () => {
  if (micState === 'idle') void startRecording()
  else if (micState === 'recording') recorder?.stop()
})
```

Note: `reset()` clears the loaded log but must not touch mic state; a cast in flight keeps running and loads when done. No change to `reset()` is needed.

- [ ] **Step 4: Style the status**

Append to `src/ui/style.css`:

```css
#mic-status { font-variant-numeric: tabular-nums; color: #3d5a6a; min-width: 12ch; }
#mic-status.recording { color: #c6472e; }
#record:disabled { opacity: 0.6; }
```

- [ ] **Step 5: Type-check, test, and verify in the browser**

Run: `npx tsc --noEmit -p . && npm test`
Expected: clean; all tests green.

Browser check (the dev server may already be running on http://localhost:5173/; if not, `npm run dev`):

1. Open http://localhost:5173/. Header shows the interpreter select (gemini), a Record button, empty status.
2. Choose **recurrence** in the interpreter select (free, no key, fast) for the first pass. Click **Record**, allow the mic, speak for ~20 seconds, click **Stop**.
3. Status moves through `● 0:20` → `saving…` → `casting recurrence… 0:0x` → `loaded mic-<stamp>.recurrence`. The counters line shows calls; **Drop** plays the reading; clicking a mark opens the inspector.
4. `ls recordings/mic-*.m4a soundings/mic-*.recurrence.jsonl` — both exist.
5. Switch the select to **gemini**, record ~30 seconds of real thinking-out-loud, Stop. Status shows `casting gemini…` with a running timer (expect ~1 minute for whisper + ~10 calls), then `loaded …gemini`. Drop plays it. `npm run compare -- soundings/mic-<stamp>.recurrence.jsonl soundings/mic-<stamp>.gemini.jsonl` prints a comparison (names will differ per recording; use the two logs from the same stamp if you recorded once with each, otherwise compare any two).
6. Error path: with the select on **claude**, temporarily rename `.env` to `.env.off`, record 5 seconds, Stop. Status ends with `error: …` mentioning ANTHROPIC_API_KEY; the `.m4a` is kept on disk. Rename `.env` back. Do not commit any of the recorded files.

If anything in steps 3–6 does not match, fix it before committing; report exactly which step diverged.

- [ ] **Step 6: Commit**

```bash
git add index.html src/ui/main.ts src/ui/style.css
git commit -m "feat(ui): Record button — mic → save → cast → auto-load the reading

Not live streaming: the cast runs after Stop and the log loads when it
finishes. Reuses the file-picker load path via loadLogText().

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AhrACiXcCSbCyf2GDuZUWw"
```

---

## Self-review

- **Spec coverage:** dev-server routes (Task 2), validators (Task 1), UI controls + state machine + `loadLogText` refactor (Task 3), transcoding to `.m4a` (Task 2 handler), error handling for mic denied / ffmpeg / cast / bad input (Tasks 2–3), tests (Tasks 1–2 unit, Task 3 browser). `GET /soundings/…` needs no code (Vite static). Out-of-scope items untouched.
- **Placeholders:** none.
- **Type consistency:** `InterpreterName`, `recordingPath`, `soundingPath`, `stampName`, `castArgv`, `soundingDevApi`, `loadLogText` are used with the signatures defined where introduced.

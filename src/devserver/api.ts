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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

export async function handleRecordingUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let tmp: string | undefined
  try {
    const bytes = await readBody(req)
    if (bytes.length === 0) return sendJson(res, 400, { error: 'empty upload' })
    const name = stampName(new Date())
    tmp = join(tmpdir(), `${name}.upload`)
    writeFileSync(tmp, bytes)
    mkdirSync('recordings', { recursive: true })
    // MediaRecorder's streamed WebM has no seek index; transcode to a seekable
    // AAC .m4a (the same container Voice Memos produces) before anything else
    // touches the file — the Gemini audio window relies on ffmpeg -ss seeking.
    const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-vn', '-c:a', 'aac', recordingPath(name)])
    if (r.code !== 0) return sendJson(res, 500, { error: r.stderr || `ffmpeg exited ${r.code}` })
    sendJson(res, 200, { name })
  } catch (err) {
    sendJson(res, 500, { error: errMsg(err) })
  } finally {
    if (tmp) { try { unlinkSync(tmp) } catch { /* already gone */ } }
  }
}

export async function handleCast(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'))
  } catch {
    return sendJson(res, 400, { error: 'body must be JSON' })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return sendJson(res, 400, { error: 'body must be a JSON object' })
  }
  const { name, interpreter } = body as { name?: unknown; interpreter?: unknown }
  if (!isValidRecordingName(name)) return sendJson(res, 400, { error: 'invalid name' })
  if (!isInterpreterName(interpreter)) return sendJson(res, 400, { error: 'invalid interpreter' })
  try {
    const r = await run('npx', castArgv(name, interpreter))
    if (r.code !== 0) return sendJson(res, 500, { error: `${r.stderr.trim()}\nexit ${r.code}` })
    sendJson(res, 200, { log: soundingPath(name, interpreter), stdout: r.stdout })
  } catch (err) {
    sendJson(res, 500, { error: errMsg(err) })
  }
}

// No request path may leave a rejected promise dangling: every handler
// invocation from the middleware goes through this backstop so a bug that
// slips past a handler's own try/catch still gets a response instead of
// crashing the process via an unhandled rejection.
function runHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  void handler(req, res).catch((err: unknown) => {
    if (!res.headersSent) sendJson(res, 500, { error: errMsg(err) })
  })
}

export function soundingDevApi(): Plugin {
  return {
    name: 'sounding-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST') return next()
        if (req.url === '/api/recordings') return runHandler(handleRecordingUpload, req, res)
        if (req.url === '/api/cast') return runHandler(handleCast, req, res)
        next()
      })
    },
  }
}

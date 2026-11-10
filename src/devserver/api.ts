// The replay UI's save-a-recording-and-cast routes: a Vite dev plugin, and the
// same middleware for the always-on server. Both listen on localhost only. API keys never pass through here —
// the cast CLI child process loads .env itself.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import {
  isValidRecordingName,
  isInterpreterName,
  recordingPath,
  soundingPath,
  stampName,
  uniqueName,
  isPaidInterpreter,
  type InterpreterName,
} from './paths'
import { apiAllowed, apiOffMessage } from '../cli/env'

export function castArgv(name: string, interp: InterpreterName): string[] {
  return ['src/cli/cast.ts', recordingPath(name), '-i', interp]
}

const TSX_BIN = join(process.cwd(), 'node_modules', '.bin', 'tsx')

/**
 * Guards `/api/cast` and `/api/recordings` against cross-site simple POSTs.
 * Vite's dev server has no CORS restriction on requests it accepts — only on
 * what a cross-origin page can read back — so a `mode: 'no-cors'` POST from
 * any web page reaches these handlers unless we reject it ourselves. Modern
 * browsers send `Sec-Fetch-Site` on every request; curl and direct navigation
 * send nothing, which we treat the same as `'none'` (top-level, no origin).
 */
export function isAllowedRequest(
  url: string,
  headers: IncomingHttpHeaders,
): { ok: true } | { ok: false; status: number; error: string } {
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, error: 'cross-site request' }
  }
  const contentTypeHeader = headers['content-type']
  const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader) ?? ''
  if (url === '/api/cast') {
    if (!contentType.startsWith('application/json')) {
      return { ok: false, status: 415, error: 'unsupported content-type' }
    }
  } else if (url === '/api/recordings') {
    if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
      return { ok: false, status: 415, error: 'unsupported content-type' }
    }
  }
  return { ok: true }
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
    // Two tabs stopping in the same second would otherwise collide on the
    // same mic-YYYYMMDD-HHmmss stamp.
    const name = uniqueName(stampName(new Date()), (n) => existsSync(recordingPath(n)))
    tmp = join(tmpdir(), `${name}-${process.pid}-${randomBytes(4).toString('hex')}.upload`)
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
  if (isPaidInterpreter(interpreter) && !apiAllowed()) return sendJson(res, 403, { error: apiOffMessage(interpreter) })
  try {
    const r = await run(TSX_BIN, castArgv(name, interpreter))
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

/**
 * The recording/cast routes as plain connect-style middleware, shared by the
 * Vite dev plugin below and the always-on server (src/serve/server.ts).
 */
export function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (req.method !== 'POST') return next()
  if (req.url !== '/api/recordings' && req.url !== '/api/cast') return next()
  const allowed = isAllowedRequest(req.url, req.headers)
  if (!allowed.ok) return sendJson(res, allowed.status, { error: allowed.error })
  if (req.url === '/api/recordings') return runHandler(handleRecordingUpload, req, res)
  return runHandler(handleCast, req, res)
}

export function soundingDevApi(): Plugin {
  return {
    name: 'sounding-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(apiMiddleware)
    },
  }
}

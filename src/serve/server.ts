// The always-on server: the built pages, the replay API and the live socket on
// one origin, so a tailnet proxy (tailscale serve) can put all of it behind a
// single https address. `npm run build && npm run serve`.
//   npm run serve -- [--port 4490] [--allow-origin <https://host:port>]... [--allow-api] [-i <interpreter>] [--lang <code|auto>]
//
// API use is OFF unless --allow-api: .env isn't loaded, and the paid
// interpreters/transcribers refuse to start (see src/cli/env.ts). Child
// processes (the cast CLI) inherit the same switch through SOUNDING_API.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { apiAllowed, loadDotEnv } from '../cli/env'
import { apiMiddleware } from '../devserver/api'
import { handleLiveConnection, isAllowedOrigin, type Args as LiveArgs } from '../live/server'
import type { InterpreterName } from '../live/live-sounding'
import { LIVE_SOCKET_PATH } from '../live/socket-path'

export interface ServeArgs {
  port: number
  allowOrigins: string[]
  allowApi: boolean
  interpreter: InterpreterName
  lang: string
}

const INTERPRETERS: readonly InterpreterName[] = ['gemini', 'claude', 'recurrence']

export function parseServeArgs(argv: string[]): ServeArgs {
  const a: ServeArgs = { port: 4490, allowOrigins: [], allowApi: false, interpreter: 'recurrence', lang: 'en-US' }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i], next = argv[i + 1]
    if (v === '--port') { a.port = Number(next); if (!Number.isInteger(a.port) || a.port <= 0) throw new Error('--port needs a positive integer'); i++ }
    else if (v === '--allow-origin') {
      if (!next || !/^https?:\/\/[^/\s]+$/.test(next)) throw new Error('--allow-origin needs an origin like https://host:port (no path)')
      a.allowOrigins.push(next); i++
    }
    else if (v === '--allow-api') a.allowApi = true
    else if (v === '-i') { if (!INTERPRETERS.includes(next as InterpreterName)) throw new Error(`-i must be ${INTERPRETERS.join('|')}`); a.interpreter = next as InterpreterName; i++ }
    else if (v === '--lang') { if (!next) throw new Error('--lang needs a code (or "auto")'); a.lang = next; i++ }
    else throw new Error(`unknown argument ${v}`)
  }
  return a
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

const SOUNDING_LOG_RE = /^\/soundings\/([A-Za-z0-9][A-Za-z0-9._-]{0,120}\.jsonl)$/

/**
 * Maps a request path to a file on disk, or null. Pure apart from the
 * `isFile` probe: `/` → index.html, `/live` → live.html, anything else is
 * looked up under `dist`; `/soundings/<name>.jsonl` (what the replay page
 * fetches after a cast) is served read-only from `soundings`. Nothing may
 * escape either root.
 */
export function resolveFile(urlPath: string, roots: { dist: string; soundings: string }, isFile: (p: string) => boolean): string | null {
  let path: string
  try { path = decodeURIComponent(urlPath.split('?')[0]) } catch { return null }
  if (path.includes('\0') || path.includes('\\')) return null
  // No dotfiles and no `..`: nothing the build emits starts with a dot.
  if (path.split('/').some((seg) => seg.startsWith('.'))) return null
  const log = SOUNDING_LOG_RE.exec(path)
  if (log) {
    const p = join(roots.soundings, log[1])
    return isFile(p) ? p : null
  }
  if (path === '/') path = '/index.html'
  const candidates = extname(path) ? [path] : [path, `${path}.html`]
  const root = resolve(roots.dist)
  for (const c of candidates) {
    const p = resolve(root, `.${c}`)
    if (p !== root && !p.startsWith(root + sep)) return null
    if (isFile(p)) return p
  }
  return null
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

function serveStatic(req: IncomingMessage, res: ServerResponse, roots: { dist: string; soundings: string }): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, HEAD')
    return void res.end()
  }
  const file = resolveFile(req.url ?? '/', roots, isFile)
  if (!file) {
    res.statusCode = 404
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    return void res.end('not found')
  }
  res.setHeader('content-type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream')
  // Vite fingerprints everything under assets/; the pages and logs change in place.
  res.setHeader('cache-control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache')
  if (req.method === 'HEAD') return void res.end()
  createReadStream(file).on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end() }).pipe(res)
}

export function startServer(args: ServeArgs, cwd = process.cwd()): ReturnType<typeof createServer> {
  const roots = { dist: join(cwd, 'dist'), soundings: join(cwd, 'soundings') }
  const live: LiveArgs = { interpreter: args.interpreter, port: args.port, fakeTranscriber: false, speed: 1, headless: false, lang: args.lang }
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws: WsSocket) => handleLiveConnection(ws, live))

  const server = createServer((req, res) => {
    apiMiddleware(req, res, () => serveStatic(req, res, roots))
  })
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== LIVE_SOCKET_PATH || !isAllowedOrigin(req.headers.origin, args.allowOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return void socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  server.listen(args.port, '127.0.0.1')
  return server
}

const isDirectRun = process.argv[1]?.endsWith('serve/server.ts')
if (isDirectRun) {
  let args: ServeArgs
  try { args = parseServeArgs(process.argv.slice(2)) } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2) }
  if (!args.allowApi) process.env.SOUNDING_API = 'off'
  loadDotEnv()
  if (!isFile(join(process.cwd(), 'dist', 'index.html'))) { console.error('no dist/ — run: npm run build'); process.exit(1) }
  const server = startServer(args)
  server.on('listening', () => {
    const origins = args.allowOrigins.length ? `, also allowing ${args.allowOrigins.join(' ')}` : ''
    console.log(`sounding serving on http://127.0.0.1:${args.port}${origins} — interpreter ${args.interpreter}, API use ${apiAllowed() ? 'ON (--allow-api)' : 'off'}`)
  })
  server.on('error', (e) => { console.error(e.message); process.exit(1) })
}

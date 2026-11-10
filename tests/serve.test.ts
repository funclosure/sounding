import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { parseServeArgs, resolveFile, startServer } from '../src/serve/server'
import { isAllowedOrigin } from '../src/live/server'
import { apiAllowed, assertApiAllowed } from '../src/cli/env'
import { ClaudeExtractionInterpreter } from '../src/providers/claude-extraction'
import { GeminiAudioInterpreter } from '../src/providers/gemini-audio'
import { TranscribeLiveClient } from '../src/live/transcribe-live'
import { isPaidInterpreter } from '../src/devserver/paths'
import { LIVE_SOCKET_PATH } from '../src/live/socket-path'

describe('parseServeArgs', () => {
  it('defaults to port 4490, API off, and the two providers that spend nothing', () => {
    expect(parseServeArgs([])).toEqual({ port: 4490, allowOrigins: [], allowApi: false, interpreter: 'claude-sub', transcriber: 'whisper', lang: 'en-US' })
  })
  it('collects repeated --allow-origin and turns API use on only with --allow-api', () => {
    const a = parseServeArgs(['--allow-origin', 'https://mini.example.ts.net:5443', '--allow-origin', 'http://localhost:4490', '--allow-api'])
    expect(a.allowOrigins).toEqual(['https://mini.example.ts.net:5443', 'http://localhost:4490'])
    expect(a.allowApi).toBe(true)
  })
  it('rejects an origin with a path, a bad port and unknown flags', () => {
    expect(() => parseServeArgs(['--allow-origin', 'https://host/x'])).toThrow()
    expect(() => parseServeArgs(['--port', 'abc'])).toThrow()
    expect(() => parseServeArgs(['--bogus'])).toThrow()
  })
})

describe('isAllowedOrigin with extra origins', () => {
  it('allows an exact extra origin and nothing that merely resembles it', () => {
    const extra = ['https://mini.example.ts.net:5443']
    expect(isAllowedOrigin('https://mini.example.ts.net:5443', extra)).toBe(true)
    expect(isAllowedOrigin('https://mini.example.ts.net:5444', extra)).toBe(false)
    expect(isAllowedOrigin('https://mini.example.ts.net', extra)).toBe(false)
    expect(isAllowedOrigin('http://localhost:4490', extra)).toBe(true)
    expect(isAllowedOrigin(undefined, extra)).toBe(false)
  })
})

describe('resolveFile', () => {
  const roots = { dist: '/app/dist', soundings: '/app/soundings' }
  const files = new Set(['/app/dist/index.html', '/app/dist/live.html', '/app/dist/assets/x.js', '/app/soundings/a.gemini.jsonl'])
  const has = (p: string) => files.has(p)
  it('maps / and extensionless pages to their html', () => {
    expect(resolveFile('/', roots, has)).toBe('/app/dist/index.html')
    expect(resolveFile('/live', roots, has)).toBe('/app/dist/live.html')
    expect(resolveFile('/live.html?interp=claude', roots, has)).toBe('/app/dist/live.html')
    expect(resolveFile('/assets/x.js', roots, has)).toBe('/app/dist/assets/x.js')
  })
  it('serves sounding logs from soundings/', () => {
    expect(resolveFile('/soundings/a.gemini.jsonl', roots, has)).toBe('/app/soundings/a.gemini.jsonl')
    expect(resolveFile('/soundings/missing.jsonl', roots, has)).toBeNull()
  })
  it('never leaves its roots', () => {
    expect(resolveFile('/../package.json', roots, () => true)).toBeNull()
    expect(resolveFile('/%2e%2e/.env', roots, () => true)).toBeNull()
    expect(resolveFile('/soundings/..%2f.env.jsonl', roots, () => true)).toBeNull()
    expect(resolveFile('/soundings/../.env', roots, () => true)).toBeNull()
    expect(resolveFile('/assets/%00.js', roots, () => true)).toBeNull()
    expect(resolveFile('/%E0%A4%A', roots, () => true)).toBeNull()
  })
})

describe('the API switch', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('is on unless SOUNDING_API=off', () => {
    expect(apiAllowed({})).toBe(true)
    expect(apiAllowed({ SOUNDING_API: 'off' })).toBe(false)
  })
  it('stops every paid provider from starting while off, with a pointer to --allow-api', () => {
    process.env.SOUNDING_API = 'off'
    expect(() => assertApiAllowed('x')).toThrow(/--allow-api/)
    expect(() => new ClaudeExtractionInterpreter()).toThrow(/API use is off/)
    expect(() => new GeminiAudioInterpreter('key')).toThrow(/API use is off/)
    expect(() => new TranscribeLiveClient('key')).toThrow(/API use is off/)
  })
  it('names gemini and claude as the paid interpreters', () => {
    expect(isPaidInterpreter('gemini')).toBe(true)
    expect(isPaidInterpreter('claude')).toBe(true)
    expect(isPaidInterpreter('recurrence')).toBe(false)
    expect(isPaidInterpreter('claude-sub')).toBe(false)
  })
})

describe('startServer (one origin: pages, logs, API, live socket)', () => {
  let base = ''
  let server: ReturnType<typeof startServer>
  const saved = process.env.SOUNDING_API
  beforeAll(async () => {
    process.env.SOUNDING_API = 'off'
    const cwd = mkdtempSync(join(tmpdir(), 'sounding-serve-'))
    mkdirSync(join(cwd, 'dist', 'assets'), { recursive: true })
    mkdirSync(join(cwd, 'soundings'))
    writeFileSync(join(cwd, 'dist', 'index.html'), '<!doctype html>replay')
    writeFileSync(join(cwd, 'dist', 'live.html'), '<!doctype html>live')
    writeFileSync(join(cwd, 'soundings', 'a.recurrence.jsonl'), '{}\n')
    writeFileSync(join(cwd, '.env'), 'SECRET=1')
    server = startServer({ port: 0, allowOrigins: ['https://mini.example.ts.net:5443'], allowApi: false, interpreter: 'recurrence', transcriber: 'whisper', lang: 'en-US' }, cwd)
    await new Promise<void>((r) => server.once('listening', () => r()))
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    process.env.SOUNDING_API = saved
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('serves the pages and a sounding log, and nothing outside them', async () => {
    const live = await fetch(`http://${base}/live`)
    expect(live.status).toBe(200)
    expect(live.headers.get('content-type')).toMatch(/text\/html/)
    expect(await live.text()).toContain('live')
    expect((await fetch(`http://${base}/soundings/a.recurrence.jsonl`)).status).toBe(200)
    expect((await fetch(`http://${base}/.env`)).status).toBe(404)
    expect((await fetch(`http://${base}/nope.js`)).status).toBe(404)
  })

  it('refuses a paid cast while API use is off, before spawning anything', async () => {
    const res = await fetch(`http://${base}/api/cast`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'memo', interpreter: 'gemini' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/--allow-api/)
  })

  const open = (path: string, origin: string) => new Promise<'open' | 'refused'>((resolve) => {
    const ws = new WebSocket(`ws://${base}${path}`, { origin })
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('error', () => resolve('refused'))
  })

  it('opens the live socket for the allowed tailnet origin and localhost only', async () => {
    expect(await open(LIVE_SOCKET_PATH, 'https://mini.example.ts.net:5443')).toBe('open')
    expect(await open(LIVE_SOCKET_PATH, 'http://localhost:5173')).toBe('open')
    expect(await open(LIVE_SOCKET_PATH, 'https://evil.example')).toBe('refused')
    expect(await open('/elsewhere', 'https://mini.example.ts.net:5443')).toBe('refused')
  })
})

import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { castArgv, soundingDevApi, handleCast, handleRecordingUpload, isAllowedRequest } from '../src/devserver/api'

describe('castArgv', () => {
  it('builds the tsx argv for the cast CLI with the recording path and interpreter', () => {
    expect(castArgv('mic-20260905-113007', 'gemini')).toEqual([
      'src/cli/cast.ts', 'recordings/mic-20260905-113007.m4a', '-i', 'gemini',
    ])
  })
})

describe('isAllowedRequest', () => {
  it('allows a same-origin JSON cast request', () => {
    expect(isAllowedRequest('/api/cast', { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }))
      .toEqual({ ok: true })
  })
  it('rejects a cross-site request', () => {
    expect(isAllowedRequest('/api/cast', { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }))
      .toEqual({ ok: false, status: 403, error: 'cross-site request' })
  })
  it('allows a missing sec-fetch-site header (curl, direct navigation) with the right content-type', () => {
    expect(isAllowedRequest('/api/cast', { 'content-type': 'application/json' }))
      .toEqual({ ok: true })
  })
  it('rejects text/plain on cast', () => {
    expect(isAllowedRequest('/api/cast', { 'content-type': 'text/plain' }))
      .toEqual({ ok: false, status: 415, error: 'unsupported content-type' })
  })
  it('allows audio/webm on recordings', () => {
    expect(isAllowedRequest('/api/recordings', { 'content-type': 'audio/webm' }))
      .toEqual({ ok: true })
  })
  it('rejects text/plain on recordings', () => {
    expect(isAllowedRequest('/api/recordings', { 'content-type': 'text/plain' }))
      .toEqual({ ok: false, status: 415, error: 'unsupported content-type' })
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

function makeReq(chunks: Array<string | Buffer>): IncomingMessage {
  const buffers = chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))
  return Readable.from(buffers) as unknown as IncomingMessage
}

function makeErrorReq(message: string): IncomingMessage {
  return new Readable({
    read() {
      this.destroy(new Error(message))
    },
  }) as unknown as IncomingMessage
}

interface FakeRes {
  res: ServerResponse
  statusCode: () => number
  headersSent: () => boolean
  body: () => string
}

function makeRes(): FakeRes {
  const state = { statusCode: 200, headersSent: false, body: '', headers: {} as Record<string, string> }
  const fake = {
    get statusCode() { return state.statusCode },
    set statusCode(v: number) { state.statusCode = v },
    get headersSent() { return state.headersSent },
    setHeader(name: string, value: string) { state.headers[name] = value },
    end(chunk?: string) {
      state.headersSent = true
      state.body = chunk ?? ''
    },
  }
  return {
    res: fake as unknown as ServerResponse,
    statusCode: () => state.statusCode,
    headersSent: () => state.headersSent,
    body: () => state.body,
  }
}

describe('handleCast', () => {
  it('rejects a JSON body that is not an object (null)', async () => {
    const req = makeReq(['null'])
    const fake = makeRes()
    await handleCast(req, fake.res)
    expect(fake.statusCode()).toBe(400)
    expect(JSON.parse(fake.body()).error).toMatch(/JSON object/)
  })

  it('rejects an invalid recording name', async () => {
    const req = makeReq([JSON.stringify({ name: '../x', interpreter: 'gemini' })])
    const fake = makeRes()
    await handleCast(req, fake.res)
    expect(fake.statusCode()).toBe(400)
    expect(JSON.parse(fake.body()).error).toMatch(/invalid name/)
  })

  it('rejects an invalid interpreter', async () => {
    const req = makeReq([JSON.stringify({ name: 'ok', interpreter: 'whisper' })])
    const fake = makeRes()
    await handleCast(req, fake.res)
    expect(fake.statusCode()).toBe(400)
    expect(JSON.parse(fake.body()).error).toMatch(/invalid interpreter/)
  })
})

describe('handleRecordingUpload', () => {
  it('rejects an empty upload', async () => {
    const req = makeReq([])
    const fake = makeRes()
    await handleRecordingUpload(req, fake.res)
    expect(fake.statusCode()).toBe(400)
    expect(JSON.parse(fake.body()).error).toMatch(/empty upload/)
  })

  it('resolves (does not reject) and responds 500 when the request stream errors', async () => {
    const req = makeErrorReq('aborted')
    const fake = makeRes()
    await expect(handleRecordingUpload(req, fake.res)).resolves.toBeUndefined()
    expect(fake.statusCode()).toBe(500)
    expect(JSON.parse(fake.body()).error).toMatch(/aborted/)
  })
})

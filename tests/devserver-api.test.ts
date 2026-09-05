import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { castArgv, soundingDevApi, handleCast, handleRecordingUpload } from '../src/devserver/api'

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

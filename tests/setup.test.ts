import { describe, it, expect } from 'vitest'
import { describeSetup } from '../src/live/setup'
import { setupLines } from '../src/ui/setup'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { readLang, saveLang } from '../src/live/setup'
import { isLang, langName } from '../src/live/langs'
import { handleLiveConnection, parseArgs } from '../src/live/server'
import { readWrapPrompt } from '../src/live/wrap'

describe('describeSetup', () => {
  it('reports the local speech model, the subscription model and the API switch', () => {
    const s = describeSetup({ interpreter: 'claude-sub', transcriber: 'whisper', lang: 'en-US' }, { prompt: 'p', isDefault: true }, { SOUNDING_API: 'off', SOUNDING_WHISPER_MODEL: 'models/ggml-large-v3-turbo.bin' })
    expect(s).toMatchObject({ transcriber: 'whisper', hearsModel: 'large-v3-turbo', interpreter: 'claude-sub', lang: 'en-US', api: false, ownInstructions: false, instructions: 'p' })
    expect(s.thinksModel).toBeTruthy()
  })
  it('names no model for providers that are not local or on the login', () => {
    const s = describeSetup({ interpreter: 'gemini', transcriber: 'gemini', lang: 'en-US' }, { prompt: 'mine', isDefault: false }, {})
    expect(s).toMatchObject({ hearsModel: null, thinksModel: null, api: true, ownInstructions: true, instructions: 'mine' })
  })
})

describe('setupLines', () => {
  it('says in plain words what listens, what understands and that nothing is spent', () => {
    const lines = Object.fromEntries(setupLines({ transcriber: 'whisper', hearsModel: 'large-v3-turbo', interpreter: 'claude-sub', thinksModel: 'claude-sonnet-5-5', lang: 'en-US', api: false, ownInstructions: true, instructions: 'x' }))
    expect(lines['hears with']).toMatch(/Whisper \(large-v3-turbo\), on the machine itself/)
    expect(lines['understands with']).toBe('Claude (claude-sonnet-5-5), on your subscription.')
    expect(lines['the wrap']).toMatch(/your own instructions/)
    expect(lines['paid API']).toMatch(/^Off/)
  })
  it('marks paid providers as paid and the model-free baseline as having no wrap', () => {
    const paid = Object.fromEntries(setupLines({ transcriber: 'gemini', hearsModel: null, interpreter: 'claude', thinksModel: null, lang: 'en-US', api: true, ownInstructions: false, instructions: 'x' }))
    expect(paid['hears with']).toMatch(/paid API/)
    expect(paid['understands with']).toMatch(/paid API/)
    expect(paid['paid API']).toMatch(/^Allowed/)
    const base = Object.fromEntries(setupLines({ transcriber: 'whisper', hearsModel: null, interpreter: 'recurrence', thinksModel: null, lang: 'en-US', api: false, ownInstructions: false, instructions: 'x' }))
    expect(base['the wrap']).toMatch(/Not written/)
  })
})

describe('the language choice', () => {
  it('accepts only the listed codes and names them', () => {
    expect(isLang('en-US')).toBe(true)
    expect(isLang('auto')).toBe(true)
    expect(isLang('xx')).toBe(false)
    expect(isLang(3)).toBe(false)
    expect(langName('ja-JP')).toBe('日本語')
    expect(langName('fr-FR')).toBe('fr-FR')
  })
  it('is kept beside the soundings, and a file with anything else in it counts as no choice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sounding-lang-'))
    expect(readLang(dir)).toBeNull()
    saveLang('zh-TW', dir)
    expect(readLang(dir)).toBe('zh-TW')
    writeFileSync(join(dir, 'lang.txt'), '../../etc')
    expect(readLang(dir)).toBeNull()
  })
})

describe('the setup sheet over the live socket', () => {
  it('reports the setup, saves a language and instructions, and ignores a language it does not know', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sounding-setup-'))
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    wss.on('connection', (ws) => handleLiveConnection(ws, parseArgs(['-i', 'recurrence']), { soundingsDir: dir, promptDir: dir, wrap: null }))
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`)
    await new Promise<void>((r) => ws.once('open', () => r()))
    const ask = (msg: object) => new Promise<{ lang: string; ownInstructions: boolean; instructions: string }>((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(String(d)).setup))
      ws.send(JSON.stringify(msg))
    })
    expect(await ask({ type: 'setup' })).toMatchObject({ lang: 'en-US', ownInstructions: false })
    expect((await ask({ type: 'lang', lang: 'ja-JP' })).lang).toBe('ja-JP')
    expect((await ask({ type: 'lang', lang: '../x' })).lang).toBe('ja-JP')
    expect(await ask({ type: 'instructions', text: 'Say it in one line.' })).toMatchObject({ ownInstructions: true, instructions: 'Say it in one line.' })
    expect(readWrapPrompt(dir).prompt).toBe('Say it in one line.')
    expect((await ask({ type: 'instructions', text: '' })).ownInstructions).toBe(false)
    expect(existsSync(join(dir, 'lang.txt'))).toBe(true)
    ws.close()
    await new Promise<void>((r) => wss.close(() => r()))
  })
})

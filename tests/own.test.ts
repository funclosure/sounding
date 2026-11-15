// The own-keys build: the listener inside the page, on the visitor's own keys.
import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { Prefs, keyHint, tidyKey, type KV } from '../src/own/prefs'
import { memoryBacking, storeOver } from '../src/own/store'
import { browserElevenSocket, checkElevenKey } from '../src/own/eleven-socket'
import { OwnClaudeInterpreter, ownWrap, type CreateMessage } from '../src/own/claude'
import { ownBridge, soundingFile } from '../src/own/bridge'
import { ownHost } from '../src/own/host'
import { localSocket } from '../src/own/local-socket'
import { DEFAULT_WRAP_PROMPT } from '../src/live/wrap-core'
import type { LiveMessage } from '../src/live/engine'
import type { LiveSocket } from '../src/live/elevenlabs'
import { setupLines } from '../src/ui/setup'
import { EventLog } from '../src/core/events'

function kv(): KV & { m: Map<string, string> } {
  const m = new Map<string, string>()
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}
const NAME = 'live-20261114-101500.claude.jsonl'
const log = (segments: string[]) => {
  const l = new EventLog()
  l.append({ type: 'sounding.dropped', t: 0, soundingId: 'x' })
  segments.forEach((s, i) => l.append({ type: 'segment.committed', t: (i + 1) * 1000, segmentId: `s${i}`, transcript: s, startT: i * 1000, endT: (i + 1) * 1000 }))
  return l.toJsonl()
}
const message = (json: unknown, usage = { input_tokens: 1000, output_tokens: 100 }) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(json) }], usage }) as unknown as Anthropic.Message

describe('what the browser remembers', () => {
  it('keeps both keys tidied, and says only enough of one to recognise it', () => {
    const p = new Prefs(kv())
    expect(p.hasKeys()).toBe(false)
    p.saveKeys({ claude: '  "sk-ant-api03-abcdefghijkl"\n', eleven: 'sk_1234567890abcdef' })
    expect(p.keys()).toEqual({ claude: 'sk-ant-api03-abcdefghijkl', eleven: 'sk_1234567890abcdef' })
    expect(p.hasKeys()).toBe(true)
    expect(keyHint(p.keys().claude)).toBe('sk-ant…ijkl')
    expect(keyHint('')).toBe('')
    expect(tidyKey(" 'k' ")).toBe('k')
    p.forgetKeys()
    expect(p.keys()).toEqual({ claude: '', eleven: '' })
  })
  it('falls back to the defaults, and survives storage that throws', () => {
    const p = new Prefs(kv())
    expect(p.model()).toBe('claude-sonnet-5-5')
    expect(p.lang()).toBe('auto')
    expect(p.wrapPrompt()).toEqual({ prompt: DEFAULT_WRAP_PROMPT, isDefault: true })
    p.saveWrapPrompt('In one line.'); p.saveLang('zh-TW'); p.saveModel('claude-haiku-5-5')
    expect(p.wrapPrompt()).toEqual({ prompt: 'In one line.', isDefault: false })
    expect([p.lang(), p.model()]).toEqual(['zh-TW', 'claude-haiku-5-5'])
    p.saveWrapPrompt(DEFAULT_WRAP_PROMPT)
    expect(p.wrapPrompt().isDefault).toBe(true)
    const broken = new Prefs({ getItem: () => { throw new Error('private') }, setItem: () => { throw new Error('private') }, removeItem: () => {} })
    broken.saveKeys({ claude: 'a', eleven: 'b' })
    expect(broken.hasKeys()).toBe(false)
  })
})

describe('soundings kept in the browser', () => {
  it('lists newest first, opens with the wrap, and removes for good', async () => {
    const s = storeOver(memoryBacking())
    await s.put('live-20261113-090000.claude.jsonl', log(['one thing']))
    await s.put(NAME, log(['the harbor wall', 'the harbor wall again']))
    await s.put('../etc/passwd', 'nope')
    await s.setWrap(NAME, 'You kept coming back to the wall.\n')
    const list = await s.list()
    expect(list.map((i) => i.name)).toEqual([NAME, 'live-20261113-090000.claude.jsonl'])
    expect(list[0]).toMatchObject({ at: '2026-11-14T10:15:00', said: true, durationMs: 2000 })
    const got = await s.get(NAME)
    expect(got?.wrap).toBe('You kept coming back to the wall.')
    expect(got?.events.length).toBe(3)
    // saving the log again (never happens today, but must not lose the wrap)
    await s.put(NAME, log(['the harbor wall']))
    expect((await s.get(NAME))?.wrap).toBe('You kept coming back to the wall.')
    expect(await s.remove(NAME)).toBe(true)
    expect(await s.remove(NAME)).toBe(false)
    expect(await s.get(NAME)).toBeNull()
  })
  it('writes one as a note a person can read', () => {
    const f = soundingFile(NAME, [...EventLog.fromJsonl(log(['the harbor wall', 'and the tide'])).all()], 'You kept coming back to the wall.')
    expect(f.filename).toBe('sounding-20261114-101500.md')
    expect(f.text).toContain('# Sounding · 2026-11-14 10:15')
    expect(f.text).toContain('## What was said back\n\nYou kept coming back to the wall.')
    expect(f.text).toContain('## Everything heard\n\nthe harbor wall\nand the tide')
  })
})

describe('the page\'s socket to ElevenLabs', () => {
  const inner = () => {
    const s = { readyState: 0, sent: [] as string[], url: '', send(d: string) { s.sent.push(d) }, close() { s.readyState = 3; s.onclose?.() }, onopen: null as null | (() => void), onmessage: null as null | ((ev: { data: unknown }) => void), onerror: null as null | (() => void), onclose: null as null | (() => void) }
    return s
  }
  it('trades the key for a token and opens with that, so the key is never in the address', async () => {
    const calls: Array<{ url: string; key: string }> = []
    const fetchFn = (async (url: string, init: RequestInit) => { calls.push({ url, key: (init.headers as Record<string, string>)['xi-api-key'] }); return new Response(JSON.stringify({ token: 'tok 1' })) }) as unknown as typeof fetch
    const s = inner()
    const sock = browserElevenSocket(fetchFn, (url) => { s.url = url; return s })('wss://x/realtime?model_id=m', 'secret-key')
    const heard: unknown[] = []
    let opened = false
    sock.on('open', () => { opened = true })
    sock.on('message', (d) => heard.push(d))
    sock.send('too early')
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([{ url: 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', key: 'secret-key' }])
    expect(s.url).toBe('wss://x/realtime?model_id=m&token=tok%201')
    expect(s.url).not.toContain('secret-key')
    s.readyState = 1; s.onopen?.()
    expect([opened, sock.readyState]).toEqual([true, 1])
    s.onmessage?.({ data: '{"message_type":"session_started"}' })
    sock.send('audio')
    expect([heard, s.sent]).toEqual([['{"message_type":"session_started"}'], ['audio']])
  })
  it('says so when the key is refused', async () => {
    const refuse = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const sock = browserElevenSocket(refuse, () => { throw new Error('must not open') })('wss://x?m=1', 'bad')
    const errors: string[] = []
    let closed = false
    sock.on('error', (e) => errors.push((e as Error).message))
    sock.on('close', () => { closed = true })
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toEqual(['ElevenLabs did not accept the key'])
    expect([closed, sock.readyState]).toEqual([true, 3])
    expect(await checkElevenKey('bad', refuse)).toBe('refused')
    expect(await checkElevenKey('k', (async () => { throw new TypeError('offline') }) as unknown as typeof fetch)).toBe('unreachable')
    expect(await checkElevenKey('k', (async () => new Response('{"token":"t"}')) as unknown as typeof fetch)).toBeNull()
  })
})

describe('Claude on the listener\'s key', () => {
  const input = (text: string, n = 1) => ({ kind: 'transcript' as const, segmentId: `s${n}`, text, startT: 0, endT: 1000 })
  it('asks without thinking, in the shape each model takes, and prices the answer', async () => {
    const bodies: Anthropic.MessageCreateParamsNonStreaming[] = []
    const create: CreateMessage = async (b) => { bodies.push(b); return message({ candidates: [{ label: 'harbor wall', strength: 0.8, confidence: 0.9 }] }) }
    const sonnet = await new OwnClaudeInterpreter(create, 'claude-sonnet-5-5').interpret(input('the harbor wall'))
    const haiku = await new OwnClaudeInterpreter(create, 'claude-haiku-5-5').interpret(input('the harbor wall'))
    expect(bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' }, output_config: { effort: 'low', format: { type: 'json_schema' } } })
    expect(bodies[1]).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' } })
    expect(sonnet.candidates).toEqual([{ label: 'harbor wall', strength: 0.8, confidence: 0.9, source: 'claude-own-key/claude-sonnet-5-5', segmentId: 's1' }])
    expect(sonnet.costUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 10)
    expect(haiku.costUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 10)
  })
  it('shows the model its own earlier labels, so a concept that returns keeps its name', async () => {
    const prompts: string[] = []
    const create: CreateMessage = async (b) => { prompts.push(String(b.messages[0].content)); return message({ candidates: [{ label: prompts.length === 1 ? 'harbor wall' : 'the tide', strength: 0.5, confidence: 0.5 }] }) }
    const it2 = new OwnClaudeInterpreter(create, 'claude-sonnet-5-5')
    await it2.interpret(input('a', 1)); await it2.interpret(input('b', 2)); await it2.interpret(input('c', 3))
    expect(prompts[0]).not.toContain('already reported')
    expect(prompts[1]).toContain('- "harbor wall"')
    expect(prompts[2]).toMatch(/- "harbor wall"\n- "the tide"/)
  })
  it('a refused key is said once and the sounding goes on without marks', async () => {
    const refused = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers())
    const told: string[] = []
    const it3 = new OwnClaudeInterpreter(async () => { throw refused }, 'claude-sonnet-5-5', (m) => told.push(m))
    expect((await it3.interpret(input('a'))).candidates).toEqual([])
    await it3.interpret(input('b', 2))
    expect(told).toEqual(['Anthropic did not accept the Claude key'])
  })
  it('writes the wrap, and fails with a reason a person can read', async () => {
    let spent = 0
    const wrap = ownWrap(async (b) => { expect(b.model).toBe('claude-sonnet-5-5'); return message({ wrap: ' You kept coming back to the wall. ' }) }, (usd) => { spent += usd })
    const material = { transcript: 'the harbor wall', marks: ['harbor wall'], dismissed: [], renamed: [], context: '' }
    expect(await wrap('briefly', material)).toBe('You kept coming back to the wall.')
    expect(spent).toBeGreaterThan(0)
    await expect(ownWrap(async () => message({ wrap: '' }))('briefly', material)).rejects.toThrow('the wrap came back empty')
    await expect(ownWrap(async () => { throw new Error('offline') })('briefly', material)).rejects.toThrow('offline')
  })
})

describe('saving the keys', () => {
  const bridge = (claude: string | null, eleven: string | null, store = kv()) => ({ store, b: ownBridge({ prefs: new Prefs(store), store: storeOver(memoryBacking()), checkClaude: async () => claude, checkEleven: async () => eleven }) })
  it('keeps keys both providers accept', async () => {
    const { b } = bridge(null, null)
    expect(await b.saveKeys({ claude: 'c', eleven: '' })).toEqual({ claude: 'ok', eleven: 'missing', saved: false })
    expect(await b.saveKeys({ claude: 'c', eleven: 'e' })).toEqual({ claude: 'ok', eleven: 'ok', saved: true })
    expect(b.hasKeys()).toBe(true)
  })
  it('never keeps a refused key, and an empty box keeps the one already saved', async () => {
    const store = kv()
    await bridge(null, null, store).b.saveKeys({ claude: 'good-c', eleven: 'good-e' })
    const refused = bridge('refused', null, store)
    expect(await refused.b.saveKeys({ claude: 'bad', eleven: '' })).toEqual({ claude: 'refused', eleven: 'ok', saved: false })
    expect(new Prefs(store).keys()).toEqual({ claude: 'good-c', eleven: 'good-e' })
    const away = bridge(null, 'unreachable', store)
    expect(await away.b.saveKeys({ claude: '', eleven: 'new-e' })).toEqual({ claude: 'ok', eleven: 'unreachable', saved: true })
    expect(new Prefs(store).keys()).toEqual({ claude: 'good-c', eleven: 'new-e' })
  })
})

describe('a whole sounding inside the page', () => {
  const RATE = 16_000
  const chunk = (ms: number, amp: number) => { const c = new Int16Array((ms / 1000) * RATE); for (let i = 0; i < c.length; i++) c[i] = i % 2 ? amp : -amp; return c.buffer }
  it('hears, marks, wraps and keeps it, with nothing but the two providers reached', async () => {
    const prefs = new Prefs(kv())
    prefs.saveKeys({ claude: 'c-key', eleven: 'e-key' })
    const store = storeOver(memoryBacking())
    const reached: string[] = []
    const fetchFn = (async (url: string) => { reached.push(url); return new Response(JSON.stringify({ text: 'we should rebuild the harbor wall before winter' })) }) as unknown as typeof fetch
    const elevenSocket = (): LiveSocket => {
      const h: Record<string, (a?: unknown) => void> = {}
      const s: LiveSocket = { readyState: 1, send: () => {}, close: () => { s.readyState = 3 }, on: (ev, fn) => { h[ev] = fn } }
      queueMicrotask(() => h.message?.(JSON.stringify({ message_type: 'session_started' })))
      return s
    }
    const claude = (key: string): CreateMessage => async (b) => {
      expect(key).toBe('c-key')
      return String(b.messages[0].content).includes('<transcript>') ? message({ wrap: 'You kept coming back to the harbor wall.' }) : message({ candidates: [{ label: 'harbor wall', strength: 0.9, confidence: 0.9 }] })
    }
    const sock = localSocket(ownHost({ prefs, store, claude, fetchFn, elevenSocket, now: () => new Date(2026, 10, 14, 10, 15, 0) }))
    const got: LiveMessage[] = []
    const until = (ok: (m: LiveMessage) => boolean) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out; saw ${got.map((m) => m.type + ('state' in m ? ':' + m.state : '')).join(' ')}`)), 4000)
      const check = () => { if (got.some(ok)) { clearTimeout(t); resolve() } else setTimeout(check, 10) }
      check()
    })
    sock.onmessage = (ev) => got.push(JSON.parse(ev.data as string))
    await new Promise<void>((r) => { sock.onopen = r })
    sock.send(JSON.stringify({ type: 'setup' }))
    await until((m) => m.type === 'live.setup')
    const setup = got.find((m) => m.type === 'live.setup')
    expect(setup && setup.type === 'live.setup' && setup.setup.own).toEqual({ keys: true, claudeHint: '…', elevenHint: '…' })
    sock.send(JSON.stringify({ type: 'start' }))
    await until((m) => m.type === 'live.status' && m.state === 'listening')
    for (let i = 0; i < 15; i++) sock.send(chunk(100, 4000))
    for (let i = 0; i < 12; i++) sock.send(chunk(100, 0))
    await until((m) => m.type === 'segment.committed')
    await until((m) => m.type === 'reading.changed' && m.reading.marks.length > 0)
    sock.send(JSON.stringify({ type: 'stop' }))
    await until((m) => m.type === 'live.wrap' && m.state === 'done')
    const order = got.filter((m) => m.type === 'live.wrap' || (m.type === 'live.status' && m.state === 'stopped')).map((m) => ('state' in m ? m.state : ''))
    expect(order).toEqual(['writing', 'stopped', 'done'])
    const stopped = got.find((m) => m.type === 'live.status' && m.state === 'stopped')
    expect(stopped && 'message' in stopped && stopped.message).toBe('live-20261114-101500.claude.jsonl')
    // every request went to ElevenLabs' file model; Claude went through the stand-in
    expect(new Set(reached)).toEqual(new Set(['https://api.elevenlabs.io/v1/speech-to-text']))
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'live-20261114-101500.claude.jsonl', marks: ['harbor wall'], said: true })
    expect((await store.get(list[0].name))?.wrap).toBe('You kept coming back to the harbor wall.')
    // and the same socket lists it and takes it away again
    sock.send(JSON.stringify({ type: 'earlier' }))
    await until((m) => m.type === 'live.earlier' && m.items.length === 1)
    sock.send(JSON.stringify({ type: 'remove', name: list[0].name }))
    await until((m) => m.type === 'live.removed' && m.ok)
    expect(await store.list()).toEqual([])
    sock.close()
  })
  it('will not start without both keys', async () => {
    const sock = localSocket(ownHost({ prefs: new Prefs(kv()), store: storeOver(memoryBacking()) }))
    const got: LiveMessage[] = []
    sock.onmessage = (ev) => got.push(JSON.parse(ev.data as string))
    await new Promise<void>((r) => { sock.onopen = r })
    sock.send(JSON.stringify({ type: 'start' }))
    await new Promise((r) => setTimeout(r, 30))
    expect(got).toEqual([{ type: 'live.status', state: 'error', message: 'both keys are needed before a sounding can start' }])
  })
})

describe('the setup sheet, on the listener\'s own keys', () => {
  it('says whose key pays and where the sound and the words go', () => {
    const rows = setupLines({ transcriber: 'elevenlabs', hearsModel: null, interpreter: 'claude', thinksModel: 'claude-haiku-5-5', lang: 'auto', api: true, ownInstructions: false, instructions: '', own: { keys: true, claudeHint: 'sk-ant…ab12', elevenHint: 'sk_123…cdef' } })
    expect(rows.map((r) => r[2])).toEqual(['keys', undefined, 'model', 'instructions', 'lang', undefined])
    expect(rows[0][1]).toBe('In this browser only. Claude sk-ant…ab12, ElevenLabs sk_123…cdef.')
    expect(rows[1][1]).toBe('ElevenLabs, on your key. Your sound goes to them.')
    expect(rows[2][1]).toBe('Claude (Haiku 5.5), on your key. The words heard go to Anthropic.')
    expect(rows.some((r) => /subscription|paid API/.test(r[1]))).toBe(false)
  })
})

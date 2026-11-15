// The own-keys build: the listener inside the page, on the visitor's own keys.
import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { Prefs, keyHint, tidyKey, type KV } from '../src/own/prefs'
import { memoryBacking, storeOver } from '../src/own/store'
import { browserElevenSocket, checkElevenKey } from '../src/own/eleven-socket'
import { OwnClaudeInterpreter, checkClaudeKey, claudeFailure, ownWrap, type CreateMessage } from '../src/own/claude'
import { carriedIn, carryCode, carryUrl, lookOf, looksCutShort, takeCarried } from '../src/own/keys'
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
    expect(keyHint(p.keys().claude)).toBe('sk-ant-…ijkl')
    expect(keyHint(p.keys().eleven)).toBe('sk_…cdef')
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
    // what ElevenLabs answers a key that is not one (seen on 15 November)
    const invalid = (async () => new Response('{"detail":{"type":"authentication_error","code":"invalid_api_key","message":"API key is invalid."}}', { status: 400 })) as unknown as typeof fetch
    expect(await checkElevenKey('sk_made_up', invalid)).toBe('refused')
    expect(await checkElevenKey('k', (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch)).toBe('unreachable')
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

const CLAUDE = 'sk-ant-api03-' + 'a'.repeat(95)
const ELEVEN = 'sk_' + '0123456789abcdef'.repeat(3)

describe('what a pasted key looks like', () => {
  it('names the other service\'s key in the wrong box, an admin key, and a key that is not one', () => {
    expect(lookOf('claude', CLAUDE)).toBe('ok')
    expect(lookOf('claude', ` "${CLAUDE}" `)).toBe('ok')
    expect(lookOf('claude', ELEVEN)).toBe('other')
    expect(lookOf('claude', '0123456789abcdef0123456789abcdef')).toBe('other') // an older ElevenLabs key
    expect(lookOf('claude', 'sk-ant-admin01-xyz')).toBe('admin')
    expect(lookOf('claude', 'hello')).toBe('shape')
    expect(lookOf('eleven', ELEVEN)).toBe('ok')
    expect(lookOf('eleven', '0123456789abcdef0123456789abcdef')).toBe('ok')
    expect(lookOf('eleven', CLAUDE)).toBe('other')
  })
  it('tells a key cut short while copying from a whole one', () => {
    expect(looksCutShort('claude', CLAUDE)).toBe(false)
    expect(looksCutShort('claude', CLAUDE.slice(0, 60))).toBe(true)
    expect(looksCutShort('eleven', ELEVEN)).toBe(false)
    expect(looksCutShort('eleven', ELEVEN.slice(0, 40))).toBe(true)
  })
})

describe('asking Anthropic about a Claude key', () => {
  const failing = (status: number, type: string, msg: string): CreateMessage => async () => {
    throw Anthropic.APIError.generate(status, { type: 'error', error: { type, message: msg } }, msg, new Headers())
  }
  it('sends one word for one token, on the model the marks use', async () => {
    const sent: Anthropic.MessageCreateParamsNonStreaming[] = []
    expect(await checkClaudeKey(CLAUDE, 'claude-haiku-5-5', async (b) => { sent.push(b); return message({}) })).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0].model).toBe('claude-haiku-5-5')
    expect(sent[0].max_tokens).toBe(1)
  })
  it('tells a refused key from an account with no credit, and a busy one from one out of reach', async () => {
    expect(await checkClaudeKey(CLAUDE, undefined, failing(401, 'authentication_error', 'invalid x-api-key'))).toBe('refused')
    expect(await checkClaudeKey(CLAUDE, undefined, failing(402, 'billing_error', 'no credit'))).toBe('nocredit')
    expect(await checkClaudeKey(CLAUDE, undefined, failing(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))).toBe('nocredit')
    expect(await checkClaudeKey(CLAUDE, undefined, failing(429, 'rate_limit_error', 'slow down'))).toBeNull()
    expect(await checkClaudeKey(CLAUDE, undefined, failing(529, 'overloaded_error', 'overloaded'))).toBe('unreachable')
    expect(await checkClaudeKey(CLAUDE, undefined, async () => { throw new Error('offline') })).toBe('unreachable')
  })
  it('ends a sounding whose account runs out of credit, with the reason', () => {
    const e = Anthropic.APIError.generate(402, { type: 'error', error: { type: 'billing_error', message: 'no credit' } }, 'no credit', new Headers())
    expect(claudeFailure(e)).toEqual({ refused: true, message: 'the Claude account has no credit left' })
  })
})

describe('keeping the keys', () => {
  const bridge = (claude: string | null, eleven: string | null, store = kv(), more: Partial<Parameters<typeof ownBridge>[0]> = {}) => {
    const asked: string[] = []
    const b = ownBridge({ prefs: new Prefs(store), store: storeOver(memoryBacking()), checkClaude: async (_k, model) => { asked.push(`claude:${model}`); return claude }, checkEleven: async () => { asked.push('eleven'); return eleven }, ...more })
    return { store, b, asked }
  }
  it('keeps each key its provider accepts, one at a time', async () => {
    const { b, store } = bridge(null, null)
    expect(await b.setKey('claude', CLAUDE)).toBe('ok')
    expect(b.hasKeys()).toBe(false)
    expect(await b.setKey('eleven', ELEVEN)).toBe('ok')
    expect(b.hasKeys()).toBe(true)
    expect(new Prefs(store).keys()).toEqual({ claude: CLAUDE, eleven: ELEVEN })
    expect(b.hints()).toEqual({ claude: 'sk-ant-…aaaa', eleven: 'sk_…cdef' })
  })
  it('asks no one about a key in the wrong box, and asks Anthropic on the model the marks use', async () => {
    const { b, asked } = bridge(null, null)
    expect(b.look('claude', ELEVEN)).toBe('other')
    expect(b.look('claude', '  ')).toBe('missing')
    expect(await b.setKey('claude', ELEVEN)).toBe('other')
    expect(await b.setKey('eleven', CLAUDE)).toBe('other')
    expect(asked).toEqual([])
    b.saveModel('claude-haiku-5-5')
    await b.setKey('claude', CLAUDE)
    expect(asked).toEqual(['claude:claude-haiku-5-5'])
  })
  it('never keeps a refused key, says when it looks cut short, and keeps one on an account with no credit yet', async () => {
    const store = kv()
    await bridge(null, null, store).b.setKey('claude', CLAUDE)
    expect(await bridge('refused', null, store).b.setKey('claude', CLAUDE.slice(0, -1) + 'b')).toBe('refused')
    expect(await bridge('refused', null, store).b.setKey('claude', CLAUDE.slice(0, 50))).toBe('short')
    expect(new Prefs(store).keys().claude).toBe(CLAUDE)
    const other = 'sk-ant-api03-' + 'c'.repeat(95)
    expect(await bridge('nocredit', null, store).b.setKey('claude', other)).toBe('nocredit')
    expect(new Prefs(store).keys().claude).toBe(other)
    expect(await bridge(null, 'unreachable', store).b.setKey('eleven', ELEVEN)).toBe('unreachable')
    expect(new Prefs(store).keys().eleven).toBe(ELEVEN)
  })
})

describe('carrying the keys to another screen', () => {
  it('puts both keys after the # of the site\'s address, and reads them back', () => {
    const url = carryUrl('https://sounding.example/live.html?x=1#old', { claude: CLAUDE, eleven: ELEVEN })
    expect(url.startsWith('https://sounding.example/live.html#')).toBe(true)
    expect(url).not.toContain('?')
    expect(carriedIn(new URL(url).hash)).toEqual({ claude: CLAUDE, eleven: ELEVEN })
    expect(carriedIn('#c=' + CLAUDE)).toBeNull()
    expect(carriedIn('')).toBeNull()
  })
  it('takes the keys out of the address before anything else can see them', () => {
    const replaced: string[] = []
    const keys = takeCarried({ hash: '#c=' + CLAUDE + '&e=' + ELEVEN, pathname: '/', search: '' }, { replaceState: (_d, _u, url) => void replaced.push(url) })
    expect(keys).toEqual({ claude: CLAUDE, eleven: ELEVEN })
    expect(replaced).toEqual(['/'])
    // half a pair is still taken out, and gives nothing
    expect(takeCarried({ hash: '#e=' + ELEVEN, pathname: '/live.html', search: '' }, { replaceState: (_d, _u, url) => void replaced.push(url) })).toBeNull()
    expect(replaced).toEqual(['/', '/live.html'])
    // an address with no keys is left alone
    takeCarried({ hash: '#chart', pathname: '/', search: '' }, { replaceState: (_d, _u, url) => void replaced.push(url) })
    expect(replaced).toHaveLength(2)
  })
  it('draws a QR code a phone can read, only once both keys are kept', async () => {
    const { b } = (() => { const store = kv(); return { b: ownBridge({ prefs: new Prefs(store), store: storeOver(memoryBacking()), checkClaude: async () => null, checkEleven: async () => null, siteUrl: () => 'https://sounding.example/' }) } })()
    expect(b.carryCode()).toBeNull()
    await b.setKey('claude', CLAUDE)
    await b.setKey('eleven', ELEVEN)
    const code = b.carryCode()!
    expect(code.length).toBe(code[0].length)
    expect(code.length).toBeGreaterThanOrEqual(21)
    expect(code.length).toBeLessThanOrEqual(81) // version 16 at most: still coarse enough for a phone across a desk
    // the three finder squares sit in their corners
    for (const [r, c] of [[0, 0], [0, code.length - 7], [code.length - 7, 0]]) expect([code[r][c], code[r + 3][c + 3], code[r + 1][c + 1]]).toEqual([true, true, false])
    expect(carryCode('https://sounding.example/#c=a&e=b').length).toBeLessThan(code.length)
  })
  it('keeps carried keys only when the listener says yes, and both or neither', async () => {
    const store = kv()
    new Prefs(store).saveKeys({ claude: 'old-c', eleven: 'old-e' })
    const carried = { claude: CLAUDE, eleven: ELEVEN }
    const no = ownBridge({ prefs: new Prefs(store), store: storeOver(memoryBacking()), carried, checkClaude: async () => null, checkEleven: async () => 'refused' })
    expect(no.carried()).toEqual({ claude: 'sk-ant-…aaaa', eleven: 'sk_…cdef' })
    expect(new Prefs(store).keys()).toEqual({ claude: 'old-c', eleven: 'old-e' })
    expect(await no.useCarried()).toEqual({ claude: 'ok', eleven: 'refused' })
    expect(new Prefs(store).keys()).toEqual({ claude: 'old-c', eleven: 'old-e' })
    expect(no.carried()).toBeNull()
    expect(await no.useCarried()).toBeNull()
    const yes = ownBridge({ prefs: new Prefs(store), store: storeOver(memoryBacking()), carried, checkClaude: async () => null, checkEleven: async () => null })
    expect(await yes.useCarried()).toEqual({ claude: 'ok', eleven: 'ok' })
    expect(new Prefs(store).keys()).toEqual(carried)
    const dropped = ownBridge({ prefs: new Prefs(store), store: storeOver(memoryBacking()), carried: { claude: 'x', eleven: 'y' } })
    dropped.dropCarried()
    expect(dropped.carried()).toBeNull()
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

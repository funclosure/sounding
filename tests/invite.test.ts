// A friend's side of an invite: the page's client and bridge, talking to the real relay code
// (on a local database), with stand-ins for Anthropic and ElevenLabs behind it.
import { describe, it, expect } from 'vitest'
import { handleRelay, type RelayEnv } from '../src/relay/relay'
import { inviteIn, takeInvite, relayClaude, InviteEnded } from '../src/own/invite'
import { claudeFailure } from '../src/own/claude'
import { ownBridge } from '../src/own/bridge'
import { ownHost } from '../src/own/host'
import { localSocket } from '../src/own/local-socket'
import { Prefs, type KV } from '../src/own/prefs'
import { memoryBacking, storeOver } from '../src/own/store'
import { setupLines } from '../src/ui/setup'
import { parseArgs, line } from '../scripts/invite'
import type { LiveMessage } from '../src/live/engine'
import type { LiveSocket } from '../src/live/elevenlabs'
import type { Setup } from '../src/live/setup'

const kv = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } }
const ADMIN = 'admin'
const SITE = 'https://sounding.example'

/** The site as a friend's page sees it: /api goes to the relay, which reaches the stand-in providers. */
function site() {
  const reached: string[] = []
  let clock = Date.UTC(2026, 10, 15, 12)
  const providers = (async (url: string) => {
    reached.push(url)
    if (url.includes('anthropic')) return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"candidates":[{"label":"harbor wall","strength":0.9,"confidence":0.9}]}' }], usage: { input_tokens: 900, output_tokens: 60 } }), { headers: { 'content-type': 'application/json' } })
    if (url.includes('single-use-token')) return new Response('{"token":"live"}')
    return new Response('{"text":"we should rebuild the harbor wall before winter"}', { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const env: RelayEnv = { DB: localD1(), ANTHROPIC_API_KEY: 'sk-ant-relay', ELEVENLABS_API_KEY: 'sk_relay', ADMIN_SECRET: ADMIN }
  const page = (async (url: string, init?: RequestInit) => handleRelay(new Request(SITE + url, init), env, { fetch: providers, now: () => clock })) as unknown as typeof fetch
  const admin = async (path: string, body?: unknown) => (await (await page(`/api/admin${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json()) as Record<string, any>
  return { page, admin, reached, later: (ms: number) => { clock += ms } }
}

import { localD1 } from './support/local-d1'

describe('an invite link', () => {
  it('is read from after the #, and taken out of the address at once', () => {
    expect(inviteIn('#invite=abc')).toBe('abc')
    expect(inviteIn('#chart')).toBeNull()
    const replaced: string[] = []
    expect(takeInvite({ hash: '#invite=abc', pathname: '/', search: '' }, { replaceState: (_a, _b, u) => void replaced.push(u) })).toBe('abc')
    expect(replaced).toEqual(['/'])
    expect(takeInvite({ hash: '', pathname: '/', search: '' }, { replaceState: (_a, _b, u) => void replaced.push(u) })).toBeNull()
    expect(replaced).toHaveLength(1)
  })
})

describe('accepting an invite in the page', () => {
  it('shows what it offers, accepts it on this device, and then the page is ready without keys', async () => {
    const s = site()
    const { token } = await s.admin('/invites', { name: 'Amy', from: 'Victor', minutes: 45 })
    const prefs = new Prefs(kv())
    const b = ownBridge({ prefs, store: storeOver(memoryBacking()), inviteToken: token, fetchFn: s.page })
    expect([b.pendingInvite(), b.ready()]).toEqual([true, false])
    const peek = await b.peekInvite()
    expect(peek).toMatchObject({ kind: 'ok', claimed: false, invite: { from: 'Victor', minutes: 45, state: 'ok' } })
    expect(b.ready()).toBe(false) // looking claims nothing
    expect(await b.acceptInvite()).toMatchObject({ kind: 'ok', claimed: false })
    expect([b.pendingInvite(), b.ready(), b.hasKeys()]).toEqual([false, true, false])
    // a second browser opening the same link finds it taken
    const other = ownBridge({ prefs: new Prefs(kv()), store: storeOver(memoryBacking()), inviteToken: token, fetchFn: s.page })
    expect(await other.peekInvite()).toMatchObject({ kind: 'ok', claimed: true })
    expect(await other.acceptInvite()).toMatchObject({ kind: 'ok', claimed: true })
    expect(other.ready()).toBe(false)
  })
  it('says plainly when a link is not an invite, or the site takes none', async () => {
    const s = site()
    const b = ownBridge({ prefs: new Prefs(kv()), store: storeOver(memoryBacking()), inviteToken: 'made-up', fetchFn: s.page })
    expect(await b.peekInvite()).toEqual({ kind: 'unknown' })
    const bare = ownBridge({ prefs: new Prefs(kv()), store: storeOver(memoryBacking()), inviteToken: 'x', fetchFn: (async (u: string, i?: RequestInit) => handleRelay(new Request(SITE + u, i), {})) as unknown as typeof fetch })
    expect(await bare.peekInvite()).toEqual({ kind: 'unset' })
  })
  it('learns when the invite ends, and lets it go when Victor releases it', async () => {
    const s = site()
    const { token, invite } = await s.admin('/invites', { name: 'Amy', from: 'Victor' })
    const prefs = new Prefs(kv())
    const b = ownBridge({ prefs, store: storeOver(memoryBacking()), inviteToken: token, fetchFn: s.page })
    await b.acceptInvite()
    await s.admin(`/invites/${invite.id}`, { revoke: true })
    expect((await b.refreshInvite())?.state).toBe('revoked')
    expect(b.ready()).toBe(false)
    await s.admin(`/invites/${invite.id}`, { restore: true, release: true })
    expect(await b.refreshInvite()).toBeNull()
    expect(b.invite()).toBeNull()
  })
})

describe('a sounding on an invite', () => {
  const RATE = 16_000
  const chunk = (ms: number, amp: number) => { const c = new Int16Array((ms / 1000) * RATE); for (let i = 0; i < c.length; i++) c[i] = i % 2 ? amp : -amp; return c.buffer }
  it('hears and marks through the relay, with no key in the page, and the minutes are counted', async () => {
    const s = site()
    const { token } = await s.admin('/invites', { name: 'Amy', from: 'Victor' })
    const prefs = new Prefs(kv())
    const b = ownBridge({ prefs, store: storeOver(memoryBacking()), inviteToken: token, fetchFn: s.page })
    await b.acceptInvite()
    const tokensAsked: string[] = []
    const elevenSocket = (url: string, key: string): LiveSocket => {
      tokensAsked.push(key)
      const h: Record<string, (a?: unknown) => void> = {}
      const sock: LiveSocket = { readyState: 1, send: () => {}, close: () => { sock.readyState = 3 }, on: (ev, fn) => { h[ev] = fn } }
      queueMicrotask(() => h.message?.(JSON.stringify({ message_type: 'session_started' })))
      return sock
    }
    const store = storeOver(memoryBacking())
    const sock = localSocket(ownHost({ prefs, store, fetchFn: s.page, elevenSocket, relayClaude: (d) => relayClaude(d, s.page), now: () => new Date(2026, 10, 15, 12) }))
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
    const setup = (got.find((m) => m.type === 'live.setup') as Extract<LiveMessage, { type: 'live.setup' }>).setup
    expect(setup.own).toMatchObject({ keys: false, invite: { from: 'Victor', minutesLeft: 60, state: 'ok' } })
    sock.send(JSON.stringify({ type: 'start' }))
    await until((m) => m.type === 'live.status' && m.state === 'listening')
    for (let i = 0; i < 15; i++) sock.send(chunk(100, 4000))
    for (let i = 0; i < 12; i++) sock.send(chunk(100, 0))
    await until((m) => m.type === 'reading.changed' && m.reading.marks.length > 0)
    sock.send(JSON.stringify({ type: 'stop' }))
    await until((m) => m.type === 'live.status' && m.state === 'stopped')
    sock.close()
    // the live socket was opened with the device's secret, which the relay trades for a token; no provider key in the page
    expect(tokensAsked.length).toBeGreaterThan(0)
    expect(s.reached).toContain('https://api.elevenlabs.io/v1/speech-to-text')
    expect(s.reached).toContain('https://api.anthropic.com/v1/messages')
    // a second and a half of talk was heard and paid for: shown to Victor to a tenth of a minute, so as 0
    const listed = (await s.admin('/invites')).invites[0]
    expect(listed.heardMinutes).toBe(0)
    expect(listed.spentUsd).toBeGreaterThan(0)
    expect((await b.refreshInvite())?.minutesLeft).toBe(59)
  })
  it('ends the sounding with the reason once the invite has ended', async () => {
    const s = site()
    const { token, invite } = await s.admin('/invites', { name: 'Amy', from: 'Victor' })
    const prefs = new Prefs(kv())
    await ownBridge({ prefs, store: storeOver(memoryBacking()), inviteToken: token, fetchFn: s.page }).acceptInvite()
    await s.admin(`/invites/${invite.id}`, { revoke: true })
    const create = relayClaude(prefs.invite()!.device, s.page)
    const e = await create({} as never).then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(InviteEnded)
    expect(claudeFailure(e)).toEqual({ refused: true, message: 'the invitation was withdrawn' })
  })
})

describe('the settings sheet on an invite', () => {
  it('says whose accounts hear and think, and how much is left', () => {
    const s: Setup = { transcriber: 'elevenlabs', hearsModel: null, interpreter: 'claude', thinksModel: 'claude-sonnet-5-5', lang: 'auto', api: true, ownInstructions: false, instructions: '',
      own: { keys: false, claudeHint: '', elevenHint: '', invite: { from: 'Victor', minutes: 60, minutesLeft: 42, expiresAt: Date.UTC(2026, 10, 22), state: 'ok' } } }
    const rows = setupLines(s)
    expect(rows[0][1]).toMatch(/^From Victor: 42 of 60 minutes left, until/)
    expect(rows.map((r) => r[1]).join(' ')).toContain('on Victor’s account')
    s.own!.invite!.state = 'used'
    expect(setupLines(s)[0][1]).toBe('The minutes of this invitation from Victor are used up.')
  })
})

describe('the invite command', () => {
  it('reads its words and flags', () => {
    expect(parseArgs(['new', 'Amy', 'Lee', '--days', '3', '--minutes=90'])).toEqual({ cmd: 'new', rest: ['Amy', 'Lee'], flags: { days: '3', minutes: '90' } })
    expect(parseArgs([])).toMatchObject({ cmd: 'help' })
  })
  it('lists an invite in one line', () => {
    const now = Date.UTC(2026, 10, 15)
    expect(line({ id: 'ab12cd34', name: 'Amy', from: 'Victor', expiresAt: Date.UTC(2026, 10, 22), minutes: 60, minutesLeft: 42, state: 'ok', claimed: true, heardMinutes: 18, spentUsd: 0.482, createdAt: now, lastUsedAt: Date.UTC(2026, 10, 16) }, now))
      .toBe('ab12cd34  Amy            in use            18 of 60 min  $0.482  until 2026-11-22, last used 2026-11-16')
  })
})

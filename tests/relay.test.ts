// The friends' relay, on a local SQLite database in place of D1 and stand-ins for both providers.
import { describe, it, expect } from 'vitest'
import { handleRelay, friendRequest, stateOf, type RelayEnv } from '../src/relay/relay'
import { localD1 } from './support/local-d1'
import { SYSTEM_PROMPT, CANDIDATES_SCHEMA, buildUserPrompt } from '../src/providers/extraction-prompt'
import { WRAP_SYSTEM, WRAP_SCHEMA } from '../src/live/wrap-core'

const SITE = 'https://sounding.example'
const ADMIN = 'admin-secret-for-tests'
const marksBody = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-5-5', max_tokens: 1024, thinking: { type: 'between_tools' },
  output_config: { effort: 'low', format: { type: 'json_schema', schema: CANDIDATES_SCHEMA } },
  system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: buildUserPrompt(['we should rebuild the harbor wall']) }],
  ...extra,
})

/** A relay with a clock to move and a log of what reached the providers. */
function relay(env: Partial<RelayEnv> = {}) {
  let t = Date.UTC(2026, 10, 15, 12)
  const reached: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    reached.push({ url, headers, body: init.body })
    if (url.includes('anthropic')) return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"candidates":[]}' }], usage: { input_tokens: 1000, output_tokens: 100 } }), { headers: { 'content-type': 'application/json' } })
    if (url.includes('single-use-token')) return new Response('{"token":"live-token"}')
    return new Response('{"text":"the harbor wall"}', { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const fullEnv: RelayEnv = { DB: localD1(), ANTHROPIC_API_KEY: 'sk-ant-relay', ELEVENLABS_API_KEY: 'sk_relay', ADMIN_SECRET: ADMIN, ...env }
  const call = (path: string, init: { method?: string; body?: unknown; auth?: string; form?: FormData } = {}) => handleRelay(new Request(SITE + path, {
    method: init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET'),
    headers: { ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  }), fullEnv, { fetch: fetchFn, now: () => t })
  const invite = async (body: Record<string, unknown> = {}) => (await (await call('/api/admin/invites', { body: { name: 'Amy', from: 'Victor', ...body }, auth: ADMIN })).json()) as { token: string; invite: { id: string } }
  const accept = async (token: string) => (await (await call('/api/invite/claim', { body: { token } })).json()) as { device: string }
  const wav = (seconds: number) => { const f = new FormData(); f.append('model_id', 'scribe_v2'); f.append('language_code', 'en'); f.append('file', new Blob([new Uint8Array(44 + seconds * 32_000)], { type: 'audio/wav' }), 'u.wav'); return f }
  return { call, invite, accept, wav, reached, env: fullEnv, later: (ms: number) => { t += ms } }
}

describe('making invites', () => {
  it('needs the admin secret, and gives a link token once', async () => {
    const r = relay()
    expect((await r.call('/api/admin/invites', { body: { name: 'Amy', from: 'Victor' } })).status).toBe(401)
    expect((await r.call('/api/admin/invites', { body: { name: 'Amy', from: 'Victor' }, auth: 'wrong' })).status).toBe(401)
    const made = await r.invite()
    expect(made.token.length).toBeGreaterThanOrEqual(24)
    const list = (await (await r.call('/api/admin/invites', { auth: ADMIN })).json()) as { invites: Array<Record<string, unknown>>; month: Record<string, unknown> }
    expect(list.invites).toHaveLength(1)
    expect(list.invites[0]).toMatchObject({ name: 'Amy', from: 'Victor', minutes: 60, minutesLeft: 60, state: 'ok', claimed: false })
    expect(JSON.stringify(list)).not.toContain(made.token) // only its hash is kept
    expect(list.month).toEqual({ month: '2026-11', spentUsd: 0, capUsd: 10 })
  })
  it('defaults to seven days and an hour of talk', async () => {
    const r = relay()
    const { token } = await r.invite()
    const peek = (await (await r.call('/api/invite/peek', { body: { token } })).json()) as { invite: { expiresAt: number; minutes: number } }
    expect(peek.invite.minutes).toBe(60)
    expect(peek.invite.expiresAt - Date.UTC(2026, 10, 15, 12)).toBe(7 * 86_400_000)
  })
})

describe('accepting an invite', () => {
  it('works on the first device only', async () => {
    const r = relay()
    const { token } = await r.invite()
    const first = await r.call('/api/invite/claim', { body: { token } })
    expect(first.status).toBe(200)
    const { device } = (await first.json()) as { device: string }
    expect((await r.call('/api/invite/claim', { body: { token } })).status).toBe(409)
    const me = (await (await r.call('/api/invite', { auth: device })).json()) as { invite: { name: string; state: string } }
    expect(me.invite).toMatchObject({ name: 'Amy', state: 'ok' })
    expect((await r.call('/api/invite', { auth: 'someone-else' })).status).toBe(401)
  })
  it('says what a link offers without claiming it, and turns away links that are not invites', async () => {
    const r = relay()
    const { token } = await r.invite({ minutes: 30 })
    const peek = (await (await r.call('/api/invite/peek', { body: { token } })).json()) as { invite: { from: string; minutes: number }; claimed: boolean }
    expect(peek).toMatchObject({ invite: { from: 'Victor', minutes: 30 }, claimed: false })
    expect((await r.call('/api/invite/claim', { body: { token } })).status).toBe(200)
    expect((await r.call('/api/invite/peek', { body: { token: 'made-up' } })).status).toBe(404)
  })
  it('can be released, so the same link works on a new device', async () => {
    const r = relay()
    const { token, invite } = await r.invite()
    const old = await r.accept(token)
    await r.call(`/api/admin/invites/${invite.id}`, { body: { release: true }, auth: ADMIN })
    expect((await r.call('/api/invite', { auth: old.device })).status).toBe(401)
    expect((await r.call('/api/invite/claim', { body: { token } })).status).toBe(200)
  })
})

describe('what a friend can reach', () => {
  it('passes on the marks and the wrap with the relay\'s key, and counts what they cost', async () => {
    const r = relay()
    const { device } = await r.accept((await r.invite()).token)
    const res = await r.call('/api/claude', { body: marksBody(), auth: device })
    expect(res.status).toBe(200)
    expect(r.reached[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(r.reached[0].headers['x-api-key']).toBe('sk-ant-relay')
    const wrap = marksBody({ system: [{ type: 'text', text: WRAP_SYSTEM, cache_control: { type: 'ephemeral' } }], output_config: { effort: 'low', format: { type: 'json_schema', schema: WRAP_SCHEMA } } })
    expect((await r.call('/api/claude', { body: wrap, auth: device })).status).toBe(200)
    const list = (await (await r.call('/api/admin/invites', { auth: ADMIN })).json()) as { invites: Array<{ spentUsd: number }>; month: { spentUsd: number } }
    expect(list.invites[0].spentUsd).toBeCloseTo(0.006, 3) // two calls of 1000 in, 100 out on Sonnet 5.5
    expect(list.month.spentUsd).toBeCloseTo(0.006, 3)
  })
  it('turns away anything that is not one of Sounding\'s requests', async () => {
    const r = relay()
    const { device } = await r.accept((await r.invite()).token)
    const refused = [
      marksBody({ system: [{ type: 'text', text: 'You are a helpful assistant.' }] }),
      marksBody({ tools: [{ name: 'x' }] }),
      marksBody({ model: 'claude-opus-5-5' }),
      marksBody({ max_tokens: 64_000 }),
      marksBody({ output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } } } }),
      marksBody({ output_config: { effort: 'low', format: { type: 'json_schema', schema: WRAP_SCHEMA } } }), // the wrap's shape under the marks' prompt
      marksBody({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }),
    ]
    for (const b of refused) expect((await r.call('/api/claude', { body: b, auth: device })).status).toBe(400)
    expect(r.reached).toHaveLength(0)
    expect(typeof friendRequest(marksBody())).toBe('object')
  })
  it('hands out a live token, and passes one utterance at a time to the file model, counting the talk', async () => {
    const r = relay()
    const { device } = await r.accept((await r.invite()).token)
    expect(await (await r.call('/api/eleven/token', { method: 'POST', auth: device })).json()).toEqual({ token: 'live-token' })
    expect(r.reached[0].headers['xi-api-key']).toBe('sk_relay')
    const heard = await r.call('/api/eleven/file', { form: r.wav(6), auth: device })
    expect(await heard.json()).toEqual({ text: 'the harbor wall' })
    const sent = r.reached[1].body as FormData
    expect([sent.get('model_id'), sent.get('language_code'), (sent.get('file') as Blob).size]).toEqual(['scribe_v2', 'en', 44 + 6 * 32_000])
    const list = (await (await r.call('/api/admin/invites', { auth: ADMIN })).json()) as { invites: Array<{ heardMinutes: number; minutesLeft: number; spentUsd: number }> }
    expect(list.invites[0].heardMinutes).toBe(0.1)
    expect(list.invites[0].spentUsd).toBeGreaterThan(0)
    const other = new FormData(); other.append('model_id', 'scribe_v1'); other.append('file', new Blob([new Uint8Array(100)]))
    expect((await r.call('/api/eleven/file', { form: other, auth: device })).status).toBe(400)
  })
})

describe('when an invite ends', () => {
  it('stops at its minutes, its date, a withdrawal, and the month\'s cap; and can be given more', async () => {
    const r = relay()
    const made = await r.invite({ minutes: 1 })
    const { device } = await r.accept(made.token)
    // a minute of talk, in two utterances (one too long for the relay is turned away and not counted)
    expect((await r.call('/api/eleven/file', { form: r.wav(32), auth: device })).status).toBe(413)
    await r.call('/api/eleven/file', { form: r.wav(30), auth: device })
    await r.call('/api/eleven/file', { form: r.wav(30), auth: device })
    const used = await r.call('/api/claude', { body: marksBody(), auth: device })
    expect(used.status).toBe(403)
    expect(await used.json()).toMatchObject({ error: { type: 'invite_ended' }, invite: { state: 'used', minutesLeft: 0 } })
    await r.call(`/api/admin/invites/${made.invite.id}`, { body: { addMinutes: 30 }, auth: ADMIN })
    expect((await r.call('/api/claude', { body: marksBody(), auth: device })).status).toBe(200)

    r.later(8 * 86_400_000)
    expect(((await (await r.call('/api/invite', { auth: device })).json()) as { invite: { state: string } }).invite.state).toBe('expired')
    await r.call(`/api/admin/invites/${made.invite.id}`, { body: { addDays: 7 }, auth: ADMIN })
    expect(((await (await r.call('/api/invite', { auth: device })).json()) as { invite: { state: string; expiresAt: number } }).invite.state).toBe('ok')

    await r.call(`/api/admin/invites/${made.invite.id}`, { body: { revoke: true }, auth: ADMIN })
    expect((await r.call('/api/eleven/token', { method: 'POST', auth: device })).status).toBe(403)
  })
  it('pauses every invite once the month\'s cap is spent', async () => {
    const r = relay({ MONTH_CAP_USD: '0.004' })
    const { device } = await r.accept((await r.invite()).token)
    expect((await r.call('/api/claude', { body: marksBody(), auth: device })).status).toBe(200) // $0.003
    expect((await r.call('/api/claude', { body: marksBody(), auth: device })).status).toBe(200) // over the cap, but already under way
    expect(((await (await r.call('/api/claude', { body: marksBody(), auth: device })).json()) as { invite: { state: string } }).invite.state).toBe('cap')
    expect(stateOf({ revoked: 0, expires_at: Infinity, heard_ms: 0, minutes: 60 }, 0, 10, 10)).toBe('cap')
  })
  it('does not mistake the relay\'s own key being refused for the friend\'s', async () => {
    const r = relay()
    const { device } = await r.accept((await r.invite()).token)
    const env = { ...r.env }
    const res = await handleRelay(new Request(`${SITE}/api/eleven/token`, { method: 'POST', headers: { authorization: `Bearer ${device}` } }), env, { fetch: (async () => new Response('{"detail":"no"}', { status: 401 })) as unknown as typeof fetch })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('relay_unavailable')
  })
  it('answers plainly when the site has no relay set up', async () => {
    const res = await handleRelay(new Request(`${SITE}/api/invite/peek`, { method: 'POST', body: '{"token":"x"}' }), {})
    expect(res.status).toBe(503)
  })
})

describe('the page\'s own requests', () => {
  it('pass the relay\'s check exactly as the page builds them, marks and wrap alike', async () => {
    const { OwnClaudeInterpreter, ownWrap } = await import('../src/own/claude')
    const sent: unknown[] = []
    const create = async (b: unknown) => { sent.push(b); return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"candidates":[],"wrap":"ok"}' }], usage: { input_tokens: 1, output_tokens: 1 } } as never }
    for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5'] as const) {
      await new OwnClaudeInterpreter(create, model).interpret({ kind: 'transcript', text: 'the harbor wall', segmentId: 's1' } as never)
    }
    await ownWrap(create)('Tell me briefly.', { transcript: 'the harbor wall', marks: ['harbor wall'], dismissed: [], renamed: [], context: '' })
    expect(sent).toHaveLength(3)
    for (const b of sent) expect(typeof friendRequest(b)).toBe('object')
  })
})

describe('removing invites', () => {
  it('takes away only invites that can no longer be used, and keeps the month\'s spend', async () => {
    const r = relay()
    const open = await r.invite({ name: 'Open' })
    const done = await r.invite({ name: 'Done' })
    const { device } = await r.accept(done.token)
    await r.call('/api/claude', { body: marksBody(), auth: device })
    const remove = (id: string) => r.call(`/api/admin/invites/${id}`, { method: 'DELETE', auth: ADMIN })
    expect((await remove(open.invite.id)).status).toBe(409)
    await r.call(`/api/admin/invites/${done.invite.id}`, { body: { revoke: true }, auth: ADMIN })
    expect(await (await remove(done.invite.id)).json()).toEqual({ removed: done.invite.id })
    expect((await remove(done.invite.id)).status).toBe(404)
    expect((await r.call('/api/invite', { auth: device })).status).toBe(401)
    const list = (await (await r.call('/api/admin/invites', { auth: ADMIN })).json()) as { invites: Array<{ name: string }>; month: { spentUsd: number } }
    expect(list.invites.map((v) => v.name)).toEqual(['Open'])
    expect(list.month.spentUsd).toBeGreaterThan(0)
    expect((await r.call(`/api/admin/invites/${open.invite.id}`, { method: 'DELETE' })).status).toBe(401)
  })
})

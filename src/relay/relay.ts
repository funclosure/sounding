// The friends' relay: lets someone Victor invites use the hosted page on his
// Anthropic and ElevenLabs keys, which stay here and never reach the browser.
// It runs as a Cloudflare Pages Function beside the site (functions/api), so
// the page reaches it on its own origin.
//
// What it guards:
// - An invite works on the first device that accepts it, until it expires, its
//   minutes of talk are used, or it is revoked. All friends together stop at a
//   monthly cap.
// - It passes on only Sounding's own requests: the marks and the wrap, each
//   with its own system prompt and answer shape, a single-use token for live
//   hearing, and one utterance at a time for the kept text. An invite cannot be
//   used as a general Claude or ElevenLabs key.
// - It keeps no words and no sound: only how much was heard and what it cost.
import { SYSTEM_PROMPT, CANDIDATES_SCHEMA } from '../providers/extraction-prompt'
import { WRAP_SYSTEM, WRAP_SCHEMA } from '../live/wrap-core'
import { llmCost } from '../providers/pricing'
import type { D1 } from './db'

export interface RelayEnv {
  DB?: D1
  ANTHROPIC_API_KEY?: string
  ELEVENLABS_API_KEY?: string
  ADMIN_SECRET?: string
  /** All friends together, per calendar month (UTC), in dollars. */
  MONTH_CAP_USD?: string
}
export interface RelayDeps { fetch?: typeof fetch; now?: () => number }

export const INVITE_DEFAULTS = { days: 7, minutes: 60 }
export const MONTH_CAP_DEFAULT_USD = 10

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ELEVEN_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe'
const ELEVEN_FILE_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
// ElevenLabs' API prices on 15 November 2026: the file model $0.20 an hour, the live model $0.22. The relay sees
// only the utterances the file model hears; the live model streams the whole sounding, pauses too, so it is
// counted as half as much again as that.
const FILE_USD_PER_SEC = 0.2 / 3600
const LIVE_USD_PER_SEC = (0.22 / 3600) * 1.5
const FRIEND_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5']
const MAX_TOKENS = 2048
const MAX_PROMPT_CHARS = 150_000
// Utterances are cut at 8 seconds; a 16 kHz mono WAV of 30 seconds is under a megabyte.
const MAX_AUDIO_BYTES = 1_000_000
const WAV_HEADER = 44
const PCM_BYTES_PER_SEC = 32_000

import { removable, type InviteState } from './invite-state'
export { removable, type InviteState }
export interface InviteView {
  id: string
  name: string
  from: string
  expiresAt: number
  minutes: number
  minutesLeft: number
  state: InviteState
}
export interface InviteAdminView extends InviteView {
  claimed: boolean
  heardMinutes: number
  spentUsd: number
  createdAt: number
  lastUsedAt: number | null
}
interface Row {
  id: string; name: string; from_name: string; token_hash: string; device_hash: string | null
  created_at: number; expires_at: number; minutes: number; heard_ms: number; spent_usd: number
  revoked: number; claimed_at: number | null; last_used_at: number | null
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const refuse = (status: number, type: string, message: string) => json({ type: 'error', error: { type, message } }, status)

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}
function randomToken(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const bearer = (req: Request) => /^Bearer\s+(\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null
const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7)

/** Compares two secrets without leaking how much of them matched, by comparing their hashes in full. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

export function stateOf(r: Pick<Row, 'revoked' | 'expires_at' | 'heard_ms' | 'minutes'>, now: number, monthSpent: number, capUsd: number): InviteState {
  if (r.revoked) return 'revoked'
  if (now >= r.expires_at) return 'expired'
  if (r.heard_ms >= r.minutes * 60_000) return 'used'
  if (monthSpent >= capUsd) return 'cap'
  return 'ok'
}
function viewOf(r: Row, state: InviteState): InviteView {
  return { id: r.id, name: r.name, from: r.from_name, expiresAt: r.expires_at, minutes: r.minutes, minutesLeft: Math.max(0, Math.floor(r.minutes - r.heard_ms / 60_000)), state }
}

/** Keys sorted at every level, so two copies of one schema compare equal however they were built. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const SHAPES = [
  { system: SYSTEM_PROMPT, schema: canonical(CANDIDATES_SCHEMA) },
  { system: WRAP_SYSTEM, schema: canonical(WRAP_SCHEMA) },
]
const THINKING = [canonical({ type: 'between_tools' }), canonical({ type: 'disabled' })]

/**
 * A Claude request from the page, checked to be one of Sounding's two (the
 * marks or the wrap) and rebuilt from what was checked. Anything else is
 * turned away with the reason, so an invite is not a general key.
 */
export function friendRequest(b: unknown): { body: Record<string, unknown>; model: string } | string {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'the request is not an object'
  const o = b as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['model', 'max_tokens', 'thinking', 'output_config', 'system', 'messages'].includes(k)) return `"${k}" is not allowed`
  const model = o.model
  if (typeof model !== 'string' || !FRIEND_MODELS.includes(model)) return 'that model is not offered'
  if (!Number.isInteger(o.max_tokens) || (o.max_tokens as number) < 1 || (o.max_tokens as number) > MAX_TOKENS) return 'max_tokens is out of range'
  if (o.thinking !== undefined && !THINKING.includes(canonical(o.thinking))) return 'that thinking setting is not offered'
  const sys = o.system
  if (!Array.isArray(sys) || sys.length !== 1) return 'the system prompt is not Sounding\'s'
  const block = sys[0] as Record<string, unknown>
  const cache = block.cache_control === undefined || canonical(block.cache_control) === canonical({ type: 'ephemeral' })
  const shape = SHAPES.find((s) => s.system === block.text)
  if (block.type !== 'text' || !cache || !shape || Object.keys(block).some((k) => !['type', 'text', 'cache_control'].includes(k))) return 'the system prompt is not Sounding\'s'
  const oc = o.output_config as Record<string, unknown> | undefined
  const format = oc?.format as Record<string, unknown> | undefined
  if (!oc || Object.keys(oc).some((k) => !['effort', 'format'].includes(k)) || (oc.effort !== undefined && oc.effort !== 'low')) return 'that output setting is not offered'
  if (!format || format.type !== 'json_schema' || Object.keys(format).length !== 2 || canonical(format.schema) !== shape.schema) return 'the answer shape is not Sounding\'s'
  const msgs = o.messages
  if (!Array.isArray(msgs) || msgs.length !== 1) return 'one user message is expected'
  const m = msgs[0] as Record<string, unknown>
  if (m.role !== 'user' || typeof m.content !== 'string' || Object.keys(m).length !== 2) return 'one user message is expected'
  if (m.content.length > MAX_PROMPT_CHARS) return 'the message is too long'
  return {
    model,
    body: {
      model, max_tokens: o.max_tokens,
      ...(o.thinking === undefined ? {} : { thinking: o.thinking }),
      output_config: { ...(oc.effort ? { effort: 'low' } : {}), format: { type: 'json_schema', schema: format.schema } },
      system: [{ type: 'text', text: shape.system, ...(block.cache_control ? { cache_control: { type: 'ephemeral' } } : {}) }],
      messages: [{ role: 'user', content: m.content }],
    },
  }
}

export async function handleRelay(req: Request, env: RelayEnv, deps: RelayDeps = {}): Promise<Response> {
  const fetchFn = deps.fetch ?? fetch
  const now = (deps.now ?? Date.now)()
  const path = new URL(req.url).pathname.replace(/\/+$/, '')
  const db = env.DB
  if (!db) return refuse(503, 'not_set_up', 'Invitations are not set up on this site.')
  const capUsd = Number(env.MONTH_CAP_USD) > 0 ? Number(env.MONTH_CAP_USD) : MONTH_CAP_DEFAULT_USD
  const monthSpent = async () => (await db.prepare('SELECT spent_usd FROM months WHERE month = ?').bind(monthOf(now)).first<{ spent_usd: number }>())?.spent_usd ?? 0

  if (path.startsWith('/api/admin/')) return admin(req, path, env, db, now, capUsd, monthSpent)

  if (!env.ANTHROPIC_API_KEY || !env.ELEVENLABS_API_KEY) return refuse(503, 'not_set_up', 'Invitations are not set up on this site.')

  // Opening an invite: what it offers, before it is accepted (nothing is claimed), then accepting it.
  if ((path === '/api/invite/peek' || path === '/api/invite/claim') && req.method === 'POST') {
    const token = ((await req.json().catch(() => ({}))) as { token?: unknown }).token
    if (typeof token !== 'string' || !token) return refuse(400, 'bad_request', 'No invitation in the request.')
    const row = await db.prepare('SELECT * FROM invites WHERE token_hash = ?').bind(await sha256(token)).first<Row>()
    if (!row) return refuse(404, 'unknown', 'This link is not a valid invitation.')
    const state = stateOf(row, now, await monthSpent(), capUsd)
    if (row.device_hash) return json({ invite: viewOf(row, state), claimed: true }, path.endsWith('peek') ? 200 : 409)
    if (path.endsWith('peek')) return json({ invite: viewOf(row, state), claimed: false })
    if (state === 'revoked' || state === 'expired' || state === 'used') return json({ invite: viewOf(row, state) }, 410)
    const device = randomToken(24)
    // first device only: a second accept racing this one finds the device already set and changes nothing
    const done = await db.prepare('UPDATE invites SET device_hash = ?, claimed_at = ? WHERE id = ? AND device_hash IS NULL').bind(await sha256(device), now, row.id).run()
    if (done.meta.changes !== 1) return json({ invite: viewOf(row, state), claimed: true }, 409)
    return json({ device, invite: viewOf(row, state) })
  }

  const device = bearer(req)
  const row = device ? await db.prepare('SELECT * FROM invites WHERE device_hash = ?').bind(await sha256(device)).first<Row>() : null
  if (!row) return refuse(401, 'unknown', 'This device has no invitation.')
  const state = stateOf(row, now, await monthSpent(), capUsd)
  if (path === '/api/invite' && req.method === 'GET') return json({ invite: viewOf(row, state) })
  if (state !== 'ok') return json({ type: 'error', error: { type: 'invite_ended', message: endedWords(state) }, invite: viewOf(row, state) }, 403)

  // What was spent is added once the provider has answered; a call in flight when the cap is reached still finishes.
  const record = (heardMs: number, usd: number) => db.batch([
    db.prepare('UPDATE invites SET heard_ms = heard_ms + ?, spent_usd = spent_usd + ?, last_used_at = ? WHERE id = ?').bind(Math.round(heardMs), usd, now, row.id),
    db.prepare('INSERT INTO months (month, spent_usd) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd').bind(monthOf(now), usd),
  ])

  if (path === '/api/claude' && req.method === 'POST') {
    const checked = friendRequest(await req.json().catch(() => null))
    if (typeof checked === 'string') return refuse(400, 'invalid_request_error', checked)
    const res = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(checked.body),
    })
    const text = await res.text()
    if (res.ok) {
      try {
        const u = (JSON.parse(text) as { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }).usage ?? {}
        await record(0, llmCost(checked.model, { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0 }))
      } catch { /* an answer without usage costs nothing we can count */ }
    }
    return upstream(res, text, 'Anthropic')
  }

  if (path === '/api/eleven/token' && req.method === 'POST') {
    const res = await fetchFn(ELEVEN_TOKEN_URL, { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } })
    const text = await res.text()
    if (!res.ok) return upstream(res, text, 'ElevenLabs')
    const token = (JSON.parse(text) as { token?: string }).token
    return token ? json({ token }) : refuse(502, 'relay', 'ElevenLabs gave no token.')
  }

  if (path === '/api/eleven/file' && req.method === 'POST') {
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    const language = form?.get('language_code')
    if (!form || !(file instanceof Blob) || form.get('model_id') !== 'scribe_v2') return refuse(400, 'bad_request', 'One utterance for scribe_v2 is expected.')
    if (file.size > MAX_AUDIO_BYTES) return refuse(413, 'bad_request', 'The utterance is too long.')
    if (language !== null && (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language))) return refuse(400, 'bad_request', 'That language code is not one.')
    const out = new FormData()
    out.append('model_id', 'scribe_v2')
    out.append('tag_audio_events', 'false')
    if (language) out.append('language_code', language)
    out.append('file', file, 'utterance.wav')
    const res = await fetchFn(ELEVEN_FILE_URL, { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, body: out })
    const text = await res.text()
    if (res.ok) {
      const seconds = Math.max(0, file.size - WAV_HEADER) / PCM_BYTES_PER_SEC
      await record(seconds * 1000, seconds * (FILE_USD_PER_SEC + LIVE_USD_PER_SEC))
    }
    return upstream(res, text, 'ElevenLabs')
  }

  return refuse(404, 'not_found', 'Nothing here.')
}

function endedWords(state: InviteState): string {
  return state === 'expired' ? 'the invitation has expired'
    : state === 'used' ? 'the invitation\'s minutes are used up'
    : state === 'revoked' ? 'the invitation was withdrawn'
    : 'invitations are paused for this month'
}

/**
 * The provider's answer, passed on. A refusal of the relay's own key or account
 * is not the friend's to fix, so it is said as the relay being unavailable rather
 * than as a bad key (which the page would tell them to replace).
 */
function upstream(res: Response, text: string, who: string): Response {
  if (res.status === 401 || res.status === 402 || res.status === 403) return refuse(503, 'relay_unavailable', `${who} is not taking invitations' requests right now.`)
  return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } })
}

/** Victor's side: make, list, extend and withdraw invites. Every call carries the admin secret. */
async function admin(req: Request, path: string, env: RelayEnv, db: D1, now: number, capUsd: number, monthSpent: () => Promise<number>): Promise<Response> {
  const given = bearer(req)
  if (!env.ADMIN_SECRET || !given || !(await sameSecret(given, env.ADMIN_SECRET))) return refuse(401, 'unauthorized', 'Not allowed.')
  const spent = await monthSpent()
  const adminView = (r: Row): InviteAdminView => ({
    ...viewOf(r, stateOf(r, now, spent, capUsd)),
    claimed: !!r.device_hash, heardMinutes: Math.round(r.heard_ms / 6000) / 10, spentUsd: Math.round(r.spent_usd * 1000) / 1000,
    createdAt: r.created_at, lastUsedAt: r.last_used_at,
  })

  if (path === '/api/admin/invites' && req.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all<Row>()
    return json({ invites: results.map(adminView), month: { month: monthOf(now), spentUsd: Math.round(spent * 1000) / 1000, capUsd } })
  }
  if (path === '/api/admin/invites' && req.method === 'POST') {
    const b = (await req.json().catch(() => ({}))) as { name?: unknown; from?: unknown; days?: unknown; minutes?: unknown }
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 60) : ''
    const from = typeof b.from === 'string' ? b.from.trim().slice(0, 40) : ''
    const days = Number(b.days ?? INVITE_DEFAULTS.days), minutes = Number(b.minutes ?? INVITE_DEFAULTS.minutes)
    if (!name || !from) return refuse(400, 'bad_request', 'An invite needs a name, and who it is from.')
    if (!(days > 0 && days <= 366) || !(Number.isInteger(minutes) && minutes > 0 && minutes <= 6000)) return refuse(400, 'bad_request', 'Days or minutes are out of range.')
    const token = randomToken(18)
    const id = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8)
    await db.prepare('INSERT INTO invites (id, name, from_name, token_hash, created_at, expires_at, minutes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, from, await sha256(token), now, Math.round(now + days * 86_400_000), minutes).run()
    const row = await db.prepare('SELECT * FROM invites WHERE id = ?').bind(id).first<Row>()
    return json({ token, invite: adminView(row!) }, 201)
  }
  const m = /^\/api\/admin\/invites\/([\w-]+)$/.exec(path)
  // Removing an invite that can no longer be used: withdrawn, expired or used up. One still open is withdrawn first,
  // so a friend is never cut off by a tidy-up. The month's spend keeps what it cost.
  if (m && req.method === 'DELETE') {
    const row = await db.prepare('SELECT * FROM invites WHERE id = ?').bind(m[1]).first<Row>()
    if (!row) return refuse(404, 'unknown', 'No such invite.')
    if (!removable(stateOf(row, now, spent, capUsd))) return refuse(409, 'still_open', 'Withdraw it first: it can still be used.')
    await db.prepare('DELETE FROM invites WHERE id = ?').bind(row.id).run()
    return json({ removed: row.id })
  }
  if (m && req.method === 'POST') {
    const row = await db.prepare('SELECT * FROM invites WHERE id = ?').bind(m[1]).first<Row>()
    if (!row) return refuse(404, 'unknown', 'No such invite.')
    const b = (await req.json().catch(() => ({}))) as { addDays?: unknown; addMinutes?: unknown; revoke?: unknown; restore?: unknown; release?: unknown }
    const addDays = Number(b.addDays ?? 0), addMinutes = Number(b.addMinutes ?? 0)
    if (!(addDays >= 0 && addDays <= 366) || !(Number.isInteger(addMinutes) && addMinutes >= 0 && addMinutes <= 6000)) return refuse(400, 'bad_request', 'Days or minutes are out of range.')
    // Extending an expired invite counts from now, so it gets the full extra days.
    const expires = addDays ? Math.round(Math.max(now, row.expires_at) + addDays * 86_400_000) : row.expires_at
    const revoked = b.revoke === true ? 1 : b.restore === true ? 0 : row.revoked
    // Releasing lets the same link be accepted again, on a new device: for a friend whose browser forgot it.
    const device = b.release === true ? null : row.device_hash
    await db.prepare('UPDATE invites SET expires_at = ?, minutes = ?, revoked = ?, device_hash = ?, claimed_at = ? WHERE id = ?')
      .bind(expires, row.minutes + addMinutes, revoked, device, device ? row.claimed_at : null, row.id).run()
    return json({ invite: adminView((await db.prepare('SELECT * FROM invites WHERE id = ?').bind(row.id).first<Row>())!) })
  }
  return refuse(404, 'not_found', 'Nothing here.')
}

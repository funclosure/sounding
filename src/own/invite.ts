// A friend invited by Victor: the page runs on the relay (src/relay, served at
// /api on the same site) instead of keys of their own. The invite arrives after
// the # of the link, so the site never sees it in a request; accepting it trades
// it for a secret kept for this device, which every later call carries.
import Anthropic from '@anthropic-ai/sdk'
import { ELEVEN_FILE_MODEL } from '../live/elevenlabs'
import { toWav } from '../live/pcm-ring'
import type { TranscribeFn } from '../live/whisper-server'
import type { InviteView } from '../relay/relay'
import type { CreateMessage } from './claude'

export type { InviteView }

/** The invite's own token, if this page was opened from an invite link. */
export const inviteIn = (hash: string): string | null => new URLSearchParams(hash.replace(/^#/, '')).get('invite') || null

/** Takes an invite out of the page's address the moment it loads, as with carried keys. */
export function takeInvite(loc: { hash: string; pathname: string; search: string }, history: { replaceState(data: unknown, unused: string, url: string): void }): string | null {
  const token = inviteIn(loc.hash)
  if (token !== null || /(^#|&)invite=/.test(loc.hash)) history.replaceState(null, '', loc.pathname + loc.search)
  return token
}

/** An invite has ended (its time, its minutes, withdrawn, or the month's cap): nothing more will work on it. */
export class InviteEnded extends Error {
  constructor(message: string, readonly invite?: InviteView) { super(message); this.name = 'InviteEnded' }
}

export type Opened =
  | { kind: 'ok'; invite: InviteView; claimed: boolean; device?: string }
  | { kind: 'unknown' | 'unreachable' | 'unset' }

/** What an invite link offers (`peek`), or accepting it on this device (`claim`). */
export async function openInvite(how: 'peek' | 'claim', token: string, fetchFn: typeof fetch = fetch): Promise<Opened> {
  let res: Response
  try { res = await fetchFn(`/api/invite/${how}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }) }
  catch { return { kind: 'unreachable' } }
  const body = (await res.json().catch(() => ({}))) as { invite?: InviteView; claimed?: boolean; device?: string; error?: { type?: string } }
  if (res.status === 404) return { kind: 'unknown' }
  if (res.status === 503 && body.error?.type === 'not_set_up') return { kind: 'unset' }
  if (!body.invite) return { kind: 'unreachable' }
  return { kind: 'ok', invite: body.invite, claimed: res.status === 409 || body.claimed === true, device: body.device }
}

/** The invite as it stands now. Null if the relay no longer knows this device (released, or never accepted). */
export async function inviteNow(device: string, fetchFn: typeof fetch = fetch): Promise<InviteView | null | 'unreachable'> {
  try {
    const res = await fetchFn('/api/invite', { headers: { authorization: `Bearer ${device}` } })
    if (res.status === 401) return null
    if (!res.ok) return 'unreachable'
    return ((await res.json()) as { invite: InviteView }).invite
  } catch { return 'unreachable' }
}

/** Reads a relay refusal: an ended invite, or the provider's own error passed on. */
async function failure(res: Response, who: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string }; invite?: InviteView }
  if (body.error?.type === 'invite_ended' || body.error?.type === 'unknown') return new InviteEnded(body.error.message ?? 'the invitation has ended', body.invite)
  return new Error(`${who}: ${body.error?.message ?? `HTTP ${res.status}`}`)
}

/** Claude through the relay. A provider error comes back as the SDK's own, so the page reads it as it reads any other. */
export function relayClaude(device: string, fetchFn: typeof fetch = fetch): CreateMessage {
  return async (body) => {
    const res = await fetchFn('/api/claude', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device}` }, body: JSON.stringify(body) })
    if (res.status === 403) throw await failure(res, 'Claude')
    const json = await res.json().catch(() => null)
    if (!res.ok) throw Anthropic.APIError.generate(res.status, json as object, undefined, res.headers)
    return json as Anthropic.Message
  }
}

/** A single-use token for the live model, from the relay. */
export function relayToken(device: string, fetchFn: typeof fetch = fetch): () => Promise<string> {
  return async () => {
    let res: Response
    try { res = await fetchFn('/api/eleven/token', { method: 'POST', headers: { authorization: `Bearer ${device}` } }) }
    catch { throw new Error('cannot reach the invitation\'s relay') }
    if (!res.ok) throw await failure(res, 'ElevenLabs')
    const token = ((await res.json()) as { token?: string }).token
    if (!token) throw new Error('the relay gave no token')
    return token
  }
}

/** The file model through the relay: one finished utterance in, its text out, as elevenFile does with a key. */
export function relayElevenFile(device: string, fetchFn: typeof fetch = fetch): TranscribeFn {
  return async (pcm, opts) => {
    const form = new FormData()
    form.append('model_id', ELEVEN_FILE_MODEL)
    if (opts.language !== 'auto') form.append('language_code', opts.language)
    form.append('file', new Blob([toWav(pcm) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'utterance.wav')
    const res = await fetchFn('/api/eleven/file', { method: 'POST', headers: { authorization: `Bearer ${device}` }, body: form })
    if (!res.ok) throw await failure(res, 'ElevenLabs speech to text')
    return ((await res.json()) as { text?: string }).text ?? ''
  }
}

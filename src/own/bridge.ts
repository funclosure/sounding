// The bridge the own-keys page talks through (src/ui/socket.ts): a listener
// that lives in the page, the keys it runs on, and a sounding as a file.
import type { KeyCheck, OwnBridge } from '../ui/socket'
import { wrapMaterial } from '../live/wrap-core'
import { checkClaudeKey, isOwnModel, OWN_MODELS, type OwnModel } from './claude'
import { checkElevenKey } from './eleven-socket'
import { ownHost, type OwnDeps } from './host'
import { localSocket } from './local-socket'
import { carryCode, carryUrl, keyHint, lookOf, looksCutShort, tidyKey, type Keys, type Which } from './keys'
import { inviteNow, openInvite, type Opened } from './invite'

export interface BridgeDeps extends OwnDeps {
  /** Each asks its provider about a key: null when it works, else 'refused', 'nocredit' (Claude only) or 'unreachable'. */
  checkClaude?: (key: string, model: OwnModel) => Promise<string | null>
  checkEleven?: (key: string) => Promise<string | null>
  /** Keys that arrived in this page's address from a carry code, already taken out of it. */
  carried?: Keys | null
  /** The site's own address, for the carry code. */
  siteUrl?: () => string
  /** An invite token that arrived in this page's address, already taken out of it. */
  inviteToken?: string | null
}

/** One kept sounding as a note a person can read: when, what stood out, what was said back, and everything heard. */
export function soundingFile(name: string, events: Parameters<typeof wrapMaterial>[0], wrap: string | null): { filename: string; text: string } {
  const m = wrapMaterial(events)
  const [, y, mo, d, h, mi] = /^live-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(name) ?? []
  const parts = [`# Sounding${y ? ` · ${y}-${mo}-${d} ${h}:${mi}` : ''}`]
  if (m.marks.length) parts.push(`## What stood out\n\n${m.marks.map((l) => `- ${l}`).join('\n')}`)
  if (wrap) parts.push(`## What was said back\n\n${wrap.trim()}`)
  if (m.context) parts.push(`## Context brought\n\n${m.context}`)
  parts.push(`## Everything heard\n\n${m.transcript || '(nothing was said)'}`)
  return { filename: `sounding-${/(\d{8}-\d{6})/.exec(name)?.[1] ?? 'kept'}.md`, text: parts.join('\n\n') + '\n' }
}

export function ownBridge(deps: BridgeDeps): OwnBridge {
  const { prefs, store } = deps
  const host = ownHost(deps)
  let carried = deps.carried ?? null
  let pending = deps.inviteToken ?? null
  const fetchFn = deps.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const shown = (o: Opened) => (o.kind === 'ok' ? { kind: 'ok' as const, invite: o.invite, claimed: o.claimed } : o)
  const keepable = (c: KeyCheck) => c === 'ok' || c === 'unreachable' || c === 'nocredit'
  // What the key itself and then its provider say about it. A refused key is never kept; one that could not be
  // checked is (the provider may only be out of reach for a moment), and so is one on an account with no credit yet.
  async function judge(which: Which, typed: string): Promise<KeyCheck> {
    const key = tidyKey(typed)
    if (!key) return 'missing'
    const look = lookOf(which, key)
    if (look !== 'ok') return look
    const r = which === 'claude' ? await (deps.checkClaude ?? checkClaudeKey)(key, prefs.model()) : await (deps.checkEleven ?? checkElevenKey)(key)
    return r === null ? 'ok' : r === 'refused' ? (looksCutShort(which, key) ? 'short' : 'refused') : r === 'nocredit' ? 'nocredit' : 'unreachable'
  }
  return {
    open: () => localSocket(host),
    hasKeys: () => prefs.hasKeys(),
    hints: () => { const k = prefs.keys(); return { claude: keyHint(k.claude), eleven: keyHint(k.eleven) } },
    look: (which, typed) => (tidyKey(typed) ? lookOf(which, typed) : 'missing'),
    async setKey(which, typed) {
      const said = await judge(which, typed)
      if (keepable(said)) prefs.saveKey(which, typed)
      return said
    },
    carryCode: () => (prefs.hasKeys() ? carryCode(carryUrl(deps.siteUrl?.() ?? location.href, prefs.keys())) : null),
    carried: () => (carried ? { claude: keyHint(carried.claude), eleven: keyHint(carried.eleven) } : null),
    async useCarried() {
      const k = carried
      carried = null
      if (!k) return null
      // Both are asked about first, and both kept only if neither was turned away: never one carried key beside one old one.
      const [claude, eleven] = await Promise.all([judge('claude', k.claude), judge('eleven', k.eleven)])
      if (keepable(claude) && keepable(eleven)) prefs.saveKeys(k)
      return { claude, eleven }
    },
    dropCarried: () => { carried = null },
    forgetKeys: () => prefs.forgetKeys(),
    ready() {
      if (prefs.hasKeys()) return true
      const inv = prefs.invite()?.invite
      return !!inv && inv.state === 'ok' && Date.now() < inv.expiresAt && inv.minutesLeft > 0
    },
    invite: () => prefs.invite()?.invite ?? null,
    async refreshInvite() {
      const kept = prefs.invite()
      if (!kept) return null
      const now = await inviteNow(kept.device, fetchFn)
      if (now === 'unreachable') return kept.invite
      // the relay no longer knows this device (released for another one): the invite is gone from here too
      prefs.saveInvite(now ? { device: kept.device, invite: now } : null)
      return now
    },
    pendingInvite: () => pending !== null,
    peekInvite: async () => (pending ? shown(await openInvite('peek', pending, fetchFn)) : { kind: 'unknown' as const }),
    async acceptInvite() {
      if (!pending) return { kind: 'unknown' as const }
      const o = await openInvite('claim', pending, fetchFn)
      if (o.kind === 'ok' && o.device) { prefs.saveInvite({ device: o.device, invite: o.invite }); pending = null }
      return shown(o)
    },
    dropInvite: () => { pending = null },
    models: () => OWN_MODELS,
    saveModel: (m) => { if (isOwnModel(m)) prefs.saveModel(m) },
    async exportSounding(name) {
      const k = await store.get(name)
      return k ? soundingFile(name, k.events, k.wrap) : null
    },
  }
}

// The bridge the own-keys page talks through (src/ui/socket.ts): a listener
// that lives in the page, the keys it runs on, and a sounding as a file.
import type { KeyCheck, OwnBridge } from '../ui/socket'
import { wrapMaterial } from '../live/wrap-core'
import { checkClaudeKey, isOwnModel, OWN_MODELS } from './claude'
import { checkElevenKey } from './eleven-socket'
import { ownHost, type OwnDeps } from './host'
import { localSocket } from './local-socket'
import { tidyKey } from './prefs'

export interface BridgeDeps extends OwnDeps {
  /** Each asks its provider whether the key is accepted, at no cost: null when it is, else 'refused' or 'unreachable'. */
  checkClaude?: (key: string) => Promise<string | null>
  checkEleven?: (key: string) => Promise<string | null>
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
  const verdict = (r: string | null): KeyCheck => (r === null ? 'ok' : r === 'refused' ? 'refused' : 'unreachable')
  return {
    open: () => localSocket(host),
    hasKeys: () => prefs.hasKeys(),
    async saveKeys(typed) {
      // An empty box keeps the key already saved.
      const kept = prefs.keys()
      const claude = tidyKey(typed.claude) || kept.claude, eleven = tidyKey(typed.eleven) || kept.eleven
      if (!claude || !eleven) return { claude: claude ? 'ok' : 'missing', eleven: eleven ? 'ok' : 'missing', saved: false }
      const [c, e] = await Promise.all([(deps.checkClaude ?? checkClaudeKey)(claude), (deps.checkEleven ?? checkElevenKey)(eleven)])
      const result = { claude: verdict(c), eleven: verdict(e) }
      // A refused key is never kept. One that could not be checked is: the provider may only be out of reach for a moment.
      const saved = result.claude !== 'refused' && result.eleven !== 'refused'
      if (saved) prefs.saveKeys({ claude, eleven })
      return { ...result, saved }
    },
    forgetKeys: () => prefs.forgetKeys(),
    models: () => OWN_MODELS,
    saveModel: (m) => { if (isOwnModel(m)) prefs.saveModel(m) },
    async exportSounding(name) {
      const k = await store.get(name)
      return k ? soundingFile(name, k.events, k.wrap) : null
    },
  }
}

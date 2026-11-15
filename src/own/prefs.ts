// What the listener's own browser remembers between visits: the two keys, the
// model for marks, the wrap instructions and the listening language. All of it
// stays in this browser's storage for this site; nothing is sent anywhere
// except each key to its own provider when a sounding runs.
import { DEFAULT_WRAP_PROMPT } from '../live/wrap-core'
import { isLang } from '../live/langs'
import { isOwnModel, type OwnModel } from './claude'

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const K = { claude: 'sounding.own.claude-key', eleven: 'sounding.own.eleven-key', model: 'sounding.own.model', prompt: 'sounding.own.wrap-prompt', lang: 'sounding.own.lang' }

export interface Keys { claude: string; eleven: string }

/** A pasted key, tidied: whitespace and stray quotes off the ends. */
export const tidyKey = (v: string): string => v.trim().replace(/^["']+|["']+$/g, '')
/** Enough of a key to recognise it by, never the key: `sk-ant-…ab12`. */
export const keyHint = (k: string): string => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? '…' : '')

export class Prefs {
  /** `kv` is localStorage in the page. It can throw (a private window): reads then come back empty and writes are dropped. */
  constructor(private readonly kv: KV) {}
  private get(k: string): string { try { return this.kv.getItem(k) ?? '' } catch { return '' } }
  private set(k: string, v: string): void { try { if (v) this.kv.setItem(k, v); else this.kv.removeItem(k) } catch { /* nothing kept this visit */ } }

  keys(): Keys { return { claude: this.get(K.claude), eleven: this.get(K.eleven) } }
  hasKeys(): boolean { const k = this.keys(); return !!k.claude && !!k.eleven }
  saveKeys(k: Keys): void { this.set(K.claude, tidyKey(k.claude)); this.set(K.eleven, tidyKey(k.eleven)) }
  forgetKeys(): void { this.set(K.claude, ''); this.set(K.eleven, '') }

  model(): OwnModel { const m = this.get(K.model); return isOwnModel(m) ? m : 'claude-sonnet-5-5' }
  saveModel(m: OwnModel): void { this.set(K.model, m) }

  lang(): string { const l = this.get(K.lang); return isLang(l) ? l : 'auto' }
  saveLang(code: string): void { this.set(K.lang, code) }

  wrapPrompt(): { prompt: string; isDefault: boolean } {
    const saved = this.get(K.prompt).trim()
    return saved ? { prompt: saved, isDefault: false } : { prompt: DEFAULT_WRAP_PROMPT, isDefault: true }
  }
  saveWrapPrompt(text: string): void { const t = text.trim(); this.set(K.prompt, t === DEFAULT_WRAP_PROMPT.trim() ? '' : t) }
}

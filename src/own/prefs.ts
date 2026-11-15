// What the listener's own browser remembers between visits: the two keys, the
// model for marks, the wrap instructions and the listening language. All of it
// stays in this browser's storage for this site; nothing is sent anywhere
// except each key to its own provider when a sounding runs.
import { DEFAULT_WRAP_PROMPT } from '../live/wrap-core'
import { isLang } from '../live/langs'
import { isOwnModel, type OwnModel } from './claude'
import { tidyKey, type Keys, type Which } from './keys'

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const K = { claude: 'sounding.own.claude-key', eleven: 'sounding.own.eleven-key', model: 'sounding.own.model', prompt: 'sounding.own.wrap-prompt', lang: 'sounding.own.lang' }

export { tidyKey, keyHint, type Keys } from './keys'

export class Prefs {
  /** `kv` is localStorage in the page. It can throw (a private window): reads then come back empty and writes are dropped. */
  constructor(private readonly kv: KV) {}
  private get(k: string): string { try { return this.kv.getItem(k) ?? '' } catch { return '' } }
  private set(k: string, v: string): void { try { if (v) this.kv.setItem(k, v); else this.kv.removeItem(k) } catch { /* nothing kept this visit */ } }

  keys(): Keys { return { claude: this.get(K.claude), eleven: this.get(K.eleven) } }
  hasKeys(): boolean { const k = this.keys(); return !!k.claude && !!k.eleven }
  saveKeys(k: Keys): void { this.set(K.claude, tidyKey(k.claude)); this.set(K.eleven, tidyKey(k.eleven)) }
  saveKey(which: Which, key: string): void { this.set(K[which], tidyKey(key)) }
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

// The page's own words, in the language being listened for. Pure: no DOM.
// "whatever I speak" has no language of its own, so the page then follows the browser.
import { en, type WordKey } from './en'
import { zhTW } from './zh-TW'
import { zhCN } from './zh-CN'
import { ja } from './ja'

export type { WordKey }
export type Tongue = 'en' | 'zh-TW' | 'zh-CN' | 'ja'
export const TABLES: Record<Tongue, Record<WordKey, string>> = { en, 'zh-TW': zhTW, 'zh-CN': zhCN, ja }

/** The page language for a listening language; `browser` (navigator.language) decides for "auto". */
export function tongueFor(lang: string, browser = 'en'): Tongue {
  const code = (lang === 'auto' ? browser : lang).toLowerCase()
  if (code.startsWith('ja')) return 'ja'
  if (code.startsWith('zh')) return /tw|hk|mo|hant/.test(code) ? 'zh-TW' : 'zh-CN'
  return 'en'
}

let tongue: Tongue = 'en'
export const currentTongue = (): Tongue => tongue
export function setTongue(t: Tongue): boolean {
  if (t === tongue) return false
  tongue = t
  return true
}

export const isWord = (key: string): key is WordKey => key in en

/** A word or line in the current language, with `{name}` places filled in. */
export function w(key: WordKey, vars?: Record<string, string>): string {
  const text = TABLES[tongue][key] ?? en[key]
  return vars ? text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '') : text
}

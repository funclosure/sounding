// Which characters Chinese is written in, whatever language is being listened
// for: someone listening for English who drops into Mandarin still reads
// Traditional (or Simplified) characters. Small and dictionary-free, so the
// page can decide before the conversion tables (chinese-script.ts) are fetched.

export type ChineseScript = 'traditional' | 'simplified' | 'heard'
export const SCRIPTS: readonly ChineseScript[] = ['traditional', 'simplified', 'heard']
export const isScript = (v: unknown): v is ChineseScript => typeof v === 'string' && (SCRIPTS as readonly string[]).includes(v)

/** What a browser's language suggests: Traditional for Taiwan, Hong Kong and Macau, Simplified for the mainland and Singapore, otherwise as heard. */
export function scriptFromBrowser(lang: string): ChineseScript {
  const l = lang.toLowerCase()
  if (!l.startsWith('zh')) return 'heard'
  return /hant|tw|hk|mo/.test(l) ? 'traditional' : 'simplified'
}

/** The characters for a sounding: the listening language's own when it is Chinese, otherwise the preference. */
export function effectiveScript(lang: string, pref: ChineseScript): ChineseScript {
  if (lang === 'zh-TW') return 'traditional'
  if (lang === 'zh-CN') return 'simplified'
  return pref
}

/** Text worth rewriting: it has Chinese characters, and no kana (which would make it Japanese, whose kanji are left alone). */
export const isChineseText = (t: string): boolean => /\p{Script=Han}/u.test(t) && !/[぀-ヿ]/.test(t)

// Whisper hears Chinese as one language and writes it in whichever characters it likes, often a mix.
// The chosen language says which script the speaker reads, so what was heard is rewritten into it:
// character for character, never word for word, so nothing that was said is swapped for a regional synonym.
// The dictionaries are large: the server page never loads this, and the own-keys page fetches it only when Chinese is chosen.
// The same goes for Chinese heard while another language is being listened for, when the listener has said which
// characters they read (script-pref.ts). Japanese, told apart by its kana, is left as it is.
import * as OpenCC from 'opencc-js'
import { effectiveScript, isChineseText, type ChineseScript } from './script-pref'

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })

/** The rewrite into a script, or undefined for "as heard". Text with no Chinese in it, or with kana, passes unchanged. */
export function chineseRewrite(script: ChineseScript): ((text: string) => string) | undefined {
  if (script === 'heard') return undefined
  const convert = script === 'traditional' ? toTraditional : toSimplified
  return (text) => (isChineseText(text) ? convert(text) : text)
}

/** The rewrite for a listening language and a script preference, or undefined when nothing is to be rewritten. */
export function scriptFor(lang: string, pref: ChineseScript = 'heard'): ((text: string) => string) | undefined {
  return chineseRewrite(effectiveScript(lang, pref))
}

// Whisper hears Chinese as one language and writes it in whichever characters it likes, often a mix.
// The chosen language says which script the speaker reads, so what was heard is rewritten into it:
// character for character, never word for word, so nothing that was said is swapped for a regional synonym.
// Server only (the dictionaries are large); the page never loads this.
import * as OpenCC from 'opencc-js'

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })

/** The rewrite for a language code, or undefined when the language needs none. */
export function scriptFor(lang: string): ((text: string) => string) | undefined {
  if (lang === 'zh-TW') return toTraditional
  if (lang === 'zh-CN') return toSimplified
  return undefined
}

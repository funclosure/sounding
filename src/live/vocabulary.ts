// Derives a Transcribe Live custom vocabulary list from context text the
// speaker brought before talking. Pure and synchronous: never touches
// ReadingDynamics, never adds weight — spelling/labelling help only.
const MAX_ENTRIES = 50
const MAX_LEN = 40

// Legacy \b is ASCII-word-based: it fails at the edge of an accented letter
// (é, ü, …) because neither side counts as \w, and it doesn't recognise Han
// characters at all. These lookarounds use cased letters (\p{Lu}/\p{Ll} —
// upper/lowercase, i.e. Latin-style scripts) as the word-character
// definition instead of \p{L}: \p{L} would also cover Han (category \p{Lo}),
// which would block a Latin token from being extracted right up against an
// adjoining Han run (no space between them, the normal way Chinese text
// embeds an English word) — exactly the "run adjacent to Latin text is split
// at the script boundary" case this fix targets.
const NOT_CASED_LETTER_BEFORE = `(?<![\\p{Lu}\\p{Ll}])`
const NOT_CASED_LETTER_AFTER = `(?![\\p{Lu}\\p{Ll}])`

// A capitalised (title-case) word: initial capital letter (\p{Lu}), one or
// more further letters that are lowercase (\p{Ll}) — excludes bare
// single-letter words like "I" and ALLCAPS words like "TSMC" (those are
// their own category below, and never chain). Unicode letter categories
// rather than [A-Z]/[a-z] so accented Latin names (José, Zürich, Café) match
// without truncating. A run may chain further title-case words directly, or
// through exactly one of a small set of lowercase joiners (of/the/and/for/de)
// — anything else (two joiners in a row, an unlisted joiner, an ALLCAPS
// neighbour) ends the run.
const CAP_WORD = `\\p{Lu}\\p{Ll}+`
const JOINED_OR_ADJACENT = `(?:\\s+(?:of|the|and|for|de)\\s+|\\s+)${CAP_WORD}`
const CAP_RUN = `${NOT_CASED_LETTER_BEFORE}${CAP_WORD}(?:${JOINED_OR_ADJACENT})*${NOT_CASED_LETTER_AFTER}`
const CAMEL_OR_ALLCAPS = `${NOT_CASED_LETTER_BEFORE}(?:\\p{Ll}+\\p{Lu}[\\p{Lu}\\p{Ll}]*|\\p{Lu}{2,})${NOT_CASED_LETTER_AFTER}`
// A run of two or more Han (CJK ideograph) characters is a term on its own —
// Chinese text has no spaces between words, so any adjoining punctuation or
// Latin text naturally splits one run from the next (the quantifier is
// greedy and Han is its own script class, so no extra boundary is needed).
const HAN_RUN = `\\p{Script=Han}{2,}`
const QUOTED = `"([^"\\n]+)"|“([^”\\n]+)”|'([^'\\n]+)'`

const TOKEN = new RegExp(`${QUOTED}|${HAN_RUN}|${CAP_RUN}|${CAMEL_OR_ALLCAPS}`, 'gu')

export function vocabularyFrom(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(text))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? m[0]).trim()
    if (raw.length === 0 || raw.length > MAX_LEN) continue
    if (!seen.has(raw)) {
      seen.add(raw)
      out.push(raw)
      if (out.length >= MAX_ENTRIES) break
    }
  }
  return out
}

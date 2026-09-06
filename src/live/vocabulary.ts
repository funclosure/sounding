// Derives a Transcribe Live custom vocabulary list from context text the
// speaker brought before talking. Pure and synchronous: never touches
// ReadingDynamics, never adds weight — spelling/labelling help only.
const MAX_ENTRIES = 50
const MAX_LEN = 40

// A capitalised (title-case) word: initial capital, one or more lowercase
// letters — excludes bare single-letter words like "I" and ALLCAPS words
// like "TSMC" (those are their own category below, and never chain). A run
// may chain further title-case words directly, or through exactly one of a
// small set of lowercase joiners (of/the/and/for/de) — anything else (two
// joiners in a row, an unlisted joiner, an ALLCAPS neighbour) ends the run.
const CAP_WORD = `[A-Z][a-z]+`
const JOINED_OR_ADJACENT = `(?:\\s+(?:of|the|and|for|de)\\s+|\\s+)${CAP_WORD}`
const CAP_RUN = `\\b${CAP_WORD}(?:${JOINED_OR_ADJACENT})*\\b`
const CAMEL_OR_ALLCAPS = `\\b(?:[a-z]+[A-Z][a-zA-Z]*|[A-Z]{2,})\\b`
const QUOTED = `"([^"\\n]+)"|“([^”\\n]+)”|'([^'\\n]+)'`

const TOKEN = new RegExp(`${QUOTED}|${CAP_RUN}|${CAMEL_OR_ALLCAPS}`, 'g')

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

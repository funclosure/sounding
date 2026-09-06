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
// \p{N} (digit) and _ join the class too, so a token glued to a digit or
// underscore run (Web3, GPT4, snake_Case) doesn't get truncated into a
// dangling prefix/suffix (Web/GPT/Case): the boundary check now refuses to
// end (or start) a run there, which means the run fails to match *at all*
// rather than matching a truncated piece — a digit/underscore-adjacent
// token is deliberately not recognised as a term, since there is no
// substring of it that is unambiguously "the term" (Web3 could be a
// version-3 coinage; GPT4 is a whole model name, not "GPT" pinned to a
// specific model). Callers who want those spelled out for the transcriber
// should say them as a quoted phrase instead.
const NOT_CASED_LETTER_BEFORE = `(?<![\\p{Lu}\\p{Ll}\\p{N}_])`
const NOT_CASED_LETTER_AFTER = `(?![\\p{Lu}\\p{Ll}\\p{N}_])`

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
// A run ending right before an apostrophe+suffix needs to tell a genuine
// possessive ("Ray Dalio's", "Apple's", "Wells Fargo's" — keep the name,
// truncated before the 's) apart from a pronoun/auxiliary contraction
// standing alone ("Isn't", "Won't", "That's", "We'd" — not a name at all).
// The two can't be told apart by word count alone (a single capitalised
// word before 's is ambiguous either way — "Apple's" vs. "It's"/"That's"),
// so the split is on the suffix itself: 't/'re/'ve/'ll/'d/'m never follow a
// real name (they're always -n't or a pronoun contraction), so a lone
// capitalised word — never a multi-word run, where the tail is always a
// name's possessive — additionally refuses to end right before one of
// those, failing the whole match rather than yielding a stem ("Isn"). A
// lone word before 's is deliberately still accepted: possessive names
// ("Nvidia's", "Tesla's") are exactly what this vocabulary exists to catch,
// and are far more common than a capitalised 's-contraction — accepting
// the rarer false positive ("It's"/"That's" -> "It"/"That") is cheaper than
// dropping every single-word possessive name.
const NOT_CASED_LETTER_OR_CONTRACTION_AFTER = `(?![\\p{Lu}\\p{Ll}\\p{N}_]|'(?:t|re|ve|ll|d|m)(?![\\p{Lu}\\p{Ll}]))`
const CAP_RUN = `${NOT_CASED_LETTER_BEFORE}${CAP_WORD}(?:(?:${JOINED_OR_ADJACENT})+${NOT_CASED_LETTER_AFTER}|${NOT_CASED_LETTER_OR_CONTRACTION_AFTER})`
const CAMEL_OR_ALLCAPS = `${NOT_CASED_LETTER_BEFORE}(?:\\p{Ll}+\\p{Lu}[\\p{Lu}\\p{Ll}]*|\\p{Lu}{2,})${NOT_CASED_LETTER_AFTER}`
// A run of two or more Han (CJK ideograph) characters is a term on its own —
// Chinese text has no spaces between words, so any adjoining punctuation or
// Latin text naturally splits one run from the next (the quantifier is
// greedy and Han is its own script class, so no extra boundary is needed).
const HAN_RUN = `\\p{Script=Han}{2,}`
// Quotes must not be letter-adjacent (\p{L}, any script): a bare apostrophe
// used as a contraction/possessive mark ("don't", "it's", "Dalio's",
// "Isn't") always has a letter on at least one side, so it can never open
// or close a quoted phrase here — only an apostrophe used as an actual
// quotation mark (space- or punctuation-adjacent on both sides) can.
const QUOTED = `"([^"\\n]+)"|“([^”\\n]+)”|(?<!\\p{L})'([^'\\n]+)'(?!\\p{L})`

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

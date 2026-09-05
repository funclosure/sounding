// Which words to flash on screen for a pending delta: content words, in the
// form they were spoken. Uses the engine's single tokenizer so "what counts
// as a word" agrees with the fast loop.
import { normalizeToken, STOPWORDS } from '../core/text'

export function heardWords(delta: string): string[] {
  return delta
    .split(/\s+/)
    .map((raw) => ({ raw: raw.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ''), norm: normalizeToken(raw) }))
    .filter(({ raw, norm }) => raw.length > 0 && norm.length > 1 && !STOPWORDS.has(norm))
    .map(({ raw }) => raw)
}

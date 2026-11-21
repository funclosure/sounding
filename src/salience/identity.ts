import { normalizeToken } from '../core/text'
import type { Concept, ConceptCandidate } from '../core/types'

/**
 * Candidate → existing-concept-or-new. Swappable: the embedding-similarity
 * resolver implements this same interface. resolve is async because
 * embedding computation is; the token resolver resolves immediately.
 */
export interface IdentityResolver {
  resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null>
}

export function normalizeLabel(label: string): string {
  return label.split(' ').map(normalizeToken).join(' ')
}

/** A label written only in Latin letters (with digits and punctuation): the kind the English embedding model can read. */
export function isLatinLabel(label: string): boolean {
  return !/[^\p{Script=Latin}\p{M}\p{N}\p{P}\p{S}\p{Z}]/u.test(label)
}

/** A label's characters as compared: normalized, spaces dropped (APP 上線 is APP上線), and 台 read as 臺. */
function charKey(label: string): string {
  return normalizeLabel(label).replace(/\s+/g, '').replace(/台/g, '臺')
}

/**
 * Whether two labels name one topic, read by their characters: for labels the English embedding model cannot read
 * (Chinese, Japanese and the like), which it takes for unknown characters and so for one another. The same
 * characters; one label inside the other (展覽 in 看展覽, 騎車 in 臺北騎車); or, in labels of four characters or more,
 * one character that slipped (選前之夜 and 選錢之夜: a sound the transcriber wrote two ways).
 */
export function sameByCharacters(a: string, b: string): boolean {
  const x = [...charKey(a)], y = [...charKey(b)]
  if (x.length === 0 || y.length === 0) return false
  const xs = x.join(''), ys = y.join('')
  if (xs === ys) return true
  const [short, long] = x.length <= y.length ? [xs, ys] : [ys, xs]
  if ([...short].length >= 2 && long.includes(short)) return true
  return x.length === y.length && x.length >= 4 && x.filter((ch, i) => ch !== y[i]).length === 1
}

/**
 * The concept a label not written in Latin letters belongs to, by its characters: one with the very same characters
 * first, else the first whose label is close by `sameByCharacters` (compared only with labels not in Latin letters,
 * so 上線 never folds into an English "app"). Null when none is.
 */
export function resolveByCharacters(label: string, concepts: readonly Concept[]): string | null {
  const key = charKey(label)
  if (key.length === 0) return null
  let close: string | null = null
  for (const c of concepts) {
    for (const l of [c.label, ...(c.aliases ?? [])]) {
      if (charKey(l) === key) return c.id
      if (close === null && !isLatinLabel(l) && sameByCharacters(label, l)) close = c.id
    }
  }
  return close
}

export class TokenIdentityResolver implements IdentityResolver {
  async resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null> {
    if (!isLatinLabel(candidate.label)) return resolveByCharacters(candidate.label, concepts)
    const key = normalizeLabel(candidate.label)
    // a label with nothing left to compare by is not the same as another such label
    if (key.trim().length === 0) return null
    for (const c of concepts) {
      if (normalizeLabel(c.label) === key || (c.aliases ?? []).some((a) => normalizeLabel(a) === key)) return c.id
    }
    return null
  }
}

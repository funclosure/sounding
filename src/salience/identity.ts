import { normalizeToken } from '../core/text'
import type { Concept, ConceptCandidate } from '../core/types'

/**
 * Candidate → existing-concept-or-new. Swappable: the embedding-similarity
 * resolver (slice 2) implements this same interface and takes over the
 * "grief"/"mourning"/"losing her" problem. v0 does normalized-token equality
 * only, which matches what the recurrence interpreter emits.
 */
export interface IdentityResolver {
  resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): string | null
}

function normalizeLabel(label: string): string {
  return label.split(' ').map(normalizeToken).join(' ')
}

export class TokenIdentityResolver implements IdentityResolver {
  resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): string | null {
    const key = normalizeLabel(candidate.label)
    for (const c of concepts) {
      if (normalizeLabel(c.label) === key) return c.id
    }
    return null
  }
}

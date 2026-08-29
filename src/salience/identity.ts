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

export class TokenIdentityResolver implements IdentityResolver {
  async resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null> {
    const key = normalizeLabel(candidate.label)
    for (const c of concepts) {
      if (normalizeLabel(c.label) === key) return c.id
    }
    return null
  }
}

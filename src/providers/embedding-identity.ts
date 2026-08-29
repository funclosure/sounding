import { embed, dot } from './embeddings'
import { normalizeLabel, type IdentityResolver } from '../salience/identity'
import type { Concept, ConceptCandidate } from '../core/types'

/**
 * The slice-2 answer to concept identity across time: cosine similarity of
 * local sentence embeddings against every concept currently tracked. Vectors
 * are normalized, so cosine == dot.
 */
export class EmbeddingIdentityResolver implements IdentityResolver {
  private readonly conceptVecs = new Map<string, Float32Array>()

  constructor(private readonly threshold: number) {}

  async resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null> {
    const vec = await embed(normalizeLabel(candidate.label))
    let bestId: string | null = null
    let bestSim = -1
    for (const c of concepts) {
      let cv = this.conceptVecs.get(c.id)
      if (!cv) {
        cv = await embed(normalizeLabel(c.label))
        this.conceptVecs.set(c.id, cv)
      }
      const sim = dot(vec, cv)
      if (sim > bestSim) {
        bestSim = sim
        bestId = c.id
      }
    }
    return bestSim >= this.threshold ? bestId : null
  }
}

import { embed, dot } from './embeddings'
import { normalizeLabel, type IdentityResolver } from '../salience/identity'
import type { Concept, ConceptCandidate } from '../core/types'

/**
 * The slice-2 answer to concept identity across time: cosine similarity of
 * local sentence embeddings against every concept currently tracked — its
 * label and any earlier labels it was renamed from. Vectors are normalized,
 * so cosine == dot.
 */
export class EmbeddingIdentityResolver implements IdentityResolver {
  /** normalized label text -> vector. Keyed by text, not concept id, so a rename needs no invalidation. */
  private readonly vecs = new Map<string, Float32Array>()

  constructor(private readonly threshold: number) {}

  private async vecOf(label: string): Promise<Float32Array> {
    const key = normalizeLabel(label)
    let v = this.vecs.get(key)
    if (!v) {
      v = await embed(key)
      this.vecs.set(key, v)
    }
    return v
  }

  async resolve(candidate: ConceptCandidate, concepts: readonly Concept[]): Promise<string | null> {
    const vec = await embed(normalizeLabel(candidate.label))
    let bestId: string | null = null
    let bestSim = -1
    for (const c of concepts) {
      for (const label of [c.label, ...(c.aliases ?? [])]) {
        const sim = dot(vec, await this.vecOf(label))
        if (sim > bestSim) {
          bestSim = sim
          bestId = c.id
        }
      }
    }
    return bestSim >= this.threshold ? bestId : null
  }
}

import { embed, dot } from './embeddings'
import { isLatinLabel, normalizeLabel, resolveByCharacters, type IdentityResolver } from '../salience/identity'
import type { Concept, ConceptCandidate } from '../core/types'

/**
 * The slice-2 answer to concept identity across time: cosine similarity of
 * local sentence embeddings against every concept currently tracked — its
 * label and any earlier labels it was renamed from. Vectors are normalized,
 * so cosine == dot.
 *
 * The model reads English only: Chinese and other scripts come out as unknown
 * characters, so any two labels of the same length look identical to it. Those
 * labels are matched by their characters instead (`resolveByCharacters`), and
 * never compared with the model.
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
    if (!isLatinLabel(candidate.label)) return resolveByCharacters(candidate.label, concepts)
    const key = normalizeLabel(candidate.label)
    // a label with nothing left to compare by is not the same as another such label
    if (key.trim().length === 0) return null
    const vec = await embed(key)
    let bestId: string | null = null
    let bestSim = -1
    for (const c of concepts) {
      for (const label of [c.label, ...(c.aliases ?? [])]) {
        if (!isLatinLabel(label)) continue
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

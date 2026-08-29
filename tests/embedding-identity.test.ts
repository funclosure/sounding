import { describe, it, expect } from 'vitest'
import { embed, dot } from '../src/providers/embeddings'
import { EmbeddingIdentityResolver } from '../src/providers/embedding-identity'
import type { Concept, ConceptCandidate } from '../src/core/types'

function concept(id: string, label: string): Concept {
  return { id, label, weight: 1, confidence: 1, firstSeenT: 0, lastSupportT: 0 }
}
function candidate(label: string): ConceptCandidate {
  return { label, strength: 1, confidence: 1, source: 'test', segmentId: 's1' }
}

describe('embeddings', () => {
  it('is deterministic and normalized', { timeout: 180_000 }, async () => {
    const a = await embed('grief')
    const b = await embed('grief')
    expect(a).toEqual(b)
    expect(dot(a, a)).toBeCloseTo(1, 3)
  })

  it('ranks related words above unrelated ones', { timeout: 60_000 }, async () => {
    const grief = await embed('grief')
    const mourning = await embed('mourning')
    const rent = await embed('rent')
    expect(dot(grief, mourning)).toBeGreaterThan(dot(grief, rent))
  })
})

describe('EmbeddingIdentityResolver', () => {
  const resolver = new EmbeddingIdentityResolver(0.6)

  it('merges close synonyms', { timeout: 60_000 }, async () => {
    expect(await resolver.resolve(candidate('mourning'), [concept('c1', 'grief')])).toBe('c1')
  })

  it('keeps unrelated concepts separate', { timeout: 60_000 }, async () => {
    expect(await resolver.resolve(candidate('car'), [concept('c1', 'rent')])).toBeNull()
  })
})

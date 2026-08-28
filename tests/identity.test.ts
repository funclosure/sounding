import { describe, it, expect } from 'vitest'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { Concept, ConceptCandidate } from '../src/core/types'

function concept(id: string, label: string): Concept {
  return { id, label, weight: 1, confidence: 1, firstSeenT: 0, lastSupportT: 0 }
}
function candidate(label: string): ConceptCandidate {
  return { label, strength: 1, confidence: 1, source: 'test', segmentId: 's1' }
}

describe('TokenIdentityResolver', () => {
  const resolver = new TokenIdentityResolver()

  it('matches identical normalized labels', () => {
    expect(resolver.resolve(candidate('sister'), [concept('c1', 'sister')])).toBe('c1')
  })

  it('matches across plural folding', () => {
    expect(resolver.resolve(candidate('guests'), [concept('c1', 'guest')])).toBe('c1')
  })

  it('matches multi-word labels token-wise', () => {
    expect(resolver.resolve(candidate('job offers'), [concept('c1', 'job offer')])).toBe('c1')
  })

  it('returns null for unknown labels — synonymy is NOT its job', () => {
    expect(resolver.resolve(candidate('mourning'), [concept('c1', 'grief')])).toBeNull()
  })
})

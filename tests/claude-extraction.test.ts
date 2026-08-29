import { describe, it, expect } from 'vitest'
import { mapCandidates } from '../src/providers/candidates'
import { buildUserPrompt } from '../src/providers/claude-extraction'

describe('mapCandidates', () => {
  it('maps, clamps, and stamps provenance', () => {
    const out = mapCandidates(
      { candidates: [{ label: '  my sister  ', strength: 1.7, confidence: -0.2 }] },
      'src-x',
      'seg9',
    )
    expect(out).toEqual([{ label: 'my sister', strength: 1, confidence: 0, source: 'src-x', segmentId: 'seg9' }])
  })

  it('drops empty labels and caps at 8', () => {
    const many = { candidates: Array.from({ length: 12 }, (_, i) => ({ label: i === 0 ? '   ' : `c${i}`, strength: 0.5, confidence: 0.5 })) }
    const out = mapCandidates(many, 's', 'seg')
    expect(out).toHaveLength(8)
    expect(out.every((c) => c.label.length > 0)).toBe(true)
  })

  it('returns [] for malformed payloads', () => {
    expect(mapCandidates(null, 's', 'seg')).toEqual([])
    expect(mapCandidates({ candidates: 'nope' }, 's', 'seg')).toEqual([])
    expect(mapCandidates({}, 's', 'seg')).toEqual([])
  })
})

describe('buildUserPrompt', () => {
  it('separates prior context from the newest segment', () => {
    const p = buildUserPrompt(['old one', 'old two', 'the new segment'])
    expect(p).toContain('old one\nold two')
    expect(p).toContain('Newest segment')
    expect(p.indexOf('the new segment')).toBeGreaterThan(p.indexOf('Newest segment'))
  })
})

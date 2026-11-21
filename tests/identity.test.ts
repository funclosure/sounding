import { describe, it, expect } from 'vitest'
import { TokenIdentityResolver, sameByCharacters } from '../src/salience/identity'
import type { Concept, ConceptCandidate } from '../src/core/types'

function concept(id: string, label: string): Concept {
  return { id, label, weight: 1, confidence: 1, firstSeenT: 0, lastSupportT: 0 }
}
function candidate(label: string): ConceptCandidate {
  return { label, strength: 1, confidence: 1, source: 'test', segmentId: 's1' }
}

describe('TokenIdentityResolver', () => {
  const resolver = new TokenIdentityResolver()

  it('matches identical normalized labels', async () => {
    expect(await resolver.resolve(candidate('sister'), [concept('c1', 'sister')])).toBe('c1')
  })

  it('matches across plural folding', async () => {
    expect(await resolver.resolve(candidate('guests'), [concept('c1', 'guest')])).toBe('c1')
  })

  it('matches multi-word labels token-wise', async () => {
    expect(await resolver.resolve(candidate('job offers'), [concept('c1', 'job offer')])).toBe('c1')
  })

  it('returns null for unknown labels — synonymy is NOT its job', async () => {
    expect(await resolver.resolve(candidate('mourning'), [concept('c1', 'grief')])).toBeNull()
  })
})

describe('Chinese labels', () => {
  const resolver = new TokenIdentityResolver()

  it('keeps different topics apart (they all used to fold into the first)', async () => {
    const seen = [concept('c1', '展覽')]
    for (const label of ['投票', '騎車', '音樂會', '書店', '網路連線']) expect(await resolver.resolve(candidate(label), seen)).toBeNull()
  })

  it('folds a label into one it contains or that contains it', async () => {
    expect(await resolver.resolve(candidate('看展覽'), [concept('c1', '展覽')])).toBe('c1')
    expect(await resolver.resolve(candidate('騎車'), [concept('c1', '臺北騎車')])).toBe('c1')
  })

  it('folds a one-character slip in a longer label, but not in a short one', async () => {
    expect(await resolver.resolve(candidate('選錢之夜'), [concept('c1', '選前之夜')])).toBe('c1')
    expect(await resolver.resolve(candidate('投資'), [concept('c1', '投票')])).toBeNull()
    expect(await resolver.resolve(candidate('音樂節'), [concept('c1', '音樂會')])).toBeNull()
  })

  it('keeps labels sharing only a prefix apart', async () => {
    expect(await resolver.resolve(candidate('學習地圖'), [concept('c1', '學習網站')])).toBeNull()
  })

  it('reads 台 as 臺, and ignores spaces between Latin and Chinese', async () => {
    expect(await resolver.resolve(candidate('台北'), [concept('c1', '臺北')])).toBe('c1')
    expect(await resolver.resolve(candidate('APP 上線'), [concept('c1', 'APP上線')])).toBe('c1')
  })

  it('prefers the very same label over a close one', async () => {
    expect(await resolver.resolve(candidate('騎車'), [concept('c1', '臺北騎車'), concept('c2', '騎車')])).toBe('c2')
  })

  it('never folds a Chinese label into an English one by its letters', async () => {
    expect(await resolver.resolve(candidate('APP上線'), [concept('c1', 'app')])).toBeNull()
  })
})

describe('sameByCharacters', () => {
  it('is false when either label is empty', () => {
    expect(sameByCharacters('', '')).toBe(false)
    expect(sameByCharacters('…', '展覽')).toBe(false)
  })
  it('is symmetric', () => {
    for (const [a, b] of [['展覽', '看展覽'], ['選前之夜', '選錢之夜'], ['學習網站', '學習地圖']]) expect(sameByCharacters(a, b)).toBe(sameByCharacters(b, a))
  })
})

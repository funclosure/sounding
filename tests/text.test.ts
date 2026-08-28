import { describe, it, expect } from 'vitest'
import { normalizeToken, tokenize } from '../src/core/text'

describe('normalizeToken', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeToken('Sister,')).toBe('sister')
    expect(normalizeToken("don't")).toBe('dont')
  })
  it('folds simple plurals but not -ss words', () => {
    expect(normalizeToken('guests')).toBe('guest')
    expect(normalizeToken('loss')).toBe('loss')
    expect(normalizeToken('gas')).toBe('gas') // length 3: too short to fold
  })
})

describe('tokenize', () => {
  it('drops stopwords and short tokens', () => {
    expect(tokenize('I keep thinking about my sister')).toEqual(['keep', 'thinking', 'sister'])
  })
  it('returns empty for pure-stopword text', () => {
    expect(tokenize('and then I was like')).toEqual([])
  })
})

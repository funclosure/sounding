import { describe, it, expect } from 'vitest'
import { heardWords } from '../src/live/heard-words'

describe('heardWords', () => {
  it('keeps content words in their spoken form and drops stopwords', () => {
    expect(heardWords("I think Ray Dalio is the good reference")).toEqual(['Ray', 'Dalio', 'good', 'reference'])
  })
  it('strips punctuation and ignores fragments', () => {
    // 'let' is not in STOPWORDS (src/core/text.ts), so it survives as a content
    // word alongside 'talk'; only the stopwords and the trailing-punctuation
    // 'one.' are dropped.
    expect(heardWords('Okay, let me talk to you about one.')).toEqual(['let', 'talk'])
  })
  it('returns nothing for empty or all-stopword input', () => {
    expect(heardWords('')).toEqual([])
    expect(heardWords('so I just')).toEqual([])
  })
})

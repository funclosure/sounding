import { describe, it, expect } from 'vitest'
import { captionWindow, captionInk } from '../src/ui/board/heard'

describe('captionWindow', () => {
  it('keeps a short utterance whole', () => {
    expect(captionWindow('comparing myself to my sister')).toEqual({ start: 0, words: ['comparing', 'myself', 'to', 'my', 'sister'] })
    expect(captionWindow('  ')).toEqual({ start: 0, words: [] })
  })
  it('keeps only the last words of a long one, and says where they start', () => {
    const w = captionWindow('one two three four five six seven eight nine ten eleven', 4)
    expect(w).toEqual({ start: 7, words: ['eight', 'nine', 'ten', 'eleven'] })
  })
  it('keeps fewer words when they would run past the line, but always the newest', () => {
    expect(captionWindow('alpha bravo charlie delta', 9, 14)).toEqual({ start: 2, words: ['charlie', 'delta'] })
    expect(captionWindow('a incomprehensibilities', 9, 10)).toEqual({ start: 1, words: ['incomprehensibilities'] })
  })
})

describe('captionInk', () => {
  it('inks the newest words fully and thins the older ones, never to nothing', () => {
    expect(captionInk(0)).toBe(0.95)
    expect(captionInk(3)).toBe(0.95)
    expect(captionInk(5)).toBeLessThan(captionInk(4))
    expect(captionInk(40)).toBe(0.12)
  })
})

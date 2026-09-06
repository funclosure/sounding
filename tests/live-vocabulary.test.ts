import { describe, it, expect } from 'vitest'
import { vocabularyFrom } from '../src/live/vocabulary'

describe('vocabularyFrom', () => {
  it('extracts capitalised runs, a quoted phrase, and an ALLCAPS token, in order, sentence-initial word included', () => {
    const text = "Today I talked to the people from Apple about Trust Wallet and the App Store. 'Sounding' is my app; TSMC and Nvidia."
    expect(vocabularyFrom(text)).toEqual(['Today', 'Apple', 'Trust Wallet', 'App Store', 'Sounding', 'TSMC', 'Nvidia'])
  })

  it('allows inner of/the/and/for/de to join a single capitalised run', () => {
    expect(vocabularyFrom('Bank of America and the Museum of Modern Art')).toEqual(['Bank of America', 'Museum of Modern Art'])
  })

  it('extracts quoted phrases in all three quote styles', () => {
    const text = `"Foo Bar" and 'Baz Qux' and “Zed Yak”`
    expect(vocabularyFrom(text)).toEqual(['Foo Bar', 'Baz Qux', 'Zed Yak'])
  })

  it('extracts CamelCase and ALLCAPS tokens', () => {
    expect(vocabularyFrom('I love my iPhone and NASA rockets')).toEqual(['iPhone', 'NASA'])
  })

  it('excludes single-letter capitalised words', () => {
    expect(vocabularyFrom('Today I went out')).toEqual(['Today'])
  })

  it('dedupes case-sensitively, keeping first-appearance order', () => {
    expect(vocabularyFrom('Apple, Apple, APPLE')).toEqual(['Apple', 'APPLE'])
  })

  it('caps at 50 entries', () => {
    const suffix = (i: number) => String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26))
    const words = Array.from({ length: 60 }, (_, i) => 'Word' + suffix(i))
    expect(vocabularyFrom(words.join(', '))).toEqual(words.slice(0, 50))
  })

  it('drops entries longer than 40 characters', () => {
    const long = 'A' + 'a'.repeat(40) // 41 chars total
    const result = vocabularyFrom(`Short, ${long}, End`)
    expect(result).toEqual(['Short', 'End'])
    expect(result.every((w) => w.length <= 40)).toBe(true)
  })

  it('returns an empty array for empty or non-matching text', () => {
    expect(vocabularyFrom('')).toEqual([])
    expect(vocabularyFrom('nothing to see here, all lowercase.')).toEqual([])
  })

  it('matches CJK runs and accented Latin names without corrupting them', () => {
    expect(vocabularyFrom('I met 王小明 and José García at Zürich')).toEqual(['王小明', 'José García', 'Zürich'])
  })

  it('matches accented capitalised runs', () => {
    expect(vocabularyFrom('Müller runs Café Zoë')).toEqual(['Müller', 'Café Zoë'])
  })

  it('treats punctuation as splitting adjoining Han runs, alongside a Latin token', () => {
    const text = '我在做 Sounding 这个应用，和我太太讨论投资'
    expect(vocabularyFrom(text)).toEqual(['我在做', 'Sounding', '这个应用', '和我太太讨论投资'])
  })

  it('splits a Latin token from an adjoining Han run at the script boundary even with no space', () => {
    expect(vocabularyFrom('我在做Sounding这个应用')).toEqual(['我在做', 'Sounding', '这个应用'])
  })
})

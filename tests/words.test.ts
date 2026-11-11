import { describe, it, expect, afterEach } from 'vitest'
import { TABLES, tongueFor, setTongue, w, isWord } from '../src/ui/words'
import { en } from '../src/ui/words/en'
import { scriptFor } from '../src/live/chinese-script'
import { setupLines } from '../src/ui/setup'

afterEach(() => { setTongue('en') })

describe('the page\'s own words', () => {
  it('every language says every line, and keeps the same places to fill in', () => {
    const places = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
    for (const [name, table] of Object.entries(TABLES)) {
      expect(Object.keys(table).sort(), name).toEqual(Object.keys(en).sort())
      for (const k of Object.keys(en) as Array<keyof typeof en>) {
        expect(table[k].trim().length, `${name} ${k}`).toBeGreaterThan(0)
        expect(places(table[k]), `${name} ${k}`).toBe(places(en[k]))
      }
    }
  })

  it('simplified is traditional, character for character', () => {
    const s = scriptFor('zh-CN')!
    for (const k of Object.keys(en) as Array<keyof typeof en>) expect(TABLES['zh-CN'][k], k).toBe(s(TABLES['zh-TW'][k]))
  })

  it('follows the language being listened for, and the browser when that is "whatever I speak"', () => {
    expect(tongueFor('en-US')).toBe('en')
    expect(tongueFor('zh-TW')).toBe('zh-TW')
    expect(tongueFor('zh-CN')).toBe('zh-CN')
    expect(tongueFor('ja-JP')).toBe('ja')
    expect(tongueFor('fr-FR')).toBe('en')
    expect(tongueFor('auto', 'zh-Hant-TW')).toBe('zh-TW')
    expect(tongueFor('auto', 'zh-CN')).toBe('zh-CN')
    expect(tongueFor('auto', 'ja')).toBe('ja')
    expect(tongueFor('auto', 'de-DE')).toBe('en')
  })

  it('fills in places and changes with the language', () => {
    expect(w('state.from', { when: '3 Nov' })).toBe('from 3 Nov')
    expect(setTongue('zh-TW')).toBe(true)
    expect(setTongue('zh-TW')).toBe(false)
    expect(w('state.ready')).toBe('就緒')
    expect(w('state.from', { when: '11/3' })).toBe('來自 11/3')
    expect(isWord('state.ready')).toBe(true)
    expect(isWord('state.nope')).toBe(false)
  })

  it('the setup sheet speaks it too', () => {
    setTongue('ja')
    const lines = Object.fromEntries(setupLines({ transcriber: 'whisper', hearsModel: 'large-v3-turbo', interpreter: 'claude-sub', thinksModel: 'claude-sonnet-5-5', lang: 'ja-JP', api: false, ownInstructions: false, instructions: 'x' }))
    expect(lines['聞き取り']).toContain('Whisper (large-v3-turbo)')
    expect(lines['言語']).toBe('日本語')
    expect(lines['有料 API']).toContain('オフ')
  })
})

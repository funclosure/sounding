import { describe, it, expect } from 'vitest'
import { LENSES, carryContext, matchCarried, soundingNote } from '../src/ui/after'

describe('the readings', () => {
  it('start with the plain one, which has no instruction of its own, and give every other one an instruction within the server limit', () => {
    expect(LENSES[0]).toMatchObject({ key: 'heard', prompt: '' })
    for (const l of LENSES.slice(1)) { expect(l.prompt.trim().length).toBeGreaterThan(20); expect(l.prompt.length).toBeLessThanOrEqual(2000) }
    expect(new Set(LENSES.map((l) => l.key)).size).toBe(LENSES.length)
  })
})

describe('carryContext', () => {
  it('puts the question first, then the marks, the wrap and what the speaker had brought', () => {
    const text = carryContext({ marks: ['sister', 'stalling'], wrap: 'You kept coming back to her.', question: 'What would you sign for?', brought: 'Denver.' })
    expect(text.indexOf('What would you sign for?')).toBeLessThan(text.indexOf('- sister'))
    expect(text.indexOf('- stalling')).toBeLessThan(text.indexOf('You kept coming back'))
    expect(text.endsWith('Denver.')).toBe(true)
  })
  it('leaves out what is missing and never passes the server limit', () => {
    expect(carryContext({ marks: ['sister'] })).toBe('What stood out in my last sounding:\n- sister')
    expect(carryContext({ marks: [], wrap: 'x'.repeat(9000) }).length).toBe(4000)
  })
})

describe('matchCarried', () => {
  const carried = ['offer letter', 'sister', 'stalling', 'not signing yet']
  it('finds the same words in any case, one phrase inside another, or a shared long word', () => {
    expect(matchCarried('Sister', carried)).toBe(1)
    expect(matchCarried('my sister', carried)).toBe(1)
    expect(matchCarried('stalling again', carried)).toBe(2)
    expect(matchCarried('the letter itself', carried)).toBe(0)
  })
  it('leaves a new thing alone, and skips a carried mark already returned to', () => {
    expect(matchCarried('Denver', carried)).toBe(-1)
    expect(matchCarried('yet', ['x', 'not signing yet'])).toBe(1)
    expect(matchCarried('sister', ['offer letter', '', 'stalling'])).toBe(-1)
    expect(matchCarried('', carried)).toBe(-1)
  })
})

describe('soundingNote', () => {
  it('is a title, the marks as a list, then the wrap', () => {
    expect(soundingNote({ title: 'Sounding · 10 Nov 2026 · 0:39', marks: ['sister', 'stalling'], wrap: 'You kept coming back.\n- She said it.' }))
      .toBe('# Sounding · 10 Nov 2026 · 0:39\n\n- sister\n- stalling\n\nYou kept coming back.\n- She said it.\n')
  })
})

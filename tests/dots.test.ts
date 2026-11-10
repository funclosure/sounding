import { describe, it, expect } from 'vitest'
import { band, boxCeiling, clearingCeiling, prominenceFromFontPx, BOX_CLEAR, CLEAR_X, CLEAR_Y } from '../src/ui/board/dots'

describe('clearingCeiling', () => {
  const halfW = 40, halfH = 12
  it('allows no dot behind the word or just around it', () => {
    expect(clearingCeiling(0, 0, halfW, halfH)).toBe(0)
    expect(clearingCeiling(halfW, halfH, halfW, halfH)).toBe(0)
    expect(clearingCeiling(-(halfW + 20), 0, halfW, halfH)).toBe(0)
  })
  it('rises toward the edge and puts no limit beyond it', () => {
    const y = halfH + CLEAR_Y
    const inner = clearingCeiling(0, y * 0.7, halfW, halfH)
    const outer = clearingCeiling(0, y * 0.9, halfW, halfH)
    expect(inner).toBeGreaterThan(0)
    expect(outer).toBeGreaterThan(inner)
    expect(clearingCeiling(0, y + 1, halfW, halfH)).toBe(Infinity)
    expect(clearingCeiling(halfW + CLEAR_X + 1, 0, halfW, halfH)).toBe(Infinity)
  })
  it('is symmetric about the label', () => {
    expect(clearingCeiling(70, 30, halfW, halfH)).toBe(clearingCeiling(-70, -30, halfW, halfH))
  })
})

describe('prominenceFromFontPx', () => {
  it('inverts the board sizing (15px + p × 62, p capped at 0.5)', () => {
    expect(prominenceFromFontPx(15)).toBe(0)
    expect(prominenceFromFontPx(15 + 0.25 * 62)).toBeCloseTo(0.25)
    expect(prominenceFromFontPx(60)).toBe(0.5)
    expect(prominenceFromFontPx(10)).toBe(0)
  })
})

describe('band', () => {
  it('stays within 0..0.34 and moves with time', () => {
    let moved = false
    for (let i = 0; i < 400; i++) {
      const x = (i * 37) % 1400, y = (i * 91) % 900
      const v = band(x, y, i * 0.1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0.34)
      if (Math.abs(v - band(x, y, i * 0.1 + 3)) > 0.01) moved = true
    }
    expect(moved).toBe(true)
  })
})

describe('boxCeiling', () => {
  const halfW = 240, halfH = 110
  it('allows no dot behind a block of text or right against it', () => {
    expect(boxCeiling(0, 0, halfW, halfH)).toBe(0)
    expect(boxCeiling(halfW, -halfH, halfW, halfH)).toBe(0)
    expect(boxCeiling(halfW + 6, 0, halfW, halfH)).toBe(0)
  })
  it('rises with distance from the edge and puts no limit beyond its reach', () => {
    const near = boxCeiling(0, halfH + 20, halfW, halfH)
    const far = boxCeiling(0, halfH + 45, halfW, halfH)
    expect(near).toBeGreaterThan(0)
    expect(far).toBeGreaterThan(near)
    expect(boxCeiling(0, halfH + BOX_CLEAR, halfW, halfH)).toBe(Infinity)
    expect(boxCeiling(halfW + BOX_CLEAR + 1, halfH + BOX_CLEAR + 1, halfW, halfH)).toBe(Infinity)
  })
})

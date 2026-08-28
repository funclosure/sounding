import { describe, it, expect } from 'vitest'
import { hashString, layoutReading } from '../src/ui/layout'
import type { Reading } from '../src/core/types'

function reading(marks: Array<[string, number]>): Reading {
  const total = marks.reduce((s, [, w]) => s + w, 0) || 1
  return {
    t: 1000, slack: false,
    marks: marks.map(([label, w], i) => ({
      conceptId: `c${i + 1}`, label, prominence: w / total, weight: w,
    })),
  }
}

describe('hashString', () => {
  it('is deterministic and spreads values', () => {
    expect(hashString('sister')).toBe(hashString('sister'))
    expect(hashString('sister')).not.toBe(hashString('offer'))
  })
})

describe('layoutReading', () => {
  const W = 1200, H = 800

  it('is deterministic', () => {
    const r = reading([['sister', 2], ['offer', 1], ['salary', 0.5]])
    expect(layoutReading(r, W, H)).toEqual(layoutReading(r, W, H))
  })

  it('radius increases with prominence', () => {
    const placed = layoutReading(reading([['big', 4], ['small', 1]]), W, H)
    const big = placed.find((p) => p.label === 'big')!
    const small = placed.find((p) => p.label === 'small')!
    expect(big.r).toBeGreaterThan(small.r)
  })

  it('keeps marks inside the viewport', () => {
    const placed = layoutReading(reading([['a1', 1], ['b2', 1], ['c3', 1], ['d4', 1], ['e5', 1], ['f6', 1], ['g7', 1]]), W, H)
    for (const p of placed) {
      expect(p.x - p.r).toBeGreaterThanOrEqual(0)
      expect(p.x + p.r).toBeLessThanOrEqual(W)
      expect(p.y - p.r).toBeGreaterThanOrEqual(0)
      expect(p.y + p.r).toBeLessThanOrEqual(H)
    }
  })

  it('pushes overlapping marks apart', () => {
    const placed = layoutReading(reading([['a1', 1], ['b2', 1], ['c3', 1], ['d4', 1], ['e5', 1], ['f6', 1], ['g7', 1]]), W, H)
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        expect(dist).toBeGreaterThanOrEqual((a.r + b.r) * 0.5)
      }
    }
  })

  it('a concept keeps its position as its size changes', () => {
    const before = layoutReading(reading([['sister', 1]]), W, H)[0]
    const after = layoutReading(reading([['sister', 3]]), W, H)[0]
    expect(after.x).toBeCloseTo(before.x, 5)
    expect(after.y).toBeCloseTo(before.y, 5)
  })
})

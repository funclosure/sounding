import { describe, it, expect } from 'vitest'
import { SlotLayout, separate } from '../src/ui/board/layout'
import type { Placed } from '../src/ui/board/layout'

describe('SlotLayout', () => {
  it('assigns slots in first-seen order and keeps them stable per id', () => {
    const layout = new SlotLayout()
    expect(layout.slotFor('a')).toBe(0)
    expect(layout.slotFor('b')).toBe(1)
    expect(layout.slotFor('a')).toBe(0)
    expect(layout.slotFor('c')).toBe(2)
    expect(layout.slotFor('b')).toBe(1)
  })

  it('positions a 366x604 box with half-width 120 inside [half+10, w-half-10] x [28, h-28]', () => {
    const layout = new SlotLayout()
    const box = { width: 366, height: 604 }
    const half = 120
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const { x, y } = layout.position(id, box, half)
      expect(x).toBeGreaterThanOrEqual(half + 10)
      expect(x).toBeLessThanOrEqual(box.width - half - 10)
      expect(y).toBeGreaterThanOrEqual(28)
      expect(y).toBeLessThanOrEqual(box.height - 28)
    }
  })

  it('clamps a half-width larger than w*0.45 to w*0.45 (the single clamp)', () => {
    const layout = new SlotLayout()
    const box = { width: 400, height: 600 }
    // half-width 500 exceeds w*0.45 (180); position() must clamp it there
    // itself — board.ts now passes the raw, unclamped half-width.
    const half = 500
    const clamped = box.width * 0.45
    const { x } = layout.position('a', box, half)
    expect(x).toBeGreaterThanOrEqual(clamped + 10)
    expect(x).toBeLessThanOrEqual(box.width - clamped - 10)
  })

  it('reset() clears slots so ids are reassigned from 0', () => {
    const layout = new SlotLayout()
    layout.slotFor('a')
    layout.slotFor('b')
    layout.reset()
    expect(layout.slotFor('b')).toBe(0)
    expect(layout.slotFor('a')).toBe(1)
  })
})

/** True if two boxes (centered on x/y, half-extents halfW/halfH) overlap at all. */
function overlaps(a: Placed, b: Placed): boolean {
  return Math.abs(b.x - a.x) < a.halfW + b.halfW && Math.abs(b.y - a.y) < a.halfH + b.halfH
}

function inBounds(p: Placed, box: { width: number; height: number }): boolean {
  return (
    p.x >= p.halfW + 10 &&
    p.x <= box.width - p.halfW - 10 &&
    p.y >= 28 &&
    p.y <= box.height - 28
  )
}

describe('separate', () => {
  it('pushes an overlapping horizontal pair apart and keeps both inside the box', () => {
    const box = { width: 400, height: 600 }
    const items: Placed[] = [
      { id: 'a', x: 200, y: 300, halfW: 60, halfH: 20 },
      { id: 'b', x: 220, y: 300, halfW: 60, halfH: 20 },
    ]
    expect(overlaps(items[0], items[1])).toBe(true)
    const out = separate(items, box)
    const [a, b] = out
    expect(overlaps(a, b)).toBe(false)
    expect(inBounds(a, box)).toBe(true)
    expect(inBounds(b, box)).toBe(true)
  })

  it('leaves an item that starts clear of every other item unmoved', () => {
    const box = { width: 400, height: 600 }
    const items: Placed[] = [
      { id: 'a', x: 200, y: 300, halfW: 60, halfH: 20 },
      { id: 'b', x: 220, y: 300, halfW: 60, halfH: 20 },
      { id: 'c', x: 350, y: 560, halfW: 20, halfH: 20 },
    ]
    const out = separate(items, box)
    const c = out.find((p) => p.id === 'c')!
    // c's own coordinates must be untouched, even though a/b moved.
    expect(c.x).toBeCloseTo(350, 5)
    expect(c.y).toBeCloseTo(560, 5)
  })

  it('separates a tight four-item cluster to be pairwise clear within the default 6 iterations', () => {
    const box = { width: 400, height: 600 }
    const items: Placed[] = [
      { id: 'a', x: 200, y: 300, halfW: 30, halfH: 15 },
      { id: 'b', x: 202, y: 301, halfW: 30, halfH: 15 },
      { id: 'c', x: 198, y: 299, halfW: 30, halfH: 15 },
      { id: 'd', x: 201, y: 298, halfW: 30, halfH: 15 },
    ]
    const out = separate(items, box)
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i], out[j])).toBe(false)
      }
    }
  })

  it('never lets an item leave [halfW+10, w-halfW-10] x [28, h-28]', () => {
    // a/b start valid but overlapping right at the left wall — pushing them
    // apart the naive amount would carry `a` past the wall without a clamp.
    const box = { width: 300, height: 400 }
    const items: Placed[] = [
      { id: 'a', x: 65, y: 35, halfW: 50, halfH: 25 },
      { id: 'b', x: 90, y: 40, halfW: 50, halfH: 25 },
      { id: 'c', x: 235, y: 365, halfW: 50, halfH: 25 },
    ]
    expect(items.every((p) => inBounds(p, box))).toBe(true)
    const out = separate(items, box)
    for (const p of out) {
      expect(inBounds(p, box)).toBe(true)
    }
  })

  it('is deterministic: the same input always separates to the same output', () => {
    const box = { width: 400, height: 600 }
    const items: Placed[] = [
      { id: 'a', x: 200, y: 300, halfW: 30, halfH: 15 },
      { id: 'b', x: 202, y: 301, halfW: 30, halfH: 15 },
      { id: 'c', x: 198, y: 299, halfW: 30, halfH: 15 },
      { id: 'd', x: 201, y: 298, halfW: 30, halfH: 15 },
    ]
    expect(separate(items, box)).toEqual(separate(items, box))
  })
})

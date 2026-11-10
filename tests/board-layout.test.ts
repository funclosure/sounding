import { describe, it, expect } from 'vitest'
import { SlotLayout, separate, columnOrder, columnFontPx } from '../src/ui/board/layout'
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

  it('separates two items with exactly coincident centres without producing NaN', () => {
    const box = { width: 400, height: 600 }
    const items: Placed[] = [
      { id: 'a', x: 200, y: 300, halfW: 40, halfH: 20 },
      { id: 'b', x: 200, y: 300, halfW: 40, halfH: 20 },
    ]
    const out = separate(items, box)
    for (const p of out) {
      expect(Number.isNaN(p.x)).toBe(false)
      expect(Number.isNaN(p.y)).toBe(false)
    }
    expect(overlaps(out[0], out[1])).toBe(false)
    expect(out.every((p) => inBounds(p, box))).toBe(true)
  })

  it('returns every item unmoved (identical) when the whole layout starts pairwise clear', () => {
    const box = { width: 400, height: 600 }
    const items: Placed[] = [
      { id: 'a', x: 80, y: 100, halfW: 30, halfH: 15 },
      { id: 'b', x: 200, y: 300, halfW: 30, halfH: 15 },
      { id: 'c', x: 320, y: 500, halfW: 30, halfH: 15 },
    ]
    const out = separate(items, box)
    expect(out).toEqual(items)
  })

  it('separates a mixed-size pair (a large box overlapping a small one)', () => {
    const box = { width: 400, height: 600 }
    const items: Placed[] = [
      { id: 'big', x: 200, y: 300, halfW: 90, halfH: 40 },
      { id: 'small', x: 230, y: 305, halfW: 15, halfH: 10 },
    ]
    expect(overlaps(items[0], items[1])).toBe(true)
    const out = separate(items, box)
    const big = out.find((p) => p.id === 'big')!
    const small = out.find((p) => p.id === 'small')!
    expect(overlaps(big, small)).toBe(false)
    expect(inBounds(big, box)).toBe(true)
    expect(inBounds(small, box)).toBe(true)
  })

  it('resolves a pair overlapping right at the wall to pairwise-clear when the field has room', () => {
    // Both boxes start pinned at/near the left wall, overlapping each other —
    // clamping to stay in-bounds competes with pushing apart. The field is
    // big enough here for both constraints to be satisfied at once.
    const box = { width: 300, height: 400 }
    const items: Placed[] = [
      { id: 'a', x: 60, y: 200, halfW: 50, halfH: 25 },
      { id: 'b', x: 65, y: 202, halfW: 50, halfH: 25 },
    ]
    expect(overlaps(items[0], items[1])).toBe(true)
    const out = separate(items, box)
    const [a, b] = out
    expect(inBounds(a, box)).toBe(true)
    expect(inBounds(b, box)).toBe(true)
    expect(overlaps(a, b)).toBe(false)
  })

  it('documents the accepted outcome when a wall clamp leaves no room to fully separate', () => {
    // A 100x100 box with two 80x80 marks: `clampX` collapses both centres to
    // the single valid x (50 — half-width 40 exceeds w*0.45, and the
    // resulting [half+10, w-half-10] band is a single point), and `clampY`'s
    // [28, 72] band (44px) is narrower than the 86px the pair would need to
    // fully clear each other vertically. Every iteration's push is undone by
    // the very clamp that keeps both boxes on-screen, so a residual overlap
    // is the correctly-documented outcome here, not a bug — `inBounds` still
    // holds throughout.
    const box = { width: 100, height: 100 }
    const items: Placed[] = [
      { id: 'a', x: 50, y: 50, halfW: 40, halfH: 40 },
      { id: 'b', x: 50, y: 52, halfW: 40, halfH: 40 },
    ]
    expect(overlaps(items[0], items[1])).toBe(true)
    const out = separate(items, box)
    const [a, b] = out
    expect(inBounds(a, box)).toBe(true)
    expect(inBounds(b, box)).toBe(true)
    expect(overlaps(a, b)).toBe(true)
    expect(a).toEqual({ id: 'a', x: 50, y: 28, halfW: 40, halfH: 40 })
    expect(b).toEqual({ id: 'b', x: 50, y: 72, halfW: 40, halfH: 40 })
  })
})

describe('the gathered column', () => {
  it('ranks strongest first and keeps the given order between equals', () => {
    const marks = [{ id: 'a', p: 0.2 }, { id: 'b', p: 0.4 }, { id: 'c', p: 0.2 }, { id: 'd', p: 0.05 }]
    expect(columnOrder(marks).map((m) => m.id)).toEqual(['b', 'a', 'c', 'd'])
    expect(marks.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('draws the sizes in: 15px at nothing, 34px from half the board up', () => {
    expect(columnFontPx(0)).toBe(15)
    expect(columnFontPx(0.25)).toBe(25)
    expect(columnFontPx(0.5)).toBe(34)
    expect(columnFontPx(0.9)).toBe(34)
    expect(columnFontPx(0, true)).toBe(14)
    expect(columnFontPx(0.5, true)).toBe(28)
  })
})

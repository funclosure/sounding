import { describe, it, expect } from 'vitest'
import { SlotLayout } from '../src/ui/board/layout'

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

  it('reset() clears slots so ids are reassigned from 0', () => {
    const layout = new SlotLayout()
    layout.slotFor('a')
    layout.slotFor('b')
    layout.reset()
    expect(layout.slotFor('b')).toBe(0)
    expect(layout.slotFor('a')).toBe(1)
  })
})

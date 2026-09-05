/** The board's viewport (px). No DOM: the caller measures and passes width/height. */
export interface Box {
  width: number
  height: number
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * Stable positions: a sunflower spiral, one slot per concept in order of
 * first appearance. Ported from the prototype's `slotFor`/`positionFor`
 * (docs/design/sounding-phone.template.html). Pure — the caller measures
 * the label's rendered half-width and passes it in.
 */
export class SlotLayout {
  private slots = new Map<string, number>()

  /** The slot index for `id`, assigning the next free one on first sight. */
  slotFor(id: string): number {
    let n = this.slots.get(id)
    if (n === undefined) {
      n = this.slots.size
      this.slots.set(id, n)
    }
    return n
  }

  /** Position for `id` within `box`, keeping the label's edge clear of the walls. */
  position(id: string, box: Box, labelHalfWidth: number): { x: number; y: number } {
    const n = this.slotFor(id)
    const { width: w, height: h } = box
    const r = Math.sqrt((n + 0.6) / 9)
    const a = n * GOLDEN_ANGLE + 0.9
    let x = (0.5 + 0.34 * Math.min(r, 1) * Math.cos(a)) * w
    let y = (0.5 + 0.38 * Math.min(r, 1) * Math.sin(a)) * h
    const half = Math.min(w * 0.45, labelHalfWidth)
    x = Math.max(half + 10, Math.min(w - half - 10, x))
    y = Math.max(28, Math.min(h - 28, y))
    return { x, y }
  }

  /** Forget every slot (a fresh sounding starts the spiral over). */
  reset(): void {
    this.slots.clear()
  }
}

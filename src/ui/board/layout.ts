/** The board's viewport (px). No DOM: the caller measures and passes width/height. */
export interface Box {
  width: number
  height: number
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/** Clamp `x` so a box of half-width `halfW` stays clear of the field's side walls. */
function clampX(x: number, halfW: number, w: number): number {
  const half = Math.min(w * 0.45, halfW)
  return Math.max(half + 10, Math.min(w - half - 10, x))
}

/** Clamp `y` so a box stays clear of the field's top/bottom walls. */
function clampY(y: number, h: number): number {
  return Math.max(28, Math.min(h - 28, y))
}

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
    x = clampX(x, labelHalfWidth, w)
    y = clampY(y, h)
    return { x, y }
  }

  /** Forget every slot (a fresh sounding starts the spiral over). */
  reset(): void {
    this.slots.clear()
  }
}

/** A positioned box: center `x`/`y` plus half-extents, keyed by mark id. */
export interface Placed {
  id: string
  x: number
  y: number
  halfW: number
  halfH: number
}

/**
 * Push overlapping boxes apart along the axis of least overlap, a few
 * iterations; keeps everything inside the box. Pure and deterministic: no
 * randomness, and ties (equal overlap, or coincident centers) resolve the
 * same way every time. Ghosts participate like any other item — callers
 * pass every live mark, real or ghost.
 */
export function separate(items: Placed[], box: Box, iterations = 6, pad = 6): Placed[] {
  const out = items.map((p) => ({ ...p }))
  const { width: w, height: h } = box

  const clamp = (p: Placed) => {
    p.x = clampX(p.x, p.halfW, w)
    p.y = clampY(p.y, h)
  }

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]
        const b = out[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const ox = a.halfW + b.halfW + pad - Math.abs(dx)
        const oy = a.halfH + b.halfH + pad - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue

        // Push apart along the axis of least overlap (deterministic
        // tie-break: y wins when ox > oy, i.e. when x is the bigger overlap).
        if (ox > oy) {
          const amount = oy / 2
          const sign = dy >= 0 ? 1 : -1
          a.y -= amount * sign
          b.y += amount * sign
        } else {
          const amount = ox / 2
          const sign = dx >= 0 ? 1 : -1
          a.x -= amount * sign
          b.x += amount * sign
        }
        clamp(a)
        clamp(b)
      }
    }
  }

  return out
}

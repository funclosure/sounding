import type { Reading } from '../core/types'

export interface PlacedMark {
  conceptId: string
  label: string
  x: number
  y: number
  r: number
}

/** FNV-1a, unsigned 32-bit. Position must be a pure function of conceptId. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const RELAX_ITERATIONS = 40

/**
 * Chart-plan view: marks scattered on a plane, size alone carrying weight
 * (BRIEF.md visual-direction caution: no depth axis). Anchor position derives
 * from the conceptId hash so a concept stays put across readings; collision
 * relaxation nudges from the anchor deterministically.
 */
export function layoutReading(reading: Reading, width: number, height: number): PlacedMark[] {
  const cx = width / 2
  const cy = height / 2
  const scale = Math.min(width, height)

  const placed: PlacedMark[] = reading.marks.map((m) => {
    const h = hashString(m.conceptId)
    const angle = ((h % 3600) / 3600) * Math.PI * 2
    const dist = (0.15 + (((h >>> 12) % 1000) / 1000) * 0.3) * scale
    return {
      conceptId: m.conceptId,
      label: m.label,
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      r: (0.03 + 0.11 * m.prominence) * scale,
    }
  })

  // Deterministic collision relaxation: push overlapping pairs apart along
  // their center line, then clamp to the viewport.
  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 1
        const overlap = a.r + b.r - dist
        if (overlap > 0) {
          const push = overlap / 2 + 1
          const ux = dx / dist
          const uy = dy / dist
          a.x -= ux * push; a.y -= uy * push
          b.x += ux * push; b.y += uy * push
        }
      }
    }
  }
  for (const p of placed) {
    p.x = Math.min(Math.max(p.x, p.r), width - p.r)
    p.y = Math.min(Math.max(p.y, p.r), height - p.r)
  }
  return placed
}

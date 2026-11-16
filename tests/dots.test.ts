import { describe, it, expect } from 'vitest'
import {
  band, boxCeiling, clearingCeiling, disturb, nudgePush, prominenceFromFontPx, stepWave, tetherScale,
  BOX_CLEAR, CLEAR_X, CLEAR_Y, FARTHEST, NUDGE, WAVE_LASTS, WAVE_SPEED, WAVE_STEP,
} from '../src/ui/board/dots'

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

describe('nudgePush', () => {
  const reach = 64
  it('pushes hardest right under the pointer and not at all past three reaches', () => {
    expect(nudgePush(0, NUDGE, reach)).toBeCloseTo(NUDGE * reach)
    expect(nudgePush((reach / 2) ** 2, NUDGE, reach)).toBeLessThan(nudgePush(0, NUDGE, reach))
    expect(nudgePush((3 * reach) ** 2 + 1, NUDGE, reach)).toBe(0)
  })
  it('never pushes one dot past another along a line out from the pointer', () => {
    let was = -Infinity
    for (let d = 0; d <= 3 * reach; d += 0.5) {
      const at = d + nudgePush(d * d, NUDGE, reach)
      expect(at).toBeGreaterThan(was)
      was = at
    }
  })
})

describe('tetherScale', () => {
  it('leaves a small offset nearly as it is', () => {
    expect(tetherScale(2, FARTHEST)).toBeGreaterThan(0.99)
    expect(tetherScale(0, FARTHEST)).toBe(1)
  })
  it('never lets a dot past the farthest, however hard it is pushed', () => {
    for (const m of [10, 32, 60, 200, 5000]) expect(m * tetherScale(m, FARTHEST)).toBeLessThan(FARTHEST + 1e-9)
  })
  it('gives more room to a bigger push, never less', () => {
    let was = 0
    for (let m = 1; m < 200; m++) {
      const kept = m * tetherScale(m, FARTHEST)
      expect(kept).toBeGreaterThan(was)
      was = kept
    }
  })
})

describe('the wave field', () => {
  const dot = 28, cols = 40, rows = 40, size = (cols + 1) * (rows + 1)
  const c2 = (WAVE_SPEED * WAVE_STEP / dot) ** 2, damp = Math.exp(-WAVE_STEP / WAVE_LASTS)
  const cell = (i: number, j: number) => j * (cols + 1) + i
  const run = (h: Float32Array, v: Float32Array, steps: number) => {
    let most = 0
    for (let s = 0; s < steps; s++) most = stepWave(h, v, cols, rows, c2, damp)
    return most
  }

  it('lays a bump centred where it is dropped', () => {
    const v = new Float32Array(size)
    disturb(v, cols, rows, dot, 20 * dot, 20 * dot, 1)
    expect(v[cell(20, 20)]).toBeCloseTo(1)
    expect(v[cell(22, 20)]).toBeLessThan(v[cell(21, 20)])
    expect(v[cell(18, 20)]).toBeCloseTo(v[cell(22, 20)])
    expect(v[cell(0, 0)]).toBe(0)
  })

  it('runs out from where it was dropped as a ring', () => {
    const h = new Float32Array(size), v = new Float32Array(size)
    disturb(v, cols, rows, dot, 20 * dot, 20 * dot, -1)
    run(h, v, 30) // half a second: the ring is about 160px out, between five and six dots
    const ring = Math.max(...[4, 5, 6, 7].map((d) => Math.abs(h[cell(20 + d, 20)])))
    expect(ring).toBeGreaterThan(Math.abs(h[cell(20, 20)]))
    expect(ring).toBeGreaterThan(Math.abs(h[cell(20 + 14, 20)]))
  })

  it('dies down and goes flat', () => {
    const h = new Float32Array(size), v = new Float32Array(size)
    disturb(v, cols, rows, dot, 20 * dot, 20 * dot, -1)
    const early = run(h, v, 12)
    const late = run(h, v, 60 * 4)
    expect(late).toBeLessThan(early * 0.2)
    expect(run(new Float32Array(size), new Float32Array(size), 1)).toBe(0)
  })
})

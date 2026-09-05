import { describe, it, expect } from 'vitest'
import { clampWidth, encodeState, decodeState } from '../src/ui/board/panels'
import type { PanelSpec, PanelState } from '../src/ui/board/panels'

const leftSpec: PanelSpec = { side: 'left', min: 280, max: 560, default: 360, key: 't' }
const rightSpec: PanelSpec = { side: 'right', min: 320, max: 720, default: 440, key: 'c' }

describe('clampWidth', () => {
  it('clamps below min up to min', () => {
    expect(clampWidth(leftSpec, 100)).toBe(280)
  })
  it('clamps above max down to max', () => {
    expect(clampWidth(leftSpec, 9000)).toBe(560)
  })
  it('passes through a value inside the range (rounded)', () => {
    expect(clampWidth(leftSpec, 400.6)).toBe(401)
  })
  it('returns the spec default for NaN', () => {
    expect(clampWidth(leftSpec, NaN)).toBe(360)
  })
  it('returns the spec default for non-finite values (Infinity)', () => {
    expect(clampWidth(rightSpec, Infinity)).toBe(440)
  })
})

describe('encodeState / decodeState round-trip', () => {
  const defaults: PanelState = { left: { open: false, width: 360 }, right: { open: false, width: 440 } }

  it('round-trips a valid state', () => {
    const s: PanelState = { left: { open: true, width: 420 }, right: { open: false, width: 500 } }
    expect(decodeState(encodeState(s), defaults)).toEqual(s)
  })

  it('returns defaults for null', () => {
    expect(decodeState(null, defaults)).toEqual(defaults)
  })

  it('returns defaults for invalid JSON', () => {
    expect(decodeState('{not json', defaults)).toEqual(defaults)
  })

  it('returns defaults for a wrong-shaped payload (missing sides)', () => {
    expect(decodeState('{}', defaults)).toEqual(defaults)
  })

  it('falls back per-side when only one side is well-formed', () => {
    const raw = JSON.stringify({ left: { open: true, width: 300 }, right: { open: 'nope', width: 500 } })
    expect(decodeState(raw, defaults)).toEqual({ left: { open: true, width: 300 }, right: defaults.right })
  })

  it('falls back per-side when width is not finite', () => {
    const raw = JSON.stringify({ left: { open: true, width: 'wide' }, right: { open: true, width: 500 } })
    expect(decodeState(raw, defaults)).toEqual({ left: defaults.left, right: { open: true, width: 500 } })
  })
})

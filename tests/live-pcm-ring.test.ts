import { describe, it, expect } from 'vitest'
import { PcmRing, toWav } from '../src/live/pcm-ring'

function chunk(v: number, n = 1600): Int16Array { return new Int16Array(n).fill(v) }

describe('PcmRing', () => {
  it('slices the requested time range from what it holds', () => {
    const r = new PcmRing(1000, 16000) // 1s window
    r.push(chunk(1), 100); r.push(chunk(2), 200); r.push(chunk(3), 300)
    const s = r.slice(100, 300)
    expect(s.length).toBe(3200)
    expect(s[0]).toBe(2); expect(s[3199]).toBe(3)
  })

  it('drops the oldest audio once the window is exceeded and clamps slices', () => {
    const r = new PcmRing(300, 16000) // holds 4800 samples
    for (let i = 1; i <= 6; i++) r.push(chunk(i), i * 100)
    expect(r.heldRange()).toEqual({ fromT: 300, toT: 600 })
    const s = r.slice(0, 600)
    expect(s.length).toBe(4800)
    expect(s[0]).toBe(4); expect(s[4799]).toBe(6)
  })

  it('returns an empty slice for a range entirely before what it holds', () => {
    const r = new PcmRing(300, 16000)
    for (let i = 1; i <= 6; i++) r.push(chunk(i), i * 100)
    expect(r.slice(0, 200).length).toBe(0)
  })
})

describe('toWav', () => {
  it('writes a valid 44-byte RIFF header for 16kHz mono 16-bit', () => {
    const wav = toWav(new Int16Array([0, 1, -1]), 16000)
    expect(wav.length).toBe(44 + 6)
    const s = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n))
    expect(s(0, 4)).toBe('RIFF'); expect(s(8, 4)).toBe('WAVE'); expect(s(12, 4)).toBe('fmt '); expect(s(36, 4)).toBe('data')
    const dv = new DataView(wav.buffer, wav.byteOffset)
    expect(dv.getUint32(24, true)).toBe(16000) // sample rate
    expect(dv.getUint16(22, true)).toBe(1)     // channels
    expect(dv.getUint16(34, true)).toBe(16)    // bits
    expect(dv.getUint32(40, true)).toBe(6)     // data bytes
    expect(dv.getInt16(46, true)).toBe(1)
    expect(dv.getInt16(48, true)).toBe(-1)
  })
})

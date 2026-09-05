// In-memory ring of recent PCM for audio-native interpretation. Never written to disk.
import type { Ms } from '../core/types'

export class PcmRing {
  private readonly capacity: number
  private readonly buf: Int16Array
  private write = 0        // next write index
  private held = 0         // samples currently held (≤ capacity)
  private endT: Ms = 0     // timestamp of the last sample
  readonly sampleRate: number

  constructor(windowMs = 30_000, sampleRate = 16_000) {
    this.sampleRate = sampleRate
    this.capacity = Math.round((windowMs / 1000) * sampleRate)
    this.buf = new Int16Array(this.capacity)
  }

  push(chunk: Int16Array, endT: Ms): void {
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.write] = chunk[i]
      this.write = (this.write + 1) % this.capacity
    }
    this.held = Math.min(this.capacity, this.held + chunk.length)
    this.endT = endT
  }

  heldRange(): { fromT: Ms; toT: Ms } {
    return { fromT: this.endT - (this.held / this.sampleRate) * 1000, toT: this.endT }
  }

  slice(fromT: Ms, toT: Ms): Int16Array {
    const { fromT: hf, toT: ht } = this.heldRange()
    const a = Math.max(fromT, hf)
    const b = Math.min(toT, ht)
    if (b <= a) return new Int16Array(0)
    const startSample = Math.round(((a - hf) / 1000) * this.sampleRate)
    const n = Math.round(((b - a) / 1000) * this.sampleRate)
    const out = new Int16Array(n)
    const oldest = (this.write - this.held + this.capacity) % this.capacity
    for (let i = 0; i < n; i++) out[i] = this.buf[(oldest + startSample + i) % this.capacity]
    return out
  }
}

export function toWav(samples: Int16Array, sampleRate = 16_000): Uint8Array {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const dv = new DataView(out.buffer)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i) }
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE')
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  str(36, 'data'); dv.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true)
  return out
}

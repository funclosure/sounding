// Captures mic audio and posts 100ms Int16 PCM chunks at 16 kHz.
// If the AudioContext could not be created at 16 kHz, decimates linearly.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.target = 16000
    this.ratio = sampleRate / this.target
    this.acc = []          // float samples at target rate
    this.pos = 0           // fractional read position for decimation
  }
  process(inputs) {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    if (this.ratio === 1) { for (let i = 0; i < ch.length; i++) this.acc.push(ch[i]) }
    else {
      // linear interpolation from context rate down to 16k
      let p = this.pos
      while (p < ch.length - 1) { const i = Math.floor(p), f = p - i; this.acc.push(ch[i] * (1 - f) + ch[Math.min(i + 1, ch.length - 1)] * f); p += this.ratio }
      this.pos = Math.max(0, p - ch.length)
    }
    while (this.acc.length >= 1600) {
      const out = new Int16Array(1600)
      for (let i = 0; i < 1600; i++) { const s = Math.max(-1, Math.min(1, this.acc[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff }
      this.acc = this.acc.slice(1600)
      this.port.postMessage(out.buffer, [out.buffer])
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)

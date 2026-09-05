// Replays a FixtureScript as if Transcribe Live were hearing it: interims
// grow word by word every `interimEveryMs`, a final fires at each segment's
// endT. Lets the whole live path run without a key or a microphone.
import type { FixtureScript } from '../replay/fixture'
import type { Transcriber, TranscriberCallbacks } from './transcriber'
import type { Clock } from './clock'

export class FakeTranscriber implements Transcriber {
  private stop: (() => void) | null = null
  constructor(private readonly script: FixtureScript, private readonly clock: Clock, private readonly opts: { interimEveryMs?: number } = {}) {}

  async connect(cbs: TranscriberCallbacks): Promise<void> {
    cbs.onStatus('listening')
    const every = this.opts.interimEveryMs ?? 500
    let segIdx = 0
    let lastInterimWords = 0
    this.stop = this.clock.every(every, () => {
      const t = this.clock.now()
      const seg = this.script.segments[segIdx]
      if (!seg) return
      if (t < seg.startT) return
      const wordsAll = seg.text.split(/\s+/)
      const frac = Math.min(1, (t - seg.startT) / Math.max(1, seg.endT - seg.startT))
      const n = Math.max(1, Math.round(frac * wordsAll.length))
      if (t >= seg.endT) {
        cbs.onFinal(seg.text)
        segIdx += 1
        lastInterimWords = 0
        return
      }
      if (n !== lastInterimWords) { lastInterimWords = n; cbs.onInterim(wordsAll.slice(0, n).join(' ')) }
    })
  }
  sendAudio(): void { /* audio is irrelevant to the fake */ }
  async end(): Promise<void> { this.stop?.(); this.stop = null }
}

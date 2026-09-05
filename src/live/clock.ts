// The live session clock. src/live is the wall-clock boundary: the engine
// only ever sees the Ms values this produces. `speed` > 1 is for headless
// fixture runs (fake transcriber), never for real audio.
import type { Ms } from '../core/types'

export class Clock {
  private t0 = 0
  constructor(private readonly speed = 1) {}
  start(): void { this.t0 = performance.now() }
  now(): Ms { return Math.round((performance.now() - this.t0) * this.speed) }
  /** Run fn every `ms` of session time; returns a stop function. */
  every(ms: Ms, fn: () => void): () => void {
    const h = setInterval(fn, Math.max(1, ms / this.speed))
    return () => clearInterval(h)
  }
  /** Sleep for `ms` of session time. */
  sleep(ms: Ms): Promise<void> { return new Promise((r) => setTimeout(r, Math.max(0, ms / this.speed))) }
}

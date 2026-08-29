import { EventLog } from './events'
import type { Ms } from './types'
import type { Interpreter } from '../interpret/port'
import type { ReadingDynamics } from '../salience/dynamics'
import type { SalienceConfig } from '../salience/config'

/**
 * One sounding, from drop to surface. Wires segmentation output through the
 * interpretation port into the reading dynamics, and owns the 10Hz tick.
 * Time only moves when the caller hands it a timestamp — replay and live
 * mode are indistinguishable from here down.
 */
export class SoundingSession {
  readonly log = new EventLog()
  private lastTick: Ms = 0

  constructor(
    private readonly interpreter: Interpreter,
    private readonly dynamics: ReadingDynamics,
    private readonly config: SalienceConfig,
    private readonly soundingId: string,
  ) {}

  drop(): void {
    this.log.append({ type: 'sounding.dropped', t: 0, soundingId: this.soundingId })
  }

  advanceTo(t: Ms): void {
    while (this.lastTick + this.config.tickMs <= t) {
      this.lastTick += this.config.tickMs
      const { transitions, reading } = this.dynamics.tick(this.lastTick)
      this.log.append({ type: 'reading.changed', t: this.lastTick, transitions, reading })
    }
  }

  feedPending(t: Ms, text: string): void {
    this.advanceTo(t)
    this.log.append({ type: 'segment.pending', t, text })
    this.dynamics.nudge(t, text)
  }

  async feedCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void> {
    this.advanceTo(t)
    this.log.append({ type: 'segment.committed', t, ...seg })
    const result = await this.interpreter.interpret({
      kind: 'transcript', segmentId: seg.segmentId, text: seg.transcript,
      startT: seg.startT, endT: seg.endT,
    })
    this.log.append({
      type: 'candidates.emitted', t, segmentId: seg.segmentId, source: this.interpreter.id,
      candidates: result.candidates, costUsd: result.costUsd, latencyMs: result.latencyMs,
    })
    await this.dynamics.applyCandidates(t, result.candidates)
  }

  surface(t: Ms): void {
    this.advanceTo(t)
    this.log.append({ type: 'sounding.surfaced', t })
  }
}

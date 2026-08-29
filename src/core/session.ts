import { EventLog } from './events'
import type { Ms } from './types'
import type { AudioSegment, Interpreter, InterpreterInput } from '../interpret/port'
import type { ReadingDynamics } from '../salience/dynamics'
import type { SalienceConfig } from '../salience/config'

export type AudioSource = (seg: { segmentId: string; startT: Ms; endT: Ms }) => Promise<AudioSegment>

/**
 * One sounding, from drop to surface. All time-advancing operations pass
 * through a single internal queue: interpretation is async, and interleaved
 * calls must not corrupt segment↔candidates pairing or log monotonicity.
 * Time only moves via the timestamps callers hand in — replay and live mode
 * are indistinguishable from here down.
 */
export class SoundingSession {
  readonly log = new EventLog()
  private lastTick: Ms = 0
  private opQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly interpreter: Interpreter,
    private readonly dynamics: ReadingDynamics,
    private readonly config: SalienceConfig,
    private readonly soundingId: string,
    private readonly audioSource?: AudioSource,
  ) {}

  private enqueue<T>(op: () => T | Promise<T>): Promise<T> {
    const run = this.opQueue.then(op)
    // keep the chain alive whether op succeeds or fails; the caller still
    // sees the rejection through `run`
    this.opQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  drop(): void {
    this.log.append({ type: 'sounding.dropped', t: 0, soundingId: this.soundingId })
  }

  advanceTo(t: Ms): Promise<void> {
    return this.enqueue(() => this.advanceNow(t))
  }

  feedPending(t: Ms, text: string): Promise<void> {
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'segment.pending', t, text })
      this.dynamics.nudge(t, text)
    })
  }

  feedCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void> {
    return this.enqueue(() => this.processCommitted(t, seg))
  }

  surface(t: Ms): Promise<void> {
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'sounding.surfaced', t })
    })
  }

  private async processCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void> {
    this.advanceNow(t)
    this.log.append({ type: 'segment.committed', t, ...seg })
    const input = await this.buildInput(seg)
    const result = await this.interpreter.interpret(input)
    this.log.append({
      type: 'candidates.emitted',
      t,
      segmentId: seg.segmentId,
      source: this.interpreter.id,
      candidates: result.candidates,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    })
    await this.dynamics.applyCandidates(t, result.candidates)
  }

  private async buildInput(seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<InterpreterInput> {
    if (this.interpreter.input === 'audio') {
      if (!this.audioSource) {
        throw new Error(`interpreter ${this.interpreter.id} needs audio input but the session has no audioSource`)
      }
      return this.audioSource({ segmentId: seg.segmentId, startT: seg.startT, endT: seg.endT })
    }
    return { kind: 'transcript', segmentId: seg.segmentId, text: seg.transcript, startT: seg.startT, endT: seg.endT }
  }

  private advanceNow(t: Ms): void {
    while (this.lastTick + this.config.tickMs <= t) {
      this.lastTick += this.config.tickMs
      const { transitions, reading } = this.dynamics.tick(this.lastTick)
      this.log.append({ type: 'reading.changed', t: this.lastTick, transitions, reading })
    }
  }
}

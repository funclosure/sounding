import { EventLog } from './events'
import type { Ms } from './types'
import type { AudioSegment, Interpreter, InterpreterInput, InterpretationHints } from '../interpret/port'
import type { ReadingDynamics } from '../salience/dynamics'
import type { SalienceConfig } from '../salience/config'

export type AudioSource = (seg: { segmentId: string; startT: Ms; endT: Ms }) => Promise<AudioSegment>

/**
 * One sounding, from drop to surface. Time-advancing log writes pass through
 * a single internal queue so interleaved calls can't corrupt log
 * monotonicity. `feedCommitted` is the exception: the interpreter call runs
 * OUTSIDE that queue (so ticks keep flowing during a slow model call), while
 * the log append + apply around it still go through the queue, timestamped
 * at max(segment time, latest time asked of the session) — the segment time
 * in replay (byte-identical logs), the arrival time live. `surface` waits
 * for every in-flight interpretation before it appends, so nothing lands
 * after the end. Time only moves via the timestamps callers hand in —
 * replay and live mode are indistinguishable from here down.
 */
export class SoundingSession {
  readonly log = new EventLog()
  private lastTick: Ms = 0
  private opQueue: Promise<unknown> = Promise.resolve()
  private latestT: Ms = 0
  private readonly inFlight = new Set<Promise<void>>()
  private hints: InterpretationHints = {}

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

  private touch(t: Ms): void {
    if (t > this.latestT) this.latestT = t
  }

  drop(): void {
    this.log.append({ type: 'sounding.dropped', t: 0, soundingId: this.soundingId })
  }

  advanceTo(t: Ms): Promise<void> {
    this.touch(t)
    return this.enqueue(() => this.advanceNow(t))
  }

  feedPending(t: Ms, text: string): Promise<void> {
    this.touch(t)
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'segment.pending', t, text })
      this.dynamics.nudge(t, text)
    })
  }

  /** Context the speaker brought before talking — not evidence, but improves labelling/spelling downstream. Never touches ReadingDynamics. */
  setContext(t: Ms, text: string): Promise<void> {
    this.touch(t)
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'context.brought', t, text })
      this.hints = { ...this.hints, context: text }
    })
  }

  /** The concept the speaker is drilling into. `null, null` clears it while keeping context. Never touches ReadingDynamics. */
  setFollow(t: Ms, conceptId: string | null, label: string | null): Promise<void> {
    this.touch(t)
    return this.enqueue(() => {
      this.advanceNow(t)
      this.log.append({ type: 'mark.followed', t, conceptId, label })
      const { follow: _drop, ...rest } = this.hints
      this.hints = label ? { ...rest, follow: label } : rest
    })
  }

  /**
   * Commit a segment. The interpreter call runs OUTSIDE the op queue so
   * ticks keep flowing during it; the log append + apply run inside the
   * queue at max(t, latestT). In replay the caller awaits this before moving
   * time, so the candidates land at `t` exactly as before (byte-identical
   * logs); in live mode they land when they arrive.
   */
  feedCommitted(t: Ms, seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<void> {
    this.touch(t)
    const p = (async () => {
      const input = await this.enqueue(async () => {
        this.advanceNow(t)
        this.log.append({ type: 'segment.committed', t, ...seg })
        return this.buildInput(seg)
      })
      const result = await this.interpreter.interpret(input)
      // Stamp op B's timestamp now, at arrival, not when it is later dequeued:
      // an op already queued behind this one (a smaller-t feedPending, or
      // another commit's op A) must still see a monotonic tA when it runs.
      const tA = Math.max(t, this.latestT)
      await this.enqueue(async () => {
        this.advanceNow(tA)
        this.log.append({
          type: 'candidates.emitted', t: tA, segmentId: seg.segmentId, source: this.interpreter.id,
          candidates: result.candidates, costUsd: result.costUsd, latencyMs: result.latencyMs,
        })
        await this.dynamics.applyCandidates(tA, result.candidates)
      })
    })()
    const tracked = p.then(() => undefined, () => undefined)
    this.inFlight.add(tracked)
    void tracked.then(() => this.inFlight.delete(tracked))
    return p
  }

  /** Surfacing waits for every in-flight interpretation so nothing lands after the end. */
  async surface(t: Ms): Promise<void> {
    this.touch(t)
    while (this.inFlight.size) await Promise.all([...this.inFlight])
    const tS = Math.max(t, this.latestT)
    await this.enqueue(() => {
      this.advanceNow(tS)
      this.log.append({ type: 'sounding.surfaced', t: tS })
    })
  }

  private async buildInput(seg: { segmentId: string; transcript: string; startT: Ms; endT: Ms }): Promise<InterpreterInput> {
    const hints = Object.keys(this.hints).length ? { ...this.hints } : undefined
    if (this.interpreter.input === 'audio') {
      if (!this.audioSource) {
        throw new Error(`interpreter ${this.interpreter.id} needs audio input but the session has no audioSource`)
      }
      const audio = await this.audioSource({ segmentId: seg.segmentId, startT: seg.startT, endT: seg.endT })
      return hints ? { ...audio, hints } : audio
    }
    return { kind: 'transcript', segmentId: seg.segmentId, text: seg.transcript, startT: seg.startT, endT: seg.endT, hints }
  }

  private advanceNow(t: Ms): void {
    while (this.lastTick + this.config.tickMs <= t) {
      this.lastTick += this.config.tickMs
      const { transitions, reading } = this.dynamics.tick(this.lastTick)
      this.log.append({ type: 'reading.changed', t: this.lastTick, transitions, reading })
    }
  }
}

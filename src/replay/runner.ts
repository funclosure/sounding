import { SoundingSession } from '../core/session'
import { ReadingDynamics } from '../salience/dynamics'
import { TokenIdentityResolver } from '../salience/identity'
import { DEFAULT_SALIENCE_CONFIG } from '../salience/config'
import { RecurrenceInterpreter } from '../interpret/recurrence'
import { buildCaptureEvents } from './fixture'
import type { CaptureEvent, FixtureScript } from './fixture'
import type { Ms } from '../core/types'

/**
 * Drives capture events through a session. The only difference between a
 * test (∞x) and the UI (1x) is how often advanceTo is called and with what
 * timestamps — the pipeline underneath is identical.
 */
export class ReplayRunner {
  private idx = 0

  constructor(
    private readonly session: SoundingSession,
    private readonly events: CaptureEvent[],
    private readonly endT: Ms,
  ) {}

  async advanceTo(t: Ms): Promise<void> {
    const target = Math.min(t, this.endT)
    while (this.idx < this.events.length && this.events[this.idx].t <= target) {
      const e = this.events[this.idx++]
      if (e.type === 'segment.pending') {
        this.session.feedPending(e.t, e.text)
      } else {
        await this.session.feedCommitted(e.t, {
          segmentId: e.segmentId, transcript: e.transcript, startT: e.startT, endT: e.endT,
        })
      }
    }
    this.session.advanceTo(target)
  }

  async runToEnd(): Promise<void> {
    await this.advanceTo(this.endT)
    this.session.surface(this.endT)
  }
}

export function createReplay(script: FixtureScript): { session: SoundingSession; runner: ReplayRunner } {
  const config = { ...DEFAULT_SALIENCE_CONFIG, ...script.configOverrides }
  const dynamics = new ReadingDynamics(new TokenIdentityResolver(), config)
  const session = new SoundingSession(new RecurrenceInterpreter(), dynamics, config, script.name)
  session.drop()
  const runner = new ReplayRunner(session, buildCaptureEvents(script), script.endT)
  return { session, runner }
}

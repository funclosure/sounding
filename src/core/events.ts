import type { ConceptCandidate, Ms, Reading, Transition } from './types'

export type SoundingEvent =
  | { type: 'sounding.dropped'; t: Ms; soundingId: string }
  | { type: 'segment.pending'; t: Ms; text: string }
  | { type: 'segment.committed'; t: Ms; segmentId: string; transcript: string; startT: Ms; endT: Ms }
  | { type: 'candidates.emitted'; t: Ms; segmentId: string; source: string; candidates: ConceptCandidate[]; costUsd: number; latencyMs: number }
  | { type: 'reading.changed'; t: Ms; transitions: Transition[]; reading: Reading }
  | { type: 'sounding.surfaced'; t: Ms }

/** Append-only, timestamp-monotonic log. The session's spine. */
export class EventLog {
  private events: SoundingEvent[] = []

  append(e: SoundingEvent): void {
    const last = this.events[this.events.length - 1]
    if (last && e.t < last.t) {
      throw new Error(`event log must be monotonic: got t=${e.t} after t=${last.t}`)
    }
    this.events.push(e)
  }

  all(): readonly SoundingEvent[] {
    return this.events
  }

  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n')
  }

  static fromJsonl(jsonl: string): EventLog {
    const log = new EventLog()
    for (const line of jsonl.split('\n')) {
      if (line.trim().length === 0) continue
      log.append(JSON.parse(line) as SoundingEvent)
    }
    return log
  }
}

import type { ConceptCandidate, Ms, Reading, Transition } from './types'

export type SoundingEvent =
  | { type: 'sounding.dropped'; t: Ms; soundingId: string }
  | { type: 'segment.pending'; t: Ms; text: string }
  | { type: 'segment.committed'; t: Ms; segmentId: string; transcript: string; startT: Ms; endT: Ms }
  // `t` is when the candidates were applied — the segment time in replay,
  // the arrival time live; `latencyMs` measures the interpreter call itself.
  | { type: 'candidates.emitted'; t: Ms; segmentId: string; source: string; candidates: ConceptCandidate[]; costUsd: number; latencyMs: number }
  | { type: 'reading.changed'; t: Ms; transitions: Transition[]; reading: Reading }
  | { type: 'sounding.surfaced'; t: Ms }
  | { type: 'context.brought'; t: Ms; text: string }
  | { type: 'mark.followed'; t: Ms; conceptId: string | null; label: string | null }

/** Append-only, timestamp-monotonic log. The session's spine. */
export class EventLog {
  private events: SoundingEvent[] = []

  private static readonly REQUIRED_FIELDS: Record<SoundingEvent['type'], string[]> = {
    'sounding.dropped': ['soundingId'],
    'segment.pending': ['text'],
    'segment.committed': ['segmentId', 'transcript', 'startT', 'endT'],
    'candidates.emitted': ['segmentId', 'source', 'candidates', 'costUsd', 'latencyMs'],
    'reading.changed': ['transitions', 'reading'],
    'sounding.surfaced': [],
    'context.brought': ['text'],
    'mark.followed': ['conceptId', 'label'],
  }

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
    const lines = jsonl.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      const where = `line ${i + 1}`
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error(`${where}: invalid JSON`)
      }
      if (typeof parsed !== 'object' || parsed === null) throw new Error(`${where}: not an object`)
      const e = parsed as Record<string, unknown>
      const required = EventLog.REQUIRED_FIELDS[e.type as SoundingEvent['type']]
      if (required === undefined) throw new Error(`${where}: unknown event type ${JSON.stringify(e.type)}`)
      if (typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t < 0) throw new Error(`${where}: missing or invalid t`)
      for (const field of required) {
        if (!(field in e)) throw new Error(`${where}: missing required field ${field}`)
      }
      log.append(parsed as SoundingEvent)
    }
    return log
  }
}

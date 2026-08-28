import type { Ms } from '../core/types'
import type { SalienceConfig } from '../salience/config'

export interface FixtureSegment { startT: Ms; endT: Ms; text: string }

export interface FixtureTruth {
  circles?: string[]
  surfacesBy?: Record<string, Ms>
  topicShiftAt?: Ms
  driftGroup?: string[]
  notes?: string
}

export interface FixtureScript {
  name: string
  description: string
  endT: Ms
  configOverrides?: Partial<SalienceConfig>
  segments: FixtureSegment[]
  truth: FixtureTruth
}

export type CaptureEvent =
  | { type: 'segment.pending'; t: Ms; text: string }
  | { type: 'segment.committed'; t: Ms; segmentId: string; transcript: string; startT: Ms; endT: Ms }

export const PENDING_INTERVAL_MS = 300

/**
 * A fixture script is the monologue as authored; this derives the capture
 * events a live segmenter would have produced: accumulating pending text at
 * a fixed cadence (words spread evenly across the segment), then the commit.
 */
export function buildCaptureEvents(script: FixtureScript): CaptureEvent[] {
  const events: CaptureEvent[] = []
  script.segments.forEach((seg, i) => {
    const words = seg.text.split(/\s+/)
    const duration = seg.endT - seg.startT
    for (let t = seg.startT + PENDING_INTERVAL_MS; t < seg.endT; t += PENDING_INTERVAL_MS) {
      const progress = (t - seg.startT) / duration
      const wordCount = Math.max(1, Math.floor(words.length * progress))
      events.push({ type: 'segment.pending', t, text: words.slice(0, wordCount).join(' ') })
    }
    events.push({
      type: 'segment.committed', t: seg.endT, segmentId: `seg${i + 1}`,
      transcript: seg.text, startT: seg.startT, endT: seg.endT,
    })
  })
  return events.sort((a, b) => a.t - b.t)
}

import { describe, it, expect } from 'vitest'
import { summarizeCounters } from '../src/replay/counters'
import type { SoundingEvent } from '../src/core/events'

function call(costUsd: number, latencyMs: number): SoundingEvent {
  return { type: 'candidates.emitted', t: 0, segmentId: 's', source: 'x', candidates: [], costUsd, latencyMs }
}

describe('summarizeCounters', () => {
  it('aggregates cost and latency across interpretation calls', () => {
    const events: SoundingEvent[] = [
      { type: 'sounding.dropped', t: 0, soundingId: 's1' },
      call(0.001, 200), call(0.002, 400), call(0, 0),
    ]
    expect(summarizeCounters(events)).toEqual({
      callCount: 3, totalCostUsd: 0.003, meanLatencyMs: 200, maxLatencyMs: 400,
    })
  })

  it('handles an empty log', () => {
    expect(summarizeCounters([])).toEqual({ callCount: 0, totalCostUsd: 0, meanLatencyMs: 0, maxLatencyMs: 0 })
  })
})

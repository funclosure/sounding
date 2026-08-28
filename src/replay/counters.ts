import type { SoundingEvent } from '../core/events'

export interface CounterSummary {
  callCount: number
  totalCostUsd: number
  meanLatencyMs: number
  maxLatencyMs: number
}

/**
 * The day-one insurance from the brief: when the reading finally feels
 * right, these say whether it happened at 3c/min or 30c/min.
 */
export function summarizeCounters(events: readonly SoundingEvent[]): CounterSummary {
  const calls = events.filter((e) => e.type === 'candidates.emitted')
  if (calls.length === 0) return { callCount: 0, totalCostUsd: 0, meanLatencyMs: 0, maxLatencyMs: 0 }
  let totalCost = 0
  let totalLatency = 0
  let maxLatency = 0
  for (const c of calls) {
    if (c.type !== 'candidates.emitted') continue
    totalCost += c.costUsd
    totalLatency += c.latencyMs
    if (c.latencyMs > maxLatency) maxLatency = c.latencyMs
  }
  return {
    callCount: calls.length,
    totalCostUsd: Number(totalCost.toFixed(6)),
    meanLatencyMs: totalLatency / calls.length,
    maxLatencyMs: maxLatency,
  }
}

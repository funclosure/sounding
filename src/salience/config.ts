/** Every tuning constant in one place so replay-based sweeps are trivial. */
export interface SalienceConfig {
  capacity: number // K — marks the chart can hold. A constant, not an output.
  halfLifeMs: number // exponential decay half-life for concept weight
  confidenceFloor: number // candidates below this never surface (a missing mark costs less than a wrong one)
  hysteresisMargin: number // challenger must exceed weakest incumbent's weight by this fraction
  hysteresisTicks: number // ...sustained for this many consecutive ticks
  tickMs: number // 10Hz state rate
  nudgeFactor: number // fast-loop weight nudge per pending-text recurrence hit
  slackAfterMs: number // silence longer than this is slack
  similarityThreshold: number // embedding resolver: min cosine similarity to merge a candidate into an existing concept
}

export const DEFAULT_SALIENCE_CONFIG: SalienceConfig = {
  capacity: 7,
  halfLifeMs: 45_000,
  confidenceFloor: 0.3,
  hysteresisMargin: 0.15,
  hysteresisTicks: 5,
  tickMs: 100,
  nudgeFactor: 0.05,
  slackAfterMs: 5_000,
  similarityThreshold: 0.6,
}

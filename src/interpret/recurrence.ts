import { tokenize } from '../core/text'
import type { Interpreter, InterpreterInput, InterpretationResult } from './port'

export interface RecurrenceOptions {
  windowSegments: number // how many committed segments the sliding window holds
  minCount: number // occurrences required before a term becomes a candidate
}

const DEFAULTS: RecurrenceOptions = { windowSegments: 8, minCount: 2 }

/**
 * Slice-1 interpreter: word/bigram recurrence over a sliding window of
 * committed segments. No network, no cost. Recurrence is a real salience
 * signal (BRIEF.md), but it cannot do synonymy — that is the embedding
 * resolver's job in slice 2.
 */
export class RecurrenceInterpreter implements Interpreter {
  readonly id = 'recurrence-v0'
  private window: string[][] = []
  private readonly opts: RecurrenceOptions

  constructor(opts?: Partial<RecurrenceOptions>) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    if (input.kind !== 'transcript') {
      throw new Error('recurrence-v0 interprets transcript input only')
    }
    this.window.push(tokenize(input.text))
    if (this.window.length > this.opts.windowSegments) this.window.shift()

    const counts = new Map<string, number>()
    for (const tokens of this.window) {
      for (const tok of tokens) counts.set(tok, (counts.get(tok) ?? 0) + 1)
      for (let i = 0; i < tokens.length - 1; i++) {
        const bigram = `${tokens[i]} ${tokens[i + 1]}`
        counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
      }
    }

    let max = 1
    for (const c of counts.values()) if (c > max) max = c

    const candidates = [...counts.entries()]
      .filter(([, c]) => c >= this.opts.minCount)
      .map(([label, c]) => ({
        label,
        strength: c / max,
        confidence: Math.min(1, c / (this.opts.minCount + 2)),
        source: this.id,
        segmentId: input.segmentId,
      }))
      .sort((a, b) => (b.strength - a.strength) || (a.label < b.label ? -1 : 1))
      .slice(0, 12)

    return { candidates, costUsd: 0, latencyMs: 0 }
  }
}

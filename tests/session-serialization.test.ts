import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../src/interpret/port'

/** Interpreter whose first call blocks until released — to provoke interleaving. */
class GatedInterpreter implements Interpreter {
  readonly id = 'gated'
  readonly input = 'transcript' as const
  private calls = 0
  release!: () => void
  private gate = new Promise<void>((res) => (this.release = res))
  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    this.calls += 1
    if (this.calls === 1) await this.gate
    if (input.kind !== 'transcript') throw new Error('transcript only')
    return {
      candidates: [{ label: input.text, strength: 1, confidence: 1, source: this.id, segmentId: input.segmentId }],
      costUsd: 0,
      latencyMs: 0,
    }
  }
}

function makeSession(interpreter: Interpreter) {
  const config = DEFAULT_SALIENCE_CONFIG
  const dynamics = new ReadingDynamics(new TokenIdentityResolver(), config)
  return new SoundingSession(interpreter, dynamics, config, 'serial-test')
}

describe('session operation queue', () => {
  it('unawaited overlapping calls still produce a correctly ordered log', async () => {
    const interp = new GatedInterpreter()
    const s = makeSession(interp)
    s.drop()
    const first = s.feedCommitted(4000, { segmentId: 'seg1', transcript: 'alpha', startT: 0, endT: 4000 })
    const pending = s.feedPending(4200, 'beta incoming')
    const second = s.feedCommitted(8000, { segmentId: 'seg2', transcript: 'beta', startT: 4000, endT: 8000 })
    interp.release()
    await Promise.all([first, pending, second])
    const types = s.log.all().map((e) => `${e.type}@${e.t}`)
    const idx = (needle: string) => types.findIndex((x) => x.startsWith(needle))
    // seg1's candidates land before anything at a later timestamp
    expect(idx('candidates.emitted@4000')).toBeGreaterThan(idx('segment.committed@4000'))
    expect(idx('segment.pending@4200')).toBeGreaterThan(idx('candidates.emitted@4000'))
    expect(idx('candidates.emitted@8000')).toBeGreaterThan(idx('segment.pending@4200'))
    // and the log is timestamp-monotonic (append would have thrown otherwise)
    const ts = s.log.all().map((e) => e.t)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
  })

  it('an interpreter error does not wedge the queue', async () => {
    const failing: Interpreter = {
      id: 'boom',
      input: 'transcript',
      interpret: async () => {
        throw new Error('boom')
      },
    }
    const s = makeSession(failing)
    s.drop()
    await expect(s.feedCommitted(4000, { segmentId: 'seg1', transcript: 'x', startT: 0, endT: 4000 })).rejects.toThrow('boom')
    await s.advanceTo(5000) // queue still alive
    expect(s.log.all().some((e) => e.type === 'reading.changed')).toBe(true)
  })
})

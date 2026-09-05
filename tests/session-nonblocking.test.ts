import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../src/interpret/port'

/** An interpreter whose answer is released by the test, so the test controls when the call "finishes". */
class GatedInterpreter implements Interpreter {
  readonly id = 'gated'; readonly input = 'transcript' as const
  release: (() => void) | null = null
  interpret(input: InterpreterInput): Promise<InterpretationResult> {
    return new Promise((resolve) => { this.release = () => resolve({ candidates: [{ label: 'sister', strength: 0.9, confidence: 0.9, source: this.id, segmentId: input.segmentId }], costUsd: 0, latencyMs: 0 }) })
  }
}
function makeSession(interp: Interpreter) {
  const cfg = { ...DEFAULT_SALIENCE_CONFIG }
  const s = new SoundingSession(interp, new ReadingDynamics(new TokenIdentityResolver(), cfg), cfg, 'nb-test')
  s.drop()
  return s
}
const seg = (id: string, t: number) => ({ segmentId: id, transcript: 'my sister called', startT: t - 3000, endT: t })

describe('interpretation does not block the clock', () => {
  it('ticks keep landing while a call is pending, and the candidates land at arrival time', async () => {
    const gi = new GatedInterpreter(); const s = makeSession(gi)
    const fc = s.feedCommitted(3000, seg('s1', 3000))
    // let op A run and the interpreter start
    await new Promise((r) => setTimeout(r, 0))
    expect(gi.release).not.toBeNull()
    await s.advanceTo(6000)                          // 30 ticks while the call is pending
    const before = s.log.all()
    expect(before.filter((e) => e.type === 'reading.changed').at(-1)!.t).toBe(6000)
    expect(before.some((e) => e.type === 'candidates.emitted')).toBe(false)
    gi.release!()
    await fc
    const ce = s.log.all().find((e) => e.type === 'candidates.emitted')!
    expect(ce.t).toBe(6000)                          // applied when it arrived, not at the segment time
    expect(s.log.all().map((e) => e.t).every((t, i, a) => i === 0 || t >= a[i - 1])).toBe(true)
  })

  it('in replay (caller awaits feedCommitted before advancing) the candidates land at the segment time', async () => {
    const gi = new GatedInterpreter(); const s = makeSession(gi)
    const fc = s.feedCommitted(3000, seg('s1', 3000))
    await new Promise((r) => setTimeout(r, 0)); gi.release!(); await fc
    expect(s.log.all().find((e) => e.type === 'candidates.emitted')!.t).toBe(3000)
  })

  it('surface waits for in-flight interpretations', async () => {
    const gi = new GatedInterpreter(); const s = makeSession(gi)
    void s.feedCommitted(3000, seg('s1', 3000))
    await new Promise((r) => setTimeout(r, 0))
    let surfaced = false
    const sp = s.surface(4000).then(() => { surfaced = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(surfaced).toBe(false)
    gi.release!(); await sp
    const types = s.log.all().map((e) => e.type)
    expect(types.indexOf('candidates.emitted')).toBeLessThan(types.indexOf('sounding.surfaced'))
    expect(types.at(-1)).toBe('sounding.surfaced')
  })

  it('a rejected interpretation rejects feedCommitted but leaves the session usable', async () => {
    const bad: Interpreter = { id: 'bad', input: 'transcript', interpret: () => Promise.reject(new Error('boom')) }
    const s = makeSession(bad)
    await expect(s.feedCommitted(3000, seg('s1', 3000))).rejects.toThrow('boom')
    await s.advanceTo(3500)
    expect(s.log.all().at(-1)!.t).toBe(3500)
    await s.surface(3600)
    expect(s.log.all().at(-1)!.type).toBe('sounding.surfaced')
  })
})

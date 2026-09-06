import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { EventLog } from '../src/core/events'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../src/interpret/port'

/** Captures every InterpreterInput it receives, and resolves immediately with no candidates. */
class CapturingInterpreter implements Interpreter {
  readonly id = 'capturing'
  readonly input = 'transcript' as const
  readonly seen: InterpreterInput[] = []
  interpret(input: InterpreterInput): Promise<InterpretationResult> {
    this.seen.push(input)
    return Promise.resolve({ candidates: [], costUsd: 0, latencyMs: 0 })
  }
}

/** Resolves immediately with a fixed, real candidate — for tests that need the reading to actually move. */
class FixedInterpreter implements Interpreter {
  readonly id = 'fixed'
  readonly input = 'transcript' as const
  interpret(input: InterpreterInput): Promise<InterpretationResult> {
    return Promise.resolve({
      candidates: [{ label: 'sister', strength: 0.9, confidence: 0.9, source: this.id, segmentId: input.segmentId }],
      costUsd: 0,
      latencyMs: 0,
    })
  }
}

function makeSession(interp: Interpreter) {
  const cfg = { ...DEFAULT_SALIENCE_CONFIG }
  const s = new SoundingSession(interp, new ReadingDynamics(new TokenIdentityResolver(), cfg), cfg, 'hints-test')
  s.drop()
  return s
}

const seg = (id: string, t: number) => ({ segmentId: id, transcript: 'some words', startT: t - 3000, endT: t })

describe('context and follow hints', () => {
  it('setContext logs context.brought and attaches hints.context to the next input', async () => {
    const interp = new CapturingInterpreter()
    const s = makeSession(interp)

    await s.setContext(1000, 'Trust Wallet, Apple')
    await s.feedCommitted(3000, seg('s1', 3000))

    const types = s.log.all().map((e) => e.type)
    expect(types.indexOf('context.brought')).toBeLessThan(types.indexOf('segment.committed'))
    const cb = s.log.all().find((e) => e.type === 'context.brought')!
    expect(cb.t).toBe(1000)
    expect((cb as { text: string }).text).toBe('Trust Wallet, Apple')

    expect(interp.seen.length).toBe(1)
    const input = interp.seen[0]
    expect(input.hints?.context).toBe('Trust Wallet, Apple')
    expect(input.hints?.follow).toBeUndefined()
  })

  it('setFollow logs mark.followed and attaches hints.follow; setFollow(t, null, null) clears follow but keeps context', async () => {
    const interp = new CapturingInterpreter()
    const s = makeSession(interp)

    await s.setContext(3500, 'kept context')
    await s.setFollow(4000, 'c2', 'work-life balance')
    await s.feedCommitted(4500, seg('s1', 4500))

    expect(interp.seen[0].hints?.context).toBe('kept context')
    expect(interp.seen[0].hints?.follow).toBe('work-life balance')
    const mf = s.log.all().find((e) => e.type === 'mark.followed')!
    expect(mf.t).toBe(4000)
    expect((mf as { conceptId: string | null }).conceptId).toBe('c2')
    expect((mf as { label: string | null }).label).toBe('work-life balance')

    await s.setFollow(5000, null, null)
    await s.feedCommitted(5500, seg('s2', 5500))
    expect(interp.seen[1].hints?.follow).toBeUndefined()
    expect(interp.seen[1].hints?.context).toBe('kept context')
  })

  it('neither op changes the reading', async () => {
    // Two sessions fed the identical commits at the identical times; only
    // one interleaves setContext/setFollow between them. If either op
    // touched ReadingDynamics (a decay tick, a nudge, a candidate), the
    // reading.changed sequences would diverge.
    const cfg = { ...DEFAULT_SALIENCE_CONFIG }
    const plain = new SoundingSession(new FixedInterpreter(), new ReadingDynamics(new TokenIdentityResolver(), cfg), cfg, 'plain')
    const withHints = new SoundingSession(new FixedInterpreter(), new ReadingDynamics(new TokenIdentityResolver(), cfg), cfg, 'with-hints')
    plain.drop(); withHints.drop()

    await plain.feedCommitted(1000, seg('s1', 1000))
    await withHints.feedCommitted(1000, seg('s1', 1000))

    // Off-tick timestamps (not multiples of tickMs) so a stray decayTo call
    // inside either op would leave a floating-point trace even though the
    // pure-math decay factor is path-independent.
    await withHints.setContext(1530, 'some context')
    await withHints.setFollow(2010, 'c1', 'a label')
    await withHints.setFollow(2470, null, null)

    await plain.feedCommitted(3000, seg('s2', 3000))
    await withHints.feedCommitted(3000, seg('s2', 3000))

    const readingEvents = (s: SoundingSession) => s.log.all().filter((e) => e.type === 'reading.changed')
    expect(readingEvents(withHints)).toEqual(readingEvents(plain))
  })

  it('EventLog.fromJsonl round-trips context.brought and mark.followed (including the null/null clear), and rejects mark.followed missing label', () => {
    const log = new EventLog()
    log.append({ type: 'context.brought', t: 1000, text: 'hello' })
    log.append({ type: 'mark.followed', t: 2000, conceptId: 'c1', label: 'x' })
    log.append({ type: 'mark.followed', t: 3000, conceptId: null, label: null })
    const jsonl = log.toJsonl()
    const roundTripped = EventLog.fromJsonl(jsonl)
    expect(roundTripped.all()).toEqual(log.all())

    const badLine = JSON.stringify({ type: 'mark.followed', t: 2000, conceptId: 'c1' })
    expect(() => EventLog.fromJsonl(badLine)).toThrow(/label/)
  })
})

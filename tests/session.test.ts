import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import { RecurrenceInterpreter } from '../src/interpret/recurrence'

function makeSession() {
  const config = DEFAULT_SALIENCE_CONFIG
  const dynamics = new ReadingDynamics(new TokenIdentityResolver(), config)
  return new SoundingSession(new RecurrenceInterpreter(), dynamics, config, 'test-sounding')
}

describe('SoundingSession', () => {
  it('drop appends sounding.dropped at t=0', () => {
    const s = makeSession()
    s.drop()
    expect(s.log.all()).toEqual([{ type: 'sounding.dropped', t: 0, soundingId: 'test-sounding' }])
  })

  it('advanceTo emits one reading.changed per tick interval', async () => {
    const s = makeSession()
    s.drop()
    await s.advanceTo(550) // tickMs=100 -> ticks at 100..500
    const ticks = s.log.all().filter((e) => e.type === 'reading.changed')
    expect(ticks.map((e) => e.t)).toEqual([100, 200, 300, 400, 500])
  })

  it('feedCommitted appends segment, then candidates, and feeds dynamics', async () => {
    const s = makeSession()
    s.drop()
    await s.feedCommitted(4000, { segmentId: 'seg1', transcript: 'my sister and the offer', startT: 0, endT: 4000 })
    await s.feedCommitted(8000, { segmentId: 'seg2', transcript: 'my sister likes the offer', startT: 4000, endT: 8000 })
    const types = s.log.all().map((e) => e.type)
    expect(types.filter((t) => t === 'segment.committed')).toHaveLength(2)
    expect(types.filter((t) => t === 'candidates.emitted')).toHaveLength(2)
    // ticks precede the event that shares/exceeds their timestamp
    expect(types.indexOf('segment.committed')).toBeGreaterThan(types.indexOf('reading.changed'))
    await s.advanceTo(8200)
    const last = s.log.all().at(-1)!
    expect(last.type).toBe('reading.changed')
    if (last.type === 'reading.changed') {
      expect(last.reading.marks.map((m) => m.label)).toContain('sister')
    }
  })

  it('feedPending appends the event and timestamps stay monotonic', async () => {
    const s = makeSession()
    s.drop()
    await s.feedPending(300, 'my sister')
    await s.feedCommitted(4000, { segmentId: 'seg1', transcript: 'my sister called', startT: 0, endT: 4000 })
    const ts = s.log.all().map((e) => e.t)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
  })

  it('surface finishes the log', async () => {
    const s = makeSession()
    s.drop()
    await s.surface(1000)
    expect(s.log.all().at(-1)).toEqual({ type: 'sounding.surfaced', t: 1000 })
  })
})

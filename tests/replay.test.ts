import { describe, it, expect } from 'vitest'
import { buildCaptureEvents, PENDING_INTERVAL_MS } from '../src/replay/fixture'
import { createReplay } from '../src/replay/runner'
import type { FixtureScript } from '../src/replay/fixture'

const tiny: FixtureScript = {
  name: 'tiny',
  description: 'two segments about a sister',
  endT: 10_000,
  segments: [
    { startT: 0, endT: 4000, text: 'my sister called about the offer' },
    { startT: 5000, endT: 9000, text: 'my sister thinks the offer is right' },
  ],
  truth: {},
}

describe('buildCaptureEvents', () => {
  it('emits accumulating pending text at the pending cadence, then the committed segment', () => {
    const events = buildCaptureEvents(tiny)
    const first = events.filter((e) => e.t <= 4000)
    const pendings = first.filter((e) => e.type === 'segment.pending')
    expect(pendings.length).toBeGreaterThan(4) // 4000ms / 300ms cadence
    expect(pendings[0].t).toBe(PENDING_INTERVAL_MS)
    // pending text accumulates
    const texts = pendings.map((e) => (e.type === 'segment.pending' ? e.text : ''))
    expect(texts[texts.length - 1].split(' ').length).toBeGreaterThanOrEqual(texts[0].split(' ').length)
    const committed = first.at(-1)!
    expect(committed).toMatchObject({ type: 'segment.committed', t: 4000, transcript: tiny.segments[0].text })
  })

  it('is sorted by t and deterministic', () => {
    const a = buildCaptureEvents(tiny)
    const b = buildCaptureEvents(tiny)
    expect(a).toEqual(b)
    const ts = a.map((e) => e.t)
    expect([...ts].sort((x, y) => x - y)).toEqual(ts)
  })

  it('gives segments sequential ids', () => {
    const ids = buildCaptureEvents(tiny)
      .filter((e) => e.type === 'segment.committed')
      .map((e) => (e.type === 'segment.committed' ? e.segmentId : ''))
    expect(ids).toEqual(['seg1', 'seg2'])
  })
})

describe('ReplayRunner', () => {
  it('runToEnd produces a complete log: dropped ... surfaced', async () => {
    const { session, runner } = createReplay(tiny)
    await runner.runToEnd()
    const types = session.log.all().map((e) => e.type)
    expect(types[0]).toBe('sounding.dropped')
    expect(types.at(-1)).toBe('sounding.surfaced')
    expect(types).toContain('segment.committed')
    expect(types).toContain('candidates.emitted')
    expect(types).toContain('reading.changed')
  })

  it('advanceTo is incremental: partial advance then rest equals one full run', async () => {
    const a = createReplay(tiny)
    await a.runner.advanceTo(6000)
    await a.runner.runToEnd()
    const b = createReplay(tiny)
    await b.runner.runToEnd()
    expect(a.session.log.toJsonl()).toBe(b.session.log.toJsonl())
  })

  it('the recurring concept surfaces in the reading', async () => {
    const { session, runner } = createReplay(tiny)
    await runner.runToEnd()
    const readings = session.log.all().filter((e) => e.type === 'reading.changed')
    const last = readings.at(-1)!
    if (last.type === 'reading.changed') {
      expect(last.reading.marks.map((m) => m.label)).toContain('sister')
    }
  })
})

import { describe, it, expect } from 'vitest'
import { diffReadings, transcriptAt, laneSeries, ranked, snapshotOf } from '../src/ui/board/model'
import type { ReadingSnapshot } from '../src/ui/board/model'
import type { SoundingEvent } from '../src/core/events'
import type { Transition } from '../src/core/types'

function snap(t: number, marks: Array<[string, string, number]>, transitions: Transition[] = [], slack = false): ReadingSnapshot {
  return { t, marks: marks.map(([id, label, p]) => ({ id, label, p })), transitions, slack }
}

describe('snapshotOf', () => {
  it('maps a reading.changed event to a ReadingSnapshot', () => {
    const event: Extract<SoundingEvent, { type: 'reading.changed' }> = {
      type: 'reading.changed',
      t: 5000,
      transitions: [],
      reading: { t: 5000, slack: true, marks: [{ conceptId: 'a', label: 'Alpha', prominence: 0.5, weight: 1.2 }] },
    }
    expect(snapshotOf(event)).toEqual({
      t: 5000,
      marks: [{ id: 'a', label: 'Alpha', p: 0.5 }],
      transitions: [],
      slack: true,
    })
  })
})

describe('diffReadings', () => {
  it('classifies arrived, kept, and departed (displaced with by, absorbed via merged)', () => {
    const prev = snap(1000, [
      ['a', 'Alpha', 0.5],
      ['b', 'Beta', 0.3],
      ['c', 'Gamma', 0.2],
    ])
    const next = snap(
      2000,
      [
        ['b', 'Beta', 0.35],
        ['d', 'Delta', 0.4],
      ],
      [
        { kind: 'displaced', conceptId: 'a', label: 'Alpha', byConceptId: 'd' },
        { kind: 'merged', fromConceptId: 'c', intoConceptId: 'b' },
      ],
    )
    const diff = diffReadings(prev, next)
    expect(diff.arrived).toEqual([{ id: 'd', label: 'Delta', p: 0.4 }])
    expect(diff.kept).toEqual([{ id: 'b', label: 'Beta', p: 0.35 }])
    expect(diff.departed).toEqual(
      expect.arrayContaining([
        { id: 'a', reason: 'displaced', by: 'd' },
        { id: 'c', reason: 'absorbed' },
      ]),
    )
    expect(diff.departed).toHaveLength(2)
  })

  it('treats a mark gone with no matching transition as faded', () => {
    const prev = snap(1000, [['x', 'X', 0.5]])
    const next = snap(2000, [])
    expect(diffReadings(prev, next).departed).toEqual([{ id: 'x', reason: 'faded' }])
  })

  it('treats a null previous snapshot as empty: everything arrives, nothing departs', () => {
    const next = snap(1000, [['a', 'Alpha', 0.5]])
    const diff = diffReadings(null, next)
    expect(diff.arrived).toEqual([{ id: 'a', label: 'Alpha', p: 0.5 }])
    expect(diff.kept).toEqual([])
    expect(diff.departed).toEqual([])
  })
})

describe('transcriptAt', () => {
  const events: SoundingEvent[] = [
    { type: 'segment.committed', t: 1000, segmentId: 's1', transcript: 'hello there', startT: 200, endT: 1000 },
    { type: 'segment.committed', t: 32000, segmentId: 's2', transcript: 'second segment', startT: 31000, endT: 32000 },
    { type: 'segment.pending', t: 33000, text: 'thi' },
    { type: 'segment.pending', t: 34000, text: 'rd seg' },
    { type: 'segment.committed', t: 45000, segmentId: 's3', transcript: 'too late', startT: 44000, endT: 45000 },
  ]

  it('includes committed segments at or before now, with a stamp every 30s of segment start', () => {
    const m = transcriptAt(events, 34000)
    expect(m.segments).toEqual([
      { t: 1000, text: 'hello there' },
      { t: 32000, text: 'second segment' },
    ])
    expect(m.stamps).toEqual([
      { t: 1000, label: '0:00' },
      { t: 32000, label: '0:30' },
    ])
  })

  it('collects pending text since the last committed segment up to now as the tail', () => {
    expect(transcriptAt(events, 34000).pendingTail).toBe('thi rd seg')
  })

  it('excludes segments (and their stamps/pending text) committed after now', () => {
    const m = transcriptAt(events, 10000)
    expect(m.segments).toEqual([{ t: 1000, text: 'hello there' }])
    expect(m.stamps).toEqual([{ t: 1000, label: '0:00' }])
    expect(m.pendingTail).toBe('')
  })
})

describe('laneSeries', () => {
  it('orders lanes by first appearance and produces step points ending at endT', () => {
    const readings: ReadingSnapshot[] = [snap(0, [['a', 'Alpha', 0.4]]), snap(1000, [['a', 'Alpha', 0.5], ['b', 'Beta', 0.2]]), snap(2000, [['b', 'Beta', 0.3]])]
    const series = laneSeries(readings, 3000)
    expect(series.map((s) => s.id)).toEqual(['a', 'b'])

    const a = series.find((s) => s.id === 'a')!
    expect(a.label).toBe('Alpha')
    expect(a.firstT).toBe(0)
    expect(a.points[0]).toEqual([0, 0])
    expect(a.points.at(-1)).toEqual([3000, 0])

    const b = series.find((s) => s.id === 'b')!
    expect(b.firstT).toBe(1000)
    expect(b.points.at(-1)).toEqual([3000, 0.3])
  })

  it('quantizes prominence to 3 decimals so ulp drift adds no points', () => {
    const readings: ReadingSnapshot[] = [
      snap(0, [['a', 'Alpha', 0.3]]),
      snap(1000, [['a', 'Alpha', 0.1 + 0.2]]), // 0.30000000000000004 in floating point, not 0.3
      snap(2000, [['a', 'Alpha', 0.3]]),
    ]
    const series = laneSeries(readings, 3000)
    const a = series.find((s) => s.id === 'a')!
    // The 0 -> 0.3 step at t=0, then flat: no extra points from the
    // 0.1 + 0.2 !== 0.3 floating-point drift at t=1000.
    expect(a.points).toEqual([
      [0, 0],
      [0, 0.3],
      [3000, 0.3],
    ])
  })
})

describe('ranked', () => {
  it('sorts by prominence and computes pct and rel relative to the top mark', () => {
    const snapshot = snap(1000, [
      ['a', 'Alpha', 0.2],
      ['b', 'Beta', 0.5],
      ['c', 'Gamma', 0.1],
    ])
    expect(ranked(snapshot)).toEqual([
      { label: 'Beta', pct: 50, rel: 1 },
      { label: 'Alpha', pct: 20, rel: 0.4 },
      { label: 'Gamma', pct: 10, rel: 0.2 },
    ])
  })

  it('returns an empty list for an empty snapshot', () => {
    expect(ranked(snap(0, []))).toEqual([])
  })
})

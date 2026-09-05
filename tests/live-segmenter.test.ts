import { describe, it, expect } from 'vitest'
import { Segmenter } from '../src/live/segmenter'

describe('Segmenter', () => {
  it('emits the new words as the pending delta when the interim grows', () => {
    const s = new Segmenter()
    expect(s.onInterim(500, 'Okay,').pendingDelta).toBe('Okay,')
    expect(s.onInterim(1000, 'Okay, let me').pendingDelta).toBe('let me')
    expect(s.onInterim(1500, 'Okay, let me').pendingDelta).toBe('')
  })

  it('emits the revised tail when the interim rewrites earlier words', () => {
    const s = new Segmenter()
    s.onInterim(500, 'about one thinking')
    expect(s.onInterim(1000, "about what I'm thinking").pendingDelta).toBe("what I'm thinking")
  })

  it('cuts a segment after maxSegmentMs when at least minSegmentWords are new', () => {
    const s = new Segmenter({ maxSegmentMs: 8000, minSegmentWords: 4 })
    s.onInterim(500, 'one two')
    expect(s.onInterim(7900, 'one two three four five').commit).toBeNull()
    const r = s.onInterim(8100, 'one two three four five six')
    expect(r.commit).toMatchObject({ transcript: 'one two three four five six', startT: 0, endT: 8100 })
    expect(r.commit!.segmentId).toBe('live-1')
  })

  it('does not cut when fewer than minSegmentWords are new', () => {
    const s = new Segmenter({ maxSegmentMs: 8000, minSegmentWords: 4 })
    s.onInterim(500, 'one two three')
    expect(s.onInterim(9000, 'one two three').commit).toBeNull()
    expect(s.onIdle(12000).commit).toBeNull()
  })

  it('a final commits only the remainder after a time-based cut, then resets', () => {
    const s = new Segmenter({ maxSegmentMs: 8000, minSegmentWords: 4 })
    const cut = s.onInterim(8100, 'one two three four five').commit
    expect(cut).toMatchObject({ transcript: 'one two three four five', startT: 0, endT: 8100, segmentId: 'live-1' })
    expect(s.onInterim(8200, 'one two three four five').commit).toBeNull()
    const idle = s.onIdle(8500).commit
    expect(idle).toBeNull()
    const fin = s.onFinal(9000, 'one two three four five six seven').commit
    expect(fin).toMatchObject({ transcript: 'six seven', startT: 8100, endT: 9000, segmentId: 'live-2' })
    // next utterance starts fresh
    expect(s.onInterim(9500, 'new').pendingDelta).toBe('new')
  })

  it('a final with nothing new commits nothing', () => {
    const s = new Segmenter()
    s.onInterim(500, 'hello there friend again')
    s.onIdle(9000)
    expect(s.onFinal(9200, 'hello there friend again').commit).toBeNull()
  })

  it('segment timestamps are monotonic across utterances', () => {
    const s = new Segmenter({ maxSegmentMs: 1000, minSegmentWords: 1 })
    const a = s.onInterim(1100, 'a b').commit!
    const b = s.onFinal(1500, 'a b c').commit!
    const c = s.onInterim(2700, 'd e').commit!
    expect(a.endT).toBeLessThanOrEqual(b.startT)
    expect(b.endT).toBeLessThanOrEqual(c.startT)
  })
})

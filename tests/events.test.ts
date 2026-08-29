import { describe, it, expect } from 'vitest'
import { EventLog } from '../src/core/events'

describe('EventLog', () => {
  it('appends and preserves order', () => {
    const log = new EventLog()
    log.append({ type: 'sounding.dropped', t: 0, soundingId: 's1' })
    log.append({ type: 'segment.pending', t: 100, text: 'hello' })
    expect(log.all().map((e) => e.type)).toEqual(['sounding.dropped', 'segment.pending'])
  })

  it('rejects non-monotonic timestamps', () => {
    const log = new EventLog()
    log.append({ type: 'segment.pending', t: 200, text: 'a' })
    expect(() => log.append({ type: 'segment.pending', t: 100, text: 'b' })).toThrow(/monotonic/)
  })

  it('allows equal timestamps', () => {
    const log = new EventLog()
    log.append({ type: 'segment.pending', t: 100, text: 'a' })
    expect(() => log.append({ type: 'segment.pending', t: 100, text: 'b' })).not.toThrow()
  })

  it('round-trips through JSONL byte-identically', () => {
    const log = new EventLog()
    log.append({ type: 'sounding.dropped', t: 0, soundingId: 's1' })
    log.append({
      type: 'reading.changed', t: 100, transitions: [{ kind: 'appeared', conceptId: 'c1', label: 'sister' }],
      reading: { t: 100, slack: false, marks: [{ conceptId: 'c1', label: 'sister', prominence: 1, weight: 0.5 }] },
    })
    log.append({ type: 'sounding.surfaced', t: 200 })
    const jsonl = log.toJsonl()
    expect(EventLog.fromJsonl(jsonl).toJsonl()).toBe(jsonl)
  })
})

describe('fromJsonl validation', () => {
  const good = '{"type":"sounding.dropped","t":0,"soundingId":"s1"}'

  it('still round-trips valid logs', () => {
    expect(EventLog.fromJsonl(good).toJsonl()).toBe(good)
  })

  it('rejects invalid JSON with a line number', () => {
    expect(() => EventLog.fromJsonl(`${good}\nnot json`)).toThrow(/line 2: invalid JSON/)
  })

  it('rejects unknown event types', () => {
    expect(() => EventLog.fromJsonl('{"type":"mystery.event","t":0}')).toThrow(/line 1: unknown event type/)
  })

  it('rejects a missing or non-numeric t', () => {
    expect(() => EventLog.fromJsonl('{"type":"sounding.surfaced","t":"soon"}')).toThrow(/line 1: .*t/)
  })

  it('rejects missing required fields', () => {
    expect(() => EventLog.fromJsonl('{"type":"segment.committed","t":100,"segmentId":"s"}')).toThrow(/line 1: .*transcript/)
  })
})

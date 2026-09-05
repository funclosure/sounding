import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { EventLog } from '../src/core/events'

describe('live server, headless fixture run', () => {
  it('runs the circling fixture through the live path with a fake transcriber and writes a valid log', () => {
    const r = spawnSync('node_modules/.bin/tsx', ['src/live/server.ts', '--fixture', 'circling', '--fake-transcriber', '--speed', '30', '-i', 'recurrence', '--headless'], { encoding: 'utf8', timeout: 120_000 })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toBe('')
    const m = r.stdout.match(/wrote (soundings\/live-[^\s]+\.recurrence\.jsonl)/)
    expect(m, r.stdout).not.toBeNull()
    const path = m![1]
    expect(existsSync(path)).toBe(true)
    const log = EventLog.fromJsonl(readFileSync(path, 'utf8'))
    const events = log.all()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('sounding.dropped')
    expect(types.at(-1)).toBe('sounding.surfaced')
    expect(types.filter((t) => t === 'segment.committed').length).toBeGreaterThanOrEqual(3)
    expect(types.filter((t) => t === 'segment.pending').length).toBeGreaterThanOrEqual(10)
    const ticks = events.filter((e) => e.type === 'reading.changed').map((e) => e.t)
    expect(ticks.length).toBeGreaterThan(100)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBe(100)
    // No committed segment was ever dropped: every segment.committed is
    // immediately followed by its own candidates.emitted (the session's op
    // queue serializes processCommitted, so nothing else can log in between).
    events.forEach((e, i) => {
      if (e.type !== 'segment.committed') return
      const next = events[i + 1]
      expect(next?.type, `segment.committed ${e.segmentId} not followed by candidates.emitted`).toBe('candidates.emitted')
      expect(next && 'segmentId' in next ? next.segmentId : undefined).toBe(e.segmentId)
    })
    unlinkSync(path)
  }, 130_000)
})

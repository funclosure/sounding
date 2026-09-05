import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { EventLog } from '../src/core/events'

describe('live server, headless fixture run', () => {
  it('runs the circling fixture through the live path with a fake transcriber and writes a valid log', () => {
    const r = spawnSync('node_modules/.bin/tsx', ['src/live/server.ts', '--fixture', 'circling', '--fake-transcriber', '--speed', '30', '-i', 'recurrence', '--headless'], { encoding: 'utf8', timeout: 120_000 })
    expect(r.status, r.stderr).toBe(0)
    // Tolerate known-benign library noise (e.g. transformers/onnx dtype
    // warnings on stderr) but still fail on anything from our own [live] logging.
    const stderrLines = r.stderr.split('\n').filter((l) => l.trim() && !/transformers|onnx|dtype|warning/i.test(l))
    expect(stderrLines.join('\n')).toBe('')
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
    // No committed segment was ever dropped: every segment.committed has a
    // later candidates.emitted for the same segment. This is pairing, not
    // strict adjacency — the engine now interprets outside the op queue, so
    // reading.changed ticks (every 100ms) can land between the two events.
    events.forEach((e, i) => {
      if (e.type !== 'segment.committed') return
      const paired = events
        .slice(i + 1)
        .find((n) => n.type === 'candidates.emitted' && n.segmentId === e.segmentId && n.t >= e.t)
      expect(paired, `segment.committed ${e.segmentId} has no later candidates.emitted`).toBeDefined()
    })
    unlinkSync(path)
  }, 130_000)
})

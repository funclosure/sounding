import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createReplay } from '../src/replay/runner'
import { circling } from '../src/replay/fixtures/circling'
import { synonymDrift } from '../src/replay/fixtures/synonym-drift'
import { FIXTURES } from '../src/replay/fixtures/index'

describe('synonym-drift fixture (pinned v0 limitation)', () => {
  it('token identity splits one concept into multiple marks', async () => {
    const { session, runner } = createReplay(synonymDrift)
    await runner.runToEnd()
    const readings = session.log.all().filter((e) => e.type === 'reading.changed')
    const last = readings.at(-1)!
    if (last.type !== 'reading.changed') throw new Error('unreachable')
    const driftLabels = last.reading.marks
      .map((m) => m.label)
      .filter((l) => synonymDrift.truth.driftGroup!.includes(l))
    // v0 failure, documented: the same concept occupies >= 2 marks.
    // Slice 2 (embedding resolver) must flip this assertion to exactly 1.
    expect(driftLabels.length).toBeGreaterThanOrEqual(2)
  })
})

describe('determinism', () => {
  it('replaying the same fixture twice produces byte-identical logs', async () => {
    const a = createReplay(circling)
    await a.runner.runToEnd()
    const b = createReplay(circling)
    await b.runner.runToEnd()
    expect(a.session.log.toJsonl()).toBe(b.session.log.toJsonl())
  })

  it('registry holds all five fixtures', () => {
    expect(FIXTURES.map((f) => f.name).sort()).toEqual(
      ['circling', 'contention', 'slack', 'synonym-drift', 'topic-shift'],
    )
  })
})

describe('wall-clock guard', () => {
  it('the engine never reads wall clock or randomness', () => {
    const banned = /Date\.now|performance\.now|new Date\(|Math\.random/
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts') && banned.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
    // Pure engine only. src/providers, src/cli, src/ui are the I/O layer and exempt.
    // src/devserver and src/ui are intentionally outside this guard too — they are
    // the I/O boundary (dev API, browser mic capture, rAF loop); stampName(d) keeps
    // the clock injected so the pure name-formatting logic stays testable.
    for (const dir of ['src/core', 'src/salience', 'src/interpret', 'src/replay']) walk(dir)
    expect(offenders).toEqual([])
  })
})

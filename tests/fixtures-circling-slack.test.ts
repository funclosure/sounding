import { describe, it, expect } from 'vitest'
import { createReplay } from '../src/replay/runner'
import { circling } from '../src/replay/fixtures/circling'
import { slack } from '../src/replay/fixtures/slack'
import type { SoundingEvent } from '../src/core/events'

type ReadingEvent = Extract<SoundingEvent, { type: 'reading.changed' }>

async function run(script: typeof circling) {
  const { session, runner } = createReplay(script)
  await runner.runToEnd()
  const events = session.log.all()
  const readings = events.filter((e): e is ReadingEvent => e.type === 'reading.changed')
  return { events, readings, final: readings.at(-1)! }
}

describe('circling fixture', () => {
  it('sister surfaces by the truth deadline and persists to the end', async () => {
    const { readings, final } = await run(circling)
    const firstWithSister = readings.find((r) => r.reading.marks.some((m) => m.label === 'sister'))
    expect(firstWithSister).toBeDefined()
    expect(firstWithSister!.t).toBeLessThanOrEqual(circling.truth.surfacesBy!.sister)
    // persists: every reading after first appearance contains sister
    const after = readings.filter((r) => r.t >= firstWithSister!.t)
    for (const r of after) {
      expect(r.reading.marks.map((m) => m.label)).toContain('sister')
    }
    // finishes in the top 3 by prominence
    const rank = final.reading.marks.findIndex((m) => m.label === 'sister')
    expect(rank).toBeGreaterThanOrEqual(0)
    expect(rank).toBeLessThan(3)
  })

  it('capacity is never exceeded', async () => {
    const { readings } = await run(circling)
    for (const r of readings) expect(r.reading.marks.length).toBeLessThanOrEqual(7)
  })
})

describe('slack fixture', () => {
  it('nothing new appears during the silence', async () => {
    const { readings } = await run(slack)
    const appearedLate = readings
      .filter((r) => r.t > 26_000)
      .flatMap((r) => r.transitions)
      .filter((tr) => tr.kind === 'appeared')
    expect(appearedLate).toEqual([])
  })

  it('weights decay through the silence', async () => {
    const { readings } = await run(slack)
    const at25 = readings.find((r) => r.t === 25_000)!
    const atEnd = readings.at(-1)!
    const weightOf = (r: ReadingEvent, label: string) =>
      r.reading.marks.find((m) => m.label === label)?.weight ?? 0
    // 45s of silence at a 45s half-life halves the weight; 0.6 margin keeps
    // the assertion off the exact floating-point boundary.
    expect(weightOf(atEnd, 'tomatoe')).toBeLessThan(weightOf(at25, 'tomatoe') * 0.6)
  })

  it('slack turns on after the configured silence and was off during speech', async () => {
    const { readings } = await run(slack)
    expect(readings.find((r) => r.t === 20_000)!.reading.slack).toBe(false)
    expect(readings.at(-1)!.reading.slack).toBe(true)
  })
})

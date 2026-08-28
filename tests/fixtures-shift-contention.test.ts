import { describe, it, expect } from 'vitest'
import { createReplay } from '../src/replay/runner'
import { topicShift } from '../src/replay/fixtures/topic-shift'
import { contention } from '../src/replay/fixtures/contention'
import type { SoundingEvent } from '../src/core/events'
import type { FixtureScript } from '../src/replay/fixture'

type ReadingEvent = Extract<SoundingEvent, { type: 'reading.changed' }>

async function run(script: FixtureScript) {
  const { session, runner } = createReplay(script)
  await runner.runToEnd()
  const readings = session.log.all().filter((e): e is ReadingEvent => e.type === 'reading.changed')
  return { readings, final: readings.at(-1)! }
}

describe('topic-shift fixture', () => {
  it('no displacements before the shift', async () => {
    const { readings } = await run(topicShift)
    const before = readings
      .filter((r) => r.t < topicShift.truth.topicShiftAt!)
      .flatMap((r) => r.transitions)
      .filter((tr) => tr.kind === 'displaced')
    expect(before).toEqual([])
  })

  it('the new topic displaces the old one after the shift', async () => {
    const { readings, final } = await run(topicShift)
    const after = readings
      .filter((r) => r.t >= topicShift.truth.topicShiftAt!)
      .flatMap((r) => r.transitions)
      .filter((tr) => tr.kind === 'displaced')
    expect(after.length).toBeGreaterThanOrEqual(2)
    const phase2 = ['offer', 'relocation', 'team', 'deadline']
    const finalLabels = final.reading.marks.map((m) => m.label)
    const phase2OnChart = finalLabels.filter((l) => phase2.includes(l))
    expect(phase2OnChart.length).toBeGreaterThanOrEqual(2)
  })
})

describe('contention fixture', () => {
  it('marks never exceed capacity 4', async () => {
    const { readings } = await run(contention)
    for (const r of readings) expect(r.reading.marks.length).toBeLessThanOrEqual(4)
  })

  it('at least 6 distinct concepts appear over the session', async () => {
    const { readings } = await run(contention)
    const appeared = new Set(
      readings.flatMap((r) => r.transitions).filter((tr) => tr.kind === 'appeared')
        .map((tr) => (tr.kind === 'appeared' ? tr.label : '')),
    )
    expect(appeared.size).toBeGreaterThanOrEqual(6)
  })

  it('displacement happens under contention', async () => {
    const { readings } = await run(contention)
    const displaced = readings.flatMap((r) => r.transitions).filter((tr) => tr.kind === 'displaced')
    expect(displaced.length).toBeGreaterThanOrEqual(2)
  })
})

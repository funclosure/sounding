import { describe, it, expect } from 'vitest'
import { createReplay } from '../src/replay/runner'
import { synonymDrift } from '../src/replay/fixtures/synonym-drift'
import { contention } from '../src/replay/fixtures/contention'
import { EmbeddingIdentityResolver } from '../src/providers/embedding-identity'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import type { SoundingEvent } from '../src/core/events'

type ReadingEvent = Extract<SoundingEvent, { type: 'reading.changed' }>

async function runWithEmbeddings(script: typeof synonymDrift) {
  const resolver = new EmbeddingIdentityResolver(DEFAULT_SALIENCE_CONFIG.similarityThreshold)
  const { session, runner } = createReplay(script, { resolver })
  await runner.runToEnd()
  const readings = session.log.all().filter((e): e is ReadingEvent => e.type === 'reading.changed')
  return { readings, final: readings.at(-1)! }
}

describe('embedding resolver acceptance pair', () => {
  it('synonym drift collapses to exactly one mark (the slice-2 flip)', { timeout: 180_000 }, async () => {
    const { final } = await runWithEmbeddings(synonymDrift)
    const driftMarks = final.reading.marks.filter((m) =>
      synonymDrift.truth.driftGroup!.some((g) => m.label.includes(g) || g.includes(m.label)),
    )
    expect(driftMarks).toHaveLength(1)
  })

  it('contention stays distinct — no false merges', { timeout: 180_000 }, async () => {
    const { readings } = await runWithEmbeddings(contention)
    const appeared = new Set(
      readings
        .flatMap((r) => r.transitions)
        .filter((tr) => tr.kind === 'appeared')
        .map((tr) => (tr.kind === 'appeared' ? tr.label : '')),
    )
    // the nine worries must not collapse into each other
    expect(appeared.size).toBeGreaterThanOrEqual(6)
    for (const r of readings) expect(r.reading.marks.length).toBeLessThanOrEqual(4)
  })
})

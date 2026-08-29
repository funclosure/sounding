import { describe, it, expect } from 'vitest'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { ConceptCandidate } from '../src/core/types'

function cand(label: string, strength = 1, confidence = 1): ConceptCandidate {
  return { label, strength, confidence, source: 'test', segmentId: 's1' }
}
function makeDynamics(overrides: Partial<typeof DEFAULT_SALIENCE_CONFIG> = {}) {
  return new ReadingDynamics(new TokenIdentityResolver(), { ...DEFAULT_SALIENCE_CONFIG, ...overrides })
}

describe('ReadingDynamics core', () => {
  it('surfaces a new concept with an appeared transition', async () => {
    const d = makeDynamics()
    await d.applyCandidates(1000, [cand('sister')])
    const { transitions, reading } = d.tick(1100)
    expect(transitions).toContainEqual({ kind: 'appeared', conceptId: 'c1', label: 'sister' })
    expect(reading.marks.map((m) => m.label)).toEqual(['sister'])
  })

  it('accumulates weight into the same concept via the resolver', async () => {
    const d = makeDynamics()
    await d.applyCandidates(1000, [cand('sister')])
    await d.applyCandidates(2000, [cand('sisters')]) // plural folds to same concept
    const { reading } = d.tick(2100)
    expect(reading.marks).toHaveLength(1)
    expect(reading.marks[0].weight).toBeGreaterThan(1)
  })

  it('never surfaces more than capacity', async () => {
    const d = makeDynamics({ capacity: 3 })
    await d.applyCandidates(1000, ['a1', 'b2', 'c3', 'd4', 'e5'].map((l) => cand(l)))
    const { reading } = d.tick(1100)
    expect(reading.marks).toHaveLength(3)
  })

  it('never surfaces a concept below the confidence floor', async () => {
    const d = makeDynamics({ confidenceFloor: 0.5 })
    await d.applyCandidates(1000, [cand('whisper', 1, 0.2), cand('solid', 1, 0.9)])
    const { reading } = d.tick(1100)
    expect(reading.marks.map((m) => m.label)).toEqual(['solid'])
  })

  it('decays weight exponentially with the configured half-life', async () => {
    const d = makeDynamics({ halfLifeMs: 10_000 })
    await d.applyCandidates(0, [cand('fading')])
    const w0 = d.tick(100).reading.marks[0].weight
    const w1 = d.tick(10_100).reading.marks[0].weight
    expect(w1).toBeCloseTo(w0 / 2, 5)
  })

  it('prominence is field-relative and sums to 1', async () => {
    const d = makeDynamics()
    await d.applyCandidates(1000, [cand('big', 1, 1), cand('small', 0.25, 1)])
    const { reading } = d.tick(1100)
    const total = reading.marks.reduce((s, m) => s + m.prominence, 0)
    expect(total).toBeCloseTo(1, 9)
    expect(reading.marks[0].label).toBe('big')
    expect(reading.marks[0].prominence).toBeGreaterThan(reading.marks[1].prominence)
  })

  it('reports slack after silence and not before', async () => {
    const d = makeDynamics({ slackAfterMs: 5000 })
    await d.applyCandidates(1000, [cand('sister')])
    expect(d.tick(2000).reading.slack).toBe(false)
    expect(d.tick(7000).reading.slack).toBe(true)
  })

  it('is deterministic across identical runs', async () => {
    const run = async () => {
      const d = makeDynamics()
      await d.applyCandidates(1000, [cand('a1'), cand('b2')])
      await d.applyCandidates(2000, [cand('b2'), cand('c3')])
      return JSON.stringify(d.tick(2100))
    }
    expect(await run()).toBe(await run())
  })
})

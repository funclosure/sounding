import { describe, it, expect } from 'vitest'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { ConceptCandidate, Transition } from '../src/core/types'

function cand(label: string, strength = 1, confidence = 1): ConceptCandidate {
  return { label, strength, confidence, source: 'test', segmentId: 's1' }
}
const CFG = { ...DEFAULT_SALIENCE_CONFIG, capacity: 2, hysteresisMargin: 0.15, hysteresisTicks: 3, tickMs: 100 }

async function makeFull() {
  const d = new ReadingDynamics(new TokenIdentityResolver(), CFG)
  await d.applyCandidates(1000, [cand('alpha', 1), cand('beta', 0.4)])
  d.tick(1100) // alpha and beta fill both slots
  return d
}

describe('hysteresis displacement', () => {
  it('a challenger below the margin never displaces', async () => {
    const d = await makeFull()
    // gamma's weight ends up between beta and beta * 1.15
    await d.applyCandidates(1200, [cand('gamma', 0.42)])
    const all: Transition[] = []
    for (let t = 1300; t <= 3000; t += 100) all.push(...d.tick(t).transitions)
    expect(all.filter((tr) => tr.kind === 'displaced')).toEqual([])
  })

  it('a challenger above the margin displaces only after the streak completes', async () => {
    const d = await makeFull()
    await d.applyCandidates(1200, [cand('gamma', 0.9)]) // well above beta * 1.15
    const t1 = d.tick(1300).transitions
    const t2 = d.tick(1400).transitions
    const t3 = d.tick(1500).transitions // 3rd qualifying tick -> displacement
    expect([...t1, ...t2].filter((tr) => tr.kind === 'displaced')).toEqual([])
    const displaced = t3.filter((tr) => tr.kind === 'displaced')
    expect(displaced).toHaveLength(1)
    expect(displaced[0]).toMatchObject({ kind: 'displaced', label: 'beta' })
    expect(t3).toContainEqual(expect.objectContaining({ kind: 'appeared', label: 'gamma' }))
  })

  it('an interrupted streak resets', async () => {
    const d = await makeFull()
    await d.applyCandidates(1200, [cand('gamma', 0.9)])
    d.tick(1300); d.tick(1400) // 2 qualifying ticks
    await d.applyCandidates(1450, [cand('beta', 1)]) // beta re-supported, gamma no longer qualifies
    d.tick(1500) // streak resets
    await d.applyCandidates(1550, [cand('gamma', 0.2)])
    const all: Transition[] = []
    for (let t = 1600; t <= 1800; t += 100) all.push(...d.tick(t).transitions)
    expect(all.filter((tr) => tr.kind === 'displaced')).toEqual([])
  })

  it('at most one displacement per tick', async () => {
    const d = await makeFull()
    await d.applyCandidates(1200, [cand('gamma', 0.9), cand('delta', 0.95)])
    for (let t = 1300; t <= 2000; t += 100) {
      const displaced = d.tick(t).transitions.filter((tr) => tr.kind === 'displaced')
      expect(displaced.length).toBeLessThanOrEqual(1)
    }
  })
})

describe('fast-loop nudges', () => {
  it('pending text mentioning a surfaced concept nudges its weight', async () => {
    const d = await makeFull()
    const before = d.tick(1200).reading.marks.find((m) => m.label === 'alpha')!.weight
    d.nudge(1250, 'talking about alpha again right now')
    const res = d.tick(1300)
    const after = res.reading.marks.find((m) => m.label === 'alpha')!.weight
    expect(after).toBeGreaterThan(before * Math.pow(2, -100 / CFG.halfLifeMs)) // grew despite decay
    expect(res.transitions).toContainEqual(
      expect.objectContaining({ kind: 'nudged', delta: CFG.nudgeFactor }),
    )
  })

  it('pending text does NOT create new concepts', async () => {
    const d = await makeFull()
    d.nudge(1250, 'something entirely new like zeppelins')
    const { reading } = d.tick(1300)
    expect(reading.marks.map((m) => m.label).sort()).toEqual(['alpha', 'beta'])
  })
})

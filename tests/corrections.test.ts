// The speaker's corrections: dismiss, restore, rename (and rename-as-merge),
// from the salience engine up through the session log, the hints the
// interpreter sees, and the page's pure model.
import { describe, it, expect } from 'vitest'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import { EmbeddingIdentityResolver } from '../src/providers/embedding-identity'
import { SoundingSession } from '../src/core/session'
import { EventLog } from '../src/core/events'
import { hintBlock } from '../src/providers/hints'
import { validLabel } from '../src/live/server'
import { diffReadings, laneSeries, type ReadingSnapshot } from '../src/ui/board/model'
import type { ConceptCandidate } from '../src/core/types'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../src/interpret/port'

const cand = (label: string, strength = 1, confidence = 1): ConceptCandidate => ({ label, strength, confidence, source: 'test', segmentId: 's1' })
const dynamics = () => new ReadingDynamics(new TokenIdentityResolver(), { ...DEFAULT_SALIENCE_CONFIG })
const labels = (d: ReadingDynamics, t: number) => d.tick(t).reading.marks.map((m) => m.label)

describe('ReadingDynamics — dismiss and restore', () => {
  it('takes a dismissed mark off the board with a dismissed transition', async () => {
    const d = dynamics()
    await d.applyCandidates(1000, [cand('sorting board'), cand('sister')])
    d.tick(1100)
    expect(d.dismiss(1200, 'c1')).toBe('sorting board')
    const { transitions, reading } = d.tick(1300)
    expect(transitions).toContainEqual({ kind: 'dismissed', conceptId: 'c1', label: 'sorting board' })
    expect(reading.marks.map((m) => m.label)).toEqual(['sister'])
  })

  it('keeps it off when the same thing is reported again, however strongly', async () => {
    const d = dynamics()
    await d.applyCandidates(1000, [cand('sorting board')])
    d.tick(1100)
    d.dismiss(1200, 'c1')
    await d.applyCandidates(2000, [cand('sorting boards', 1, 1), cand('sorting board', 1, 1)])
    expect(labels(d, 2100)).toEqual([])
    // and no fresh concept was minted for it either
    await d.applyCandidates(3000, [cand('sister')])
    expect(d.tick(3100).reading.marks.map((m) => m.conceptId)).toEqual(['c2'])
  })

  it('brings a restored mark back to compete with the weight it has left', async () => {
    const d = dynamics()
    await d.applyCandidates(1000, [cand('sorting board')])
    d.tick(1100)
    d.dismiss(1200, 'c1')
    d.tick(1300)
    expect(d.restore(1400, 'c1')).toBe('sorting board')
    const { transitions, reading } = d.tick(1500)
    expect(transitions).toContainEqual({ kind: 'restored', conceptId: 'c1', label: 'sorting board' })
    expect(reading.marks.map((m) => m.label)).toEqual(['sorting board'])
  })

  it('answers null for an unknown id, a second dismiss, and a restore of something not dismissed', async () => {
    const d = dynamics()
    await d.applyCandidates(1000, [cand('sister')])
    expect(d.dismiss(1100, 'nope')).toBeNull()
    expect(d.restore(1100, 'c1')).toBeNull()
    expect(d.dismiss(1100, 'c1')).toBe('sister')
    expect(d.dismiss(1200, 'c1')).toBeNull()
  })
})

describe('ReadingDynamics — rename', () => {
  it('changes the label in place and keeps weight and id', async () => {
    const d = dynamics()
    await d.applyCandidates(1000, [cand('sorting board')])
    const before = d.tick(1100).reading.marks[0]
    expect(d.rename(1100, 'c1', '  sounding board ')).toEqual({ from: 'sorting board', to: 'sounding board', mergedInto: null })
    const { transitions, reading } = d.tick(1200)
    expect(transitions).toContainEqual({ kind: 'renamed', conceptId: 'c1', from: 'sorting board', to: 'sounding board' })
    expect(reading.marks.map((m) => [m.conceptId, m.label])).toEqual([['c1', 'sounding board']])
    expect(reading.marks[0].weight).toBeGreaterThan(before.weight * 0.9)
  })

  it('still catches the old label afterwards — the next mishearing lands on the corrected mark', async () => {
    const d = dynamics()
    await d.applyCandidates(1000, [cand('sorting board')])
    d.rename(1100, 'c1', 'sounding board')
    await d.applyCandidates(2000, [cand('sorting board'), cand('sounding board')])
    const { reading } = d.tick(2100)
    expect(reading.marks.map((m) => m.label)).toEqual(['sounding board'])
    expect(reading.marks[0].weight).toBeGreaterThan(2)
  })

  it('merges into the concept that already has the new label', async () => {
    const d = dynamics()
    await d.applyCandidates(1000, [cand('sounding board', 0.5), cand('sorting board', 0.8)])
    d.tick(1100)
    expect(d.rename(1200, 'c2', 'Sounding Board')).toEqual({ from: 'sorting board', to: 'sounding board', mergedInto: 'c1' })
    const { transitions, reading } = d.tick(1300)
    expect(transitions).toContainEqual({ kind: 'merged', fromConceptId: 'c2', intoConceptId: 'c1' })
    expect(reading.marks).toHaveLength(1)
    expect(reading.marks[0].weight).toBeGreaterThan(1.2)
    // the absorbed label is an alias of the survivor now
    await d.applyCandidates(2000, [cand('sorting board')])
    expect(d.tick(2100).reading.marks).toHaveLength(1)
  })

  it('answers null when nothing would change', async () => {
    const d = dynamics()
    await d.applyCandidates(1000, [cand('sister')])
    expect(d.rename(1100, 'c1', 'sister')).toBeNull()
    expect(d.rename(1100, 'c1', '   ')).toBeNull()
    expect(d.rename(1100, 'nope', 'x')).toBeNull()
    d.dismiss(1100, 'c1')
    expect(d.rename(1200, 'c1', 'brother')).toBeNull()
  })
})

describe('EmbeddingIdentityResolver — aliases', () => {
  it('resolves a candidate to a renamed concept through its old label', async () => {
    const r = new EmbeddingIdentityResolver(DEFAULT_SALIENCE_CONFIG.similarityThreshold)
    const base = { weight: 1, confidence: 1, firstSeenT: 0, lastSupportT: 0 }
    const plain = [{ id: 'c1', label: 'Anneke', ...base }]
    const aliased = [{ id: 'c1', label: 'Anneke', aliases: ['a neck'], ...base }]
    expect(await r.resolve(cand('a neck'), aliased)).toBe('c1')
    expect(await r.resolve(cand('quarterly budget'), aliased)).toBeNull()
    // and the alias is what made the difference
    expect(await r.resolve(cand('a neck'), plain)).toBeNull()
  }, 30_000)
})

class Capturing implements Interpreter {
  readonly id = 'capturing'
  readonly input = 'transcript' as const
  readonly seen: InterpreterInput[] = []
  constructor(private readonly out: string[] = []) {}
  interpret(input: InterpreterInput): Promise<InterpretationResult> {
    this.seen.push(input)
    return Promise.resolve({ candidates: this.out.map((label) => ({ label, strength: 0.9, confidence: 0.9, source: this.id, segmentId: input.segmentId })), costUsd: 0, latencyMs: 0 })
  }
}
function session(interp: Interpreter) {
  const cfg = { ...DEFAULT_SALIENCE_CONFIG }
  const s = new SoundingSession(interp, new ReadingDynamics(new TokenIdentityResolver(), cfg), cfg, 'corrections-test')
  s.drop()
  return s
}
const seg = (id: string, t: number) => ({ segmentId: id, transcript: 'some words', startT: t - 3000, endT: t })
const types = (s: SoundingSession) => s.log.all().filter((e) => e.type.startsWith('mark.')).map((e) => e.type)

describe('SoundingSession — corrections', () => {
  it('logs a dismissal, tells the interpreter, and lets go of the mark if it was followed', async () => {
    const interp = new Capturing(['sorting board', 'sister'])
    const s = session(interp)
    await s.feedCommitted(1000, seg('a', 1000))
    await s.setFollow(1500, 'c1', 'sorting board')
    expect(await s.dismissMark(2000, 'c1')).toBe('sorting board')
    expect(types(s)).toEqual(['mark.followed', 'mark.dismissed', 'mark.followed'])
    expect(s.log.all().at(-1)).toEqual({ type: 'mark.followed', t: 2000, conceptId: null, label: null })
    await s.feedCommitted(3000, seg('b', 3000))
    expect(interp.seen[1].hints).toEqual({ dismissed: ['sorting board'] })
    const last = [...s.log.all()].reverse().find((e) => e.type === 'reading.changed')
    expect(last?.type === 'reading.changed' && last.reading.marks.map((m) => m.label)).toEqual(['sister'])
  })

  it('drops the hint again on restore, and logs nothing for a correction that changed nothing', async () => {
    const interp = new Capturing(['sorting board'])
    const s = session(interp)
    await s.feedCommitted(1000, seg('a', 1000))
    await s.dismissMark(2000, 'c1')
    expect(await s.restoreMark(2500, 'c1')).toBe('sorting board')
    expect(await s.restoreMark(2600, 'c1')).toBeNull()
    expect(await s.dismissMark(2700, 'nope')).toBeNull()
    expect(await s.renameMark(2800, 'c1', 'sorting board')).toBeNull()
    expect(types(s)).toEqual(['mark.dismissed', 'mark.restored'])
    await s.feedCommitted(3000, seg('b', 3000))
    expect(interp.seen[1].hints).toBeUndefined()
  })

  it('logs a rename, hints the correction, and keeps following under the new label', async () => {
    const interp = new Capturing(['sorting board'])
    const s = session(interp)
    await s.feedCommitted(1000, seg('a', 1000))
    await s.setFollow(1500, 'c1', 'sorting board')
    expect(await s.renameMark(2000, 'c1', 'sounding board')).toEqual({ from: 'sorting board', to: 'sounding board', mergedInto: null })
    expect(s.log.all().find((e) => e.type === 'mark.renamed')).toEqual({ type: 'mark.renamed', t: 2000, conceptId: 'c1', from: 'sorting board', to: 'sounding board', mergedInto: null })
    await s.feedCommitted(3000, seg('b', 3000))
    expect(interp.seen[1].hints).toEqual({ follow: 'sounding board', corrections: [{ from: 'sorting board', to: 'sounding board' }] })
  })

  it('round-trips the new events through the log', async () => {
    const s = session(new Capturing(['sorting board', 'sounding board']))
    await s.feedCommitted(1000, seg('a', 1000))
    await s.dismissMark(1500, 'c1')
    await s.restoreMark(1600, 'c1')
    await s.renameMark(2000, 'c1', 'sounding board')
    const again = EventLog.fromJsonl(s.log.toJsonl())
    expect(again.all()).toEqual(s.log.all())
    expect(again.all().find((e) => e.type === 'mark.renamed')).toMatchObject({ mergedInto: 'c2' })
    expect(() => EventLog.fromJsonl('{"type":"mark.renamed","t":1,"conceptId":"c1","from":"a"}')).toThrow(/missing required field/)
  })
})

describe('hintBlock — corrections', () => {
  it('lists corrections and dismissals for the model', () => {
    const b = hintBlock({ corrections: [{ from: 'sorting board', to: 'sounding board' }], dismissed: ['thank you'] })
    expect(b).toContain('"sorting board" → "sounding board"')
    expect(b).toMatch(/dismissed these as wrong[\s\S]*"thank you"/)
    expect(hintBlock({ corrections: [], dismissed: [] })).toBe('')
  })
})

describe('validLabel', () => {
  it('accepts a trimmed one-line label within the cap, and nothing else', () => {
    expect(validLabel('  sounding board ')).toBe('sounding board')
    expect(validLabel('x'.repeat(60))).toHaveLength(60)
    expect(validLabel('x'.repeat(61))).toBeNull()
    expect(validLabel('   ')).toBeNull()
    expect(validLabel('two\nlines')).toBeNull()
    expect(validLabel(42)).toBeNull()
  })
})

describe('page model — corrections', () => {
  const snap = (t: number, marks: Array<[string, string]>, transitions: ReadingSnapshot['transitions'] = []): ReadingSnapshot =>
    ({ t, slack: false, transitions, marks: marks.map(([id, label]) => ({ id, label, p: 1 / marks.length })) })

  it('names a dismissed mark as dismissed, not faded', () => {
    const d = diffReadings(snap(0, [['c1', 'sorting board'], ['c2', 'sister']]), snap(100, [['c2', 'sister']], [{ kind: 'dismissed', conceptId: 'c1', label: 'sorting board' }]))
    expect(d.departed).toEqual([{ id: 'c1', reason: 'dismissed' }])
  })

  it('gives a lane its concept\'s latest label', () => {
    const lanes = laneSeries([snap(0, [['c1', 'sorting board']]), snap(100, [['c1', 'sounding board']])], 200)
    expect(lanes.map((l) => [l.id, l.label, l.firstT])).toEqual([['c1', 'sounding board', 0]])
  })
})

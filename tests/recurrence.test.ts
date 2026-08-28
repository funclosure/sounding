import { describe, it, expect } from 'vitest'
import { RecurrenceInterpreter } from '../src/interpret/recurrence'
import type { Transcript } from '../src/interpret/port'

function seg(id: string, text: string): Transcript {
  return { kind: 'transcript', segmentId: id, text, startT: 0, endT: 4000 }
}

describe('RecurrenceInterpreter', () => {
  it('emits no candidates below minCount', async () => {
    const interp = new RecurrenceInterpreter()
    const r = await interp.interpret(seg('s1', 'the garden needs water'))
    expect(r.candidates).toEqual([])
    expect(r.costUsd).toBe(0)
    expect(r.latencyMs).toBe(0)
  })

  it('surfaces recurring words across the window', async () => {
    const interp = new RecurrenceInterpreter()
    await interp.interpret(seg('s1', 'my sister called about the offer'))
    const r = await interp.interpret(seg('s2', 'my sister thinks the offer is fine'))
    const labels = r.candidates.map((c) => c.label)
    expect(labels).toContain('sister')
    expect(labels).toContain('offer')
  })

  it('counts recurrence within a single segment', async () => {
    const interp = new RecurrenceInterpreter()
    const r = await interp.interpret(seg('s1', 'the rent went up and the rent was already high'))
    expect(r.candidates.map((c) => c.label)).toContain('rent')
  })

  it('emits bigrams for adjacent recurring pairs', async () => {
    const interp = new RecurrenceInterpreter()
    await interp.interpret(seg('s1', 'the job offer arrived, the job offer looks good'))
    const r = await interp.interpret(seg('s2', 'signing the job offer today'))
    expect(r.candidates.map((c) => c.label)).toContain('job offer')
  })

  it('forgets segments outside the window', async () => {
    const interp = new RecurrenceInterpreter({ windowSegments: 2 })
    await interp.interpret(seg('s1', 'sister sister sister'))
    await interp.interpret(seg('s2', 'garden fence shade'))
    const r = await interp.interpret(seg('s3', 'tomato basil sun'))
    expect(r.candidates.map((c) => c.label)).not.toContain('sister')
  })

  it('is deterministic: candidates sorted by strength then label', async () => {
    const a = new RecurrenceInterpreter()
    const b = new RecurrenceInterpreter()
    const texts = ['the offer and my sister', 'the offer and my sister again today']
    let ra, rb
    for (const t of texts) {
      ra = await a.interpret(seg('x', t))
      rb = await b.interpret(seg('x', t))
    }
    expect(ra).toEqual(rb)
  })

  it('rejects audio input for now', async () => {
    const interp = new RecurrenceInterpreter()
    const audio = { kind: 'audio' as const, segmentId: 'a1', samples: new Float32Array(0), sampleRate: 16000, startT: 0, endT: 0 }
    await expect(interp.interpret(audio)).rejects.toThrow(/transcript/)
  })
})

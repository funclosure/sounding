import { describe, it, expect } from 'vitest'
import { whisperJsonToFixtureScript } from '../src/providers/whisper-transcription'

const sample = {
  transcription: [
    { offsets: { from: 0, to: 3200 }, text: ' So I got the offer letter yesterday.' },
    { offsets: { from: 3200, to: 3200 }, text: ' Hm.' }, // zero-length segment
    { offsets: { from: 3400, to: 7100 }, text: '   ' }, // whitespace-only
    { offsets: { from: 7200, to: 11000 }, text: ' The salary was never the problem.' },
  ],
}

describe('whisperJsonToFixtureScript', () => {
  it('maps offsets to segment times and trims text', () => {
    const script = whisperJsonToFixtureScript(sample, 'memo1')
    expect(script.name).toBe('memo1')
    expect(script.segments[0]).toEqual({ startT: 0, endT: 3200, text: 'So I got the offer letter yesterday.' })
  })

  it('drops whitespace-only segments and enforces a minimum duration', () => {
    const script = whisperJsonToFixtureScript(sample, 'memo1')
    expect(script.segments).toHaveLength(3)
    const hm = script.segments[1]
    expect(hm.text).toBe('Hm.')
    expect(hm.endT - hm.startT).toBeGreaterThanOrEqual(100)
  })

  it('pads endT past the last segment', () => {
    const script = whisperJsonToFixtureScript(sample, 'memo1')
    expect(script.endT).toBe(11000 + 2000)
  })

  it('handles an empty transcription', () => {
    const script = whisperJsonToFixtureScript({ transcription: [] }, 'empty')
    expect(script.segments).toEqual([])
    expect(script.endT).toBe(2000)
  })
})

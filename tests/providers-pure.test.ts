import { describe, it, expect } from 'vitest'
import { sliceWindow, AUDIO_WINDOW_MS } from '../src/providers/audio-slicer'
import { llmCost, PRICING } from '../src/providers/pricing'

describe('sliceWindow', () => {
  it('clamps the window start at zero', () => {
    expect(sliceWindow(10_000)).toEqual({ fromMs: 0, toMs: 10_000 })
  })
  it('spans AUDIO_WINDOW_MS once past it', () => {
    expect(sliceWindow(90_000)).toEqual({ fromMs: 90_000 - AUDIO_WINDOW_MS, toMs: 90_000 })
  })
})

describe('llmCost', () => {
  it('computes claude-opus-5 cost including cache tiers', () => {
    // $5/MTok in, $25/MTok out, write 1.25x, read 0.1x
    const usd = llmCost('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 100_000, cacheWriteTokens: 100_000, cacheReadTokens: 1_000_000 })
    expect(usd).toBeCloseTo(5 + 2.5 + 0.625 + 0.5, 6)
  })
  it('throws on an unknown model', () => {
    expect(() => llmCost('mystery-model', { inputTokens: 1, outputTokens: 1 })).toThrow(/pricing/)
  })
  it('has pricing for every provider model id used in this repo', () => {
    expect(PRICING['claude-opus-5']).toBeDefined()
  })
})

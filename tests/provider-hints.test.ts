import { describe, it, expect } from 'vitest'
import { hintBlock } from '../src/providers/hints'
import { buildUserPrompt, SYSTEM_PROMPT } from '../src/providers/claude-extraction'
import { buildGeminiRequest, AUDIO_PROMPT } from '../src/providers/gemini-audio'
import type { AudioSegment } from '../src/interpret/port'

const CONTEXT_SENTENCE =
  'Context the speaker brought before talking. Names and terms here are likely to recur: use their exact spelling as labels. This context is NOT evidence of anything said — never report a concept only because it appears here.'
const FILLER_CLAUSE = ', the language being spoken, or whether the listener understands it'

describe('hintBlock', () => {
  it('is empty for no hints', () => {
    expect(hintBlock(undefined)).toBe('')
    expect(hintBlock({})).toBe('')
  })

  it('renders exactly the context block', () => {
    expect(hintBlock({ context: 'Trust Wallet' })).toBe(`${CONTEXT_SENTENCE}\nTrust Wallet`)
  })

  it('renders exactly the follow block', () => {
    expect(hintBlock({ follow: 'work-life balance' })).toBe(
      'The speaker is following "work-life balance". If the talk touches it, report it and its evidence attentively. Do not invent support for it.',
    )
  })

  it('joins both blocks with a blank line, context first', () => {
    const block = hintBlock({ context: 'Trust Wallet', follow: 'work-life balance' })
    expect(block).toBe(
      `${CONTEXT_SENTENCE}\nTrust Wallet\n\nThe speaker is following "work-life balance". If the talk touches it, report it and its evidence attentively. Do not invent support for it.`,
    )
  })

  it('trims context beyond 1200 chars with an ellipsis', () => {
    const long = 'x'.repeat(1300)
    const block = hintBlock({ context: long })
    expect(block).toBe(`${CONTEXT_SENTENCE}\n${'x'.repeat(1200)}…`)
  })

  it('ignores blank-only hints', () => {
    expect(hintBlock({ context: '   ', follow: '  ' })).toBe('')
  })
})

describe('claude buildUserPrompt with hints', () => {
  it('is unchanged when hints are absent', () => {
    const p = buildUserPrompt(['old', 'new'])
    expect(p).toBe('Recent talk (oldest first):\nold\n\nNewest segment (interpret it in the context of the above):\nnew')
    expect(p).toBe(buildUserPrompt(['old', 'new'], undefined))
  })

  it('appends the hint block when hints are present', () => {
    const p = buildUserPrompt(['old', 'new'], { context: 'Trust Wallet' })
    expect(p.endsWith(`\n\n${hintBlock({ context: 'Trust Wallet' })}`)).toBe(true)
  })

  it('includes the language-as-discourse clause', () => {
    expect(SYSTEM_PROMPT).toContain(`the act of talking itself${FILLER_CLAUSE}`)
  })
})

describe('gemini buildGeminiRequest with hints', () => {
  const base: AudioSegment = { kind: 'audio', segmentId: 's1', mimeType: 'audio/mpeg', data: new Uint8Array([1, 2]), startT: 0, endT: 1000 }

  it('leaves the text part unchanged when hints are absent', () => {
    const req = buildGeminiRequest(base) as { contents: Array<{ parts: Array<{ text?: string }> }> }
    const text = req.contents[0].parts[0].text
    expect(text).toBe(AUDIO_PROMPT)
  })

  it('appends the hint block to the end of the text part, after the prompt and before the audio part', () => {
    const audio: AudioSegment = { ...base, hints: { context: 'Trust Wallet' } }
    const req = buildGeminiRequest(audio) as { contents: Array<{ parts: Array<Record<string, unknown>> }> }
    const parts = req.contents[0].parts
    expect(parts).toHaveLength(2)
    expect(typeof parts[0].text).toBe('string')
    expect((parts[0].text as string).endsWith(`\n\n${hintBlock({ context: 'Trust Wallet' })}`)).toBe(true)
    expect('inlineData' in parts[1] || 'inline_data' in parts[1]).toBe(true)
  })

  it('includes the language-as-discourse clause', () => {
    expect(AUDIO_PROMPT).toContain(`the act of talking itself${FILLER_CLAUSE}`)
  })
})

import { describe, it, expect } from 'vitest'
import { buildGeminiRequest, extractGeminiJson } from '../src/providers/gemini-audio'
import type { AudioSegment } from '../src/interpret/port'

const audio: AudioSegment = { kind: 'audio', segmentId: 's1', mimeType: 'audio/mpeg', data: new Uint8Array([104, 105]), startT: 0, endT: 4000 }

describe('buildGeminiRequest', () => {
  it('inlines base64 audio and constrains the response to JSON', () => {
    const req = buildGeminiRequest(audio) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>
      generationConfig: Record<string, unknown>
    }
    const parts = req.contents[0].parts
    const inline = parts.find((p) => 'inline_data' in p || 'inlineData' in p) as Record<string, { mime_type?: string; mimeType?: string; data: string }>
    const blob = inline.inline_data ?? inline.inlineData
    expect(blob.data).toBe(Buffer.from([104, 105]).toString('base64'))
    expect(blob.mime_type ?? blob.mimeType).toBe('audio/mpeg')
    expect(parts.some((p) => typeof p.text === 'string' && (p.text as string).includes('hesitation'))).toBe(true)
    expect(JSON.stringify(req.generationConfig)).toContain('application/json')
  })
})

describe('extractGeminiJson', () => {
  it('pulls the JSON text out of a generateContent response', () => {
    const body = { candidates: [{ content: { parts: [{ text: '{"candidates":[{"label":"sister","strength":0.9,"confidence":0.8}]}' }] } }] }
    expect(extractGeminiJson(body)).toEqual({ candidates: [{ label: 'sister', strength: 0.9, confidence: 0.8 }] })
  })
  it('returns an empty payload on malformed bodies', () => {
    expect(extractGeminiJson({})).toEqual({ candidates: [] })
    expect(extractGeminiJson({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] })).toEqual({ candidates: [] })
  })
})

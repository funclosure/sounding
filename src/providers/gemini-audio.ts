// Audio-native interpretation: the model hears the window — emphasis,
// hesitation, pace — instead of reading a transcript of it. This is the
// brief's central architecture bet, run behind the same port as the
// transcript path so the two can be A/B'd on identical capture events.
import { mapCandidates } from './candidates'
import { llmCost } from './pricing'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../interpret/port'
import type { AudioSegment } from '../interpret/port'

// Verified against ai.google.dev/gemini-api/docs/generate-content/audio and
// ai.google.dev/gemini-api/docs/pricing on 2026-08-29 (Task 14 Step 1):
// gemini-3.7-flash is the current flagship flash-tier model and the one used
// throughout the official audio-understanding guide's REST/Python/JS samples.
export const GEMINI_MODEL = 'gemini-3.7-flash'

const AUDIO_PROMPT = `You are listening to a stretch of one person thinking aloud. Report concept candidates — what this talk is actually about or keeps returning to.

Attend to the signals a transcript loses: emphasis, hesitation, pace changes, repetition with stress, the thing the voice keeps circling back to. Something said quickly in passing matters less than something said slowly, repeated, or stumbled over.

Rules:
- Labels are short (1-4 words), in the speaker's own vocabulary where possible.
- strength (0 to 1): how strongly this audio supports the concept (recurrence, centrality, vocal emphasis).
- confidence (0 to 1): honesty required — a missing candidate costs less than a wrong one.
- Return 0-8 candidates as JSON: {"candidates":[{"label":...,"strength":...,"confidence":...}]}`

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    candidates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          strength: { type: 'NUMBER' },
          confidence: { type: 'NUMBER' },
        },
        required: ['label', 'strength', 'confidence'],
      },
    },
  },
  required: ['candidates'],
}

export function buildGeminiRequest(audio: AudioSegment): object {
  return {
    contents: [
      {
        parts: [
          { text: AUDIO_PROMPT },
          // inlineData/mimeType (camelCase): matches the current official
          // "Pass inline audio data" JS sample — protobuf JSON accepts this
          // interchangeably with the inline_data/mime_type spelling used in
          // the docs' hand-written curl examples.
          { inlineData: { mimeType: audio.mimeType, data: Buffer.from(audio.data).toString('base64') } },
        ],
      },
    ],
    generationConfig: {
      // Verified live 2026-09-05 against gemini-3.7-flash: the flat
      // responseMimeType + responseSchema pair is accepted and yields schema-
      // conformant JSON. The nested responseFormat.text.mimeType field also
      // exists in v1beta but is an enum that rejects "application/json"
      // (HTTP 400 INVALID_ARGUMENT), so it is not used here.
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  }
}

export function extractGeminiJson(body: unknown): unknown {
  try {
    const text = (body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
      .candidates?.[0]?.content?.parts?.[0]?.text
    if (typeof text !== 'string') return { candidates: [] }
    return JSON.parse(text)
  } catch {
    return { candidates: [] }
  }
}

export class GeminiAudioInterpreter implements Interpreter {
  readonly id = `gemini-audio/${GEMINI_MODEL}`
  readonly input = 'audio' as const
  private readonly apiKey: string

  constructor(apiKey = process.env.GEMINI_API_KEY ?? '') {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set — get one at aistudio.google.com')
    this.apiKey = apiKey
  }

  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    if (input.kind !== 'audio') throw new Error(`${this.id} interprets audio input only`)
    const started = performance.now()
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(buildGeminiRequest(input)),
        },
      )
      const latencyMs = Math.round(performance.now() - started)
      if (!res.ok) {
        console.error(`[${this.id}] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
        return { candidates: [], costUsd: 0, latencyMs }
      }
      const body = (await res.json()) as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }
      const candidates = mapCandidates(extractGeminiJson(body), this.id, input.segmentId)
      const costUsd = llmCost(GEMINI_MODEL, {
        inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      })
      return { candidates, costUsd, latencyMs }
    } catch (err) {
      console.error(`[${this.id}] call failed: ${err}`)
      return { candidates: [], costUsd: 0, latencyMs: Math.round(performance.now() - started) }
    }
  }
}

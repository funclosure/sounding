// Transcribe-then-extract interpretation: Claude reads the recent transcript
// window and reports concept candidates. Official SDK, structured outputs,
// cached system prompt. Provider layer — wall clock allowed.
import Anthropic from '@anthropic-ai/sdk'
import { mapCandidates } from './candidates'
import { llmCost } from './pricing'
import { hintBlock } from './hints'
import { assertApiAllowed } from '../cli/env'
import type { Interpreter, InterpreterInput, InterpretationResult, InterpretationHints } from '../interpret/port'

const MODEL = 'claude-opus-5'
const WINDOW_SEGMENTS = 8
// Tuning constant: 'low' effort for a ~0.5Hz extraction loop (latency + cost);
// sweep against higher efforts on the replay corpus later.
const EXTRACTION_EFFORT = 'low'

export const SYSTEM_PROMPT = `You listen to a person thinking aloud and report concept candidates — the things this stretch of talk is actually about or keeps returning to.

Guidance:
- Prefer what recurs or carries weight over what merely sounds like a topic. A named person, a specific memory, a repeated image, or an unresolved worry beats a tidy abstract noun. If someone talking through a job decision keeps mentioning their sister, "sister" is a candidate even though it isn't the "topic".
- Do not report discourse or framing — "what I'm thinking", "this afternoon", "let me talk about", time-of-day, or the act of talking itself, the language being spoken, or whether the listener understands it. Report only the content being thought about.
- Labels are short (1-4 words), in the speaker's own vocabulary where possible.
- strength (0 to 1): how strongly THIS window of talk supports the concept — recurrence, centrality, emphasis.
- confidence (0 to 1): how sure you are the concept is real and correctly labeled. Be honest: a missing candidate costs less than a wrong one.
- Return 0-8 candidates. Fewer, stronger candidates beat padding. Returning zero is fine for filler.`

export const CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          strength: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['label', 'strength', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const

export function buildUserPrompt(window: string[], hints?: InterpretationHints): string {
  const prior = window.slice(0, -1)
  const current = window.at(-1) ?? ''
  const base = `Recent talk (oldest first):\n${prior.join('\n')}\n\nNewest segment (interpret it in the context of the above):\n${current}`
  const block = hintBlock(hints)
  return block ? `${base}\n\n${block}` : base
}

export class ClaudeExtractionInterpreter implements Interpreter {
  readonly id = `claude-extraction/${MODEL}`
  readonly input = 'transcript' as const
  private readonly window: string[] = []
  private readonly client: Anthropic

  constructor() {
    assertApiAllowed('the claude interpreter (ANTHROPIC_API_KEY)')
    this.client = new Anthropic()
  }

  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    if (input.kind !== 'transcript') throw new Error(`${this.id} interprets transcript input only`)
    this.window.push(input.text)
    if (this.window.length > WINDOW_SEGMENTS) this.window.shift()
    const started = performance.now()
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        // thinking is on by default on claude-opus-5 and max_tokens caps
        // thinking + response together — 8000 leaves headroom (unused tokens
        // cost nothing). The cache_control below engages only once the system
        // prompt crosses the 512-token cacheable minimum; until then
        // cache_read_input_tokens: 0 is expected, not a bug.
        max_tokens: 8000,
        output_config: { effort: EXTRACTION_EFFORT, format: { type: 'json_schema', schema: CANDIDATES_SCHEMA } },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildUserPrompt(this.window, input.hints) }],
      })
      const latencyMs = Math.round(performance.now() - started)
      const costUsd = llmCost(MODEL, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      })
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
        console.error(`[${this.id}] no usable output (stop_reason=${response.stop_reason}${response.stop_details?.category ? `, ${response.stop_details.category}` : ''}); returning no candidates`)
        return { candidates: [], costUsd, latencyMs }
      }
      const text = response.content.find((b) => b.type === 'text')?.text ?? '{"candidates":[]}'
      const candidates = mapCandidates(JSON.parse(text), this.id, input.segmentId)
      return { candidates, costUsd, latencyMs }
    } catch (err) {
      // one failed call must not kill a long cast — degrade to no candidates
      console.error(`[${this.id}] call failed: ${err}`)
      return { candidates: [], costUsd: 0, latencyMs: Math.round(performance.now() - started) }
    }
  }
}

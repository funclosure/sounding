// Transcribe-then-extract interpretation: Claude reads the recent transcript
// window and reports concept candidates. Official SDK, structured outputs,
// cached system prompt. Provider layer — wall clock allowed.
import Anthropic from '@anthropic-ai/sdk'
import { mapCandidates } from './candidates'
import { llmCost } from './pricing'
import { SYSTEM_PROMPT, CANDIDATES_SCHEMA, buildUserPrompt } from './extraction-prompt'
import { assertApiAllowed } from '../cli/env'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../interpret/port'

export { SYSTEM_PROMPT, CANDIDATES_SCHEMA, buildUserPrompt }

const MODEL = 'claude-opus-5'
const WINDOW_SEGMENTS = 8
// Tuning constant: 'low' effort for a ~0.5Hz extraction loop (latency + cost);
// sweep against higher efforts on the replay corpus later.
const EXTRACTION_EFFORT = 'low'

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

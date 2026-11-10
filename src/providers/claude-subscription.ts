// The same transcript extraction as claude-extraction.ts, but through the
// Claude Code login (subscription) instead of an API key: the Claude Agent
// SDK runs one stateless, tool-less turn per segment and returns structured
// output. Spends no API credit — which is why it stays available while API
// use is off. Provider layer — wall clock allowed.
import { mapCandidates } from './candidates'
import { SYSTEM_PROMPT, CANDIDATES_SCHEMA, buildUserPrompt } from './claude-extraction'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../interpret/port'

export const SUBSCRIPTION_MODEL = process.env.SOUNDING_SUBSCRIPTION_MODEL ?? 'claude-sonnet-5-5'
const WINDOW_SEGMENTS = 8

/**
 * The SDK bills the API whenever a key is in its environment, and `npm run
 * live`/`cast` load .env into ours. This interpreter's whole point is the
 * login, so every credential that would route around it is dropped.
 */
export function subscriptionEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN' || k === 'ANTHROPIC_BASE_URL') continue
    out[k] = v
  }
  return out
}

export interface TurnRequest { system: string; prompt: string; model: string; schema: unknown; env: Record<string, string> }
/** One turn: resolves with the structured output, rejects with a readable reason. */
export type RunTurn = (req: TurnRequest) => Promise<unknown>

async function sdkTurn(req: TurnRequest): Promise<unknown> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const conversation = query({
    prompt: req.prompt,
    options: {
      systemPrompt: req.system,
      model: req.model,
      env: req.env,
      tools: [],
      settingSources: [],
      persistSession: false,
      effort: 'low',
      thinking: { type: 'disabled' },
      outputFormat: { type: 'json_schema', schema: req.schema as Record<string, unknown> },
    },
  })
  for await (const m of conversation) {
    if (m.type !== 'result') continue
    // "Not logged in" and the like arrive as a *successful* result flagged is_error, with the reason as its text.
    if (m.subtype === 'success' && !m.is_error) return m.structured_output
    throw new Error(m.subtype === 'success' ? m.result : `turn ended with ${m.subtype}`)
  }
  throw new Error('turn ended without a result')
}

export class ClaudeSubscriptionInterpreter implements Interpreter {
  readonly id = `claude-subscription/${SUBSCRIPTION_MODEL}`
  readonly input = 'transcript' as const
  private readonly window: string[] = []

  constructor(private readonly runTurn: RunTurn = sdkTurn) {}

  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    if (input.kind !== 'transcript') throw new Error(`${this.id} interprets transcript input only`)
    this.window.push(input.text)
    if (this.window.length > WINDOW_SEGMENTS) this.window.shift()
    const started = performance.now()
    try {
      const out = await this.runTurn({
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(this.window, input.hints),
        model: SUBSCRIPTION_MODEL,
        schema: CANDIDATES_SCHEMA,
        env: subscriptionEnv(),
      })
      // costUsd 0: the turn is covered by the subscription, not billed per token.
      return { candidates: mapCandidates(out, this.id, input.segmentId), costUsd: 0, latencyMs: Math.round(performance.now() - started) }
    } catch (err) {
      // one failed call must not kill a sounding — degrade to no candidates
      console.error(`[${this.id}] call failed: ${err instanceof Error ? err.message : err}`)
      return { candidates: [], costUsd: 0, latencyMs: Math.round(performance.now() - started) }
    }
  }
}

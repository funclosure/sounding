// Claude with the listener's own API key, called straight from the page: the
// marks (one short call per kept stretch of talk) and the wrap. The key goes
// from the browser to Anthropic and nowhere else.
import Anthropic from '@anthropic-ai/sdk'
import { mapCandidates } from '../providers/candidates'
import { SYSTEM_PROMPT, CANDIDATES_SCHEMA, buildUserPrompt } from '../providers/claude-extraction'
import { llmCost } from '../providers/pricing'
import type { Interpreter, InterpreterInput, InterpretationResult } from '../interpret/port'
import { WRAP_SCHEMA, WRAP_SYSTEM, buildWrapRequest, wrapFrom, type WrapWriter } from '../live/wrap-core'

/** The models a listener may pick for marks. The wrap is always written by the first. */
export const OWN_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'] as const
export type OwnModel = (typeof OWN_MODELS)[number]
export const isOwnModel = (v: unknown): v is OwnModel => typeof v === 'string' && (OWN_MODELS as readonly string[]).includes(v)
export const WRAP_MODEL: OwnModel = 'claude-sonnet-5-5'

const WINDOW_SEGMENTS = 8
const KNOWN_LABELS = 24

/** No thinking before answering: these are short, frequent calls. Sonnet 5.5 refuses `disabled` and takes `between_tools` for the same thing. */
const noThinking = (model: string) => ({ type: model === 'claude-sonnet-5-5' ? 'between_tools' : 'disabled' }) as unknown as Anthropic.ThinkingConfigParam

/** The one SDK call both uses make, so tests can stand in for it. */
export type CreateMessage = (body: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>

/** A client for use in the page. `dangerouslyAllowBrowser` is the point here: the key is the listener's own, typed into their own browser. */
export function ownClaude(key: string): CreateMessage {
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1 })
  return (body) => client.messages.create(body)
}

/** Asks Anthropic whether the key is accepted. Costs nothing. Resolves to null when it is, else a reason. */
export async function checkClaudeKey(key: string): Promise<string | null> {
  try {
    await new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0 }).models.list({ limit: 1 })
    return null
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return 'refused'
    return 'unreachable'
  }
}

function structured(model: string, system: string, prompt: string, schema: unknown, maxTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: maxTokens,
    thinking: noThinking(model),
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  }
}

function jsonOf(response: Anthropic.Message): unknown {
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer')
  if (response.stop_reason === 'max_tokens') throw new Error('the answer was cut short')
  const text = response.content.find((b) => b.type === 'text')?.text
  if (!text) throw new Error('the answer came back empty')
  return JSON.parse(text)
}

function costOf(model: string, u: Anthropic.Usage): number {
  return llmCost(model, { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0 })
}

/** Why a call failed, in words for the page. A refused key is told apart: nothing will work until it is changed. */
export function claudeFailure(e: unknown): { refused: boolean; message: string } {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { refused: true, message: 'Anthropic did not accept the Claude key' }
  if (e instanceof Anthropic.RateLimitError) return { refused: false, message: 'Anthropic is rate-limiting this key' }
  if (e instanceof Anthropic.APIError) return { refused: false, message: e.message }
  return { refused: false, message: e instanceof Error ? e.message : String(e) }
}

/**
 * The same transcript extraction as the server's Claude interpreters. Concept
 * identity in the page is by label alone (no embedding model is downloaded),
 * so the model is shown the labels it has already given and asked to reuse
 * them when the talk returns to the same thing.
 */
export class OwnClaudeInterpreter implements Interpreter {
  readonly id: string
  readonly input = 'transcript' as const
  private readonly window: string[] = []
  private readonly known: string[] = []
  private refusedTold = false

  constructor(private readonly create: CreateMessage, private readonly model: OwnModel, private readonly onTrouble: (message: string) => void = () => {}) {
    this.id = `claude-own-key/${model}`
  }

  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    if (input.kind !== 'transcript') throw new Error(`${this.id} interprets transcript input only`)
    this.window.push(input.text)
    if (this.window.length > WINDOW_SEGMENTS) this.window.shift()
    const started = performance.now()
    const reuse = this.known.length
      ? `\n\nLabels you have already reported in this sounding. When the talk means one of these again, report it under exactly the same label rather than a new wording:\n${this.known.map((l) => `- "${l}"`).join('\n')}`
      : ''
    try {
      const response = await this.create(structured(this.model, SYSTEM_PROMPT, buildUserPrompt(this.window, input.hints) + reuse, CANDIDATES_SCHEMA, 1024))
      const candidates = mapCandidates(jsonOf(response), this.id, input.segmentId)
      for (const c of candidates) {
        const i = this.known.indexOf(c.label)
        if (i >= 0) this.known.splice(i, 1)
        this.known.push(c.label)
      }
      while (this.known.length > KNOWN_LABELS) this.known.shift()
      return { candidates, costUsd: costOf(this.model, response.usage), latencyMs: Math.round(performance.now() - started) }
    } catch (e) {
      // one failed call must not end a sounding — but a refused key is said once, since no call after it will work either
      const f = claudeFailure(e)
      if (f.refused && !this.refusedTold) { this.refusedTold = true; this.onTrouble(f.message) }
      console.error(`[${this.id}] call failed: ${f.message}`)
      return { candidates: [], costUsd: 0, latencyMs: Math.round(performance.now() - started) }
    }
  }
}

/** The wrap with the listener's key. `spent` hears what each one cost. */
export function ownWrap(create: CreateMessage, spent: (usd: number) => void = () => {}): WrapWriter {
  return async (instructions, material) => {
    let response: Anthropic.Message
    try { response = await create(structured(WRAP_MODEL, WRAP_SYSTEM, buildWrapRequest(instructions, material), WRAP_SCHEMA, 2048)) }
    catch (e) { throw new Error(claudeFailure(e).message) }
    spent(costOf(WRAP_MODEL, response.usage))
    return wrapFrom(jsonOf(response))
  }
}

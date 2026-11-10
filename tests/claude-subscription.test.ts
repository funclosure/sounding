import { describe, it, expect, vi, afterEach } from 'vitest'
import { ClaudeSubscriptionInterpreter, subscriptionEnv, type TurnRequest } from '../src/providers/claude-subscription'
import { SYSTEM_PROMPT } from '../src/providers/claude-extraction'

const transcript = (text: string, n = 1) => ({ kind: 'transcript' as const, segmentId: `s${n}`, text, startT: 0, endT: 8000 })

describe('subscriptionEnv', () => {
  it('drops every credential that would route around the login, and nothing else', () => {
    const env = subscriptionEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_OAUTH_TOKEN: 'login', PATH: '/bin', UNSET: undefined })
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'login', PATH: '/bin' })
  })
})

describe('ClaudeSubscriptionInterpreter', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks() })

  it('stays available while API use is off, and never passes an API key to the turn', async () => {
    process.env.SOUNDING_API = 'off'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-travel'
    const seen: TurnRequest[] = []
    const i = new ClaudeSubscriptionInterpreter(async (req) => { seen.push(req); return { candidates: [{ label: 'sister', strength: 0.9, confidence: 0.8 }] } })
    const r = await i.interpret(transcript('my sister called'))
    expect(r.candidates).toEqual([{ label: 'sister', strength: 0.9, confidence: 0.8, source: i.id, segmentId: 's1' }])
    expect(r.costUsd).toBe(0)
    expect(seen[0].env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(seen[0].system).toBe(SYSTEM_PROMPT)
    expect(seen[0].model).toBe('claude-sonnet-5-5')
    expect(i.id).toBe('claude-subscription/claude-sonnet-5-5')
  })

  it('sends the recent window, newest segment last', async () => {
    const prompts: string[] = []
    const i = new ClaudeSubscriptionInterpreter(async (req) => { prompts.push(req.prompt); return { candidates: [] } })
    await i.interpret(transcript('first thing', 1))
    await i.interpret(transcript('second thing', 2))
    expect(prompts[1]).toMatch(/first thing[\s\S]*Newest segment[\s\S]*second thing/)
  })

  it('degrades to no candidates when the turn fails or returns junk', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = new ClaudeSubscriptionInterpreter(async () => { throw new Error('not logged in') })
    expect((await failing.interpret(transcript('x'))).candidates).toEqual([])
    const junk = new ClaudeSubscriptionInterpreter(async () => 'not an object')
    expect((await junk.interpret(transcript('x'))).candidates).toEqual([])
  })

  it('refuses audio input', async () => {
    const i = new ClaudeSubscriptionInterpreter(async () => ({ candidates: [] }))
    await expect(i.interpret({ kind: 'audio', segmentId: 's', mimeType: 'audio/wav', data: new Uint8Array(), startT: 0, endT: 1 })).rejects.toThrow(/transcript input only/)
  })
})

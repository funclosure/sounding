// The wrap: when a sounding ends, the listener says back, briefly, what it
// heard. The instructions for it are the speaker's to adjust; the default
// lives here. Written through the Claude login (no API spend), saved next to
// the log as <sounding>.wrap.md. Provider layer — wall clock and disk allowed.
export * from './wrap-core'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_WRAP_PROMPT, WRAP_SCHEMA, WRAP_SYSTEM, buildWrapRequest, wrapFrom, type WrapWriter } from './wrap-core'
import { SUBSCRIPTION_MODEL, sdkTurn, subscriptionEnv, type RunTurn } from '../providers/claude-subscription'

const PROMPT_FILE = 'wrap-prompt.txt'

/** The saved instructions, or the default when none are saved. */
export function readWrapPrompt(dir = 'soundings'): { prompt: string; isDefault: boolean } {
  const file = join(dir, PROMPT_FILE)
  const saved = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  return saved ? { prompt: saved, isDefault: false } : { prompt: DEFAULT_WRAP_PROMPT, isDefault: true }
}

/** Saves the instructions; blank (or the default itself) clears back to the default. */
export function saveWrapPrompt(text: string, dir = 'soundings'): void {
  mkdirSync(dir, { recursive: true })
  const t = text.trim()
  writeFileSync(join(dir, PROMPT_FILE), t === DEFAULT_WRAP_PROMPT.trim() ? '' : t)
}

/** The wrap through the Claude login: one stateless, tool-less turn. */
export function subscriptionWrap(runTurn: RunTurn = sdkTurn): WrapWriter {
  return async (instructions, material) => {
    const out = await runTurn({ system: WRAP_SYSTEM, prompt: buildWrapRequest(instructions, material), model: SUBSCRIPTION_MODEL, schema: WRAP_SCHEMA, env: subscriptionEnv() })
    return wrapFrom(out)
  }
}

/** soundings/x.jsonl → soundings/x.wrap.md, holding the latest wrap for that sounding. */
export function writeWrapFile(logPath: string, text: string): string {
  const path = logPath.replace(/\.jsonl$/, '') + '.wrap.md'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text + '\n')
  return path
}

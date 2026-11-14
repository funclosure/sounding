// What this server is set up with, for the page to show: which models listen and understand, and what is switched on.
// Facts only; the page words them (src/ui/setup.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isLang } from './langs'
import { apiAllowed } from '../cli/env'
import { SUBSCRIPTION_MODEL } from '../providers/claude-subscription'
import { DEFAULT_WHISPER_MODEL } from './whisper-server'

export interface Setup {
  transcriber: string
  /** The local speech model, when the transcriber is one. */
  hearsModel: string | null
  interpreter: string
  /** The model behind the interpreter and the wrap, when it runs on the Claude login. */
  thinksModel: string | null
  lang: string
  /** Whether paid API providers may be started at all. */
  api: boolean
  ownInstructions: boolean
  /** The wrap instructions in use, for the sheet's editor. */
  instructions: string
  /** Set when the page runs the sounding itself with the listener's own keys (src/own): whether both are in, and enough of each to recognise it by. */
  own?: { keys: boolean; claudeHint: string; elevenHint: string }
}

const LANG_FILE = 'lang.txt'
/** The language chosen from the page, or null when none was (the server's own --lang then applies). */
export function readLang(dir = 'soundings'): string | null {
  const file = join(dir, LANG_FILE)
  const saved = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  return isLang(saved) ? saved : null
}
export function saveLang(code: string, dir = 'soundings'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, LANG_FILE), code)
}

export function describeSetup(args: { interpreter: string; transcriber: string; lang: string }, wrap: { prompt: string; isDefault: boolean }, env: Record<string, string | undefined> = process.env): Setup {
  const whisper = basename(env.SOUNDING_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL).replace(/^ggml-/, '').replace(/\.bin$/, '')
  return {
    transcriber: args.transcriber,
    hearsModel: args.transcriber === 'whisper' ? whisper : null,
    interpreter: args.interpreter,
    thinksModel: args.interpreter === 'claude-sub' ? SUBSCRIPTION_MODEL : null,
    lang: args.lang,
    api: apiAllowed(env),
    ownInstructions: !wrap.isDefault,
    instructions: wrap.prompt,
  }
}

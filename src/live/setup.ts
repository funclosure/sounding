// What this server is set up with, for the page to show: which models listen and understand, and what is switched on.
// Facts only; the page words them (src/ui/setup.ts).
import { basename } from 'node:path'
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
}

export function describeSetup(args: { interpreter: string; transcriber: string; lang: string }, ownInstructions: boolean, env: Record<string, string | undefined> = process.env): Setup {
  const whisper = basename(env.SOUNDING_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL).replace(/^ggml-/, '').replace(/\.bin$/, '')
  return {
    transcriber: args.transcriber,
    hearsModel: args.transcriber === 'whisper' ? whisper : null,
    interpreter: args.interpreter,
    thinksModel: args.interpreter === 'claude-sub' ? SUBSCRIPTION_MODEL : null,
    lang: args.lang,
    api: apiAllowed(env),
    ownInstructions,
  }
}

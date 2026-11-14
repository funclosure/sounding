// One live sounding on the server: the engine, with the interpreter picked by
// name, concept identity from local embeddings, and the log written to
// soundings/ on stop.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SALIENCE_CONFIG } from '../salience/config'
import { EmbeddingIdentityResolver } from '../providers/embedding-identity'
import { RecurrenceInterpreter } from '../interpret/recurrence'
import { ClaudeExtractionInterpreter } from '../providers/claude-extraction'
import { ClaudeSubscriptionInterpreter } from '../providers/claude-subscription'
import type { InterpreterName } from '../devserver/paths'
import { GeminiAudioInterpreter } from '../providers/gemini-audio'
import type { Interpreter } from '../interpret/port'
import { SoundingEngine, type LiveMessage } from './engine'
import type { Transcriber } from './transcriber'
import type { Clock } from './clock'

export type { InterpreterName, LiveMessage }

export interface LiveSoundingOptions {
  interpreterName: InterpreterName
  transcriber: Transcriber
  clock: Clock
  send: (m: LiveMessage) => void
  soundingId: string
  /** Context text brought before talking, applied right after drop, before the first commit. */
  context?: string
}

function makeInterpreter(name: InterpreterName): Interpreter {
  if (name === 'claude') return new ClaudeExtractionInterpreter()
  if (name === 'claude-sub') return new ClaudeSubscriptionInterpreter()
  if (name === 'gemini') return new GeminiAudioInterpreter()
  return new RecurrenceInterpreter()
}

function writeLog(soundingId: string, jsonl: string): string {
  mkdirSync('soundings', { recursive: true })
  const logPath = join('soundings', `${soundingId}.jsonl`)
  writeFileSync(logPath, jsonl)
  return logPath
}

export class LiveSounding extends SoundingEngine {
  constructor(opts: LiveSoundingOptions) {
    const { interpreterName, ...rest } = opts
    super({ ...rest, interpreter: makeInterpreter(interpreterName), identity: new EmbeddingIdentityResolver(DEFAULT_SALIENCE_CONFIG.similarityThreshold), persist: writeLog })
  }
}

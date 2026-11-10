// cast: drop a recording through the pipeline and persist the sounding.
//   npm run cast -- recordings/memo.m4a -i claude
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadDotEnv } from './env'
import { join, dirname, basename } from 'node:path'
import { transcribeRecording } from '../providers/whisper-transcription'
import { ClaudeExtractionInterpreter } from '../providers/claude-extraction'
import { ClaudeSubscriptionInterpreter } from '../providers/claude-subscription'
import { GeminiAudioInterpreter } from '../providers/gemini-audio'
import { makeAudioSource } from '../providers/audio-slicer'
import { EmbeddingIdentityResolver } from '../providers/embedding-identity'
import { RecurrenceInterpreter } from '../interpret/recurrence'
import { SoundingSession } from '../core/session'
import { ReadingDynamics } from '../salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../salience/config'
import { ReplayRunner } from '../replay/runner'
import { buildCaptureEvents } from '../replay/fixture'
import { summarizeCounters } from '../replay/counters'
import type { FixtureScript } from '../replay/fixture'
import type { Interpreter } from '../interpret/port'
import type { SoundingEvent } from '../core/events'

const INTERPRETERS = ['recurrence', 'claude', 'claude-sub', 'gemini'] as const
type InterpreterName = (typeof INTERPRETERS)[number]

export interface CastArgs {
  audioPath: string
  interpreter: InterpreterName
  modelPath: string
  threshold: number | undefined
  contextPath: string | undefined
}

export function parseCastArgs(argv: string[]): CastArgs {
  const args: Partial<CastArgs> = { modelPath: 'models/ggml-large-v3-turbo.bin' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-i' || a === '--interpreter') {
      const v = argv[++i]
      if (!INTERPRETERS.includes(v as InterpreterName)) throw new Error(`unknown interpreter ${v} — one of: ${INTERPRETERS.join(', ')}`)
      args.interpreter = v as InterpreterName
    } else if (a === '--model-path') {
      const v = argv[++i]
      if (!v) throw new Error('--model-path requires a path')
      args.modelPath = v
    } else if (a === '--threshold') {
      const v = Number(argv[++i])
      if (!Number.isFinite(v)) throw new Error('--threshold requires a number')
      args.threshold = v
    } else if (a === '--context') {
      const v = argv[++i]
      if (!v) throw new Error('--context requires a path')
      args.contextPath = v
    }
    else if (!a.startsWith('-') && !args.audioPath) args.audioPath = a
    else throw new Error(`unrecognized argument ${a}`)
  }
  if (!args.audioPath || !args.interpreter) {
    throw new Error('usage: npm run cast -- <audio-file> -i <recurrence|claude|claude-sub|gemini> [--model-path <ggml>] [--threshold <n>] [--context <file>]')
  }
  if (args.contextPath && !existsSync(args.contextPath)) {
    throw new Error(`--context file not found: ${args.contextPath}`)
  }
  return args as CastArgs
}

export async function loadOrTranscribe(
  audioPath: string,
  modelPath: string,
  transcribe: (audioPath: string, modelPath: string) => Promise<FixtureScript> = transcribeRecording,
): Promise<FixtureScript> {
  const base = basename(audioPath).replace(/\.[^.]+$/, '')
  const cachePath = join(dirname(audioPath), `${base}.transcript.json`)
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8')) as FixtureScript
  const script = await transcribe(audioPath, modelPath)
  writeFileSync(cachePath, JSON.stringify(script, null, 2))
  return script
}

function makeInterpreter(name: InterpreterName): Interpreter {
  if (name === 'claude') return new ClaudeExtractionInterpreter()
  if (name === 'claude-sub') return new ClaudeSubscriptionInterpreter()
  if (name === 'gemini') return new GeminiAudioInterpreter()
  return new RecurrenceInterpreter()
}

function formatFinalReading(events: readonly SoundingEvent[]): string {
  const last = [...events].reverse().find((e) => e.type === 'reading.changed')
  if (!last || last.type !== 'reading.changed') return '(no reading)'
  return last.reading.marks.map((m) => `  ${m.label.padEnd(28)} ${(m.prominence * 100).toFixed(1)}%`).join('\n')
}

async function main() {
  loadDotEnv()
  const opts = parseCastArgs(process.argv.slice(2))
  const script = await loadOrTranscribe(opts.audioPath, opts.modelPath)
  console.log(`cast: ${script.segments.length} segments, ${(script.endT / 1000).toFixed(0)}s — interpreter ${opts.interpreter}`)

  const config = { ...DEFAULT_SALIENCE_CONFIG }
  const interpreter = makeInterpreter(opts.interpreter)
  const resolver = new EmbeddingIdentityResolver(opts.threshold ?? config.similarityThreshold)
  const dynamics = new ReadingDynamics(resolver, config)
  const audioSource = interpreter.input === 'audio' ? makeAudioSource(opts.audioPath) : undefined
  const base = basename(opts.audioPath).replace(/\.[^.]+$/, '')
  const session = new SoundingSession(interpreter, dynamics, config, `${base}.${opts.interpreter}`, audioSource)
  session.drop()
  if (opts.contextPath) await session.setContext(0, readFileSync(opts.contextPath, 'utf8').trim())

  const runner = new ReplayRunner(session, buildCaptureEvents(script), script.endT)
  await runner.runToEnd()

  mkdirSync('soundings', { recursive: true })
  const outPath = join('soundings', `${base}.${opts.interpreter}.jsonl`)
  writeFileSync(outPath, session.log.toJsonl())

  const c = summarizeCounters(session.log.all())
  console.log(`\nfinal reading:\n${formatFinalReading(session.log.all())}`)
  console.log(`\n${c.callCount} interpretation calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms · max ${Math.round(c.maxLatencyMs)}ms`)
  console.log(`wrote ${outPath}`)
}

const isDirectRun = process.argv[1]?.endsWith('cast.ts')
if (isDirectRun) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  })
}

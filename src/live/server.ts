// The live server: browser mic ↔ LiveSounding ↔ Gemini. `bun run live`.
//   bun run live -- [-i gemini|claude|claude-sub|recurrence] [--transcriber gemini|whisper|elevenlabs] [--port 8790] [--from <audio>] [--fixture <name> --fake-transcriber] [--speed N] [--headless] [--lang <code|auto>]
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { assertApiAllowed, loadDotEnv } from '../cli/env'
import { FIXTURES } from '../replay/fixtures/index'
import { transcribeRecording } from '../providers/whisper-transcription'
import { stampName, isInterpreterName, INTERPRETERS } from '../devserver/paths'
import { Clock } from './clock'
import { LiveSounding, type InterpreterName, type LiveMessage } from './live-sounding'
import { TranscribeLiveClient } from './transcribe-live'
import { vocabularyFrom } from './vocabulary'
import { DEFAULT_LIVE_PORT } from './socket-path'
import { FakeTranscriber } from './fake-transcriber'
import { streamFile } from './fake-mic'
import type { Transcriber } from './transcriber'
import { WhisperTranscriber } from './whisper-transcriber'
import { elevenFile, ElevenLive } from './elevenlabs'
import { nodeElevenSocket } from './elevenlabs-node'
import { sharedWhisper, whisperLanguage } from './whisper-server'
import type { FixtureScript } from '../replay/fixture'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listEarlier, readEarlier, removeEarlier } from './earlier'
import { describeSetup, readLang, saveLang } from './setup'
import { scriptFor } from './chinese-script'
import { readWrapPrompt, saveWrapPrompt, subscriptionWrap, writeWrapFile, type WrapWriter } from './wrap'
import { liveConnection, type LiveHost } from './connection'

export const TRANSCRIBERS = ['gemini', 'whisper', 'elevenlabs'] as const
export type TranscriberName = (typeof TRANSCRIBERS)[number]
export function isTranscriberName(x: unknown): x is TranscriberName {
  return typeof x === 'string' && (TRANSCRIBERS as readonly string[]).includes(x)
}

export interface Args { interpreter: InterpreterName; transcriber: TranscriberName; port: number; from?: string; fixture?: string; fakeTranscriber: boolean; speed: number; headless: boolean; lang: string }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export { LABEL_MAX_CHARS, validLabel } from './connection'

/**
 * Only a browser tab served from this same machine may open the live socket,
 * plus any exact origin the always-on server was told to allow (its tailnet
 * address).
 */
export function isAllowedOrigin(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (origin !== undefined && extra.includes(origin)) return true
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? '')
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { interpreter: 'gemini', transcriber: 'gemini', port: DEFAULT_LIVE_PORT, fakeTranscriber: false, speed: 1, headless: false, lang: 'en-US' }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i], next = argv[i + 1]
    if (v === '-i') { if (!isInterpreterName(next)) throw new Error(`-i must be ${INTERPRETERS.join('|')}`); a.interpreter = next; i++ }
    else if (v === '--transcriber') { if (!isTranscriberName(next)) throw new Error(`--transcriber must be ${TRANSCRIBERS.join('|')}`); a.transcriber = next; i++ }
    else if (v === '--port') { a.port = Number(next); if (!Number.isInteger(a.port)) throw new Error('--port needs an integer'); i++ }
    else if (v === '--from') { if (!next) throw new Error('--from needs a path'); a.from = next; i++ }
    else if (v === '--fixture') { if (!next) throw new Error('--fixture needs a name'); a.fixture = next; i++ }
    else if (v === '--fake-transcriber') a.fakeTranscriber = true
    else if (v === '--speed') { a.speed = Number(next); if (!Number.isFinite(a.speed) || a.speed <= 0) throw new Error('--speed needs a positive number'); i++ }
    else if (v === '--headless') a.headless = true
    else if (v === '--lang') { if (!next) throw new Error('--lang needs a code (or "auto")'); a.lang = next; i++ }
    else throw new Error(`unknown argument ${v}`)
  }
  if (a.fakeTranscriber && !a.fixture && !a.from) throw new Error('--fake-transcriber needs --fixture <name> or --from <audio>')
  if (a.speed !== 1 && !a.fakeTranscriber) throw new Error('--speed is only valid with --fake-transcriber')
  if (a.headless && !a.fixture && !a.from) throw new Error('--headless needs --fixture <name> or --from <audio>')
  if (a.fixture && !a.fakeTranscriber) throw new Error('--fixture needs --fake-transcriber')
  if (a.from && a.fixture) throw new Error('--from and --fixture are mutually exclusive')
  return a
}

/** `context` only affects the real client's custom vocabulary — fixture/`--from` playback ignores it. */
async function makeTranscriber(args: Args, clock: Clock, context?: string): Promise<Transcriber> {
  if (args.fakeTranscriber) {
    let script: FixtureScript | undefined
    if (args.fixture) script = FIXTURES.find((f) => f.name === args.fixture)
    else if (args.from) script = await transcribeRecording(args.from, 'models/ggml-large-v3-turbo.bin')
    if (!script) throw new Error(`fixture not found: ${args.fixture}`)
    return new FakeTranscriber(script, clock)
  }
  if (args.transcriber === 'whisper') {
    return new WhisperTranscriber({ open: () => sharedWhisper(), language: whisperLanguage(args.lang), rewrite: scriptFor(args.lang), vocabulary: vocabularyFrom(context ?? '') })
  }
  if (args.transcriber === 'elevenlabs') {
    assertApiAllowed('ElevenLabs hearing (ELEVENLABS_API_KEY)')
    const elevenKey = process.env.ELEVENLABS_API_KEY
    if (!elevenKey) throw new Error('ELEVENLABS_API_KEY is not set')
    const language = whisperLanguage(args.lang)
    return new WhisperTranscriber({ open: async () => elevenFile(elevenKey), live: new ElevenLive(elevenKey, language, nodeElevenSocket), opening: 'reaching ElevenLabs', maxUtteranceMs: 8000, language, rewrite: scriptFor(args.lang) })
  }
  assertApiAllowed('Gemini Transcribe Live (GEMINI_API_KEY)')
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set — get one at aistudio.google.com')
  return new TranscribeLiveClient(key, { languageCodes: args.lang === 'auto' ? [] : [args.lang], customVocabulary: vocabularyFrom(context ?? '') })
}

async function runHeadless(args: Args): Promise<void> {
  const clock = new Clock(args.speed)
  const transcriber = await makeTranscriber(args, clock)
  const soundingId = `live-${stampName(new Date()).slice(4)}.${args.interpreter}`
  const live = new LiveSounding({
    interpreterName: args.interpreter, transcriber, clock,
    send: (m) => { if (m.type === 'live.status' && m.state === 'error') console.error(`[live] ${m.message}`) },
    soundingId,
  })
  await live.start()
  const script = args.fixture ? FIXTURES.find((f) => f.name === args.fixture) : undefined
  let streamError: unknown = null
  try {
    if (args.from) await streamFile(args.from, clock, (pcm) => live.pushAudio(pcm))
    else if (script) await clock.sleep(script.endT + 1500)
  } catch (e) {
    streamError = e
  }
  // Persist whatever the session captured even if the mic feed failed.
  const { logPath, summary } = await live.stop()
  console.log(summary)
  console.log(`wrote ${logPath}`)
  // Re-thrown as-is: the direct-run guard below prints it and exits non-zero.
  if (streamError) throw streamError instanceof Error ? streamError : new Error(errMsg(streamError))
}

export interface LiveDeps {
  /** Writes the wrap. Default: the Claude login, except for the model-free `recurrence` baseline, which gets none. Null turns wraps off. */
  wrap?: WrapWriter | null
  /** Where the speaker's wrap instructions are kept. */
  promptDir?: string
  /** Where saved soundings are (for listing, opening and removing earlier ones). */
  soundingsDir?: string
  /** Where a removed sounding goes. Default: the user's Trash. */
  trashDir?: string
}

/** What the conversation in connection.ts needs from this machine: its disk, its models and its keys. */
export function nodeHost(args: Args, deps: LiveDeps = {}): LiveHost {
  const dir = deps.soundingsDir ?? 'soundings'
  const lang = () => readLang(deps.promptDir) ?? args.lang
  // The clock of the sounding being listened to: a recording played in as the microphone keeps time with it.
  let liveClock: Clock | null = null
  return {
    lang,
    saveLang: (code) => saveLang(code, deps.promptDir),
    wrapPrompt: () => readWrapPrompt(deps.promptDir),
    saveWrapPrompt: (text) => saveWrapPrompt(text, deps.promptDir),
    setup: () => describeSetup({ ...args, lang: lang() }, readWrapPrompt(deps.promptDir)),
    async create(req, liveLang, send) {
      let interpreter = args.interpreter
      if (req.interpreter !== undefined) {
        if (isInterpreterName(req.interpreter)) interpreter = req.interpreter
        else send({ type: 'live.status', state: 'warning', message: `unknown interpreter ${String(req.interpreter)}, using ${interpreter}` })
      }
      let transcriberName = args.transcriber
      if (req.transcriber !== undefined) {
        if (isTranscriberName(req.transcriber)) transcriberName = req.transcriber
        else send({ type: 'live.status', state: 'warning', message: `unknown transcriber ${String(req.transcriber)}, using ${transcriberName}` })
      }
      const clock = new Clock(args.speed)
      const transcriber = await makeTranscriber({ ...args, interpreter, transcriber: transcriberName, lang: liveLang }, clock, req.context)
      const soundingId = `live-${stampName(new Date()).slice(4)}.${interpreter}`
      const sounding = new LiveSounding({ interpreterName: interpreter, transcriber, clock, send, soundingId, context: req.context })
      liveClock = clock
      return { sounding, writer: deps.wrap !== undefined ? deps.wrap : interpreter === 'recurrence' ? null : subscriptionWrap() }
    },
    started(push, stop, fail) {
      if (args.from && liveClock) streamFile(args.from, liveClock, push).then(stop).catch(fail)
    },
    writer: () => (deps.wrap !== undefined ? deps.wrap : subscriptionWrap()),
    saveWrap: (logPath, text) => { console.log(`wrote ${writeWrapFile(logPath, text)}`) },
    listEarlier: () => listEarlier(deps.soundingsDir),
    readEarlier: (name) => readEarlier(name, deps.soundingsDir),
    removeEarlier: (name) => removeEarlier(name, dir, deps.trashDir ?? join(homedir(), '.Trash')),
    logPathOf: (name) => join(dir, name),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  }
}

/** One browser tab's live socket: the conversation in connection.ts, over a WebSocket. Shared with the always-on server. */
export function handleLiveConnection(ws: WsSocket, args: Args, deps: LiveDeps = {}): void {
  const conn = liveConnection((m: LiveMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }, nodeHost(args, deps))
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) conn.audio(new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - (data.length % 2))))
    else void conn.text(data.toString('utf8'))
  })
  ws.on('close', () => conn.closed())
}

function serve(args: Args): void {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: args.port, verifyClient: ({ origin }: { origin: string }) => isAllowedOrigin(origin) })
  console.log(`live server listening on ws://localhost:${args.port} — interpreter ${args.interpreter}${args.from ? `, fake mic from ${args.from}` : ''}`)
  wss.on('connection', (ws: WsSocket) => handleLiveConnection(ws, args))
}

// `live/` included: src/serve/server.ts imports this file and also ends in server.ts.
const isDirectRun = process.argv[1]?.endsWith('live/server.ts')
if (isDirectRun) {
  loadDotEnv()
  let args: Args
  try { args = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2) }
  if (args.headless) runHeadless(args).then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
  else serve(args)
}

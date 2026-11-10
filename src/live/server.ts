// The live server: browser mic ↔ LiveSounding ↔ Gemini. `bun run live`.
//   bun run live -- [-i gemini|claude|claude-sub|recurrence] [--transcriber gemini|whisper] [--port 8790] [--from <audio>] [--fixture <name> --fake-transcriber] [--speed N] [--headless] [--lang <code|auto>]
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
import { sharedWhisper, whisperLanguage } from './whisper-server'
import type { FixtureScript } from '../replay/fixture'
import { readWrapPrompt, saveWrapPrompt, subscriptionWrap, validWrapPrompt, wrapMaterial, writeWrapFile, WRAP_PROMPT_MAX_CHARS, type WrapMaterial, type WrapWriter } from './wrap'

export const TRANSCRIBERS = ['gemini', 'whisper'] as const
export type TranscriberName = (typeof TRANSCRIBERS)[number]
export function isTranscriberName(x: unknown): x is TranscriberName {
  return typeof x === 'string' && (TRANSCRIBERS as readonly string[]).includes(x)
}

export interface Args { interpreter: InterpreterName; transcriber: TranscriberName; port: number; from?: string; fixture?: string; fakeTranscriber: boolean; speed: number; headless: boolean; lang: string }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const CONTEXT_MAX_CHARS = 4000
export const LABEL_MAX_CHARS = 60
/** A corrected label: a non-blank single line within the cap. Returns it trimmed, or null. */
export function validLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length > 0 && s.length <= LABEL_MAX_CHARS && !/[\r\n]/.test(s) ? s : null
}
/** true only for a validation-worthy string: within the length cap. Doesn't accept undefined — caller checks presence separately. */
function isValidContext(v: unknown): v is string {
  return typeof v === 'string' && v.length <= CONTEXT_MAX_CHARS
}

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
    return new WhisperTranscriber({ open: () => sharedWhisper(), language: whisperLanguage(args.lang), vocabulary: vocabularyFrom(context ?? '') })
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
}

/** One browser tab's live socket: start/stop/context/follow messages plus binary PCM. Shared with the always-on server. */
export function handleLiveConnection(ws: WsSocket, args: Args, deps: LiveDeps = {}): void {
  let live: LiveSounding | null = null
  // The sounding that just ended on this connection, kept so the speaker can
  // adjust the instructions and have the same sounding wrapped again.
  let ended: { material: WrapMaterial; logPath: string; writer: WrapWriter } | null = null
  let wrapRun = 0
  /** `once`: instructions for this one writing only (another reading of the same sounding); the saved ones are left alone. */
  const writeWrap = async (once?: string) => {
    const e = ended
    if (!e) return
    const run = ++wrapRun
    const { prompt, isDefault } = readWrapPrompt(deps.promptDir)
    send({ type: 'live.wrap', state: 'writing' })
    try {
      const text = await e.writer(once || prompt, e.material)
      if (run !== wrapRun) return // a newer request (changed instructions) supersedes this one
      console.log(`wrote ${writeWrapFile(e.logPath, text)}`)
      send({ type: 'live.wrap', state: 'done', text, prompt, isDefaultPrompt: isDefault })
    } catch (err) {
      if (run !== wrapRun) return
      console.error(`[wrap] ${errMsg(err)}`)
      send({ type: 'live.wrap', state: 'failed', message: errMsg(err), prompt, isDefaultPrompt: isDefault })
    }
  }
  // Tracks an in-flight `start` so a racing `stop` (an explicit stop
  // message, or the socket closing) waits for it to fully settle before
  // touching `live` — calling l.stop() while l.start() is still awaiting
  // transcriber.connect() would leak the timers/socket start() registers
  // right after that await resolves.
  let starting: Promise<void> | null = null
  // Tracks an in-flight `stop` so a racing `start` (a fresh `start`
  // message arriving while the previous sounding is still draining and
  // surfacing) waits for it to fully finish before creating a new
  // LiveSounding on this connection — otherwise the old sounding's timers
  // are still running when the new one starts pushing audio, and frames
  // from both interleave into the ring/segmenter.
  let stopping: Promise<void> | null = null
  const send = (m: LiveMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
  // The writer for the sounding currently live, fixed at its start.
  let liveWriter: WrapWriter | null = null
  const stop = async () => {
    if (starting) { try { await starting } catch { /* start already reported its own error */ } }
    if (!live) return
    const l = live; live = null
    const writer = liveWriter
    stopping = (async () => {
      try {
        const { logPath, summary } = await l.stop(); console.log(summary); console.log(`wrote ${logPath}`)
        const material = wrapMaterial(l.events())
        // Nothing said, nothing to say back.
        ended = writer && material.transcript ? { material, logPath, writer } : null
        // Not awaited: the page gets `writing`, then `stopped` at once, then the wrap when it is ready.
        // A wrap still in flight when the tab goes away is finished and saved all the same.
        if (ended) void writeWrap()
        send({ type: 'live.status', state: 'stopped', message: logPath })
      }
      catch (e) { send({ type: 'live.status', state: 'error', message: errMsg(e) }) }
    })()
    try { await stopping } finally { stopping = null }
  }
  ws.on('message', async (data: Buffer, isBinary: boolean) => {
    if (isBinary) { live?.pushAudio(new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - (data.length % 2)))); return }
    let msg: { type?: string; interpreter?: string; transcriber?: unknown; label?: unknown; context?: unknown; text?: unknown; conceptId?: unknown }
    try { msg = JSON.parse(data.toString('utf8')) } catch { return }
    if (msg.type === 'start' && !live && !starting) {
      let interpreter = args.interpreter
      if (msg.interpreter !== undefined) {
        if (isInterpreterName(msg.interpreter)) interpreter = msg.interpreter
        else send({ type: 'live.status', state: 'warning', message: `unknown interpreter ${msg.interpreter}, using ${interpreter}` })
      }
      let transcriberName = args.transcriber
      if (msg.transcriber !== undefined) {
        if (isTranscriberName(msg.transcriber)) transcriberName = msg.transcriber
        else send({ type: 'live.status', state: 'warning', message: `unknown transcriber ${String(msg.transcriber)}, using ${transcriberName}` })
      }
      let context: string | undefined
      if (msg.context !== undefined) {
        if (isValidContext(msg.context)) context = msg.context
        else send({ type: 'live.status', state: 'warning', message: `context must be a string of at most ${CONTEXT_MAX_CHARS} characters, ignoring` })
      }
      const clock = new Clock(args.speed)
      starting = (async () => {
        const transcriber = await makeTranscriber({ ...args, interpreter, transcriber: transcriberName }, clock, context)
        // A prior sounding on this connection may still be draining and
        // surfacing (stop() in flight); let it finish before this one
        // starts pushing audio into a fresh LiveSounding.
        if (stopping) { try { await stopping } catch { /* stop already reported its own error */ } }
        const soundingId = `live-${stampName(new Date()).slice(4)}.${interpreter}`
        const l = new LiveSounding({ interpreterName: interpreter, transcriber, clock, send, soundingId, context })
        live = l
        liveWriter = deps.wrap !== undefined ? deps.wrap : interpreter === 'recurrence' ? null : subscriptionWrap()
        await l.start()
        if (args.from) {
          streamFile(args.from, clock, (pcm) => live?.pushAudio(pcm))
            .then(stop)
            .catch((e) => send({ type: 'live.status', state: 'error', message: errMsg(e) }))
        }
      })().catch((e) => { send({ type: 'live.status', state: 'error', message: errMsg(e) }); live = null })
      await starting
      starting = null
    } else if (msg.type === 'stop') {
      await stop()
    } else if (msg.type === 'wrap-prompt') {
      // The speaker's own instructions for the wrap ('' goes back to the default), then the sounding that just ended is wrapped again with them.
      const prompt = validWrapPrompt(msg.text)
      if (prompt === null) { send({ type: 'live.status', state: 'warning', message: `wrap instructions must be text of at most ${WRAP_PROMPT_MAX_CHARS} characters, ignoring` }); return }
      saveWrapPrompt(prompt, deps.promptDir)
      await writeWrap()
    } else if (msg.type === 'rewrap') {
      // With `text`: the same sounding read with other instructions, this once. Nothing is saved.
      const once = msg.text === undefined ? '' : validWrapPrompt(msg.text)
      if (once === null) { send({ type: 'live.status', state: 'warning', message: `wrap instructions must be text of at most ${WRAP_PROMPT_MAX_CHARS} characters, ignoring` }); return }
      await writeWrap(once)
    } else if (msg.type === 'context') {
      // A `context` message can race a still-in-flight `start` (the
      // browser drops it as soon as the socket opens, before the session
      // is up) — without waiting here, `live` is still null and the
      // message is silently dropped. Wait for `start` to settle (ignoring
      // its own error, which it already reported) and apply the context
      // once `live` exists.
      if (starting) { try { await starting } catch { /* start already reported its own error */ } }
      if (!live) return
      if (isValidContext(msg.text)) await live.setContext(msg.text)
      else send({ type: 'live.status', state: 'warning', message: `context must be a string of at most ${CONTEXT_MAX_CHARS} characters, ignoring` })
    } else if (msg.type === 'follow') {
      if (!live) return
      const raw = msg.conceptId
      if (raw !== null && typeof raw !== 'string') {
        send({ type: 'live.status', state: 'warning', message: 'follow conceptId must be a string or null, ignoring' })
        return
      }
      const { label } = await live.follow(raw)
      if (raw !== null && label === null) send({ type: 'live.status', state: 'warning', message: 'unknown concept, let go' })
    } else if (msg.type === 'dismiss' || msg.type === 'restore' || msg.type === 'rename') {
      // The speaker's corrections. Whatever changes reaches the page as log
      // events; only a request that changed nothing gets a warning back.
      if (!live) return
      if (typeof msg.conceptId !== 'string') { send({ type: 'live.status', state: 'warning', message: `${msg.type} needs a conceptId, ignoring` }); return }
      if (msg.type === 'rename') {
        const label = validLabel(msg.label)
        if (label === null) { send({ type: 'live.status', state: 'warning', message: `a label must be 1 to ${LABEL_MAX_CHARS} characters on one line, ignoring` }); return }
        if ((await live.rename(msg.conceptId, label)) === null) send({ type: 'live.status', state: 'warning', message: 'nothing to rename' })
      } else {
        const done = msg.type === 'dismiss' ? await live.dismiss(msg.conceptId) : await live.restore(msg.conceptId)
        if (done === null) send({ type: 'live.status', state: 'warning', message: `nothing to ${msg.type}` })
      }
    }
  })
  ws.on('close', () => void stop())
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

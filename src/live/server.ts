// The live server: browser mic ↔ LiveSounding ↔ Gemini. `npm run live`.
//   npm run live -- [-i gemini|claude|recurrence] [--port 8787] [--from <audio>] [--fixture <name> --fake-transcriber] [--speed N] [--headless]
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { loadDotEnv } from '../cli/env'
import { FIXTURES } from '../replay/fixtures/index'
import { transcribeRecording } from '../providers/whisper-transcription'
import { stampName } from '../devserver/paths'
import { Clock } from './clock'
import { LiveSounding, type InterpreterName, type LiveMessage } from './live-sounding'
import { TranscribeLiveClient } from './transcribe-live'
import { FakeTranscriber } from './fake-transcriber'
import { streamFile } from './fake-mic'
import type { Transcriber } from './transcriber'
import type { FixtureScript } from '../replay/fixture'

interface Args { interpreter: InterpreterName; port: number; from?: string; fixture?: string; fakeTranscriber: boolean; speed: number; headless: boolean }

export function parseArgs(argv: string[]): Args {
  const a: Args = { interpreter: 'gemini', port: 8787, fakeTranscriber: false, speed: 1, headless: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i], next = argv[i + 1]
    if (v === '-i') { if (!['gemini', 'claude', 'recurrence'].includes(next)) throw new Error(`-i must be gemini|claude|recurrence`); a.interpreter = next as InterpreterName; i++ }
    else if (v === '--port') { a.port = Number(next); if (!Number.isInteger(a.port)) throw new Error('--port needs an integer'); i++ }
    else if (v === '--from') { if (!next) throw new Error('--from needs a path'); a.from = next; i++ }
    else if (v === '--fixture') { if (!next) throw new Error('--fixture needs a name'); a.fixture = next; i++ }
    else if (v === '--fake-transcriber') a.fakeTranscriber = true
    else if (v === '--speed') { a.speed = Number(next); if (!Number.isFinite(a.speed) || a.speed <= 0) throw new Error('--speed needs a positive number'); i++ }
    else if (v === '--headless') a.headless = true
    else throw new Error(`unknown argument ${v}`)
  }
  if (a.fakeTranscriber && !a.fixture && !a.from) throw new Error('--fake-transcriber needs --fixture <name> or --from <audio>')
  if (a.speed !== 1 && !a.fakeTranscriber) throw new Error('--speed is only valid with --fake-transcriber')
  return a
}

async function makeTranscriber(args: Args, clock: Clock): Promise<Transcriber> {
  if (args.fakeTranscriber) {
    let script: FixtureScript | undefined
    if (args.fixture) script = FIXTURES.find((f) => f.name === args.fixture)
    else if (args.from) script = await transcribeRecording(args.from, 'models/ggml-large-v3-turbo.bin')
    if (!script) throw new Error(`fixture not found: ${args.fixture}`)
    return new FakeTranscriber(script, clock)
  }
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set — get one at aistudio.google.com')
  return new TranscribeLiveClient(key)
}

async function runHeadless(args: Args): Promise<void> {
  const clock = new Clock(args.speed)
  const transcriber = await makeTranscriber(args, clock)
  const soundingId = `live-${stampName(new Date()).slice(4)}.${args.interpreter}`
  const live = new LiveSounding({ interpreterName: args.interpreter, transcriber, clock, send: () => {}, soundingId })
  await live.start()
  const script = args.fixture ? FIXTURES.find((f) => f.name === args.fixture) : undefined
  if (args.from) await streamFile(args.from, clock, (pcm) => live.pushAudio(pcm))
  else if (script) await clock.sleep(script.endT + 1500)
  const { logPath, summary } = await live.stop()
  console.log(summary)
  console.log(`wrote ${logPath}`)
}

function serve(args: Args): void {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: args.port })
  console.log(`live server listening on ws://localhost:${args.port} — interpreter ${args.interpreter}${args.from ? `, fake mic from ${args.from}` : ''}`)
  wss.on('connection', (ws: WsSocket) => {
    let live: LiveSounding | null = null
    let fakeMic: Promise<void> | null = null
    const send = (m: LiveMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
    const stop = async () => {
      if (!live) return
      const l = live; live = null
      try { const { logPath, summary } = await l.stop(); console.log(summary); console.log(`wrote ${logPath}`); send({ type: 'live.status', state: 'stopped', message: logPath }) }
      catch (e) { send({ type: 'live.status', state: 'error', message: e instanceof Error ? e.message : String(e) }) }
    }
    ws.on('message', async (data: Buffer, isBinary: boolean) => {
      if (isBinary) { live?.pushAudio(new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - (data.length % 2)))); return }
      let msg: { type?: string; interpreter?: string }
      try { msg = JSON.parse(data.toString('utf8')) } catch { return }
      if (msg.type === 'start' && !live) {
        const interpreter = (['gemini', 'claude', 'recurrence'].includes(msg.interpreter ?? '') ? msg.interpreter : args.interpreter) as InterpreterName
        const clock = new Clock(args.speed)
        try {
          const transcriber = await makeTranscriber({ ...args, interpreter }, clock)
          const soundingId = `live-${stampName(new Date()).slice(4)}.${interpreter}`
          live = new LiveSounding({ interpreterName: interpreter, transcriber, clock, send, soundingId })
          await live.start()
          if (args.from) fakeMic = streamFile(args.from, clock, (pcm) => live?.pushAudio(pcm)).then(stop)
        } catch (e) { send({ type: 'live.status', state: 'error', message: e instanceof Error ? e.message : String(e) }); live = null }
      } else if (msg.type === 'stop') await stop()
    })
    ws.on('close', () => void stop())
    void fakeMic
  })
}

const isDirectRun = process.argv[1]?.endsWith('server.ts')
if (isDirectRun) {
  loadDotEnv()
  let args: Args
  try { args = parseArgs(process.argv.slice(2)) } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2) }
  if (args.headless) runHeadless(args).then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
  else serve(args)
}

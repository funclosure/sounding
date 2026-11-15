// Keeps one local whisper.cpp server (Homebrew's `whisper-server`) running for
// this process, model loaded once, bound to 127.0.0.1 on a free port. Every
// live sounding on the whisper transcriber posts its audio here; nothing
// leaves the machine.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { toWav } from './pcm-ring'

export const DEFAULT_WHISPER_MODEL = 'models/ggml-large-v3-turbo.bin'
const READY_TIMEOUT_MS = 90_000

export interface TranscribeOptions { language: string; prompt?: string }
export type TranscribeFn = (pcm: Int16Array, opts: TranscribeOptions) => Promise<string>

export { whisperLanguage } from './langs'

/** Multipart body for whisper-server's /inference. */
export function inferenceForm(pcm: Int16Array, opts: TranscribeOptions): FormData {
  const form = new FormData()
  form.append('file', new Blob([toWav(pcm) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'utterance.wav')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  form.append('language', opts.language)
  if (opts.prompt) form.append('prompt', opts.prompt)
  return form
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let shared: Promise<TranscribeFn> | null = null
let child: ChildProcess | null = null
let signalsHooked = false

function hookSignals(): void {
  if (signalsHooked) return
  signalsHooked = true
  // The child must not outlive us: 'exit' covers normal exits, the signal
  // handlers cover Ctrl-C and launchd's SIGTERM (which skip 'exit' by default).
  process.on('exit', () => child?.kill())
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { child?.kill(); process.exit(sig === 'SIGINT' ? 130 : 143) })
}

async function start(modelPath: string): Promise<TranscribeFn> {
  if (!existsSync(modelPath)) throw new Error(`whisper model not found: ${modelPath}`)
  const port = await freePort()
  const proc = spawn('whisper-server', ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-sns'], { stdio: ['ignore', 'ignore', 'pipe'] })
  child = proc
  hookSignals()
  let stderrTail = ''
  proc.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-600) })
  let failure: Error | null = null
  proc.on('error', (e: NodeJS.ErrnoException) => {
    failure = e.code === 'ENOENT' ? new Error('whisper-server not found in PATH — install with: brew install whisper-cpp') : e
  })
  proc.on('close', (code) => {
    failure ??= new Error(`whisper-server exited (${code}): ${stderrTail.trim().split('\n').at(-1) ?? ''}`)
    if (child === proc) { child = null; shared = null } // next sounding starts a fresh one
  })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + READY_TIMEOUT_MS
  // The server only starts listening once the model is loaded.
  for (;;) {
    if (failure) throw failure
    try { await fetch(base, { signal: AbortSignal.timeout(1000) }); break } catch { /* not up yet */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error('whisper-server did not come up in time') }
    await sleep(200)
  }
  console.log(`whisper-server ready on ${base} — ${modelPath}`)

  return async (pcm, opts) => {
    const res = await fetch(`${base}/inference`, { method: 'POST', body: inferenceForm(pcm, opts) })
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { text?: unknown; error?: unknown }
    if (body.error) throw new Error(`whisper-server: ${String(body.error)}`)
    return typeof body.text === 'string' ? body.text : ''
  }
}

/** The process-wide server, started on first use. A failed start is not cached. */
export function sharedWhisper(modelPath = process.env.SOUNDING_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL): Promise<TranscribeFn> {
  shared ??= start(modelPath).catch((e) => { shared = null; throw e })
  return shared
}

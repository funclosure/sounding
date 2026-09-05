// Gemini 3.5 Transcribe Live over the Live API WebSocket. Verified wire
// shapes are in the slice-3 spec ("Facts"). Key lives in the URL, so this
// runs only in the local Node process.
import type { Transcriber, TranscriberCallbacks } from './transcriber'

export interface WebSocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  readyState: number
}

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
export const SETUP = { setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: [], mode: 'VERBATIM' } } }
const SESSION_LIMIT_MS = 9.5 * 60_000

interface Options {
  socketFactory?: (url: string) => WebSocketLike
  sessionLimitMs?: number
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export class TranscribeLiveClient implements Transcriber {
  private ws: WebSocketLike | null = null
  private cbs: TranscriberCallbacks | null = null
  private limitTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Per-socket: a socket is present whenever audio has been sent to it since
   * its last final. Tells drain(ws) whether a trailing final is still owed
   * by *that* socket — tracked per socket so a final on the old socket
   * during rotation can't clear the fresh socket's pending state.
   */
  private readonly pending = new Set<WebSocketLike>()
  /** Set by end(); tells an in-flight rotate() not to resurrect the session once its fresh socket opens. */
  private ended = false
  private readonly factory: (url: string) => WebSocketLike
  private readonly sessionLimitMs: number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(private readonly apiKey: string, opts: Options = {}) {
    this.factory = opts.socketFactory ?? ((url) => new (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket(url))
    this.sessionLimitMs = opts.sessionLimitMs ?? SESSION_LIMIT_MS
    this.setTimer = opts.setTimer ?? setTimeout
    this.clearTimer = opts.clearTimer ?? clearTimeout
  }

  async connect(cbs: TranscriberCallbacks): Promise<void> {
    this.cbs = cbs
    cbs.onStatus('connecting')
    this.ws = await this.open()
    cbs.onStatus('listening')
    this.armLimit()
  }

  sendAudio(pcm: Int16Array): void {
    if (!this.ws || this.ws.readyState !== 1) return
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: bytes.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }))
    this.pending.add(this.ws)
  }

  async end(): Promise<void> {
    this.ended = true
    if (this.limitTimer) this.clearTimer(this.limitTimer)
    const ws = this.ws
    this.ws = null
    if (!ws) return
    await this.drain(ws)
  }

  private open(): Promise<WebSocketLike> {
    return new Promise((resolve, reject) => {
      const ws = this.factory(`${ENDPOINT}?key=${this.apiKey}`)
      let settled = false
      ws.onopen = () => ws.send(JSON.stringify(SETUP))
      ws.onerror = (e) => { if (!settled) { settled = true; reject(new Error(`transcribe-live socket error: ${String((e as { message?: string })?.message ?? e)}`)) } else this.cbs?.onStatus('error', String((e as { message?: string })?.message ?? e)) }
      ws.onclose = (e) => { if (!settled) { settled = true; reject(new Error(`transcribe-live closed before setup: ${e.code} ${e.reason}`)) } }
      ws.onmessage = (ev) => {
        // Never awaited by the caller (it's a callback field), so a rejection
        // here would be unhandled — keep every failure path inside this try.
        void (async () => {
          let text: string
          try {
            text = typeof ev.data === 'string' ? ev.data : Buffer.from(await (ev.data as Blob).arrayBuffer()).toString('utf8')
          } catch { return }
          let m: { setupComplete?: unknown; serverContent?: { interimInputTranscription?: { text?: string }; inputTranscription?: { text?: string } }; error?: unknown }
          try { m = JSON.parse(text) } catch { return }
          if (m.setupComplete !== undefined) { if (!settled) { settled = true; resolve(ws) } return }
          if (m.error) { this.cbs?.onStatus('error', JSON.stringify(m.error).slice(0, 200)); return }
          const sc = m.serverContent
          // voiceActivity / generationComplete carry no transcript text and are
          // deliberately ignored here; only interim/final text is dispatched.
          if (sc?.interimInputTranscription?.text !== undefined) {
            this.cbs?.onInterim(sc.interimInputTranscription.text)
          } else if (sc?.inputTranscription?.text !== undefined) {
            this.pending.delete(ws)
            this.cbs?.onFinal(sc.inputTranscription.text)
          }
        })()
      }
    })
  }

  /**
   * Send audioStreamEnd, then close. If audio was sent to this socket since
   * its last final, a trailing final is still owed: wait briefly (message or
   * 3s timer, whichever first) before closing. Otherwise there is nothing to
   * wait for and we close right away.
   */
  private drain(ws: WebSocketLike): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; try { ws.close() } catch { /* already closed */ } resolve() } }
      const owed = this.pending.delete(ws)
      try { ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })) } catch { finish(); return }
      if (!owed) { finish(); return }
      const prev = ws.onmessage
      ws.onmessage = (ev) => { prev?.(ev); if (typeof ev.data === 'string' && ev.data.includes('"inputTranscription"')) finish() }
      this.setTimer(finish, 3000)
    })
  }

  private armLimit(): void {
    this.limitTimer = this.setTimer(() => void this.rotate(), this.sessionLimitMs)
  }

  /** Open a fresh session before the 10-minute cap; audio goes to the new socket as soon as it is up. */
  private async rotate(): Promise<void> {
    const old = this.ws
    this.cbs?.onStatus('reconnecting')
    try {
      const fresh = await this.open()
      if (this.ended) { await this.drain(fresh); return }
      this.ws = fresh
      this.cbs?.onStatus('listening')
      this.armLimit()
      if (old) void this.drain(old)
    } catch (e) {
      this.cbs?.onStatus('error', `reconnect failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

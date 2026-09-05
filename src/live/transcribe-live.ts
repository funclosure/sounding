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

/** Setup frame sent on socket open. `languageCodes: []` lets Gemini auto-detect; a non-empty list pins transcription to those languages. */
export function setupMessage(languageCodes: string[]) {
  return { setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes, mode: 'VERBATIM' } } }
}
export const SETUP = setupMessage(['en-US'])
const SESSION_LIMIT_MS = 9.5 * 60_000

const SETUP_TIMEOUT_MS = 10_000

/** Frames arrive as a string, ArrayBuffer, Node Buffer, or Blob depending on the WebSocketLike implementation — decode all four uniformly. */
async function decodeFrame(d: unknown): Promise<string> {
  return typeof d === 'string'
    ? d
    : d instanceof ArrayBuffer
      ? Buffer.from(d).toString('utf8')
      : Buffer.isBuffer(d)
        ? d.toString('utf8')
        : Buffer.from(await (d as Blob).arrayBuffer()).toString('utf8')
}

interface Options {
  socketFactory?: (url: string) => WebSocketLike
  sessionLimitMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  languageCodes?: string[]
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
  /**
   * Per-socket: drain(ws) stores its `finish` resolver here while a trailing
   * final is owed. onmessage calls it (and deletes the entry) at the same
   * point it clears `pending`, so drain resolves on the dispatched final
   * rather than sniffing the raw frame for the string "inputTranscription".
   */
  private readonly drainResolvers = new Map<WebSocketLike, () => void>()
  /** Set by end(); tells an in-flight rotate() not to resurrect the session once its fresh socket opens. */
  private ended = false
  private readonly factory: (url: string) => WebSocketLike
  private readonly sessionLimitMs: number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly languageCodes: string[]

  constructor(private readonly apiKey: string, opts: Options = {}) {
    this.factory = opts.socketFactory ?? ((url) => new (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket(url))
    this.sessionLimitMs = opts.sessionLimitMs ?? SESSION_LIMIT_MS
    this.setTimer = opts.setTimer ?? setTimeout
    this.clearTimer = opts.clearTimer ?? clearTimeout
    this.languageCodes = opts.languageCodes ?? ['en-US']
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
      let setupTimer: ReturnType<typeof setTimeout> | null = null
      const clearSetupTimer = () => { if (setupTimer) { this.clearTimer(setupTimer); setupTimer = null } }
      const doResolve = () => { if (settled) return; settled = true; clearSetupTimer(); resolve(ws) }
      const doReject = (err: Error) => { if (settled) return; settled = true; clearSetupTimer(); reject(err) }
      ws.onopen = () => {
        ws.send(JSON.stringify(setupMessage(this.languageCodes)))
        setupTimer = this.setTimer(() => {
          doReject(new Error('transcribe-live setup timed out'))
          try { ws.close() } catch { /* already closed */ }
        }, SETUP_TIMEOUT_MS)
      }
      ws.onerror = (e) => { if (!settled) doReject(new Error(`transcribe-live socket error: ${String((e as { message?: string })?.message ?? e)}`)); else this.cbs?.onStatus('error', String((e as { message?: string })?.message ?? e)) }
      ws.onclose = (e) => {
        if (!settled) { doReject(new Error(`transcribe-live closed before setup: ${e.code} ${e.reason}`)); return }
        // Setup already completed on this socket. If it's still the client's
        // current socket (not superseded by a rotate/end), an unexpected
        // close here would otherwise leave the session listening into a
        // void — surface it and null out this.ws so sendAudio no-ops.
        if (ws === this.ws && !this.ended) {
          this.cbs?.onStatus('error', `transcribe-live closed: ${e.code} ${e.reason}`)
          this.ws = null
        }
      }
      ws.onmessage = (ev) => {
        // Never awaited by the caller (it's a callback field), so a rejection
        // here would be unhandled — keep every failure path inside this try.
        void (async () => {
          // Stay synchronous for the (overwhelmingly common) string-frame path:
          // awaiting decodeFrame() unconditionally would insert a microtask
          // tick even when there's nothing to decode, reordering this handler
          // relative to synchronous sendAudio()/end() calls made right after
          // ws.onmessage fires.
          let text: string
          try { text = typeof ev.data === 'string' ? ev.data : await decodeFrame(ev.data) } catch { return }
          let m: { setupComplete?: unknown; serverContent?: { interimInputTranscription?: { text?: string }; inputTranscription?: { text?: string } }; error?: unknown }
          try { m = JSON.parse(text) } catch { return }
          if (m.setupComplete !== undefined) { doResolve(); return }
          if (m.error) {
            if (!settled) { doReject(new Error(JSON.stringify(m.error).slice(0, 200))); return }
            this.cbs?.onStatus('error', JSON.stringify(m.error).slice(0, 200))
            return
          }
          const sc = m.serverContent
          // voiceActivity / generationComplete carry no transcript text and are
          // deliberately ignored here; only interim/final text is dispatched.
          if (sc?.interimInputTranscription?.text !== undefined) {
            this.cbs?.onInterim(sc.interimInputTranscription.text)
          } else if (sc?.inputTranscription?.text !== undefined) {
            this.pending.delete(ws)
            this.cbs?.onFinal(sc.inputTranscription.text)
            this.drainResolvers.get(ws)?.()
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
      const finish = () => { if (!done) { done = true; this.drainResolvers.delete(ws); try { ws.close() } catch { /* already closed */ } resolve() } }
      const owed = this.pending.delete(ws)
      try { ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })) } catch { finish(); return }
      if (!owed) { finish(); return }
      this.drainResolvers.set(ws, finish)
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

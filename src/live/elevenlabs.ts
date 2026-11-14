// ElevenLabs hearing, in two halves that the utterance transcriber joins:
// the live model streams a running guess about once a second (what the page
// shows while you speak), and the file model re-hears each finished utterance
// (what is kept, marked and wrapped). The live model is quick but mishears
// ordinary words the file model gets right, so nothing it says is kept.
//
// Both send the sound to ElevenLabs and spend API credit; the key stays in
// this Node process.
import WebSocket from 'ws'
import { toWav } from './pcm-ring'
import type { TranscribeFn } from './whisper-server'
import type { LiveText } from './whisper-transcriber'

export const ELEVEN_FILE_MODEL = 'scribe_v2'
export const ELEVEN_LIVE_MODEL = 'scribe_v2_realtime'
const FILE_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
const LIVE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'

/** The file model as a TranscribeFn: one finished utterance in, its text out. */
export function elevenFile(key: string, fetchFn: typeof fetch = fetch): TranscribeFn {
  return async (pcm, opts) => {
    const form = new FormData()
    form.append('model_id', ELEVEN_FILE_MODEL)
    form.append('tag_audio_events', 'false')
    if (opts.language !== 'auto') form.append('language_code', opts.language)
    form.append('file', new Blob([toWav(pcm) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'utterance.wav')
    const res = await fetchFn(FILE_URL, { method: 'POST', headers: { 'xi-api-key': key }, body: form })
    if (!res.ok) throw new Error(`ElevenLabs speech to text: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    return ((await res.json()) as { text?: string }).text ?? ''
  }
}

export interface LiveSocket {
  send(data: string): void
  close(): void
  on(event: 'open' | 'message' | 'close' | 'error', fn: (arg?: unknown) => void): void
  readyState: number
}

/** How long after a cut the live model's text is ignored when it never confirms the cut. */
const CUT_SETTLE_MS = 1500

/** The live model's running guess. Reopens itself if the socket drops; a sounding never ends because of it. */
export class ElevenLive implements LiveText {
  private ws: LiveSocket | null = null
  private onText: ((text: string) => void) | null = null
  private cutPending = false
  /** After a cut, text still describing the closed utterance may be on its way: dropped until the cut is confirmed. */
  private staleUntil = 0
  /** The live model's text since its last cut, and how much of it belongs to utterances already closed without one. */
  private running = ''
  private shown = 0
  private closed = false

  constructor(
    private readonly key: string,
    private readonly language: string,
    private readonly socket: (url: string, key: string) => LiveSocket = (url, k) => new WebSocket(url, { headers: { 'xi-api-key': k } }) as unknown as LiveSocket,
    private readonly now: () => number = Date.now,
  ) {}

  async open(onText: (text: string) => void): Promise<void> {
    this.onText = onText
    await this.connect()
  }

  feed(pcm: Int16Array): void {
    if (this.closed) return
    if (!this.ws) { void this.connect().catch(() => { /* tried again on the next chunk */ }); return }
    if (this.ws.readyState !== 1) return
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    this.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: bytes.toString('base64'), commit: this.cutPending, sample_rate: 16_000 }))
    if (this.cutPending) { this.cutPending = false; this.staleUntil = this.now() + CUT_SETTLE_MS }
  }

  /**
   * On a pause the live model is told to start over, which it does cleanly
   * from silence. Mid-talk it is left running (started cold inside a sentence
   * it invents words), and only what it adds from here on is passed along.
   */
  cut(paused: boolean): void {
    if (!paused) { this.shown = this.running.length; return }
    this.cutPending = true
    this.staleUntil = Infinity
  }

  close(): void {
    this.closed = true
    try { this.ws?.close() } catch { /* already closed */ }
    this.ws = null
  }

  private connecting: Promise<void> | null = null
  private connect(): Promise<void> {
    if (this.connecting) return this.connecting
    const q = new URLSearchParams({ model_id: ELEVEN_LIVE_MODEL, audio_format: 'pcm_16000', commit_strategy: 'manual' })
    if (this.language !== 'auto') q.set('language_code', this.language)
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = this.socket(`${LIVE_URL}?${q}`, this.key)
      let started = false
      ws.on('message', (data) => {
        let m: { message_type?: string; text?: string; error?: string }
        try { m = JSON.parse(String(data)) } catch { return }
        const type = m.message_type ?? ''
        if (type === 'session_started') { started = true; this.ws = ws; resolve(); return }
        if (type === 'auth_error' || type === 'quota_exceeded') { reject(new Error(`ElevenLabs live: ${m.error ?? type}`)); return }
        if (type.startsWith('committed_transcript')) { this.staleUntil = 0; this.running = ''; this.shown = 0; return }
        if (type !== 'partial_transcript' || !m.text || this.now() < this.staleUntil) return
        this.running = m.text
        if (this.running.length < this.shown) this.shown = 0 // it revised itself shorter than what was set aside
        const fresh = this.running.slice(this.shown)
        // A cut that landed inside a Latin word: start at the next whole one.
        const text = (this.shown > 0 && /^[A-Za-z']/.test(fresh) && /[A-Za-z']$/.test(this.running.slice(0, this.shown)) ? fresh.replace(/^\S+\s*/, '') : fresh).replace(/^[\s,.;:!?，。、！？…—-]+/, '')
        if (text) this.onText?.(text)
      })
      ws.on('error', (e) => { if (!started) reject(new Error(`ElevenLabs live socket: ${String((e as { message?: string })?.message ?? e)}`)) })
      ws.on('close', () => {
        if (!started) reject(new Error('ElevenLabs live closed before it started'))
        if (this.ws === ws) this.ws = null // feed() reopens it
      })
    }).finally(() => { this.connecting = null })
    return this.connecting
  }
}

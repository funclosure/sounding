// A local Transcriber: the same interim/final stream Gemini Transcribe Live
// gives, made from whisper. Audio is gated on energy into utterances; while
// one is being spoken it is re-transcribed about once a second (the interim,
// cumulative and free to revise earlier words); a pause closes it with a
// final. A long run without a pause is closed at its quietest recent moment
// (a breath, a gap between words) and the rest carries into the next one.
//
// All timing is counted in samples received, never the wall clock, so it
// behaves the same at any session speed and tests drive it exactly.
import type { Transcriber, TranscriberCallbacks } from './transcriber'
import type { TranscribeFn } from './whisper-server'

const SAMPLE_RATE = 16_000
const FRAME = 320 // 20ms

export interface WhisperTranscriberOptions {
  /** Resolves once the model is loaded and returns the transcribe call. */
  open: () => Promise<TranscribeFn>
  language: string
  /** Names the speaker brought as context; biases whisper's spelling. */
  vocabulary?: string[]
  /** Rewrites everything heard (Chinese into the chosen script). The rewritten text is also what primes the next utterance. */
  rewrite?: (text: string) => string
  /** A pause this long closes the utterance. */
  endSilenceMs?: number
  /** Continuous talk is closed after this long even without a pause. */
  maxUtteranceMs?: number
  /** New audio needed between two interim passes. */
  interimEveryMs?: number
  /** Voiced audio an utterance needs before it is worth transcribing (drops clicks and coughs). */
  minVoicedMs?: number
  /** Audio kept from just before the voice started, so the first word isn't clipped. */
  preRollMs?: number
  /** Frames quieter than this RMS (int16 scale) are never speech. */
  minRms?: number
  /** How far back from the end a too-long utterance may be cut. */
  splitSearchMs?: number
}

interface Frame { pcm: Int16Array; level: number; loud: boolean }
/** How much of the previous final rides along as whisper's prompt, so casing and punctuation stay consistent across cuts. */
const PROMPT_TAIL_CHARS = 200

const ms = (frames: number) => frames * (FRAME / SAMPLE_RATE) * 1000

function rms(frame: Int16Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

/** Whisper marks non-speech as [BLANK_AUDIO], (music), *sighs* and the like; none of it is talk. */
export function cleanWhisperText(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪/g, ' ').replace(/\s+/g, ' ').trim()
}

export class WhisperTranscriber implements Transcriber {
  private cbs: TranscriberCallbacks | null = null
  private transcribe: TranscribeFn | null = null
  private connected = false
  private readonly o: Required<Omit<WhisperTranscriberOptions, 'open' | 'language' | 'vocabulary' | 'rewrite'>>
  private words: string[]
  private lastFinal = ''

  private carry = new Int16Array(0)          // samples not yet making a whole frame
  private preRoll: Frame[] = []
  private noiseFloor = 0                     // slow average RMS of non-speech frames
  private utterance: Frame[] | null = null
  private voicedFrames = 0
  private silentFrames = 0
  private framesSinceInterim = 0
  /** Bumped whenever an utterance closes: an interim that lands after its utterance closed is stale. */
  private generation = 0
  private interimInFlight = false
  /** Whisper calls run one at a time, in order, so a final always lands before the next utterance's interims. */
  private chain: Promise<void> = Promise.resolve()
  private ended = false
  private failing = false

  constructor(private readonly opts: WhisperTranscriberOptions) {
    this.o = {
      endSilenceMs: opts.endSilenceMs ?? 700,
      maxUtteranceMs: opts.maxUtteranceMs ?? 12_000,
      interimEveryMs: opts.interimEveryMs ?? 1000,
      minVoicedMs: opts.minVoicedMs ?? 200,
      preRollMs: opts.preRollMs ?? 300,
      minRms: opts.minRms ?? 200,
      splitSearchMs: opts.splitSearchMs ?? 3000,
    }
    this.words = [...(opts.vocabulary ?? [])]
  }

  async connect(cbs: TranscriberCallbacks): Promise<void> {
    this.cbs = cbs
    cbs.onStatus('connecting', 'loading the local whisper model')
    this.transcribe = await this.opts.open()
    this.connected = true
    cbs.onStatus('listening')
  }

  sendAudio(pcm: Int16Array): void {
    if (this.ended || !this.connected) return
    const all = new Int16Array(this.carry.length + pcm.length)
    all.set(this.carry); all.set(pcm, this.carry.length)
    let off = 0
    for (; off + FRAME <= all.length; off += FRAME) this.onFrame(all.subarray(off, off + FRAME))
    this.carry = all.slice(off)
  }

  addVocabulary(words: string[]): void {
    for (const w of words) if (!this.words.includes(w)) this.words.push(w)
  }

  /** Closes whatever is being spoken and resolves once its final has been delivered. */
  async end(): Promise<void> {
    if (this.ended) return void (await this.chain)
    this.ended = true
    if (this.utterance) this.close()
    await this.chain
  }

  private onFrame(frame: Int16Array): void {
    const level = rms(frame)
    const loud = level >= Math.max(this.o.minRms, this.noiseFloor * 3)
    if (!this.utterance) {
      if (!loud) {
        this.noiseFloor = this.noiseFloor === 0 ? level : this.noiseFloor * 0.95 + level * 0.05
        this.preRoll.push({ pcm: frame.slice(), level, loud: false })
        if (ms(this.preRoll.length) > this.o.preRollMs) this.preRoll.shift()
        return
      }
      this.utterance = this.preRoll
      this.preRoll = []
      this.voicedFrames = 0
      this.silentFrames = 0
      this.framesSinceInterim = 0
    }
    this.utterance.push({ pcm: frame.slice(), level, loud })
    this.framesSinceInterim++
    if (loud) { this.voicedFrames++; this.silentFrames = 0 } else this.silentFrames++

    if (ms(this.silentFrames) >= this.o.endSilenceMs) return this.close()
    if (ms(this.utterance.length) >= this.o.maxUtteranceMs) return this.split()
    if (!this.interimInFlight && ms(this.framesSinceInterim) >= this.o.interimEveryMs && ms(this.voicedFrames) >= this.o.minVoicedMs) this.interim()
  }

  private snapshot(): Int16Array {
    const frames = this.utterance ?? []
    const out = new Int16Array(frames.length * FRAME)
    frames.forEach((f, i) => out.set(f.pcm, i * FRAME))
    return out
  }

  /**
   * Too long without a pause: close the utterance at the quietest 100ms of
   * its last few seconds rather than wherever the clock ran out (which is
   * usually mid-word), and start the next utterance with what came after.
   */
  private split(): void {
    const frames = this.utterance!
    const SPAN = 5
    const from = Math.max(SPAN, frames.length - Math.round(this.o.splitSearchMs / ms(1)))
    let cut = frames.length, quietest = Infinity
    for (let i = from; i + SPAN <= frames.length; i++) {
      let sum = 0
      for (let j = i; j < i + SPAN; j++) sum += frames[j].level
      if (sum < quietest) { quietest = sum; cut = i + Math.floor(SPAN / 2) }
    }
    const rest = frames.slice(cut)
    this.utterance = frames.slice(0, cut)
    this.voicedFrames = this.utterance.filter((f) => f.loud).length
    this.close()
    if (rest.length === 0) return
    this.utterance = rest
    this.voicedFrames = rest.filter((f) => f.loud).length
    this.silentFrames = 0
    for (let i = rest.length - 1; i >= 0 && !rest[i].loud; i--) this.silentFrames++
    this.framesSinceInterim = rest.length
  }

  private interim(): void {
    const pcm = this.snapshot()
    const gen = this.generation
    this.framesSinceInterim = 0
    this.interimInFlight = true
    this.enqueue(async () => {
      try {
        if (gen !== this.generation) return // its utterance already closed; the final supersedes it
        const text = await this.run(pcm)
        if (text && gen === this.generation) this.cbs?.onInterim(text)
      } finally {
        this.interimInFlight = false
      }
    })
  }

  private close(): void {
    const pcm = this.snapshot()
    const voiced = ms(this.voicedFrames) >= this.o.minVoicedMs
    this.utterance = null
    this.generation++
    if (!voiced) return
    this.enqueue(async () => {
      const text = await this.run(pcm)
      if (text) { this.lastFinal = text; this.cbs?.onFinal(text) }
    })
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch(() => { /* run() reports its own failures */ })
  }

  private async run(pcm: Int16Array): Promise<string> {
    try {
      // After a failure the handle is dropped, so this asks for the server again (it restarts if it died).
      this.transcribe ??= await this.opts.open()
      const heard = cleanWhisperText(await this.transcribe(pcm, { language: this.opts.language, prompt: ((this.words.length ? `${this.words.join(', ')}. ` : '') + this.lastFinal.slice(-PROMPT_TAIL_CHARS)) || undefined }))
      const text = this.opts.rewrite ? this.opts.rewrite(heard) : heard
      if (this.failing) { this.failing = false; this.cbs?.onStatus('listening') }
      return text
    } catch (e) {
      // 'reconnecting', not 'error': an error status ends the sounding on the
      // page, and one lost utterance shouldn't. Reported once per streak.
      this.transcribe = null
      if (!this.failing) { this.failing = true; this.cbs?.onStatus('reconnecting', e instanceof Error ? e.message : String(e)) }
      return ''
    }
  }
}

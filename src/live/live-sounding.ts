// One live sounding. Owns the session, the transcriber, the ring buffer and
// the segmenter; forwards every log event to `send`; writes the log on stop.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SoundingSession } from '../core/session'
import type { SoundingEvent } from '../core/events'
import type { Ms } from '../core/types'
import { ReadingDynamics } from '../salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../salience/config'
import { EmbeddingIdentityResolver } from '../providers/embedding-identity'
import { RecurrenceInterpreter } from '../interpret/recurrence'
import { ClaudeExtractionInterpreter } from '../providers/claude-extraction'
import { GeminiAudioInterpreter } from '../providers/gemini-audio'
import { summarizeCounters } from '../replay/counters'
import type { Interpreter } from '../interpret/port'
import { Segmenter } from './segmenter'
import { PcmRing, toWav } from './pcm-ring'
import { heardWords } from './heard-words'
import type { Transcriber } from './transcriber'
import type { Clock } from './clock'

export type InterpreterName = 'gemini' | 'claude' | 'recurrence'
export type LiveMessage =
  | SoundingEvent
  | { type: 'live.heard'; t: Ms; words: string[] }
  | { type: 'live.status'; state: string; message?: string }

export interface LiveSoundingOptions {
  interpreterName: InterpreterName
  transcriber: Transcriber
  clock: Clock
  send: (m: LiveMessage) => void
  soundingId: string
}

function makeInterpreter(name: InterpreterName): Interpreter {
  if (name === 'claude') return new ClaudeExtractionInterpreter()
  if (name === 'gemini') return new GeminiAudioInterpreter()
  return new RecurrenceInterpreter()
}

export class LiveSounding {
  private readonly session: SoundingSession
  private readonly ring = new PcmRing()
  private readonly segmenter = new Segmenter()
  private sent = 0
  private stopClock: (() => void) | null = null
  private stopIdle: (() => void) | null = null
  private stopped = false

  constructor(private readonly opts: LiveSoundingOptions) {
    const interpreter = makeInterpreter(opts.interpreterName)
    const config = { ...DEFAULT_SALIENCE_CONFIG }
    const dynamics = new ReadingDynamics(new EmbeddingIdentityResolver(config.similarityThreshold), config)
    const audioSource = interpreter.input === 'audio'
      ? async (seg: { segmentId: string; startT: Ms; endT: Ms }) => ({
          kind: 'audio' as const, segmentId: seg.segmentId, mimeType: 'audio/wav',
          data: toWav(this.ring.slice(seg.endT - 30_000, seg.endT)), startT: seg.startT, endT: seg.endT,
        })
      : undefined
    this.session = new SoundingSession(interpreter, dynamics, config, opts.soundingId, audioSource)
  }

  async start(): Promise<void> {
    const { clock, transcriber } = this.opts
    clock.start()
    this.session.drop()
    this.flush()
    await transcriber.connect({
      onInterim: (text) => void this.onInterim(text),
      onFinal: (text) => void this.onFinal(text),
      onStatus: (state, message) => this.opts.send({ type: 'live.status', state, message }),
    })
    this.stopClock = clock.every(100, () => void this.run(() => this.session.advanceTo(clock.now())))
    this.stopIdle = clock.every(1000, () => void this.onIdle())
  }

  pushAudio(pcm: Int16Array): void {
    if (this.stopped) return
    this.ring.push(pcm, this.opts.clock.now())
    this.opts.transcriber.sendAudio(pcm)
  }

  async stop(): Promise<{ logPath: string; summary: string }> {
    this.stopped = true
    this.stopClock?.(); this.stopIdle?.()
    await this.opts.transcriber.end()
    await this.run(() => this.session.surface(this.opts.clock.now()))
    mkdirSync('soundings', { recursive: true })
    const logPath = join('soundings', `${this.opts.soundingId}.jsonl`)
    writeFileSync(logPath, this.session.log.toJsonl())
    const c = summarizeCounters(this.session.log.all())
    const summary = `${c.callCount} interpretation calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms · max ${Math.round(c.maxLatencyMs)}ms`
    return { logPath, summary }
  }

  private async onInterim(text: string): Promise<void> {
    const t = this.opts.clock.now()
    const { pendingDelta, commit } = this.segmenter.onInterim(t, text)
    if (pendingDelta) {
      const words = heardWords(pendingDelta)
      if (words.length) this.opts.send({ type: 'live.heard', t, words })
      await this.run(() => this.session.feedPending(t, pendingDelta))
    }
    if (commit) await this.run(() => this.session.feedCommitted(commit.endT, commit))
  }

  private async onFinal(text: string): Promise<void> {
    const { commit } = this.segmenter.onFinal(this.opts.clock.now(), text)
    if (commit) await this.run(() => this.session.feedCommitted(commit.endT, commit))
  }

  private async onIdle(): Promise<void> {
    const { commit } = this.segmenter.onIdle(this.opts.clock.now())
    if (commit) await this.run(() => this.session.feedCommitted(commit.endT, commit))
  }

  /** Run a session op, then forward whatever it appended. Errors go to the client as status, never crash. */
  private async run(op: () => Promise<void>): Promise<void> {
    try { await op() } catch (e) { this.opts.send({ type: 'live.status', state: 'error', message: e instanceof Error ? e.message : String(e) }) }
    this.flush()
  }

  private flush(): void {
    const all = this.session.log.all()
    while (this.sent < all.length) this.opts.send(all[this.sent++])
  }
}

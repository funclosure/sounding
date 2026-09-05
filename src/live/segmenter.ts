// Turns Transcribe Live's interim/final stream into the engine's two loops.
// Interims are cumulative per utterance and revise earlier words; finals only
// arrive on pauses, so continuous talk is cut on a clock as well.
import type { Ms } from '../core/types'

export interface LiveSegment { segmentId: string; transcript: string; startT: Ms; endT: Ms }
export interface SegmenterOptions { maxSegmentMs?: number; minSegmentWords?: number }

const words = (s: string) => s.trim().split(/\s+/).filter((w) => w.length > 0)

export class Segmenter {
  private readonly maxSegmentMs: number
  private readonly minSegmentWords: number
  private lastInterim = ''
  private committedPrefix = ''  // words of the current utterance already committed
  private lastCommitT: Ms = 0
  private seq = 0

  constructor(opts: SegmenterOptions = {}) {
    this.maxSegmentMs = opts.maxSegmentMs ?? 8000
    this.minSegmentWords = opts.minSegmentWords ?? 4
  }

  onInterim(t: Ms, text: string): { pendingDelta: string; commit: LiveSegment | null } {
    const prev = words(this.lastInterim)
    const next = words(text)
    let i = 0
    while (i < prev.length && i < next.length && prev[i] === next[i]) i++
    const pendingDelta = next.slice(i).join(' ')
    this.lastInterim = text
    return { pendingDelta, commit: this.maybeCut(t) }
  }

  onIdle(t: Ms): { commit: LiveSegment | null } {
    return { commit: this.maybeCut(t) }
  }

  onFinal(t: Ms, text: string): { commit: LiveSegment | null } {
    const remainder = this.tailAfterCommitted(text)
    let commit: LiveSegment | null = null
    if (words(remainder).length > 0) commit = this.emit(t, remainder)
    this.lastInterim = ''
    this.committedPrefix = ''
    this.lastCommitT = t
    return { commit }
  }

  private maybeCut(t: Ms): LiveSegment | null {
    if (t - this.lastCommitT < this.maxSegmentMs) return null
    const tail = this.tailAfterCommitted(this.lastInterim)
    if (words(tail).length < this.minSegmentWords) return null
    const seg = this.emit(t, tail)
    this.committedPrefix = this.lastInterim
    return seg
  }

  /** Words of `text` after the committed prefix (by word count, since finals may re-punctuate). */
  private tailAfterCommitted(text: string): string {
    const n = words(this.committedPrefix).length
    return words(text).slice(n).join(' ')
  }

  private emit(t: Ms, transcript: string): LiveSegment {
    this.seq += 1
    const seg = { segmentId: `live-${this.seq}`, transcript, startT: this.lastCommitT, endT: t }
    this.lastCommitT = t
    return seg
  }
}

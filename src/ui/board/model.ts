import type { SoundingEvent } from '../../core/events'
import type { Ms, Transition } from '../../core/types'

/** A mark as the board draws it: no weight, no history — just what's shown. */
export interface MarkView {
  id: string
  label: string
  p: number
}

/** One reading, flattened to what the pure board/model code needs. */
export interface ReadingSnapshot {
  t: Ms
  marks: MarkView[]
  transitions: Transition[]
  slack: boolean
}

export function snapshotOf(e: Extract<SoundingEvent, { type: 'reading.changed' }>): ReadingSnapshot {
  return {
    t: e.t,
    marks: e.reading.marks.map((m) => ({ id: m.conceptId, label: m.label, p: m.prominence })),
    transitions: e.transitions,
    slack: e.reading.slack,
  }
}

export interface Diff {
  arrived: MarkView[]
  kept: MarkView[]
  departed: Array<{ id: string; reason: 'displaced' | 'absorbed' | 'faded'; by?: string }>
}

/**
 * What changed between two readings. Ported from the prototype's
 * `applyReading` (docs/design/sounding-phone.template.html): a mark that
 * vanishes is `displaced` when a `displaced` transition names it, `absorbed`
 * when a `merged` transition's `fromConceptId` is it, else it just `faded`.
 */
export function diffReadings(prev: ReadingSnapshot | null, next: ReadingSnapshot): Diff {
  const prevIds = new Set((prev?.marks ?? []).map((m) => m.id))
  const nextIds = new Set(next.marks.map((m) => m.id))

  const displacedBy = new Map<string, string>()
  const absorbed = new Set<string>()
  for (const tr of next.transitions) {
    if (tr.kind === 'displaced') displacedBy.set(tr.conceptId, tr.byConceptId)
    if (tr.kind === 'merged') absorbed.add(tr.fromConceptId)
  }

  const arrived: MarkView[] = []
  const kept: MarkView[] = []
  for (const m of next.marks) {
    if (prevIds.has(m.id)) kept.push(m)
    else arrived.push(m)
  }

  const departed: Diff['departed'] = []
  for (const id of prevIds) {
    if (nextIds.has(id)) continue
    const by = displacedBy.get(id)
    if (by) departed.push({ id, reason: 'displaced', by })
    else if (absorbed.has(id)) departed.push({ id, reason: 'absorbed' })
    else departed.push({ id, reason: 'faded' })
  }

  return { arrived, kept, departed }
}

export interface TranscriptModel {
  stamps: Array<{ t: Ms; label: string }>
  segments: Array<{ t: Ms; text: string }>
  pendingTail: string
}

function fmtClock(t: Ms): string {
  const s = Math.floor(t / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const STAMP_INTERVAL_MS = 30_000

/**
 * The transcript as it stood at `now`: committed segments at or before now,
 * a time stamp every 30s of segment start (the prototype's
 * `buildTranscript`/`renderTranscript`), and the pending text heard since
 * the last committed segment, up to now.
 */
export function transcriptAt(events: readonly SoundingEvent[], now: Ms): TranscriptModel {
  const stamps: Array<{ t: Ms; label: string }> = []
  const segments: Array<{ t: Ms; text: string }> = []
  let lastBucket = -1
  let lastCommittedT = 0

  for (const e of events) {
    if (e.type !== 'segment.committed') continue
    if (e.t > now) continue
    const bucket = Math.floor(e.startT / STAMP_INTERVAL_MS)
    if (bucket !== lastBucket) {
      // `t` anchors the stamp to the segment that triggered it (for exact
      // interleaving against `segments` by commit order); `label` is the
      // displayed clock, derived from the 30s bucket of that segment's start.
      stamps.push({ t: e.t, label: fmtClock(bucket * STAMP_INTERVAL_MS) })
      lastBucket = bucket
    }
    segments.push({ t: e.t, text: e.transcript })
    lastCommittedT = e.t
  }

  const tail: string[] = []
  for (const e of events) {
    if (e.type !== 'segment.pending') continue
    if (e.t > lastCommittedT && e.t <= now) tail.push(e.text)
  }

  return { stamps, segments, pendingTail: tail.join(' ') }
}

/**
 * One lane per concept, ordered by first appearance, each a step series of
 * prominence over time (the prototype's `series`/the `order`/`firstT` setup
 * in `buildChart`).
 */
export function laneSeries(readings: ReadingSnapshot[], endT: Ms): Array<{ id: string; label: string; firstT: Ms; points: Array<[Ms, number]> }> {
  const order: string[] = []
  const firstT = new Map<string, Ms>()
  const labels = new Map<string, string>()
  for (const r of readings) {
    for (const m of r.marks) {
      if (!firstT.has(m.id)) {
        firstT.set(m.id, r.t)
        labels.set(m.id, m.label)
        order.push(m.id)
      }
    }
  }

  return order.map((id) => {
    const points: Array<[Ms, number]> = []
    let cur = 0
    for (const r of readings) {
      const m = r.marks.find((x) => x.id === id)
      // Quantized to 3 decimals: floating-point drift in prominence would
      // otherwise never compare equal to `cur`, adding two points per tick
      // even when the value hasn't meaningfully changed.
      const p = m ? Math.round(m.p * 1000) / 1000 : 0
      if (p !== cur) {
        points.push([r.t, cur])
        points.push([r.t, p])
        cur = p
      } else if (points.length === 0) {
        points.push([r.t, 0])
      }
    }
    points.push([endT, cur])
    return { id, label: labels.get(id)!, firstT: firstT.get(id)!, points }
  })
}

/** The final reading, ranked — the prototype's "surfaced" list. */
export function ranked(snapshot: ReadingSnapshot): Array<{ label: string; pct: number; rel: number }> {
  if (snapshot.marks.length === 0) return []
  const sorted = [...snapshot.marks].sort((a, b) => b.p - a.p)
  const top = sorted[0].p
  return sorted.map((m) => ({ label: m.label, pct: Math.round(m.p * 100), rel: top > 0 ? m.p / top : 0 }))
}

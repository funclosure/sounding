// Earlier soundings, the pure half: how one is named and what the list says of
// it. Shared by the server (earlier.ts, on disk) and the page (src/own, in the
// browser's own storage).
import type { SoundingEvent } from '../core/events'
import { wrapMaterial } from './wrap-core'

/** Only soundings spoken into the app: live-YYYYMMDD-HHMMSS.<interpreter>.jsonl. The name is the only thing a page may ask for. */
export const EARLIER_NAME_RE = /^live-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.[a-z][a-z-]{0,30}\.jsonl$/
export const EARLIER_MAX = 200

export interface EarlierItem {
  name: string
  /** When it was started, as local wall time: YYYY-MM-DDTHH:MM:SS. */
  at: string
  durationMs: number
  /** The most prominent marks at the end, at most three. */
  marks: string[]
  /** Whether anything was said at all. */
  said: boolean
}

export const isEarlierName = (v: unknown): v is string => typeof v === 'string' && EARLIER_NAME_RE.test(v)

/** The list's line for one sounding, from its name and its log. */
export function earlierItem(name: string, events: readonly SoundingEvent[]): EarlierItem {
  const [, y, mo, d, h, mi, s] = EARLIER_NAME_RE.exec(name)!
  const m = wrapMaterial(events)
  return { name, at: `${y}-${mo}-${d}T${h}:${mi}:${s}`, durationMs: events.at(-1)?.t ?? 0, marks: m.marks.slice(0, 3), said: !!m.transcript }
}

// Earlier soundings: the ones already saved in soundings/, listed, opened
// again and removed. Removing moves the files to the Trash, never deletes
// them. Provider layer — disk allowed.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { EventLog, type SoundingEvent } from '../core/events'
import { EARLIER_MAX, EARLIER_NAME_RE as NAME_RE, earlierItem, isEarlierName, type EarlierItem } from './earlier-core'

export { EARLIER_MAX, isEarlierName, type EarlierItem }

const wrapPathOf = (logPath: string) => logPath.replace(/\.jsonl$/, '') + '.wrap.md'

function readEvents(path: string): SoundingEvent[] | null {
  try { return [...EventLog.fromJsonl(readFileSync(path, 'utf8')).all()] } catch { return null }
}

/** Newest first. A log that cannot be read is still listed (so it can be removed), as an empty one. */
export function listEarlier(dir = 'soundings'): EarlierItem[] {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).filter((n) => NAME_RE.test(n)).sort().reverse().slice(0, EARLIER_MAX)
  return names.map((name) => earlierItem(name, readEvents(join(dir, name)) ?? []))
}

/** One earlier sounding: its log, and the wrap saved beside it if there is one. Null if there is no such sounding. */
export function readEarlier(name: string, dir = 'soundings'): { logPath: string; events: SoundingEvent[]; wrap: string | null } | null {
  if (!isEarlierName(name)) return null
  const logPath = join(dir, name)
  if (!existsSync(logPath)) return null
  const events = readEvents(logPath)
  if (!events) return null
  const wrapPath = wrapPathOf(logPath)
  const wrap = existsSync(wrapPath) ? readFileSync(wrapPath, 'utf8').trim() || null : null
  return { logPath, events, wrap }
}

function moveTo(from: string, trash: string, name: string): void {
  let to = join(trash, name)
  for (let i = 2; existsSync(to); i++) to = join(trash, `${name.replace(/(\.[^.]+)$/, '')} ${i}${/(\.[^.]+)$/.exec(name)?.[1] ?? ''}`)
  try { renameSync(from, to) }
  catch (e) {
    // the Trash is on another volume: copy, then drop the original
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

/** Moves the sounding's log and its wrap to the Trash. False if there is no such sounding. */
export function removeEarlier(name: string, dir: string, trash: string): boolean {
  if (!isEarlierName(name)) return false
  const logPath = join(dir, name)
  if (!existsSync(logPath)) return false
  mkdirSync(trash, { recursive: true })
  const wrapPath = wrapPathOf(logPath)
  if (existsSync(wrapPath)) moveTo(wrapPath, trash, wrapPathOf(name))
  moveTo(logPath, trash, name)
  return true
}

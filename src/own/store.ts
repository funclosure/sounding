// Soundings kept in the listener's own browser (IndexedDB): the log, the wrap
// beside it, and the line the earlier-list shows. Nothing here leaves the
// device; removing one deletes it for good, since a browser has no Trash.
import { EventLog, type SoundingEvent } from '../core/events'
import { EARLIER_MAX, earlierItem, isEarlierName, type EarlierItem } from '../live/earlier-core'

export interface Kept { name: string; jsonl: string; wrap: string | null; item: EarlierItem }

export interface SoundingStore {
  put(name: string, jsonl: string): Promise<void>
  setWrap(name: string, wrap: string): Promise<void>
  list(): Promise<EarlierItem[]>
  get(name: string): Promise<{ events: SoundingEvent[]; wrap: string | null; jsonl: string } | null>
  remove(name: string): Promise<boolean>
}

function eventsOf(jsonl: string): SoundingEvent[] | null {
  try { return [...EventLog.fromJsonl(jsonl).all()] } catch { return null }
}

/** What is kept for one sounding. A log that cannot be read is still kept (so it can be removed), listed as an empty one. */
export function keptOf(name: string, jsonl: string, wrap: string | null = null): Kept {
  return { name, jsonl, wrap, item: earlierItem(name, eventsOf(jsonl) ?? []) }
}

/** The store's behaviour over any map-like backing; the IndexedDB one below and the tests' in-memory one share it. */
export interface Backing {
  read(name: string): Promise<Kept | undefined>
  write(k: Kept): Promise<void>
  erase(name: string): Promise<void>
  all(): Promise<Kept[]>
}

export function storeOver(b: Backing): SoundingStore {
  return {
    async put(name, jsonl) { if (isEarlierName(name)) await b.write(keptOf(name, jsonl, (await b.read(name))?.wrap ?? null)) },
    async setWrap(name, wrap) { const k = await b.read(name); if (k) await b.write({ ...k, wrap: wrap.trim() || null }) },
    // newest first: the names sort by their timestamp
    async list() { return (await b.all()).map((k) => k.item).sort((x, y) => (x.name < y.name ? 1 : -1)).slice(0, EARLIER_MAX) },
    async get(name) {
      const k = isEarlierName(name) ? await b.read(name) : undefined
      const events = k && eventsOf(k.jsonl)
      return k && events ? { events, wrap: k.wrap, jsonl: k.jsonl } : null
    },
    async remove(name) { if (!isEarlierName(name) || !(await b.read(name))) return false; await b.erase(name); return true },
  }
}

export function memoryBacking(): Backing {
  const m = new Map<string, Kept>()
  return { read: async (n) => m.get(n), write: async (k) => void m.set(k.name, k), erase: async (n) => void m.delete(n), all: async () => [...m.values()] }
}

const DB = 'sounding', STORE = 'soundings'
function idbBacking(): Backing {
  let opening: Promise<IDBDatabase> | null = null
  const db = () => (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { opening = null; reject(req.error ?? new Error('this browser will not keep soundings')) }
  }))
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db()
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error('could not reach the saved soundings'))
    })
  }
  return {
    read: (n) => run<Kept | undefined>('readonly', (s) => s.get(n)),
    write: async (k) => void (await run('readwrite', (s) => s.put(k))),
    erase: async (n) => void (await run('readwrite', (s) => s.delete(n))),
    all: () => run<Kept[]>('readonly', (s) => s.getAll()),
  }
}

/** The browser's store. Falls back to memory (kept for this visit only) where IndexedDB is not available. */
export function browserStore(): SoundingStore {
  return storeOver(typeof indexedDB === 'undefined' ? memoryBacking() : idbBacking())
}

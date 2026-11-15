// How the live page reaches its listener. By default that is a WebSocket to
// the server it was loaded from. The own-keys build (src/own) installs a
// bridge before the page starts: the listener then runs inside the page, and
// the bridge also carries the few things only that build has (the keys, the
// model for marks, saving a sounding to a file).
export interface PageSocket {
  readyState: number
  binaryType: string
  send(data: string | ArrayBuffer): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
}

/** What a check of one pasted key found: accepted, refused by its provider, or the provider could not be reached. */
export type KeyCheck = 'ok' | 'refused' | 'unreachable' | 'missing'

export interface OwnBridge {
  open(): PageSocket
  hasKeys(): boolean
  /** Checks both keys with their providers (no cost) and keeps them only if neither was refused. */
  saveKeys(k: { claude: string; eleven: string }): Promise<{ claude: KeyCheck; eleven: KeyCheck; saved: boolean }>
  forgetKeys(): void
  models(): readonly string[]
  saveModel(model: string): void
  /** One kept sounding as a file's worth of text, for the listener to save. Null if it is no longer there. */
  exportSounding(name: string): Promise<{ filename: string; text: string } | null>
}

let bridge: OwnBridge | null = null
export function installOwn(b: OwnBridge): void { bridge = b }
export function own(): OwnBridge | null { return bridge }

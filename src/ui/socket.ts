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

/**
 * What a check of one pasted key found. From the key itself: 'missing', 'other' (the other service's key),
 * 'admin' (an Anthropic admin key) or 'shape' (not a Claude key). From its provider: 'ok', 'refused',
 * 'short' (refused, and shorter than a whole key), 'nocredit' (Claude: no credit on the account) or 'unreachable'.
 */
export type KeyCheck = 'ok' | 'missing' | 'other' | 'admin' | 'shape' | 'refused' | 'short' | 'nocredit' | 'unreachable'
export type KeyWhich = 'claude' | 'eleven'

export interface OwnBridge {
  open(): PageSocket
  hasKeys(): boolean
  /** Enough of each saved key to recognise it by. */
  hints(): { claude: string; eleven: string }
  /** What the pasted text looks like, before anyone is asked: 'ok' means it is worth asking. */
  look(which: KeyWhich, typed: string): KeyCheck
  /** Asks the key's provider (a fraction of a cent for Claude, nothing for ElevenLabs) and keeps the key unless it was refused. */
  setKey(which: KeyWhich, typed: string): Promise<KeyCheck>
  /** The carry code: a QR code of this site's address with both saved keys after its #, as rows of dark (true) and light modules. Null until both are saved. */
  carryCode(): boolean[][] | null
  /** Hints of the keys that arrived in this page's address from a carry code, waiting for the listener to say yes. */
  carried(): { claude: string; eleven: string } | null
  /** Checks the carried keys and keeps both, unless either was turned away. Null if none were waiting. */
  useCarried(): Promise<{ claude: KeyCheck; eleven: KeyCheck } | null>
  dropCarried(): void
  forgetKeys(): void
  models(): readonly string[]
  saveModel(model: string): void
  /** One kept sounding as a file's worth of text, for the listener to save. Null if it is no longer there. */
  exportSounding(name: string): Promise<{ filename: string; text: string } | null>
}

let bridge: OwnBridge | null = null
export function installOwn(b: OwnBridge): void { bridge = b }
export function own(): OwnBridge | null { return bridge }

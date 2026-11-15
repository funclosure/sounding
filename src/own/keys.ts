import qrcode from 'qrcode-generator'

// The two keys a listener brings, before anyone is asked about them: what a
// pasted key looks like at a glance, and the code that carries both keys from
// one of the listener's own screens to another.

export type Which = 'claude' | 'eleven'
export interface Keys { claude: string; eleven: string }

/** A pasted key, tidied: whitespace and stray quotes off the ends. */
export const tidyKey = (v: string): string => v.trim().replace(/^["']+|["']+$/g, '')

/**
 * What can be told from the key itself, before its provider is asked:
 * 'other' is the other service's key in this box, 'admin' an Anthropic admin
 * key (it cannot make calls), 'shape' something that is not a Claude key at all.
 */
export type Look = 'ok' | 'other' | 'admin' | 'shape'
export function lookOf(which: Which, key: string): Look {
  const k = tidyKey(key)
  if (which === 'claude') {
    if (/^sk_/.test(k) || /^[0-9a-f]{32}$/.test(k)) return 'other'
    if (/^sk-ant-admin/.test(k)) return 'admin'
    return /^sk-ant-/.test(k) ? 'ok' : 'shape'
  }
  // ElevenLabs keys start with sk_ today; older ones are 32 hex digits. Only a Claude key is turned away here.
  return /^sk-ant-/.test(k) ? 'other' : 'ok'
}

/** Shorter than any whole key of its kind: a refused key this short was most likely cut off while copying. */
export function looksCutShort(which: Which, key: string): boolean {
  const k = tidyKey(key)
  return which === 'claude' ? k.length < 90 : /^sk_/.test(k) ? k.length < 51 : k.length < 32
}

/** Enough of a key to recognise it by, never the key: `sk-ant-…ab12`. */
export const keyHint = (k: string): string => (k.length > 12 ? `${k.slice(0, /^sk_/.test(k) ? 3 : 7)}…${k.slice(-4)}` : k ? '…' : '')

// ---- the carry code. Both keys ride in the address's fragment (after #), which
// a browser never sends to the site: they go from one screen to the other
// through the camera and nothing else.

/** The address a code on one screen gives the other: this site, with both keys after the #. */
export function carryUrl(siteUrl: string, keys: Keys): string {
  const u = new URL(siteUrl)
  u.search = ''
  u.hash = new URLSearchParams({ c: tidyKey(keys.claude), e: tidyKey(keys.eleven) }).toString()
  return u.toString()
}

/** Keys arriving in this page's address, if they did. Null when the fragment does not hold both. */
export function carriedIn(hash: string): Keys | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const claude = tidyKey(p.get('c') ?? ''), eleven = tidyKey(p.get('e') ?? '')
  return claude && eleven ? { claude, eleven } : null
}

/** The modules of a QR code for an address, dark as true. Error correction M: a screen photographed by a phone is a clean picture. */
export function carryCode(url: string): boolean[][] {
  const q = qrcode(0, 'M')
  q.addData(url, 'Byte')
  q.make()
  const n = q.getModuleCount()
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)))
}

/** Whether an address's fragment carries keys, whole or in part. */
export const holdsKeys = (hash: string): boolean => /(^#|&)(c|e)=/.test(hash)

/** Takes keys out of the page's address the moment it loads, so they are never left in it, in its history entry or in a bookmark. */
export function takeCarried(loc: { hash: string; pathname: string; search: string }, history: { replaceState(data: unknown, unused: string, url: string): void }): Keys | null {
  const keys = carriedIn(loc.hash)
  if (holdsKeys(loc.hash)) history.replaceState(null, '', loc.pathname + loc.search)
  return keys
}

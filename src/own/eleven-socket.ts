// The page's socket to ElevenLabs' live model. A browser cannot put the key in
// a header on a WebSocket, so the page first trades the key for a single-use
// token (one request, straight to ElevenLabs) and opens the socket with that.
import type { LiveSocket } from '../live/elevenlabs'

const TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe'

/** A token good for one live connection. Throws with a readable reason. */
export async function elevenToken(key: string, fetchFn: typeof fetch = fetch): Promise<string> {
  let res: Response
  try { res = await fetchFn(TOKEN_URL, { method: 'POST', headers: { 'xi-api-key': key } }) }
  catch { throw new Error('cannot reach ElevenLabs') }
  if (res.status === 401 || res.status === 403) throw new Error('ElevenLabs did not accept the key')
  if (!res.ok) throw new Error(`ElevenLabs: HTTP ${res.status}`)
  const token = ((await res.json()) as { token?: string }).token
  if (!token) throw new Error('ElevenLabs gave no token')
  return token
}

/** Asks ElevenLabs whether the key is accepted for live hearing. Costs nothing. Null when it is, else a reason. */
export async function checkElevenKey(key: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try { await elevenToken(key, fetchFn); return null }
  catch (e) { return e instanceof Error && e.message.includes('did not accept') ? 'refused' : 'unreachable' }
}

type Handler = (arg?: unknown) => void
interface BrowserSocket { send(d: string): void; close(): void; readyState: number; onopen: (() => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onerror: (() => void) | null; onclose: (() => void) | null }

/** The socket factory ElevenLive takes: token first, then the WebSocket. Until it is open nothing is sent. */
export function browserElevenSocket(fetchFn: typeof fetch = fetch, open: (url: string) => BrowserSocket = (url) => new WebSocket(url) as unknown as BrowserSocket) {
  return (url: string, key: string): LiveSocket => {
    const handlers: Record<string, Handler> = {}
    let inner: BrowserSocket | null = null
    let closed = false
    const sock: LiveSocket = {
      readyState: 0,
      send: (d) => { if (inner && inner.readyState === 1) inner.send(d) },
      close: () => { closed = true; sock.readyState = 3; if (inner) inner.close(); else handlers.close?.() },
      on: (ev, fn) => { handlers[ev] = fn },
    }
    elevenToken(key, fetchFn).then((token) => {
      if (closed) return
      inner = open(`${url}&token=${encodeURIComponent(token)}`)
      inner.onopen = () => { sock.readyState = 1; handlers.open?.() }
      inner.onmessage = (ev) => handlers.message?.(ev.data)
      inner.onerror = () => handlers.error?.(new Error('the connection to ElevenLabs failed'))
      inner.onclose = () => { sock.readyState = 3; handlers.close?.() }
    }, (e) => { if (closed) return; sock.readyState = 3; handlers.error?.(e); handlers.close?.() })
    return sock
  }
}

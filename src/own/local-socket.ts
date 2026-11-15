// The listener inside the page, behind the same face the page's WebSocket has:
// the page sends the same messages and microphone frames and hears the same
// answers, but nothing crosses a network here. What does leave the device is
// decided by the host (the sound to ElevenLabs, the words to Anthropic).
import { liveConnection, type LiveHost } from '../live/connection'
import type { PageSocket } from '../ui/socket'

export function localSocket(host: LiveHost): PageSocket {
  // Answers are handed over in order on a later turn, as a real socket's are: the page never hears one from inside its own send().
  const out: string[] = []
  let flushing = false
  const flush = () => {
    flushing = false
    while (out.length) { const data = out.shift()!; if (s.readyState === 1) s.onmessage?.({ data }) }
  }
  const conn = liveConnection((m) => {
    if (s.readyState !== 1) return
    out.push(JSON.stringify(m))
    if (!flushing) { flushing = true; queueMicrotask(flush) }
  }, host)
  const s: PageSocket = {
    readyState: 0,
    binaryType: 'arraybuffer',
    onopen: null, onmessage: null, onerror: null, onclose: null,
    send(data) {
      if (s.readyState !== 1) return
      if (typeof data === 'string') void conn.text(data)
      else conn.audio(new Int16Array(data, 0, Math.floor(data.byteLength / 2)))
    },
    close() {
      if (s.readyState === 3) return
      s.readyState = 3
      conn.closed()
      queueMicrotask(() => s.onclose?.())
    },
  }
  queueMicrotask(() => { if (s.readyState === 0) { s.readyState = 1; s.onopen?.() } })
  return s
}

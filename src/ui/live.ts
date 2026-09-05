// The live page: mic → local live server → events → chart. Wall clock allowed here.
import { createChart, fmt } from './chart'
import { summarizeCounters } from '../replay/counters'
import type { SoundingEvent } from '../core/events'
import type { Ms } from '../core/types'

type LiveMessage = SoundingEvent | { type: 'live.heard'; t: Ms; words: string[] } | { type: 'live.status'; state: string; message?: string }

const interp = document.getElementById('live-interp') as HTMLSelectElement
const listenBtn = document.getElementById('listen') as HTMLButtonElement
const statusEl = document.getElementById('live-status')!
const clockEl = document.getElementById('clock')!
const countersEl = document.getElementById('counters')!
const heardEl = document.getElementById('heard')!
const view = createChart({
  chart: document.getElementById('chart') as unknown as SVGSVGElement,
  inspector: document.getElementById('inspector')!,
  slackEl: document.getElementById('slack-indicator')!,
})

const port = new URLSearchParams(location.search).get('port') ?? '8787'
let ws: WebSocket | null = null
let audio: { ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null = null
// Set as soon as getUserMedia resolves inside setupAudio, cleared once setupAudio
// either succeeds (into `audio`) or fails. Lets teardownAudio() stop the mic even
// when it's called (via finish()) while setupAudio is still mid-flight.
let pendingStream: MediaStream | null = null
let events: SoundingEvent[] = []
let state: 'idle' | 'starting' | 'live' | 'stopping' = 'idle'
// True once this connection's onopen has fired — distinguishes "the socket
// never connected" from "it connected and later closed" for onclose's message.
let opened = false
// Recorded for diagnostics; onclose (not onerror) owns the state transition.
let sawError = false
// Bumped on every start() so a stale onclose/onopen from a socket that
// finish() already closed (e.g. a fast re-click starting a new session)
// can't act on state it no longer owns.
let gen = 0

function setStatus(text: string, listening = false) { statusEl.textContent = text; statusEl.classList.toggle('listening', listening) }

// The one authoritative teardown: every exit path (server error, socket
// error/close, a failed setupAudio, or a clean stop) routes through this so
// the mic is always released and the button/select always return to rest.
function finish(statusText: string, opts?: { keepStatusClass?: boolean }) {
  void teardownAudio()
  if (ws && ws.readyState === WebSocket.OPEN) ws.close()
  ws = null
  state = 'idle'
  listenBtn.textContent = 'Listen'
  listenBtn.disabled = false
  interp.disabled = false
  if (opts?.keepStatusClass) statusEl.textContent = statusText
  else setStatus(statusText, false)
}

function flashWords(words: string[]) {
  for (const w of words) {
    const el = document.createElement('span')
    el.className = 'heard-word'
    el.textContent = w
    el.style.left = `${15 + Math.random() * 70}%`
    el.style.top = `${15 + Math.random() * 70}%`
    heardEl.appendChild(el)
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('fading')))
    setTimeout(() => el.remove(), 1600)
  }
}

function onMessage(m: LiveMessage) {
  if (m.type === 'live.heard') { flashWords(m.words); return }
  if (m.type === 'live.status') {
    if (m.state === 'error') {
      // A server-side error while starting, listening, or stopping means no
      // `stopped` reply is coming — finish now instead of waiting for one.
      if (state !== 'idle') finish(`error: ${m.message ?? ''}`)
    } else if (m.state === 'stopped') {
      finish(`saved ${m.message ?? ''}`)
    } else {
      setStatus(m.state, m.state === 'listening')
      if (m.state === 'listening') listenBtn.disabled = false
    }
    return
  }
  events.push(m)
  clockEl.textContent = fmt(m.t)
  if (m.type === 'reading.changed') { view.recordTransitions(m.t, m.transitions); view.render(m.reading) }
  if (m.type === 'candidates.emitted') { const c = summarizeCounters(events); countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms` }
}

async function setupAudio(socket: WebSocket) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  pendingStream = stream
  let ctx: AudioContext | null = null
  try {
    try { ctx = new AudioContext({ sampleRate: 16000 }) } catch { ctx = new AudioContext() }
    await ctx.audioWorklet.addModule('/pcm-worklet.js')
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 })
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => { if (socket.readyState === WebSocket.OPEN) socket.send(e.data) }
    src.connect(node)
    audio = { ctx, stream, node }
    pendingStream = null
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    if (ctx) await ctx.close().catch(() => {})
    pendingStream = null
    throw e
  }
}

// Idempotent: safe to call multiple times (e.g. once from finish() and once
// more from a caller that also holds a reference), and safe to call while
// setupAudio() is still awaiting getUserMedia/addModule — it stops the
// mic track that setupAudio has claimed via `pendingStream` even though
// `audio` hasn't been assigned yet.
async function teardownAudio() {
  if (pendingStream) { pendingStream.getTracks().forEach((t) => t.stop()); pendingStream = null }
  if (!audio) return
  const a = audio
  audio = null
  a.node.disconnect()
  a.stream.getTracks().forEach((t) => t.stop())
  await a.ctx.close().catch(() => {})
}

async function start() {
  const mine = ++gen
  state = 'starting'; opened = false; sawError = false
  listenBtn.disabled = true; setStatus('connecting…')
  events = []; view.reset(); countersEl.textContent = ''; clockEl.textContent = '0:00'
  const socket = new WebSocket(`ws://localhost:${port}`)
  socket.binaryType = 'arraybuffer'
  // onerror never owns state — a socket error is always followed by a close
  // event (per the WebSocket spec), and onclose is the one place that decides
  // what happened and finishes the session.
  socket.onerror = () => { sawError = true }
  socket.onclose = () => {
    if (mine !== gen) return // a stale socket from a session finish() already closed
    if (state === 'idle') return // already finished via a 'stopped' status
    if (sawError && opened) console.warn('live socket errored before closing')
    finish(opened ? 'connection closed' : `cannot reach live server at ws://localhost:${port} — run: npm run live`)
  }
  socket.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data as string)) } catch (e) { console.error(e) } }
  socket.onopen = async () => {
    if (mine !== gen) { socket.close(); return } // superseded by a newer start()
    opened = true
    ws = socket
    try {
      await setupAudio(socket)
    } catch (e) {
      finish(`error: ${e instanceof Error && e.name === 'NotAllowedError' ? 'microphone access denied' : (e instanceof Error ? e.message : String(e))}`)
      return
    }
    // finish() may have run while setupAudio() was mid-flight (e.g. the
    // socket closed, or a server error arrived before `start` was even
    // sent). Don't resurrect a session that's already been torn down —
    // just release the audio setupAudio just finished acquiring.
    if (state !== 'starting') { await teardownAudio(); return }
    socket.send(JSON.stringify({ type: 'start', interpreter: interp.value }))
    state = 'live'
    listenBtn.textContent = 'Stop'
    // Stays disabled until the first `listening` status arrives, so a start
    // that never gets that far can't be "stopped" into the void.
    listenBtn.disabled = true
    interp.disabled = true
  }
}

async function stop() {
  if (!ws) return
  const socket = ws
  state = 'stopping'; listenBtn.disabled = true; setStatus('stopping…')
  await teardownAudio()
  // `ws` may have been reset to null by a concurrent finish() (e.g. a
  // server error arriving mid-teardown) — act on the captured reference.
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }))
  interp.disabled = false
  // 'stopped' status from the server calls finish(), which flips the button back.
}

listenBtn.addEventListener('click', () => { if (state === 'idle') void start(); else if (state === 'live') void stop() })

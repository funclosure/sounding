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
let events: SoundingEvent[] = []
let state: 'idle' | 'starting' | 'live' | 'stopping' = 'idle'

function setStatus(text: string, listening = false) { statusEl.textContent = text; statusEl.classList.toggle('listening', listening) }

function flashWords(words: string[]) {
  const { width, height } = heardEl.getBoundingClientRect()
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
  void width; void height
}

function onMessage(m: LiveMessage) {
  if (m.type === 'live.heard') { flashWords(m.words); return }
  if (m.type === 'live.status') {
    if (m.state === 'error') setStatus(`error: ${m.message ?? ''}`)
    else if (m.state === 'stopped') { setStatus(`saved ${m.message ?? ''}`); void teardownAudio(); state = 'idle'; listenBtn.textContent = 'Listen'; listenBtn.disabled = false }
    else setStatus(m.state, m.state === 'listening')
    return
  }
  events.push(m)
  clockEl.textContent = fmt(m.t)
  if (m.type === 'reading.changed') { view.recordTransitions(m.t, m.transitions); view.render(m.reading) }
  if (m.type === 'candidates.emitted') { const c = summarizeCounters(events); countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms` }
}

async function setupAudio(socket: WebSocket) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  let ctx: AudioContext
  try { ctx = new AudioContext({ sampleRate: 16000 }) } catch { ctx = new AudioContext() }
  await ctx.audioWorklet.addModule('/pcm-worklet.js')
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 })
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => { if (socket.readyState === WebSocket.OPEN) socket.send(e.data) }
  src.connect(node)
  audio = { ctx, stream, node }
}

async function teardownAudio() {
  if (!audio) return
  audio.node.disconnect()
  audio.stream.getTracks().forEach((t) => t.stop())
  await audio.ctx.close()
  audio = null
}

async function start() {
  state = 'starting'; listenBtn.disabled = true; setStatus('connecting…')
  events = []; view.reset(); countersEl.textContent = ''; clockEl.textContent = '0:00'
  const socket = new WebSocket(`ws://localhost:${port}`)
  socket.binaryType = 'arraybuffer'
  socket.onerror = () => { setStatus(`error: cannot reach live server at ws://localhost:${port} — run: npm run live`); state = 'idle'; listenBtn.disabled = false }
  socket.onclose = () => { if (state === 'live') { setStatus('connection closed'); void teardownAudio(); state = 'idle'; listenBtn.textContent = 'Listen'; listenBtn.disabled = false } }
  socket.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data as string)) } catch (e) { console.error(e) } }
  socket.onopen = async () => {
    try {
      await setupAudio(socket)
    } catch (e) {
      setStatus(`error: ${e instanceof Error && e.name === 'NotAllowedError' ? 'microphone access denied' : (e instanceof Error ? e.message : String(e))}`)
      socket.close(); state = 'idle'; listenBtn.disabled = false; return
    }
    socket.send(JSON.stringify({ type: 'start', interpreter: interp.value }))
    ws = socket; state = 'live'; listenBtn.textContent = 'Stop'; listenBtn.disabled = false; interp.disabled = true
  }
}

async function stop() {
  if (!ws) return
  state = 'stopping'; listenBtn.disabled = true; setStatus('stopping…')
  await teardownAudio()
  ws.send(JSON.stringify({ type: 'stop' }))
  interp.disabled = false
  // 'stopped' status from the server flips the button back
}

listenBtn.addEventListener('click', () => { if (state === 'idle') void start(); else if (state === 'live') void stop() })

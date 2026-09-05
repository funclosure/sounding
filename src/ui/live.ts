// The live page: mic → local live server → events → the board. Wall clock allowed here.
import { fmt } from './chart'
import { summarizeCounters } from '../replay/counters'
import type { SoundingEvent } from '../core/events'
import type { Ms } from '../core/types'
import type { LiveMessage } from '../live/live-sounding'
import { snapshotOf, transcriptAt, laneSeries, ranked } from './board/model'
import type { ReadingSnapshot } from './board/model'
import { createBoard } from './board/board'
import { createHeard } from './board/heard'
import { createTranscript } from './board/transcript'
import { createLanes } from './board/lanes'
import { createSheet } from './board/sheet'

const screen = document.getElementById('screen') as HTMLElement
const fieldEl = document.getElementById('field') as HTMLElement
const heardEl = document.getElementById('heard') as HTMLElement
const stateEl = document.getElementById('state')!
const clockEl = document.getElementById('clock')!
const counters = document.getElementById('counters')!
const big = document.getElementById('big') as HTMLButtonElement
const hint = document.getElementById('hint')!
const scrim = document.getElementById('scrim') as HTMLElement
const sheetRoot = document.getElementById('sheet') as HTMLElement
const grab = document.getElementById('grab') as HTMLElement
const tabs = document.getElementById('tabs') as HTMLElement
const sheetBody = document.getElementById('sheetbody') as HTMLElement
const transcriptEl = document.getElementById('transcript') as HTMLElement
const chartSvg = document.getElementById('chartsvg') as unknown as SVGSVGElement
const surfacedBox = document.getElementById('surfacedbox')!
const contextTextarea = document.getElementById('ctxtext') as HTMLTextAreaElement
const contextChips = Array.from(document.querySelectorAll<HTMLButtonElement>('#context .chip'))
const seedBtn = document.getElementById('ctxadd') as HTMLButtonElement
const clearBtn = document.getElementById('ctxclear') as HTMLButtonElement

const board = createBoard(fieldEl)
const heard = createHeard(heardEl)
const transcript = createTranscript(transcriptEl)
const lanes = createLanes(chartSvg)
const sheet = createSheet(sheetRoot, { grab, tabs, body: sheetBody, scrim })

const port = new URLSearchParams(location.search).get('port') ?? '8787'
// No interpreter picker in this design (the prototype has none); ?interp=
// preserves the old page's ability to override the server's default (`-i`)
// without adding UI the brief doesn't call for.
const interpParam = new URLSearchParams(location.search).get('interp')
let ws: WebSocket | null = null
let audio: AudioRig | null = null
// Set as soon as getUserMedia resolves inside setupAudio, cleared once setupAudio
// either succeeds (into `audio`) or fails. Lets teardownAudio() stop the mic even
// when it's called (via finish()) while setupAudio is still mid-flight.
let pendingStream: MediaStream | null = null
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

// ---- event store + display cursor
const events: SoundingEvent[] = []
const readings: ReadingSnapshot[] = []
let replaying = false // true while the user scrubs; new events still accumulate
let headT: Ms = 0 // latest event time seen
let shownT: Ms = 0 // time the board currently displays
let lastShown: ReadingSnapshot | null = null

// ---- context (display-only: seeds ghost marks, never sent to the server)
let contextText = ''
let contextSeeds: Array<{ id: string; label: string }> = []
const seenLabelIds = new Set<string>()
const labelOf = new Map<string, string>()

// ---- follow (display-only: orange highlight on a mark and its lane)
let lit: string | null = null

// True once a `stopped` status has been handled — distinguishes the initial
// "ready" word from "surfaced" when the round control returns to idle.
let surfacedOnce = false

function setState(text: string, listening: boolean) {
  stateEl.textContent = text
  screen.classList.toggle('listening', listening)
}

/** Mirrors the prototype's slack handling: dims the dot and swaps the word while live. */
function slackWord(slack: boolean) {
  screen.classList.toggle('slack', slack && state === 'live')
  if (state === 'live') stateEl.textContent = slack ? 'slack' : 'listening'
}

function matchesContext(label: string): boolean {
  if (!contextText) return false
  const l = label.toLowerCase()
  return contextText.includes(l) || l.split(' ').some((w) => w.length > 4 && contextText.includes(w))
}

function summary(evts: readonly SoundingEvent[]): string {
  const c = summarizeCounters(evts)
  return `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// The one authoritative teardown: every exit path (server error, socket
// error/close, a failed setupAudio, or a clean stop) routes through this so
// the mic is always released and the button always returns to rest.
function finish(statusText: string, opts?: { keepStatusClass?: boolean }) {
  void teardownAudio()
  if (ws && ws.readyState === WebSocket.OPEN) ws.close()
  ws = null
  state = 'idle'
  big.disabled = false
  big.setAttribute('aria-label', 'Drop')
  if (opts?.keepStatusClass) {
    stateEl.textContent = statusText
  } else {
    setState(statusText, false)
    screen.classList.remove('slack', 'surfaced')
  }
}

function showSurfaced() {
  surfacedOnce = true
  screen.classList.add('surfaced')
  const last = readings.at(-1)
  if (last) {
    const items = ranked(last)
    surfacedBox.innerHTML = `<h3>What you kept coming back to <small style="font-size:12px;color:var(--chrome);font-family:'IBM Plex Mono',monospace;letter-spacing:.08em">· ${fmt(last.t)}</small></h3>
      <ol>${items
        .map(
          (it) =>
            `<li><span class="lbl">${escapeHtml(it.label)}</span><span class="pct">${it.pct}%</span><span class="bar"><i style="width:${Math.round(it.rel * 100)}%"></i></span></li>`,
        )
        .join('')}</ol>`
  } else {
    surfacedBox.innerHTML = ''
  }
  surfacedBox.classList.add('on')
  sheet.showTab('chart')
  sheet.set('medium')
}

function toggleFollow(id: string) {
  lit = lit === id ? null : id
  board.setLit(lit)
  lanes.setLit(lit)
  hint.innerHTML = lit ? `following <b>${escapeHtml(labelOf.get(lit) ?? lit)}</b> · tap again to let go` : ''
}
board.onTap(toggleFollow)
lanes.onTapLane(toggleFollow)

function flashWords(words: string[]) {
  heard.flash(words)
}

function onMessage(m: LiveMessage) {
  if (m.type === 'live.heard') {
    if (!replaying) flashWords(m.words)
    return
  }
  if (m.type === 'live.status') {
    if (m.state === 'error') {
      // A server-side error while starting, listening, or stopping means no
      // `stopped` reply is coming — finish now instead of waiting for one.
      if (state !== 'idle') finish(`error: ${m.message ?? ''}`)
    } else if (m.state === 'stopped') {
      finish(`saved ${m.message ?? ''}`)
      showSurfaced()
    } else {
      setState(m.state, m.state === 'listening')
      if (m.state === 'listening') big.disabled = false
    }
    return
  }
  events.push(m)
  headT = m.t
  if (m.type === 'reading.changed') {
    const snap = snapshotOf(m)
    readings.push(snap)
    // Context: the first time a label appears, if it matches the stored
    // context text and isn't seeded yet, seed it now so board.apply's
    // ghost-promotion path (below, via showLive) treats it as confirmed
    // instead of a brand-new arrival.
    for (const mk of snap.marks) {
      labelOf.set(mk.id, mk.label)
      if (seenLabelIds.has(mk.id)) continue
      seenLabelIds.add(mk.id)
      if (contextText && !contextSeeds.some((s) => s.id === mk.id) && matchesContext(mk.label)) {
        contextSeeds = [...contextSeeds, { id: mk.id, label: mk.label }]
        board.seedGhosts(contextSeeds)
      }
    }
  }
  if (m.type === 'candidates.emitted') counters.textContent = summary(events)
  if (!replaying) showLive(m)
}

function showLive(m: SoundingEvent) {
  shownT = m.t
  clockEl.textContent = fmt(m.t)
  if (m.type === 'reading.changed') {
    const s = snapshotOf(m)
    board.apply(s)
    lastShown = s
    slackWord(s.slack)
  }
  if (m.type === 'segment.committed' || m.type === 'segment.pending') {
    transcript.render(transcriptAt(events, m.t), true)
  }
  lanes.build(laneSeries(readings, Math.max(headT, 1)), Math.max(headT, 1))
  lanes.head(m.t)
}

function showAt(t: Ms) {
  // A scrub with no events yet is a no-op.
  if (events.length === 0) return
  replaying = true
  shownT = t
  const s = readings.filter((r) => r.t <= t).at(-1) ?? null
  board.reset()
  if (s) board.apply(s, { instant: true })
  lastShown = s
  transcript.render(transcriptAt(events, t), false)
  lanes.head(t)
  clockEl.textContent = fmt(t)
  stateEl.textContent = 'replaying · tap to return'
  screen.classList.remove('listening')
}
function backToLive() {
  replaying = false
  const s = readings.at(-1) ?? null
  board.reset()
  if (s) board.apply(s, { instant: true })
  lastShown = s
  transcript.render(transcriptAt(events, headT), true)
  lanes.head(headT)
  clockEl.textContent = fmt(headT)
  stateEl.textContent = state === 'live' ? 'listening' : state === 'idle' ? (surfacedOnce ? 'surfaced' : 'ready') : state
  screen.classList.toggle('listening', state === 'live' && !(s?.slack))
  screen.classList.toggle('slack', state === 'live' && !!s?.slack)
}
lanes.onScrub(showAt)
stateEl.addEventListener('click', () => {
  if (replaying) backToLive()
})

type AudioRig = { ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode }

// Does not assign the module-level `audio` — the caller (onopen) decides
// whether this rig is still wanted (the session may have been superseded or
// torn down while getUserMedia/addModule was in flight) before claiming it.
async function setupAudio(socket: WebSocket): Promise<AudioRig> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  pendingStream = stream
  let ctx: AudioContext | null = null
  try {
    try {
      ctx = new AudioContext({ sampleRate: 16000 })
    } catch {
      ctx = new AudioContext()
    }
    if (ctx.state === 'suspended') await ctx.resume()
    await ctx.audioWorklet.addModule('/pcm-worklet.js')
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 })
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(e.data)
    }
    src.connect(node)
    pendingStream = null
    return { ctx, stream, node }
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    if (ctx) await ctx.close().catch(() => {})
    pendingStream = null
    throw e
  }
}

async function closeAudioRig(a: AudioRig) {
  a.node.disconnect()
  a.stream.getTracks().forEach((t) => t.stop())
  await a.ctx.close().catch(() => {})
}

// Idempotent: safe to call multiple times (e.g. once from finish() and once
// more from a caller that also holds a reference), and safe to call while
// setupAudio() is still awaiting getUserMedia/addModule — it stops the
// mic track that setupAudio has claimed via `pendingStream` even though
// `audio` hasn't been assigned yet.
async function teardownAudio() {
  if (pendingStream) {
    pendingStream.getTracks().forEach((t) => t.stop())
    pendingStream = null
  }
  if (!audio) return
  const a = audio
  audio = null
  await closeAudioRig(a)
}

async function start() {
  const mine = ++gen
  state = 'starting'
  opened = false
  sawError = false
  big.disabled = true
  setState('connecting…', false)
  screen.classList.remove('slack', 'surfaced')

  events.length = 0
  readings.length = 0
  replaying = false
  headT = 0
  shownT = 0
  lastShown = null
  seenLabelIds.clear()
  labelOf.clear()
  lit = null
  hint.textContent = ''
  // Each start() is a fresh session with a fresh identity space — concept
  // ids from a previous session won't recur, so a ghost seeded against one
  // would never get promoted and would linger beside a same-labelled but
  // differently-id'd real mark. Drop the seeded ids but keep contextText:
  // onMessage's first-appearance matcher re-seeds against the new session's
  // ids as labels arrive, which is exactly the "seeding before Drop only
  // stores the text" semantic.
  contextSeeds = []

  board.clearGhosts() // also drops the board's own internal seed list, so reset() below doesn't reseed stale ids
  board.reset()
  heard.clear()
  transcript.render(transcriptAt([], 0), true)
  lanes.build([], 1)
  lanes.head(0)
  counters.textContent = ''
  clockEl.textContent = '0:00'
  surfacedBox.classList.remove('on')
  surfacedBox.innerHTML = ''
  sheet.showTab('transcript')
  if (sheet.get() !== 'peek') sheet.set('peek')

  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  socket.binaryType = 'arraybuffer'
  // onerror never owns state — a socket error is always followed by a close
  // event (per the WebSocket spec), and onclose is the one place that decides
  // what happened and finishes the session.
  socket.onerror = () => {
    sawError = true
  }
  socket.onclose = () => {
    if (mine !== gen) return // a stale socket from a session finish() already closed
    if (state === 'idle') return // already finished via a 'stopped' status
    if (sawError && opened) console.warn('live socket errored before closing')
    finish(opened ? 'connection closed' : `cannot reach live server at ws://127.0.0.1:${port} — run: npm run live`)
  }
  socket.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data as string))
    } catch (e) {
      console.error(e)
    }
  }
  socket.onopen = async () => {
    if (mine !== gen) {
      socket.close()
      return
    } // superseded by a newer start()
    opened = true
    ws = socket
    let a: AudioRig
    try {
      a = await setupAudio(socket)
    } catch (e) {
      // A stale session's setupAudio() rejecting (e.g. mic access denied,
      // reported only after a fast re-click already started a newer
      // session) must not finish() the session that superseded it.
      if (mine !== gen) return
      finish(`error: ${e instanceof Error && e.name === 'NotAllowedError' ? 'microphone access denied' : (e instanceof Error ? e.message : String(e))}`)
      return
    }
    // finish() may have run while setupAudio() was mid-flight (e.g. the
    // socket closed, or a server error arrived before `start` was even
    // sent), or a fast re-click may have started a newer session while this
    // one was still acquiring the mic. Don't resurrect/interfere with state
    // this generation no longer owns — just release the audio setupAudio
    // just finished acquiring.
    if (mine !== gen || state !== 'starting') {
      await closeAudioRig(a)
      return
    }
    audio = a
    socket.send(JSON.stringify(interpParam ? { type: 'start', interpreter: interpParam } : { type: 'start' }))
    state = 'live'
    big.setAttribute('aria-label', 'Surface')
    // Stays disabled until the first `listening` status arrives, so a start
    // that never gets that far can't be "stopped" into the void.
    big.disabled = true
  }
}

async function stop() {
  if (!ws) return
  const socket = ws
  state = 'stopping'
  big.disabled = true
  setState('stopping…', false)
  await teardownAudio()
  // `ws` may have been reset to null by a concurrent finish() (e.g. a
  // server error arriving mid-teardown) — act on the captured reference.
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }))
  // 'stopped' status from the server calls finish(), which flips the button back.
}

big.addEventListener('click', () => {
  if (state === 'idle') void start()
  else if (state === 'live') void stop()
})

// ---- context: seeds ghost marks by matching against labels as they arrive; nothing is sent to the server
for (const chip of contextChips) {
  chip.addEventListener('click', () => {
    const extra = chip.dataset.ctx ?? ''
    contextTextarea.value = (contextTextarea.value.trim() ? contextTextarea.value.trim() + ' ' : '') + extra
  })
}
seedBtn.addEventListener('click', () => {
  contextText = contextTextarea.value.toLowerCase()
  const labels = new Map<string, string>()
  for (const r of readings) for (const mk of r.marks) labels.set(mk.id, mk.label)
  contextSeeds = [...labels.entries()]
    .filter(([, l]) => matchesContext(l))
    .slice(0, 5)
    .map(([id, label]) => ({ id, label }))
  board.clearGhosts()
  board.seedGhosts(contextSeeds)
  sheet.set('peek')
})
clearBtn.addEventListener('click', () => {
  contextTextarea.value = ''
  contextText = ''
  contextSeeds = []
  board.clearGhosts()
})

sheet.set('peek')
window.addEventListener('resize', () => {
  sheet.set(sheet.get())
  board.relayout()
})

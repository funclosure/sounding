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
import { createPanels } from './board/panels'
import { createPopover } from './board/popover'

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
const contextEl = document.getElementById('context') as HTMLElement
// desktop panels + popover
const transcriptElD = document.getElementById('transcript-d') as HTMLElement
const chartSvgD = document.getElementById('chartsvg-d') as unknown as SVGSVGElement
const surfacedBoxD = document.getElementById('surfacedbox-d')!
const contextElD = document.getElementById('context-d') as HTMLElement
const contextPopEl = document.getElementById('context-pop') as HTMLElement
const ctxOpenBtn = document.getElementById('ctxopen') as HTMLButtonElement

const board = createBoard(fieldEl)
const heard = createHeard(heardEl)
const transcript = createTranscript(transcriptEl)
const lanes = createLanes(chartSvg)
const transcriptD = createTranscript(transcriptElD)
const lanesD = createLanes(chartSvgD)
const sheet = createSheet(sheetRoot, { grab, tabs, body: sheetBody, scrim })
const contextPop = createPopover(ctxOpenBtn, contextPopEl)
const panels = createPanels(
  screen,
  {
    left: { side: 'left', min: 280, max: 560, default: 360, key: 't' },
    right: { side: 'right', min: 320, max: 720, default: 440, key: 'c' },
  },
  () => {
    board.relayout()
    // A panel opening/closing/resizing moves the round control (the
    // popover's anchor) since it lives in the centre field column — close
    // the popover rather than leave it pointing at a stale position.
    contextPop.close()
  },
)
const mq = window.matchMedia('(min-width: 720px)')
const layout = {
  isDesktop: () => mq.matches,
  showTranscript() {
    if (mq.matches) panels.open('left')
    else {
      sheet.showTab('transcript')
      sheet.set('medium')
    }
  },
  showChart() {
    if (mq.matches) panels.open('right')
    else {
      sheet.showTab('chart')
      sheet.set('medium')
    }
  },
  showContext() {
    if (mq.matches) contextPop.open()
    else {
      sheet.showTab('context')
      sheet.set('medium')
    }
  },
  closeContext() {
    contextPop.close()
  },
  onSurfaced() {
    this.showChart()
  },
}
mq.addEventListener('change', () => {
  contextPop.close()
  sheet.set('peek')
  board.relayout()
})

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
// Last time lanes.build() actually ran. reading.changed arrives every 100ms
// and laneSeries scans every reading, so rebuilding on every tick is
// quadratic over a session; a rebuild is warranted immediately on a
// transition or a fresh candidate set, and otherwise at most once a second
// just to keep the axis extending.
let lastBuildT: Ms = 0

// ---- context: seeds ghost marks locally, and is sent to the server on
// `start` (as the seeded vocabulary hint) and again via a `context` message
// whenever it's (re)seeded or cleared while live.
let contextText = ''
let contextSeeds: Array<{ id: string; label: string }> = []
const seenLabelIds = new Set<string>()
const labelOf = new Map<string, string>()

// ---- follow: orange highlight on a mark and its lane, and sent to the
// server as a `follow` message (null when letting go) whenever the socket
// is open
let lit: string | null = null

// True once a `stopped` status has been handled — distinguishes the initial
// "ready" word from "surfaced" when the round control returns to idle.
let surfacedOnce = false

// The most recent 'listening'/'reconnecting' word from a live.status message,
// so backToLive() can restore exactly what was showing instead of assuming
// 'listening' (a scrub can return to the head while the transcriber is
// mid-reconnect).
let lastStatusWord: 'listening' | 'reconnecting' = 'listening'

function setState(text: string, listening: boolean) {
  stateEl.textContent = text
  screen.classList.toggle('listening', listening)
}

/**
 * Mirrors the prototype's slack handling: dims the dot and swaps the word
 * while live. Gated on the `listening` class (not the `live` business
 * state) so a reading arriving while the transcriber is reconnecting can't
 * clobber the `reconnecting` word — the `live` state covers all of
 * connecting/listening/reconnecting, but only `listening` should ever have
 * its status word or class touched here.
 */
function slackWord(slack: boolean) {
  if (!screen.classList.contains('listening')) return
  screen.classList.toggle('slack', state === 'live' && slack)
  stateEl.textContent = slack ? 'slack' : 'listening'
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
  if (replaying) backToLive()
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
  syncCtxOpenVisibility()
}

// The "bring context" button (round-control affordance for the popover on
// desktop, and the sheet's Context tab on narrow) is shown only while idle
// — before a session starts, or after one has surfaced.
function syncCtxOpenVisibility() {
  ctxOpenBtn.hidden = state !== 'idle'
}

// Rebuilds both chart renderers (sheet + desktop panel) from every reading
// gathered so far, at the head. Used whenever display returns to the head
// from a scrub (or the head itself needs a full rebuild before being
// shown) — showLive's throttled build only ever covers what was shown
// live, so a scrub, or a stop/error interrupting one, needs a rebuild from
// the full `readings` array to be complete.
function rebuildLanes() {
  const series = laneSeries(readings, Math.max(headT, 1))
  const endT = Math.max(headT, 1)
  lanes.build(series, endT)
  lanes.head(headT)
  lanesD.build(series, endT)
  lanesD.head(headT)
  lastBuildT = headT
}

function showSurfaced() {
  surfacedOnce = true
  screen.classList.add('surfaced')
  rebuildLanes()
  const last = readings.at(-1)
  const html = last
    ? `<h3>What you kept coming back to <small style="font-size:12px;color:var(--chrome);font-family:'IBM Plex Mono',monospace;letter-spacing:.08em">· ${fmt(last.t)}</small></h3>
      <ol>${ranked(last)
        .map(
          (it) =>
            `<li><span class="lbl">${escapeHtml(it.label)}</span><span class="pct">${it.pct}%</span><span class="bar"><i style="width:${Math.round(it.rel * 100)}%"></i></span></li>`,
        )
        .join('')}</ol>`
    : ''
  surfacedBox.innerHTML = html
  surfacedBoxD.innerHTML = html
  surfacedBox.classList.add('on')
  surfacedBoxD.classList.add('on')
  layout.onSurfaced()
}

function toggleFollow(id: string) {
  lit = lit === id ? null : id
  board.setLit(lit)
  lanes.setLit(lit)
  lanesD.setLit(lit)
  hint.innerHTML = lit ? `following <b>${escapeHtml(labelOf.get(lit) ?? lit)}</b> · tap again to let go` : ''
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'follow', conceptId: lit }))
  }
}
board.onTap(toggleFollow)
lanes.onTapLane(toggleFollow)
lanesD.onTapLane(toggleFollow)

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
      // finish() itself returns from a scrub first (its first statement),
      // so the return-to-live affordance can't be stranded here.
      if (state !== 'idle') finish(`error: ${m.message ?? ''}`)
    } else if (m.state === 'stopped') {
      // Same reasoning: finish() returns from a scrub before doing anything
      // else, so the surfaced chart below reflects every reading received
      // during the scrub, not just what was shown live.
      finish(`saved ${m.message ?? ''}`)
      showSurfaced()
    } else {
      setState(m.state, m.state === 'listening')
      if (m.state === 'listening') big.disabled = false
      if (m.state === 'listening' || m.state === 'reconnecting') lastStatusWord = m.state
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
      if (contextText && contextSeeds.length < 5 && !contextSeeds.some((s) => s.id === mk.id) && matchesContext(mk.label)) {
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
    const tm = transcriptAt(events, m.t)
    transcript.render(tm, true)
    transcriptD.render(tm, true)
  }
  const shouldRebuild =
    m.type === 'candidates.emitted' || (m.type === 'reading.changed' && m.transitions.length > 0) || m.t - lastBuildT >= 1000
  if (shouldRebuild) {
    const series = laneSeries(readings, Math.max(headT, 1))
    const endT = Math.max(headT, 1)
    lanes.build(series, endT)
    lanesD.build(series, endT)
    lastBuildT = m.t
  }
  lanes.head(m.t)
  lanesD.head(m.t)
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
  const tm = transcriptAt(events, t)
  transcript.render(tm, false)
  transcriptD.render(tm, false)
  lanes.head(t)
  lanesD.head(t)
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
  const tm = transcriptAt(events, headT)
  transcript.render(tm, true)
  transcriptD.render(tm, true)
  rebuildLanes()
  clockEl.textContent = fmt(headT)
  stateEl.textContent = state === 'live' ? lastStatusWord : state === 'idle' ? (surfacedOnce ? 'surfaced' : 'ready') : state
  screen.classList.toggle('listening', state === 'live')
  screen.classList.toggle('slack', state === 'live' && !!s?.slack)
}
lanes.onScrub(showAt)
lanesD.onScrub(showAt)
stateEl.addEventListener('click', () => {
  if (replaying) backToLive()
})
stateEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
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
  syncCtxOpenVisibility()
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
  lastBuildT = 0
  lastStatusWord = 'listening'
  seenLabelIds.clear()
  labelOf.clear()
  lit = null
  board.setLit(null)
  lanes.setLit(null)
  lanesD.setLit(null)
  hint.textContent = ''
  // Each start() gets a fresh ReadingDynamics, whose concept ids are always
  // `c1, c2, …` counting up from one — so ids *recur* every session, and a
  // stale ghost left over from a previous session could get promoted by an
  // unrelated concept that happens to land on the same id. Drop the seeded
  // ids but keep contextText: onMessage's first-appearance matcher re-seeds
  // against the new session's ids as labels arrive, which is exactly the
  // "seeding before Drop only stores the text" semantic.
  contextSeeds = []

  board.clearGhosts() // also drops the board's own internal seed list, so reset() below doesn't reseed stale ids
  board.reset()
  heard.clear()
  const emptyTranscript = transcriptAt([], 0)
  transcript.render(emptyTranscript, true)
  transcriptD.render(emptyTranscript, true)
  lanes.build([], 1)
  lanes.head(0)
  lanesD.build([], 1)
  lanesD.head(0)
  counters.textContent = ''
  clockEl.textContent = '0:00'
  surfacedBox.classList.remove('on')
  surfacedBox.innerHTML = ''
  surfacedBoxD.classList.remove('on')
  surfacedBoxD.innerHTML = ''
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
    const startMsg: { type: 'start'; interpreter?: string; context?: string } = { type: 'start' }
    if (interpParam) startMsg.interpreter = interpParam
    const ctx = contextText.trim()
    if (ctx) startMsg.context = ctx
    socket.send(JSON.stringify(startMsg))
    state = 'live'
    syncCtxOpenVisibility()
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
  syncCtxOpenVisibility()
  big.disabled = true
  setState('stopping…', false)
  await teardownAudio()
  // `ws` may have been reset to null by a concurrent finish() (e.g. a
  // server error arriving mid-teardown) — act on the captured reference.
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }))
  // 'stopped' status from the server calls finish(), which flips the button back.
}

big.addEventListener('click', () => {
  layout.closeContext()
  if (state === 'idle') void start()
  else if (state === 'live') void stop()
})

// ---- context: seeds ghost marks by matching against labels as they arrive, and
// (via seed/clear below) sends the text to the server if a session is live. Built
// once into each of the two containers (the sheet's #context and the desktop
// popover's #context-d) so both stay in sync — only one is ever visible/interactive
// at a given viewport width, but their textareas mirror each other so switching
// layouts mid-type doesn't lose what was typed.
const contextTextareas: HTMLTextAreaElement[] = []
function buildContext(el: HTMLElement, opts: { onSeed?: () => void }) {
  el.innerHTML = `
    <h3>What are you circling already?</h3>
    <textarea placeholder="A question, a few notes, a name…"></textarea>
    <div class="chips">
      <button class="chip" type="button" data-ctx="A question I keep coming back to.">a question</button>
      <button class="chip" type="button" data-ctx="Notes from last time.">notes from last time</button>
      <button class="chip" type="button" data-ctx="A previous sounding.">a previous sounding</button>
    </div>
    <p class="note">
      Context seeds faint marks on the board. They stay faint until your talking actually reaches them,
      then they become real. Nothing you bring counts as something you said. Seeding before you drop only
      stores the text — labels aren't known until you start talking. Names here also help the transcriber
      from the next drop.
    </p>
    <div class="row">
      <button class="act" type="button" data-act="seed">Seed the board</button>
      <button class="act quiet" type="button" data-act="clear">Clear</button>
    </div>`
  const textarea = el.querySelector('textarea') as HTMLTextAreaElement
  contextTextareas.push(textarea)
  textarea.addEventListener('input', () => {
    for (const t of contextTextareas) if (t !== textarea) t.value = textarea.value
  })
  for (const chip of Array.from(el.querySelectorAll<HTMLButtonElement>('.chip'))) {
    chip.addEventListener('click', () => {
      const extra = chip.dataset.ctx ?? ''
      const next = (textarea.value.trim() ? textarea.value.trim() + ' ' : '') + extra
      for (const t of contextTextareas) t.value = next
    })
  }
  el.querySelector<HTMLButtonElement>('[data-act="seed"]')!.addEventListener('click', () => {
    contextText = textarea.value.toLowerCase()
    const labels = new Map<string, string>()
    for (const r of readings) for (const mk of r.marks) labels.set(mk.id, mk.label)
    contextSeeds = [...labels.entries()]
      .filter(([, l]) => matchesContext(l))
      .slice(0, 5)
      .map(([id, label]) => ({ id, label }))
    board.clearGhosts()
    board.seedGhosts(contextSeeds)
    if (state === 'live' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'context', text: contextText }))
    }
    opts.onSeed?.()
  })
  el.querySelector<HTMLButtonElement>('[data-act="clear"]')!.addEventListener('click', () => {
    for (const t of contextTextareas) t.value = ''
    contextText = ''
    contextSeeds = []
    board.clearGhosts()
    if (state === 'live' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'context', text: '' }))
    }
  })
}
buildContext(contextEl, { onSeed: () => sheet.set('peek') })
buildContext(contextElD, {}) // the popover stays open after seeding; only Escape/drop close it

ctxOpenBtn.addEventListener('click', () => layout.showContext())

syncCtxOpenVisibility()
sheet.set('peek')
window.addEventListener('resize', () => {
  sheet.set(sheet.get())
  board.relayout()
})

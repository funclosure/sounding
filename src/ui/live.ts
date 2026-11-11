// The live page: mic → local live server → events → the board. Wall clock allowed here.
import { fmt } from './chart'
import { summarizeCounters } from '../replay/counters'
import type { SoundingEvent } from '../core/events'
import type { Ms } from '../core/types'
import type { LiveMessage } from '../live/live-sounding'
import type { EarlierItem } from '../live/earlier'
import type { Setup } from '../live/setup'
import { setupLines } from './setup'
import { snapshotOf, transcriptAt, laneSeries, ranked } from './board/model'
import type { ReadingSnapshot } from './board/model'
import { createBoard } from './board/board'
import { createHeard } from './board/heard'
import { columnOrder } from './board/layout'
import { createDots } from './board/dots'
import { createTranscript } from './board/transcript'
import { createLanes } from './board/lanes'
import { createSheet } from './board/sheet'
import { createPanels } from './board/panels'
import { createPopover } from './board/popover'
import { LIVE_SOCKET_PATH } from '../live/socket-path'
import { LENSES, CARRY_MAX_MARKS, carryContext, matchCarried, soundingNote } from './after'

const screen = document.getElementById('screen') as HTMLElement
const fieldEl = document.getElementById('field') as HTMLElement
const heardEl = document.getElementById('heard') as HTMLElement
const stateEl = document.getElementById('state')!
const clockEl = document.getElementById('clock')!
const counters = document.getElementById('counters')!
const big = document.getElementById('big') as HTMLButtonElement
const hint = document.getElementById('hint')!
const wrapEl = document.getElementById('wrap') as HTMLElement
const pinnedEl = document.getElementById('pinned') as HTMLElement
const controls = document.querySelector('.controls') as HTMLElement
const earlierEl = document.getElementById('earlier') as HTMLElement
const earlierBtn = document.getElementById('earlierbtn') as HTMLButtonElement
const setupEl = document.getElementById('setup') as HTMLElement
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

// the gathered column tells the wrap where to start
const board = createBoard(fieldEl, { onColumn: (bottom) => (bottom === null ? screen.style.removeProperty('--wrap-top') : screen.style.setProperty('--wrap-top', `${Math.round(bottom + 18)}px`)) })
const heard = createHeard(heardEl)
const dots = createDots(document.getElementById('dots') as HTMLCanvasElement, { field: fieldEl, voice: big, clear: wrapEl })
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
}
mq.addEventListener('change', () => {
  contextPop.close()
  sheet.set('peek')
  board.relayout()
})

// Same origin by default: the always-on server answers the socket at
// LIVE_SOCKET_PATH itself, and in dev Vite proxies that path to `bun run live`.
// ?port= keeps the old direct connection to a live server on this machine.
const portParam = new URLSearchParams(location.search).get('port')
const liveUrl = portParam
  ? `ws://127.0.0.1:${portParam}`
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${LIVE_SOCKET_PATH}`
// No interpreter picker in this design (the prototype has none); ?interp=
// preserves the old page's ability to override the server's default (`-i`)
// without adding UI the brief doesn't call for.
const interpParam = new URLSearchParams(location.search).get('interp')
// Same for the transcriber: ?transcriber=gemini|whisper overrides the server's default for this tab.
const transcriberParam = new URLSearchParams(location.search).get('transcriber')
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
// what the speaker typed into "bring context" themselves; a carried-on sounding adds to it, a fresh one goes back to it
let broughtText = ''
// carrying on: the last sounding's marks come back faint under ids of their own, and a mark that returns to one takes its place
let carried: string[] = []
const carryId = (i: number) => `carry-${i}`
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
  const ct = contextText.toLowerCase()
  const l = label.toLowerCase()
  return ct.includes(l) || l.split(' ').some((w) => w.length > 4 && ct.includes(w))
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
function finish(statusText: string, opts?: { keepStatusClass?: boolean; keepSocket?: boolean }) {
  if (replaying) backToLive()
  void teardownAudio()
  // A wrap is on its way: the socket stays open for it (and for rewrites) until the next sounding starts.
  if (opts?.keepSocket && ws && ws.readyState === WebSocket.OPEN) wrapWs = ws
  else if (ws && ws.readyState === WebSocket.OPEN) ws.close()
  ws = null
  state = 'idle'
  // the rings keep closing in only while a wrap is still being written
  if (wrap?.state !== 'writing') dots.gather(false)
  big.disabled = false
  big.setAttribute('aria-label', 'Drop')
  if (opts?.keepStatusClass) {
    stateEl.textContent = statusText
  } else {
    setState(statusText, false)
    screen.classList.remove('slack', 'surfaced')
  }
  syncCtxOpenVisibility()
  renaming = null
  renderHint() // corrections are only offered while live
}

// The "bring context" button (round-control affordance for the popover on
// desktop, and the sheet's Context tab on narrow) is shown only while idle
// — before a session starts, or after one has surfaced.
function syncCtxOpenVisibility() {
  ctxOpenBtn.hidden = state !== 'idle'
  earlierBtn.hidden = state !== 'idle'
  // the corner holds the counters while a sounding runs, and the way to earlier ones when nothing is running
  counters.hidden = state === 'idle'
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
  // The chart stays closed: the gathered column already says what stood out, and the chart is one tap (or C) away.
}

// ---- corrections: the speaker dismisses or renames the followed mark from
// the hint line. `renaming` holds the id whose label is being edited;
// `undo` the last dismissed mark, offered back for a few seconds.
let renaming: string | null = null
let undo: { id: string; label: string } | null = null
let undoTimer: ReturnType<typeof setTimeout> | null = null
const UNDO_MS = 8000

const canCorrect = () => state === 'live' && !replaying && !!ws && ws.readyState === WebSocket.OPEN

function renderHint() {
  controls.classList.toggle('after', canCarry())
  if (renaming && renaming === lit) {
    hint.innerHTML = `<form class="rename"><label>rename <input name="label" maxlength="60" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(labelOf.get(lit) ?? '')}" /></label> · <button type="button" data-act="cancel">cancel</button></form>`
    const input = hint.querySelector('input')!
    input.focus()
    input.select()
    return
  }
  if (lit) {
    const acts = canCorrect() ? `<button type="button" data-act="rename">rename</button> · <button type="button" data-act="dismiss">dismiss</button> · ` : ''
    hint.innerHTML = `following <b>${escapeHtml(labelOf.get(lit) ?? lit)}</b> · ${acts}<button type="button" data-act="letgo">let go</button>`
    return
  }
  if (undo && canCorrect()) {
    hint.innerHTML = `dismissed <b class="gone">${escapeHtml(undo.label)}</b> · <button type="button" data-act="undo">undo</button>`
    return
  }
  // after a sounding the circle carries on from it, and says so right under itself
  if (canCarry()) {
    const q = lens === 'question' && wrap?.state === 'done'
    hint.innerHTML = q
      ? `<span class="go">answer it out loud</span> · the question stays<span class="long"> at the top of the board</span>`
      : `<span class="go">keep talking</span> · these words stay, faint<span class="long">, until you return to them</span>${wrap ? '' : ' · <button type="button" data-act="fresh">start fresh</button>'}`
    return
  }
  hint.textContent = ''
}

// ---- the wrap: what the listener heard, said back once a sounding has ended.
// It arrives on the ended sounding's socket, which finish() keeps open for it;
// the same socket carries a change of instructions and the rewrite that follows.
type Wrap =
  | { state: 'writing' }
  | { state: 'done'; text: string; prompt: string; isDefaultPrompt: boolean }
  | { state: 'failed'; message: string; prompt: string; isDefaultPrompt: boolean }
let wrap: Wrap | null = null
let wrapEditing = false
let wrapWs: WebSocket | null = null
// the instructions as last reported by the server, kept across a rewrite so the editor always has them
let wrapPrompt: { text: string; isDefault: boolean } | null = null
// which reading of the sounding the wrap on screen is: a key of LENSES, or 'own' for instructions typed for this once
let lens = 'heard'
let lensOpen = false
let ownPrompt = ''
// the plain "what I heard" of this sounding, kept so it is what gets carried on even while another reading is showing
let heardText = ''
const WRAP_HEADS: Record<string, string> = { heard: 'I hear you…', avoided: 'what you stepped around…', question: 'a question…', next: 'what next…', own: 'in your own words…' }

const lastMarkLabels = (): string[] => { const last = readings.at(-1); return last ? columnOrder(last.marks).map((m) => m.label) : [] }
/** After a sounding has ended with something on the board, the circle carries on from it. */
const canCarry = () => state === 'idle' && ended && !replaying && lastMarkLabels().length > 0

/** How far apart the words of a fresh wrap arrive (ms); the CSS multiplies it by each word's place. */
const WORD_EVERY_MS = 45
// the text already shown once: a wrap comes word by word only the first time it is seen
const wrapRevealed = new Set<string>()
// every reading already written for this sounding, by lens: going back to one shows it again, as it was
const written = new Map<string, string>()
// the lens of the wrap being waited for; a reply nobody is waiting for any more is only kept, not shown
let awaiting: string | null = null

/** Plain text with "- " bullets → paragraphs and lists, every word in a span numbered in reading order. */
function wrapHtml(text: string): { html: string; words: number } {
  const out: string[] = []
  let items: string[] = []
  let n = 0
  const words = (line: string) => line.split(/\s+/).filter(Boolean).map((w) => `<span class="w" style="--i:${n++}">${escapeHtml(w)}</span>`).join(' ')
  const flushItems = () => { if (items.length) { out.push(`<ul>${items.join('')}</ul>`); items = [] } }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) { flushItems(); continue }
    const bullet = /^[-•*]\s+(.*)$/.exec(line)
    if (bullet) items.push(`<li style="--i:${n}">${words(bullet[1])}</li>`)
    else { flushItems(); out.push(`<p>${words(line)}</p>`) }
  }
  flushItems()
  return { html: out.join(''), words: n }
}

function renderWrap() {
  // a scrub puts the board back as it was at that moment; the wrap waits until the return
  const shown = !!wrap && !replaying
  wrapEl.hidden = !shown
  wrapEl.classList.toggle('editing', shown && wrapEditing && !!wrapPrompt)
  if (!wrap || !shown) { wrapEl.innerHTML = ''; return }
  const act = (name: string, label: string, quiet = false) => `<button type="button" class="act${quiet ? ' quiet' : ''}" data-act="${name}">${label}</button>`
  // every way on from here says what it will do, in a line beside its name
  const opt = (name: string, label: string, says: string, pressed?: boolean) => `<button type="button" class="opt" data-act="${name}"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}><b>${label}</b><span>${says}</span></button>`
  if (wrapEditing && wrapPrompt) {
    // the instruction behind the reading in use, open to change: for this once, or for every sounding
    const text = lens === 'own' ? ownPrompt : LENSES.find((l) => l.key === lens)?.prompt || wrapPrompt.text
    wrapEl.innerHTML = `<form><p class="wl"><label for="wrap-prompt">how to read this sounding</label></p>
      <textarea id="wrap-prompt" maxlength="2000" spellcheck="false">${escapeHtml(text)}</textarea>
      <p class="note">“Just this time” rewrites this wrap only. “From now on” saves it for every sounding, on every device${wrapPrompt.isDefault ? '' : ', in place of your own saved instructions'}.</p>
      <div class="acts">${act('once', 'use it just this time')}<button type="submit" class="act">use it from now on</button>${wrapPrompt.isDefault ? '' : act('default', 'back to the default', true)}${act('cancel', 'cancel', true)}</div></form>`
    return
  }
  if (lensOpen) {
    // the readings take the wrap's place while they are open, so nothing has to scroll
    wrapEl.innerHTML = `<p class="wl">hear it differently</p><div class="next" role="group" aria-label="Hear it differently">${LENSES.map((l) => opt(`lens:${l.key}`, l.label, l.says, l.key === lens)).join('')}${opt('own', 'my own words…', 'See the instruction behind it and write your own.', lens === 'own')}${opt('angle', 'back', 'Leave the wrap as it is.')}</div>`
    return
  }
  const head = `<p class="wl">${WRAP_HEADS[lens] ?? WRAP_HEADS.heard}</p>`
  const others = `${opt('angle', 'hear it differently', 'The same talk, read another way.')}`
  const fresh = opt('fresh', 'start fresh', 'Clear the board and listen from nothing.')
    + (currentName ? (confirming === currentName ? opt('remove', 'really remove?', 'Tap again to move it to the Trash.') : opt('remove', 'remove it', 'Move this sounding to the Trash.')) : '')
  if (wrap.state === 'writing') wrapEl.innerHTML = head
  else if (wrap.state === 'done') {
    const said = wrapHtml(wrap.text)
    const arriving = !wrapRevealed.has(wrap.text)
    wrapRevealed.add(wrap.text)
    wrapEl.style.setProperty('--word-every', `${WORD_EVERY_MS}ms`)
    wrapEl.innerHTML = `${head}<div class="said${arriving ? ' arriving' : ''}">${said.html}</div><div class="next ruled${arriving ? ' arriving' : ''}" style="--i:${said.words}">${others}${opt('note', 'copy as a note', 'The words and the wrap, ready to paste.')}${fresh}</div>`
  }
  else wrapEl.innerHTML = `${head}<p class="quiet">It didn’t come through: ${escapeHtml(wrap.message)}</p><div class="next ruled">${opt('again', 'try again', 'Ask for the same reading once more.')}${others}${fresh}</div>`
}

function onWrap(m: Extract<LiveMessage, { type: 'live.wrap' }>) {
  if (m.state === 'writing') {
    // the sounding's own first wrap announces itself; a rewrite was already marked as awaited when it was asked for
    if (!wrap) awaiting = 'heard'
    if (awaiting === null) return
    wrap = { state: 'writing' }
  } else {
    const key = awaiting
    wrapPrompt = { text: m.prompt, isDefault: m.isDefaultPrompt }
    // the speaker went back to a reading they already had while this one was being written
    if (key === null) return
    awaiting = null
    if (m.state === 'done') { written.set(key, m.text); if (key === 'heard') heardText = m.text }
    wrap = m
  }
  wrapEditing = false
  dots.gather(wrap.state === 'writing')
  renderWrap()
  renderHint()
}

function sendWrap(msg: { type: 'rewrap'; text?: string } | { type: 'wrap-prompt'; text: string }) {
  wrapEditing = false
  lensOpen = false
  if (wrapWs && wrapWs.readyState === WebSocket.OPEN) {
    wrapWs.send(JSON.stringify(msg))
    awaiting = lens
    wrap = { state: 'writing' }
  } else if (wrapPrompt) {
    wrap = { state: 'failed', message: 'the connection to the server has closed', prompt: wrapPrompt.text, isDefaultPrompt: wrapPrompt.isDefault }
  }
  dots.gather(wrap?.state === 'writing')
  renderWrap()
  renderHint()
}

/** The same sounding, read with another instruction; "what I heard" is the saved one. Nothing is saved by this. */
function readAs(key: string) {
  lens = key
  const had = written.get(key)
  if (had !== undefined && wrapPrompt) {
    awaiting = null
    wrapEditing = false
    lensOpen = false
    wrap = { state: 'done', text: had, prompt: wrapPrompt.text, isDefaultPrompt: wrapPrompt.isDefault }
    dots.gather(false)
    renderWrap()
    return renderHint()
  }
  const text = key === 'own' ? ownPrompt : LENSES.find((l) => l.key === key)?.prompt
  sendWrap(text ? { type: 'rewrap', text } : { type: 'rewrap' })
}

function clearWrap() {
  if (wrapWs && wrapWs.readyState === WebSocket.OPEN) wrapWs.close()
  wrapWs = null
  wrap = null
  wrapRevealed.clear()
  written.clear()
  awaiting = null
  wrapEditing = false
  lens = 'heard'
  lensOpen = false
  heardText = ''
  renderWrap()
}

wrapEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  const act = el?.dataset.act
  if (!el || !act) return
  if (act === 'angle') { lensOpen = !lensOpen; return renderWrap() }
  if (act.startsWith('lens:')) {
    const key = act.slice(5)
    // the reading already on screen: just go back to it
    if (key === lens && wrap?.state === 'done') { lensOpen = false; return renderWrap() }
    return readAs(key)
  }
  if (act === 'own') { lensOpen = false; wrapEditing = true; renderWrap(); return wrapEl.querySelector('textarea')?.focus() }
  if (act === 'once') {
    const text = (wrapEl.querySelector('textarea')?.value ?? '').trim()
    if (!text) return
    if (text !== ownPrompt) written.delete('own')
    ownPrompt = text
    return readAs('own')
  }
  if (act === 'cancel') { wrapEditing = false; return renderWrap() }
  if (act === 'again') { written.delete(lens); return readAs(lens) }
  if (act === 'default') { lens = 'heard'; written.delete('heard'); return sendWrap({ type: 'wrap-prompt', text: '' }) }
  if (act === 'fresh') return void start()
  if (act === 'remove' && currentName) {
    if (confirming !== currentName) { confirming = currentName; return renderWrap() }
    confirming = null
    return tell({ type: 'remove', name: currentName })
  }
  if (act === 'note' && wrap?.state === 'done') {
    const title = `Sounding · ${(dateOf(currentName) ?? new Date()).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · ${fmt(headT)}`
    const says = el.querySelector('span') ?? el
    void navigator.clipboard.writeText(soundingNote({ title, marks: lastMarkLabels(), wrap: wrap.text })).then(() => { says.textContent = 'Copied.' }, () => { says.textContent = 'Copying is blocked here: select the text instead.' })
  }
})
wrapEl.addEventListener('submit', (e) => {
  e.preventDefault()
  lens = 'heard'
  written.delete('heard') // new saved instructions: the plain reading is written again
  sendWrap({ type: 'wrap-prompt', text: wrapEl.querySelector('textarea')?.value ?? '' })
})
wrapEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && wrapEditing) { wrapEditing = false; renderWrap() }
  e.stopPropagation() // typing here must not reach the page's T / C shortcuts
})

function setFollow(id: string | null, tellServer: boolean) {
  lit = id
  renaming = null
  board.setLit(lit)
  lanes.setLit(lit)
  lanesD.setLit(lit)
  renderHint()
  if (tellServer && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'follow', conceptId: lit }))
}

function toggleFollow(id: string) {
  setFollow(lit === id ? null : id, true)
}

function clearUndo() {
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = null
  undo = null
}

hint.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
  if (!act) return
  if (act === 'letgo') return setFollow(null, true)
  if (act === 'fresh') return void start()
  if (act === 'cancel') { renaming = null; return renderHint() }
  if (!canCorrect()) return renderHint()
  if (act === 'rename' && lit) { renaming = lit; return renderHint() }
  if (act === 'dismiss' && lit) {
    const id = lit
    clearUndo()
    undo = { id, label: labelOf.get(id) ?? id }
    undoTimer = setTimeout(() => { clearUndo(); renderHint() }, UNDO_MS)
    ws!.send(JSON.stringify({ type: 'dismiss', conceptId: id }))
    // the server lets go of a dismissed mark itself, so no follow message
    return setFollow(null, false)
  }
  if (act === 'undo' && undo) {
    ws!.send(JSON.stringify({ type: 'restore', conceptId: undo.id }))
    clearUndo()
    return renderHint()
  }
})
hint.addEventListener('submit', (e) => {
  e.preventDefault()
  const id = renaming
  const label = (hint.querySelector('input')?.value ?? '').trim()
  renaming = null
  if (id && label && label !== labelOf.get(id) && canCorrect()) ws!.send(JSON.stringify({ type: 'rename', conceptId: id, label }))
  renderHint()
})
hint.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && renaming) { renaming = null; renderHint() }
})
board.onTap(toggleFollow)
lanes.onTapLane(toggleFollow)
lanesD.onTapLane(toggleFollow)

// ---- the ending: between "stop" and the wrap the marks draw together into
// one ranked column, the echo comes back in through the dots, and each mark
// brightens in turn. The board stays gathered until the next sounding.
let ended = false
const endTimers: Array<ReturnType<typeof setTimeout>> = []
function beginEnding() {
  if (replaying) backToLive()
  ended = true
  pinnedEl.hidden = true
  heard.clear()
  board.gather()
  dots.gather(true)
  const last = readings.at(-1)
  if (last) columnOrder(last.marks).forEach((m, i) => endTimers.push(setTimeout(() => dots.pulse(m.id, false), 1700 + i * 260)))
}
function clearEnding() {
  ended = false
  for (const t of endTimers.splice(0)) clearTimeout(t)
  dots.gather(false)
}

// ---- earlier soundings: listed, opened again as they ended, and removed (to the Trash, on the server's machine).
// The name of the sounding on the board, once it is a saved one.
let currentName: string | null = null
let earlierOpen = false
let earlierItems: EarlierItem[] | null = null
let earlierFailed = false
// the sounding a first tap on "remove" named; the second tap removes it
let confirming: string | null = null

const dateOf = (name: string | null): Date | null => {
  const m = name && /^live-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\./.exec(name)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
}
const whenOf = (name: string): string => dateOf(name)?.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) ?? name

// Between soundings the page talks to the server on the ended sounding's socket if it is still open, or on one opened for the purpose.
let idleConnecting: Promise<WebSocket> | null = null
function idleSocket(): Promise<WebSocket> {
  if (wrapWs && wrapWs.readyState === WebSocket.OPEN) return Promise.resolve(wrapWs)
  if (idleConnecting) return idleConnecting
  const mine = gen
  const p = new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(liveUrl)
    socket.onopen = () => {
      if (mine !== gen || state !== 'idle') { socket.close(); return reject(new Error('a sounding has started')) }
      wrapWs = socket
      resolve(socket)
    }
    socket.onerror = () => reject(new Error('cannot reach the server'))
    socket.onmessage = (ev) => {
      if (mine !== gen || wrapWs !== socket) return
      try { onMessage(JSON.parse(ev.data as string)) } catch (e) { console.error(e) }
    }
  })
  idleConnecting = p
  const done = () => { if (idleConnecting === p) idleConnecting = null }
  p.then(done, done)
  return p
}
function tell(msg: { type: 'earlier' | 'setup' } | { type: 'open' | 'remove'; name: string }) {
  idleSocket().then((s) => s.send(JSON.stringify(msg)), () => { earlierFailed = true; setupFailed = true; renderEarlier(); renderSetup() })
}

// ---- how this is set up: the state word opens a sheet saying which models listen and understand. Read only.
let setupOpen = false
let setup: Setup | null = null
let setupFailed = false
function renderSetup() {
  setupEl.hidden = !setupOpen
  stateEl.setAttribute('aria-expanded', String(setupOpen))
  if (!setupOpen) { setupEl.innerHTML = ''; return }
  const body = setupFailed ? '<p class="quiet">The server cannot be reached.</p>'
    : !setup ? '<p class="quiet">…</p>'
    : `<ul>${setupLines(setup).map(([name, says]) => `<li><b>${escapeHtml(name)}</b><span>${escapeHtml(says)}</span></li>`).join('')}</ul>`
  setupEl.innerHTML = `<p class="wl">how this is set up</p>${body}`
}
function closeSetup() {
  if (!setupOpen) return
  setupOpen = false
  renderSetup()
}
function toggleSetup() {
  if (state !== 'idle') return
  layout.closeContext()
  closeEarlier()
  setupOpen = !setupOpen
  setup = null
  setupFailed = false
  renderSetup()
  if (setupOpen) tell({ type: 'setup' })
}

function renderEarlier() {
  earlierEl.hidden = !earlierOpen
  // the word in the corner opens the list and, while it is open, closes it
  earlierBtn.textContent = earlierOpen ? 'close' : 'earlier'
  earlierBtn.setAttribute('aria-expanded', String(earlierOpen))
  if (!earlierOpen) { earlierEl.innerHTML = ''; return }
  const row = (it: EarlierItem) => `<li${it.name === currentName ? ' aria-current="true"' : ''}><button type="button" class="opt" data-open="${escapeHtml(it.name)}"><b>${escapeHtml(whenOf(it.name))} · ${fmt(it.durationMs)}</b><span>${it.marks.length ? escapeHtml(it.marks.join(', ')) : it.said ? 'nothing stood out' : 'nothing was said'}</span></button><button type="button" class="x${confirming === it.name ? ' sure' : ''}" data-remove="${escapeHtml(it.name)}" aria-label="${confirming === it.name ? 'Really remove this sounding' : 'Remove this sounding'}">${confirming === it.name ? 'remove?' : '×'}</button></li>`
  const body = earlierFailed ? '<p class="quiet">The server cannot be reached.</p>'
    : !earlierItems ? '<p class="quiet">…</p>'
    : !earlierItems.length ? '<p class="quiet">Nothing saved yet.</p>'
    : `<ul>${earlierItems.map(row).join('')}</ul>`
  earlierEl.innerHTML = `<p class="wl">earlier soundings</p>${body}`
}

/** Everything a sounding put on the page, taken off again. The page stays idle. */
function clearPage() {
  replaying = false
  events.length = 0
  readings.length = 0
  headT = 0
  shownT = 0
  lastShown = null
  lastBuildT = 0
  seenLabelIds.clear()
  labelOf.clear()
  lit = null
  renaming = null
  clearUndo()
  wrap = null
  wrapRevealed.clear()
  written.clear()
  awaiting = null
  wrapEditing = false
  lens = 'heard'
  lensOpen = false
  heardText = ''
  confirming = null
  clearEnding()
  contextSeeds = []
  carried = []
  contextText = broughtText
  pinnedEl.hidden = true
  board.setLit(null)
  lanes.setLit(null)
  lanesD.setLit(null)
  board.clearGhosts()
  board.reset()
  heard.clear()
  const empty = transcriptAt([], 0)
  transcript.render(empty, true)
  transcriptD.render(empty, true)
  lanes.build([], 1)
  lanes.head(0)
  lanesD.build([], 1)
  lanesD.head(0)
  counters.textContent = ''
  clockEl.textContent = '0:00'
  for (const box of [surfacedBox, surfacedBoxD]) { box.classList.remove('on'); box.innerHTML = '' }
  screen.classList.remove('slack', 'surfaced')
}

/** An earlier sounding, put back on the board as it ended: gathered, with its wrap on the way, and every choice a fresh ending has. */
function showEarlier(m: Extract<LiveMessage, { type: 'live.opened' }>) {
  if (state !== 'idle') return
  earlierOpen = false
  renderEarlier()
  clearPage()
  for (const e of m.events) {
    events.push(e)
    headT = e.t
    if (e.type === 'reading.changed') {
      const snap = snapshotOf(e)
      readings.push(snap)
      for (const mk of snap.marks) labelOf.set(mk.id, mk.label)
    }
  }
  currentName = m.name
  ended = true
  const s = readings.at(-1) ?? null
  if (s) board.apply(s, { instant: true })
  board.gather({ instant: true })
  lastShown = s
  const tm = transcriptAt(events, headT)
  transcript.render(tm, true)
  transcriptD.render(tm, true)
  clockEl.textContent = fmt(headT)
  setState(`from ${whenOf(m.name)}`, false)
  showSurfaced()
  // its wrap follows on the same socket: the saved one, or a new one if it never had any
  if (m.said) { awaiting = 'heard'; wrap = { state: 'writing' } }
  renderWrap()
  renderHint()
}

earlierBtn.addEventListener('click', () => {
  if (state !== 'idle') return
  layout.closeContext()
  closeSetup()
  earlierOpen = !earlierOpen
  confirming = null
  earlierItems = null
  earlierFailed = false
  renderEarlier()
  if (earlierOpen) tell({ type: 'earlier' })
})
earlierEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-open], [data-remove], [data-act]')
  if (!el) return
  if (el.dataset.open) return tell({ type: 'open', name: el.dataset.open })
  const name = el.dataset.remove
  if (!name) return
  if (confirming !== name) { confirming = name; return renderEarlier() }
  confirming = null
  tell({ type: 'remove', name })
})
earlierEl.addEventListener('keydown', (e) => e.stopPropagation())
// Escape, or a tap anywhere off the list, puts it away
function closeEarlier() {
  if (!earlierOpen) return
  earlierOpen = false
  confirming = null
  renderEarlier()
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeEarlier(); closeSetup() } }, true)
document.addEventListener('pointerdown', (e) => {
  const t = e.target as Node
  if (earlierOpen && !earlierEl.contains(t) && !earlierBtn.contains(t)) closeEarlier()
  if (setupOpen && !setupEl.contains(t) && !stateEl.contains(t)) closeSetup()
})

function onMessage(m: LiveMessage) {
  if (m.type === 'live.heard') {
    if (replaying || state !== 'live') return
    dots.heard(m.words.length)
    heard.say(m.line, m.text)
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
      currentName = (m.message ?? '').split('/').pop() || null
      finish('surfaced', { keepSocket: wrap !== null })
      showSurfaced()
    } else if (m.state === 'warning') {
      console.warn(`live: ${m.message ?? ''}`)
    } else {
      setState(m.state, m.state === 'listening')
      if (m.state === 'listening') big.disabled = false
      if (m.state === 'listening' || m.state === 'reconnecting') lastStatusWord = m.state
    }
    return
  }
  if (m.type === 'live.wrap') return onWrap(m)
  if (m.type === 'live.setup') { setup = m.setup; setupFailed = false; return renderSetup() }
  if (m.type === 'live.earlier') { earlierItems = m.items; earlierFailed = false; return renderEarlier() }
  if (m.type === 'live.opened') return showEarlier(m)
  if (m.type === 'live.removed') {
    if (m.ok && m.name === currentName) { clearPage(); currentName = null; setState('removed', false); renderWrap(); renderHint() }
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
      const relabelled = mk.id === lit && labelOf.get(mk.id) !== mk.label
      labelOf.set(mk.id, mk.label)
      if (relabelled && !renaming) renderHint()
      if (seenLabelIds.has(mk.id)) continue
      seenLabelIds.add(mk.id)
      // a return to something carried over from the last sounding: its faint mark becomes this one
      const ci = carried.length ? matchCarried(mk.label, carried) : -1
      if (ci >= 0) {
        carried[ci] = ''
        contextSeeds = contextSeeds.map((s) => (s.id === carryId(ci) ? { id: mk.id, label: mk.label } : s))
        board.clearGhosts()
        board.seedGhosts(contextSeeds)
        continue
      }
      if (contextText && !carried.length && contextSeeds.length < 5 && !contextSeeds.some((s) => s.id === mk.id) && matchesContext(mk.label)) {
        contextSeeds = [...contextSeeds, { id: mk.id, label: mk.label }]
        board.seedGhosts(contextSeeds)
      }
    }
  }
  if (m.type === 'candidates.emitted') counters.textContent = summary(events)
  // a rename that turned out to be a merge: the followed mark is gone, absorbed into the other
  if (m.type === 'mark.renamed' && m.mergedInto && lit === m.conceptId) setFollow(null, false)
  if (!replaying) showLive(m)
}

function showLive(m: SoundingEvent) {
  shownT = m.t
  clockEl.textContent = fmt(m.t)
  if (m.type === 'reading.changed') {
    const s = snapshotOf(m)
    board.apply(s)
    // a mark that just arrived or gained ground: its pool in the field brightens and rings
    for (const tr of m.transitions) if (tr.kind === 'appeared' || (tr.kind === 'nudged' && tr.delta > 0)) dots.pulse(tr.conceptId)
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
  renaming = null
  renderHint()
  shownT = t
  const s = readings.filter((r) => r.t <= t).at(-1) ?? null
  board.reset()
  if (s) board.apply(s, { instant: true })
  renderWrap()
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
  renderHint()
  const s = readings.at(-1) ?? null
  board.reset()
  if (s) board.apply(s, { instant: true })
  if (ended) board.gather({ instant: true })
  renderWrap()
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
  else toggleSetup()
})
stateEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  if (replaying) backToLive()
  else toggleSetup()
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

/** `carry`: the next sounding starts from the one that just ended, its marks faint on the board and its wrap as context. */
async function start(carry = false) {
  const carriedLabels = carry ? lastMarkLabels().slice(0, CARRY_MAX_MARKS) : []
  const question = carry && lens === 'question' && wrap?.state === 'done' ? wrap.text.trim() : ''
  const carriedText = carry ? carryContext({ marks: carriedLabels, wrap: heardText, question, brought: broughtText }) : ''
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
  renaming = null
  clearUndo()
  clearWrap()
  clearEnding()
  currentName = null
  confirming = null
  earlierOpen = false
  renderEarlier()
  closeSetup()
  board.setLit(null)
  lanes.setLit(null)
  lanesD.setLit(null)
  hint.textContent = ''
  controls.classList.remove('after')
  // Each start() gets a fresh ReadingDynamics, whose concept ids are always
  // `c1, c2, …` counting up from one — so ids *recur* every session, and a
  // stale ghost left over from a previous session could get promoted by an
  // unrelated concept that happens to land on the same id. Drop the seeded
  // ids but keep contextText: onMessage's first-appearance matcher re-seeds
  // against the new session's ids as labels arrive, which is exactly the
  // "seeding before Drop only stores the text" semantic.
  contextSeeds = carriedLabels.map((label, i) => ({ id: carryId(i), label }))
  carried = carriedLabels
  contextText = carry ? carriedText : broughtText
  pinnedEl.textContent = question
  pinnedEl.hidden = !question

  board.clearGhosts() // also drops the board's own internal seed list, so reset() below doesn't reseed stale ids
  board.reset()
  if (contextSeeds.length) board.seedGhosts(contextSeeds)
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

  const socket = new WebSocket(liveUrl)
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
    finish(opened ? 'connection closed' : `cannot reach live server at ${liveUrl} — run: bun run live`)
  }
  socket.onmessage = (ev) => {
    if (mine !== gen) return // a late wrap for a sounding the page has already moved on from
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
    const startMsg: { type: 'start'; interpreter?: string; transcriber?: string; context?: string } = { type: 'start' }
    if (interpParam) startMsg.interpreter = interpParam
    if (transcriberParam) startMsg.transcriber = transcriberParam
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
  setState('surfacing…', false)
  beginEnding()
  await teardownAudio()
  // `ws` may have been reset to null by a concurrent finish() (e.g. a
  // server error arriving mid-teardown) — act on the captured reference.
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }))
  // 'stopped' status from the server calls finish(), which flips the button back.
}

big.addEventListener('click', () => {
  layout.closeContext()
  if (state === 'idle') void start(canCarry())
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
    <textarea placeholder="A question, a few notes, a name…" maxlength="4000"></textarea>
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
    contextText = textarea.value.trim()
    broughtText = contextText
    carried = []
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
    broughtText = ''
    carried = []
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

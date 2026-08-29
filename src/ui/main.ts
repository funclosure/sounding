// The replay instrument. This is the only file allowed to read wall clock.
import { createReplay } from '../replay/runner'
import { FIXTURES } from '../replay/fixtures/index'
import { summarizeCounters } from '../replay/counters'
import { layoutReading } from './layout'
import type { Reading, Transition, Ms } from '../core/types'
import { EventLog, type SoundingEvent } from '../core/events'

const fixtureSelect = document.getElementById('fixture-select') as HTMLSelectElement
const logFileInput = document.getElementById('log-file') as HTMLInputElement
const playPause = document.getElementById('play-pause') as HTMLButtonElement
const speedSelect = document.getElementById('speed') as HTMLSelectElement
const clockEl = document.getElementById('clock')!
const slackEl = document.getElementById('slack-indicator')!
const countersEl = document.getElementById('counters')!
const chart = document.getElementById('chart') as unknown as SVGSVGElement
const inspector = document.getElementById('inspector')!

for (const f of FIXTURES) {
  const opt = document.createElement('option')
  opt.value = f.name
  opt.textContent = `${f.name} — ${f.description}`
  fixtureSelect.appendChild(opt)
}

let replay = createReplay(FIXTURES[0])
let script = FIXTURES[0]
let sessionT: Ms = 0
let playing = false
let lastFrameWallT = 0
let advancing = false
let renderedThrough = 0
let selectedConceptId: string | null = null
const history = new Map<string, Array<{ t: Ms; transition: Transition }>>()

// A loaded .jsonl log stands in for the live runner: same clock, same
// controls, but the readings come from a finished recording instead of
// interpretation happening in real time.
let loadedReadings: Array<Extract<SoundingEvent, { type: 'reading.changed' }>> | null = null
let loadedIdx = 0
let loadedEvents: readonly SoundingEvent[] = []

function reset() {
  script = FIXTURES.find((f) => f.name === fixtureSelect.value) ?? FIXTURES[0]
  replay = createReplay(script)
  sessionT = 0
  playing = false
  advancing = false
  renderedThrough = 0
  selectedConceptId = null
  history.clear()
  playPause.textContent = 'Drop'
  inspector.innerHTML = '<p>Click a mark to see its transition history.</p>'
  chart.innerHTML = ''
  clockEl.textContent = '0:00'
  slackEl.hidden = true
  countersEl.textContent = ''
  loadedReadings = null
  loadedIdx = 0
  loadedEvents = []
  logFileInput.value = ''
}

fixtureSelect.addEventListener('change', reset)

logFileInput.addEventListener('change', async () => {
  const file = logFileInput.files?.[0]
  if (!file) return
  let log: EventLog
  try {
    log = EventLog.fromJsonl(await file.text())
  } catch (err) {
    console.error(err)
    inspector.innerHTML = `<p>Failed to load ${file.name}: ${err instanceof Error ? err.message : String(err)}</p>`
    logFileInput.value = ''
    return
  }
  reset()
  loadedEvents = log.all()
  loadedReadings = loadedEvents.filter((e): e is Extract<SoundingEvent, { type: 'reading.changed' }> => e.type === 'reading.changed')
  loadedIdx = 0
  const c = summarizeCounters(loadedEvents)
  countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms`
  playPause.textContent = 'Drop'
})

playPause.addEventListener('click', async () => {
  if (advancing || playPause.textContent === 'Surfaced') return // a sounding surfaces once; pick a fixture to re-drop
  if (loadedReadings) {
    if (speedSelect.value === '0') {
      playing = false // stop any in-flight streaming playback before the bulk rebuild below
      sessionT = loadedEvents.at(-1)?.t ?? 0
      history.clear()
      // replay all transitions instantly
      for (const r of loadedReadings) {
        recordTransitions(r.t, r.transitions)
      }
      loadedIdx = loadedReadings.length // frame()'s while loop must never re-walk what we just replayed
      const last = loadedReadings.at(-1)
      if (last) renderReading(last.reading)
      clockEl.textContent = fmt(sessionT)
      playPause.textContent = 'Surfaced'
      return
    }
    playing = !playing
    playPause.textContent = playing ? 'Pause' : 'Resume'
    lastFrameWallT = performance.now()
    return
  }
  if (speedSelect.value === '0') {
    advancing = true
    try {
      await replay.runner.runToEnd()
    } finally {
      advancing = false
    }
    sessionT = script.endT
    consumeAndRender()
    playPause.textContent = 'Surfaced'
    return
  }
  playing = !playing
  playPause.textContent = playing ? 'Pause' : 'Resume'
  lastFrameWallT = performance.now()
})

function fmt(t: Ms): string {
  const s = Math.floor(t / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Record each transition in `history`, keyed by the concept it lands on. */
function recordTransitions(t: Ms, transitions: readonly Transition[]) {
  for (const tr of transitions) {
    const id = tr.kind === 'merged' ? tr.intoConceptId : tr.conceptId
    if (!history.has(id)) history.set(id, [])
    history.get(id)!.push({ t, transition: tr })
  }
}

function consumeAndRender() {
  const events = replay.session.log.all()
  let latest: Extract<SoundingEvent, { type: 'reading.changed' }> | null = null
  for (let i = renderedThrough; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'reading.changed') {
      latest = e
      recordTransitions(e.t, e.transitions)
    }
  }
  renderedThrough = events.length
  if (latest) renderReading(latest.reading)
  const c = summarizeCounters(events)
  countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms`
  clockEl.textContent = fmt(sessionT)
}

function renderReading(reading: Reading) {
  slackEl.hidden = !reading.slack
  const { width, height } = chart.getBoundingClientRect()
  const placed = layoutReading(reading, Math.max(width, 200), Math.max(height, 200))
  chart.innerHTML = ''
  for (const p of placed) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('class', p.conceptId === selectedConceptId ? 'mark selected' : 'mark')
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', String(p.x))
    circle.setAttribute('cy', String(p.y))
    circle.setAttribute('r', String(p.r))
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    text.setAttribute('x', String(p.x))
    text.setAttribute('y', String(p.y + 4))
    text.setAttribute('font-size', String(Math.max(11, p.r / 3)))
    text.textContent = p.label
    g.appendChild(circle)
    g.appendChild(text)
    g.addEventListener('click', () => {
      selectedConceptId = p.conceptId
      renderInspector(p.conceptId, p.label)
      renderReading(reading)
    })
    chart.appendChild(g)
  }
}

function describe(tr: Transition): string {
  switch (tr.kind) {
    case 'appeared': return 'appeared'
    case 'nudged': return `nudged +${tr.delta}`
    case 'displaced': return `displaced by ${tr.byConceptId}`
    case 'merged': return `absorbed ${tr.fromConceptId}`
  }
}

function renderInspector(conceptId: string, label: string) {
  const entries = history.get(conceptId) ?? []
  inspector.innerHTML = `<h2>${label} <small>(${conceptId})</small></h2>`
  const ul = document.createElement('ul')
  for (const { t, transition } of entries) {
    const li = document.createElement('li')
    li.textContent = `${fmt(t)} — ${describe(transition)}`
    ul.appendChild(li)
  }
  inspector.appendChild(ul)
}

async function frame(wallT: number) {
  if (playing && loadedReadings) {
    const speed = Number(speedSelect.value) || 1
    const endT = loadedEvents.at(-1)?.t ?? 0
    sessionT = Math.min(sessionT + (wallT - lastFrameWallT) * speed, endT)
    lastFrameWallT = wallT
    let latest: (typeof loadedReadings)[number] | null = null
    while (loadedIdx < loadedReadings.length && loadedReadings[loadedIdx].t <= sessionT) {
      latest = loadedReadings[loadedIdx]
      recordTransitions(latest.t, latest.transitions)
      loadedIdx += 1
    }
    if (latest) renderReading(latest.reading)
    clockEl.textContent = fmt(sessionT)
    if (sessionT >= endT) {
      playing = false
      playPause.textContent = 'Surfaced'
    }
  } else if (playing && !advancing) {
    const speed = Number(speedSelect.value) || 1
    sessionT = Math.min(sessionT + (wallT - lastFrameWallT) * speed, script.endT)
    lastFrameWallT = wallT
    advancing = true
    try {
      await replay.runner.advanceTo(sessionT)
    } finally {
      advancing = false
    }
    consumeAndRender()
    if (sessionT >= script.endT) {
      playing = false
      playPause.textContent = 'Surfaced'
    }
  } else {
    lastFrameWallT = wallT
  }
  requestAnimationFrame(frame)
}

reset()
requestAnimationFrame(frame)

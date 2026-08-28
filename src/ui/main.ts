// The replay instrument. This is the only file allowed to read wall clock.
import { createReplay } from '../replay/runner'
import { FIXTURES } from '../replay/fixtures/index'
import { summarizeCounters } from '../replay/counters'
import { layoutReading } from './layout'
import type { Reading, Transition, Ms } from '../core/types'
import type { SoundingEvent } from '../core/events'

const fixtureSelect = document.getElementById('fixture-select') as HTMLSelectElement
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

function reset() {
  script = FIXTURES.find((f) => f.name === fixtureSelect.value) ?? FIXTURES[0]
  replay = createReplay(script)
  sessionT = 0
  playing = false
  renderedThrough = 0
  selectedConceptId = null
  history.clear()
  playPause.textContent = 'Drop'
  inspector.innerHTML = '<p>Click a mark to see its transition history.</p>'
  chart.innerHTML = ''
  clockEl.textContent = '0:00'
  slackEl.hidden = true
  countersEl.textContent = ''
}

fixtureSelect.addEventListener('change', reset)

playPause.addEventListener('click', async () => {
  if (advancing || playPause.textContent === 'Surfaced') return // a sounding surfaces once; pick a fixture to re-drop
  if (speedSelect.value === '0') {
    advancing = true
    await replay.runner.runToEnd()
    advancing = false
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

function consumeAndRender() {
  const events = replay.session.log.all()
  let latest: Extract<SoundingEvent, { type: 'reading.changed' }> | null = null
  for (let i = renderedThrough; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'reading.changed') {
      latest = e
      for (const tr of e.transitions) {
        const id = tr.kind === 'merged' ? tr.intoConceptId : tr.conceptId
        if (!history.has(id)) history.set(id, [])
        history.get(id)!.push({ t: e.t, transition: tr })
      }
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
  if (playing && !advancing) {
    const speed = Number(speedSelect.value) || 1
    sessionT = Math.min(sessionT + (wallT - lastFrameWallT) * speed, script.endT)
    lastFrameWallT = wallT
    advancing = true
    await replay.runner.advanceTo(sessionT)
    advancing = false
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

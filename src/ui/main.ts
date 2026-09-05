// The replay instrument. This is the only file allowed to read wall clock.
import { createReplay } from '../replay/runner'
import { FIXTURES } from '../replay/fixtures/index'
import { summarizeCounters } from '../replay/counters'
import { createChart, fmt } from './chart'
import type { Ms } from '../core/types'
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
const micInterp = document.getElementById('mic-interp') as HTMLSelectElement
const recordBtn = document.getElementById('record') as HTMLButtonElement
const micStatus = document.getElementById('mic-status')!
const view = createChart({ chart, inspector, slackEl })

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
  view.reset()
  playPause.textContent = 'Drop'
  clockEl.textContent = '0:00'
  countersEl.textContent = ''
  loadedReadings = null
  loadedIdx = 0
  loadedEvents = []
  logFileInput.value = ''
}

fixtureSelect.addEventListener('change', reset)

/** Load a sounding log (jsonl text) into the loaded-log playback mode. Returns false on parse failure. */
function loadLogText(text: string, label: string): boolean {
  let log: EventLog
  try {
    log = EventLog.fromJsonl(text)
  } catch (err) {
    console.error(err)
    inspector.innerHTML = `<p>Failed to load ${label}: ${err instanceof Error ? err.message : String(err)}</p>`
    return false
  }
  reset()
  loadedEvents = log.all()
  loadedReadings = loadedEvents.filter((e): e is Extract<SoundingEvent, { type: 'reading.changed' }> => e.type === 'reading.changed')
  loadedIdx = 0
  const c = summarizeCounters(loadedEvents)
  countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms`
  playPause.textContent = 'Drop'
  return true
}

logFileInput.addEventListener('change', async () => {
  const file = logFileInput.files?.[0]
  if (!file) return
  const ok = loadLogText(await file.text(), file.name)
  if (!ok) logFileInput.value = ''
})

/** The loaded-log part of a Drop click: play (or instantly surface) a loaded sounding log. */
function dropLoaded() {
  if (!loadedReadings) return
  if (speedSelect.value === '0') {
    playing = false // stop any in-flight streaming playback before the bulk rebuild below
    sessionT = loadedEvents.at(-1)?.t ?? 0
    view.reset()
    // replay all transitions instantly
    for (const r of loadedReadings) {
      view.recordTransitions(r.t, r.transitions)
    }
    loadedIdx = loadedReadings.length // frame()'s while loop must never re-walk what we just replayed
    const last = loadedReadings.at(-1)
    if (last) view.render(last.reading)
    clockEl.textContent = fmt(sessionT)
    playPause.textContent = 'Surfaced'
    return
  }
  playing = !playing
  playPause.textContent = playing ? 'Pause' : 'Resume'
  lastFrameWallT = performance.now()
}

playPause.addEventListener('click', async () => {
  if (advancing || playPause.textContent === 'Surfaced') return // a sounding surfaces once; pick a fixture to re-drop
  if (loadedReadings) {
    dropLoaded()
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

function consumeAndRender() {
  const events = replay.session.log.all()
  let latest: Extract<SoundingEvent, { type: 'reading.changed' }> | null = null
  for (let i = renderedThrough; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'reading.changed') {
      latest = e
      view.recordTransitions(e.t, e.transitions)
    }
  }
  renderedThrough = events.length
  if (latest) view.render(latest.reading)
  const c = summarizeCounters(events)
  countersEl.textContent = `${c.callCount} calls · $${c.totalCostUsd.toFixed(4)} · mean ${Math.round(c.meanLatencyMs)}ms`
  clockEl.textContent = fmt(sessionT)
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
      view.recordTransitions(latest.t, latest.transitions)
      loadedIdx += 1
    }
    if (latest) view.render(latest.reading)
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

// ---- Mic recording: record → save → cast → load. Not live; the cast runs
// after Stop, and the reading appears when it finishes.
type MicState = 'idle' | 'starting' | 'recording' | 'saving' | 'casting'
let micState: MicState = 'idle'
let recorder: MediaRecorder | null = null
let micChunks: Blob[] = []
let micStartedWallT = 0
let micTimer: number | null = null

function setMic(state: MicState, status = '') {
  micState = state
  micStatus.textContent = status
  micStatus.classList.toggle('recording', state === 'recording')
  recordBtn.textContent = state === 'recording' ? 'Stop' : 'Record'
  recordBtn.disabled = state === 'starting' || state === 'saving' || state === 'casting'
  micInterp.disabled = state !== 'idle'
}

function startMicTimer(prefix: string) {
  micStartedWallT = performance.now()
  const tick = () => { micStatus.textContent = `${prefix} ${fmt(performance.now() - micStartedWallT)}` }
  tick()
  micTimer = window.setInterval(tick, 500)
}

function stopMicTimer() {
  if (micTimer !== null) window.clearInterval(micTimer)
  micTimer = null
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim().length > 0) ?? s
}

async function postJson<T>(url: string, body: BodyInit, contentType: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body })
  const text = await res.text()
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const json = JSON.parse(text) as { error?: string }
      if (json.error) message = json.error
    } catch {
      // not JSON (e.g. a dev-server error page); fall back to the HTTP status
    }
    throw new Error(message)
  }
  return JSON.parse(text) as T
}

async function startRecording() {
  setMic('starting', 'starting…')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    setMic('idle', 'error: microphone access denied')
    return
  }
  micChunks = []
  try {
    recorder = new MediaRecorder(stream)
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    setMic('idle', `error: recorder unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  recorder.ondataavailable = (e) => { if (e.data.size > 0) micChunks.push(e.data) }
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop()) // clears the browser's recording indicator
    void saveAndCast(new Blob(micChunks, { type: recorder?.mimeType || 'audio/webm' }))
  }
  recorder.start(1000)
  setMic('recording')
  startMicTimer('●')
}

async function saveAndCast(blob: Blob) {
  stopMicTimer()
  const interpreter = micInterp.value
  try {
    setMic('saving', 'saving…')
    const { name } = await postJson<{ name: string }>('/api/recordings', blob, blob.type || 'application/octet-stream')
    setMic('casting')
    startMicTimer(`casting ${interpreter}…`)
    const { log } = await postJson<{ log: string }>(
      '/api/cast',
      JSON.stringify({ name, interpreter }),
      'application/json',
    )
    stopMicTimer()
    const res = await fetch(`/${log}`)
    if (!res.ok) throw new Error(`could not fetch ${log} (HTTP ${res.status})`)
    const ok = loadLogText(await res.text(), log)
    if (ok) dropLoaded()
    setMic('idle', ok ? `loaded ${name}.${interpreter}` : `error: ${log} did not parse`)
  } catch (err) {
    stopMicTimer()
    setMic('idle', `error: ${firstLine(err instanceof Error ? err.message : String(err))}`)
  }
}

recordBtn.addEventListener('click', () => {
  if (micState === 'idle') void startRecording()
  else if (micState === 'recording') {
    stopMicTimer()
    setMic('saving', 'saving…')
    if (recorder?.state === 'recording') recorder.stop()
  }
})

reset()
requestAnimationFrame(frame)

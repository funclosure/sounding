import { describe, it, expect } from 'vitest'
import { TranscribeLiveClient, type WebSocketLike } from '../src/live/transcribe-live'

class FakeSocket implements WebSocketLike {
  static created: FakeSocket[] = []
  sent: string[] = []
  closed = false
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  constructor(public url: string) { FakeSocket.created.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true; this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }) }
  open() { this.readyState = 1; this.onopen?.({}) }
  receive(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

function makeClient(now: { t: number }, timers: Array<{ at: number; fn: () => void }>) {
  return new TranscribeLiveClient('KEY', {
    socketFactory: (url) => new FakeSocket(url),
    sessionLimitMs: 1000,
    now: () => now.t,
    setTimer: ((fn: () => void, ms: number) => { timers.push({ at: now.t + ms, fn }); return timers.length as unknown as NodeJS.Timeout }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  })
}

describe('TranscribeLiveClient', () => {
  it('sends the setup message, resolves on setupComplete, frames audio, dispatches interim/final', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const got: string[] = []
    const p = c.connect({ onInterim: (t) => got.push('I:' + t), onFinal: (t) => got.push('F:' + t), onStatus: () => {} })
    const ws = FakeSocket.created[0]
    expect(ws.url).toContain('BidiGenerateContent?key=KEY')
    ws.open()
    expect(JSON.parse(ws.sent[0])).toEqual({ setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: [], mode: 'VERBATIM' } } })
    ws.receive({ setupComplete: {} })
    await p
    c.sendAudio(new Int16Array([1, 2, 3]))
    const audio = JSON.parse(ws.sent[1])
    expect(audio.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000')
    expect(Buffer.from(audio.realtimeInput.audio.data, 'base64').length).toBe(6)
    ws.receive({ serverContent: { interimInputTranscription: { text: 'hel' } } })
    ws.receive({ serverContent: { inputTranscription: { text: 'hello' } } })
    ws.receive({ serverContent: {}, voiceActivity: { type: 'ACTIVITY_END', audioOffset: '1s' } })
    expect(got).toEqual(['I:hel', 'F:hello'])
    await c.end()
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } })
  })

  it('reconnects at the session limit and routes new audio to the new socket', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    FakeSocket.created[0].open(); FakeSocket.created[0].receive({ setupComplete: {} }); await p
    now.t = 1000
    timers.find((x) => x.at === 1000)!.fn()                   // session-limit timer fires
    expect(FakeSocket.created.length).toBe(2)
    const old = FakeSocket.created[0], fresh = FakeSocket.created[1]
    fresh.open(); fresh.receive({ setupComplete: {} })
    await Promise.resolve()
    c.sendAudio(new Int16Array([9]))
    expect(fresh.sent.some((s) => s.includes('"audio"'))).toBe(true)
    expect(old.sent.at(-1)).toContain('audioStreamEnd')
  })

  // Additional coverage (not in the brief) for the `awaitingFinal` branch of
  // drain(): the two tests above only exercise awaitingFinal === false
  // (a final already arrived before end()). These exercise the true branch,
  // where an interim has arrived with no matching final yet.
  it('drain waits for the timer when a final is still owed, then resolves and closes', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open(); ws.receive({ setupComplete: {} }); await p
    ws.receive({ serverContent: { interimInputTranscription: { text: 'hel' } } })
    let resolved = false
    const endP = c.end().then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    expect(ws.closed).toBe(false)
    timers.find((x) => x.at === 3000)!.fn()
    await endP
    expect(resolved).toBe(true)
    expect(ws.closed).toBe(true)
  })

  it('drain resolves as soon as the trailing final arrives, before the timer fires', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const got: string[] = []
    const p = c.connect({ onInterim: () => {}, onFinal: (t) => got.push('F:' + t), onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open(); ws.receive({ setupComplete: {} }); await p
    ws.receive({ serverContent: { interimInputTranscription: { text: 'hel' } } })
    const endP = c.end()
    ws.receive({ serverContent: { inputTranscription: { text: 'hello' } } })
    await endP
    expect(got).toEqual(['F:hello'])
    expect(ws.closed).toBe(true)
  })
})

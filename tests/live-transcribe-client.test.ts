import { describe, it, expect } from 'vitest'
import { TranscribeLiveClient, setupMessage, type WebSocketLike } from '../src/live/transcribe-live'

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

function makeClient(now: { t: number }, timers: Array<{ at: number; fn: () => void }>, languageCodes?: string[]) {
  return new TranscribeLiveClient('KEY', {
    socketFactory: (url) => new FakeSocket(url),
    sessionLimitMs: 1000,
    setTimer: ((fn: () => void, ms: number) => { timers.push({ at: now.t + ms, fn }); return timers.length as unknown as NodeJS.Timeout }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
    ...(languageCodes !== undefined ? { languageCodes } : {}),
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
    expect(JSON.parse(ws.sent[0])).toEqual(setupMessage(['en-US']))
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

  it('sends the configured languageCodes in the setup message', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers, ['fr-FR'])
    void c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open()
    expect(JSON.parse(ws.sent[0])).toEqual(setupMessage(['fr-FR']))
  })

  it('sends the configured customVocabulary in the setup message', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = new TranscribeLiveClient('KEY', {
      socketFactory: (url) => new FakeSocket(url),
      sessionLimitMs: 1000,
      setTimer: ((fn: () => void, ms: number) => { timers.push({ at: now.t + ms, fn }); return timers.length as unknown as NodeJS.Timeout }) as typeof setTimeout,
      clearTimer: (() => {}) as typeof clearTimeout,
      customVocabulary: ['Sounding'],
    })
    void c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open()
    expect(JSON.parse(ws.sent[0])).toEqual(setupMessage(['en-US'], ['Sounding']))
    expect(JSON.parse(ws.sent[0]).setup.inputAudioTranscription.customVocabulary).toEqual(['Sounding'])
  })

  it('defaults customVocabulary to an empty array', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    void c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open()
    expect(JSON.parse(ws.sent[0]).setup.inputAudioTranscription.customVocabulary).toEqual([])
  })

  it('sends an empty languageCodes array (auto-detect) when configured', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers, [])
    void c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open()
    expect(JSON.parse(ws.sent[0])).toEqual(setupMessage([]))
    expect(JSON.parse(ws.sent[0]).setup.inputAudioTranscription.languageCodes).toEqual([])
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

  // Additional coverage (not in the brief) for the "final still owed" branch
  // of drain(): the two tests above only exercise the not-owed case (a final
  // already arrived, with no audio sent since, before end()). These exercise
  // the owed branch, where audio was sent to the socket since its last final.
  it('drain waits for the timer when a final is still owed, then resolves and closes', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open(); ws.receive({ setupComplete: {} }); await p
    c.sendAudio(new Int16Array([1]))
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
    c.sendAudio(new Int16Array([1]))
    ws.receive({ serverContent: { interimInputTranscription: { text: 'hel' } } })
    const endP = c.end()
    ws.receive({ serverContent: { inputTranscription: { text: 'hello' } } })
    await endP
    expect(got).toEqual(['F:hello'])
    expect(ws.closed).toBe(true)
  })

  it('end() waits for the trailing final when audio was sent after the last final', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const got: string[] = []
    const p = c.connect({ onInterim: () => {}, onFinal: (t) => got.push('F:' + t), onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open(); ws.receive({ setupComplete: {} }); await p
    ws.receive({ serverContent: { inputTranscription: { text: 'hello' } } })
    c.sendAudio(new Int16Array([1]))
    let resolved = false
    const endP = c.end().then(() => { resolved = true })
    await Promise.resolve()
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    expect(resolved).toBe(false)
    expect(ws.closed).toBe(false)
    ws.receive({ serverContent: { inputTranscription: { text: 'world' } } })
    await endP
    expect(got).toEqual(['F:hello', 'F:world'])
    expect(resolved).toBe(true)
    expect(ws.closed).toBe(true)
  })

  it('end() falls back to the 3s timer when no final arrives', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open(); ws.receive({ setupComplete: {} }); await p
    ws.receive({ serverContent: { inputTranscription: { text: 'hello' } } })
    c.sendAudio(new Int16Array([1]))
    let resolved = false
    const endP = c.end().then(() => { resolved = true })
    await Promise.resolve()
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    expect(resolved).toBe(false)
    expect(ws.closed).toBe(false)
    timers.find((x) => x.at === 3000)!.fn()
    await endP
    expect(resolved).toBe(true)
    expect(ws.closed).toBe(true)
  })

  it("rotation: a final on the old socket does not clear the fresh socket's pending flag", async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const old = FakeSocket.created[0]
    old.open(); old.receive({ setupComplete: {} }); await p
    c.sendAudio(new Int16Array([1]))
    now.t = 1000
    timers.find((x) => x.at === 1000)!.fn()                    // session-limit timer fires; rotate() begins
    expect(FakeSocket.created.length).toBe(2)
    const fresh = FakeSocket.created[1]
    fresh.open(); fresh.receive({ setupComplete: {} })
    await Promise.resolve()                                    // rotate() continuation: this.ws = fresh; drain(old) begins
    c.sendAudio(new Int16Array([2]))                            // goes to fresh
    old.receive({ serverContent: { inputTranscription: { text: 'old-final' } } })
    expect(old.closed).toBe(true)                               // old's owed final arrived; old drains and closes
    let resolved = false
    const endP = c.end().then(() => { resolved = true })
    await Promise.resolve()
    expect(JSON.parse(fresh.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    expect(resolved).toBe(false)
    expect(fresh.closed).toBe(false)
    fresh.receive({ serverContent: { inputTranscription: { text: 'fresh-final' } } })
    await endP
    expect(resolved).toBe(true)
    expect(fresh.closed).toBe(true)
  })

  it('end() during an in-flight rotate does not resurrect a socket', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const old = FakeSocket.created[0]
    old.open(); old.receive({ setupComplete: {} }); await p
    now.t = 1000
    timers.find((x) => x.at === 1000)!.fn()                    // session-limit timer fires; fresh socket created but not opened
    expect(FakeSocket.created.length).toBe(2)
    const fresh = FakeSocket.created[1]
    await c.end()
    expect(old.closed).toBe(true)
    fresh.open()                                                 // arms fresh's own 10s setup timer
    const timerCountBefore = timers.length
    fresh.receive({ setupComplete: {} })                         // rotate()'s open() resolves after end() already ran
    await Promise.resolve()
    await Promise.resolve()
    expect(JSON.parse(fresh.sent.at(-1)!)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    expect(fresh.closed).toBe(true)
    expect(timers.length).toBe(timerCountBefore)                 // no session-limit timer armed once ended
  })

  it('an unexpected close after setup surfaces a status error, and sendAudio then no-ops', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const statuses: Array<{ state: string; message?: string }> = []
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: (state, message) => statuses.push({ state, message }) })
    const ws = FakeSocket.created[0]
    ws.open(); ws.receive({ setupComplete: {} }); await p
    ws.close() // simulate the remote end dropping the connection, not end()/drain()
    expect(statuses.at(-1)?.state).toBe('error')
    expect(statuses.at(-1)?.message).toContain('transcribe-live closed')
    const sentBefore = ws.sent.length
    expect(() => c.sendAudio(new Int16Array([1]))).not.toThrow()
    expect(ws.sent.length).toBe(sentBefore) // no-op: this.ws was nulled out
  })

  it('an error message before setupComplete rejects connect()', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open()
    ws.receive({ error: { code: 400, message: 'bad setup' } })
    await expect(p).rejects.toThrow(/bad setup|400/)
  })

  it('a setup timeout rejects connect() when setupComplete never arrives', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const p = c.connect({ onInterim: () => {}, onFinal: () => {}, onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open()
    const rejected = p.catch((e: unknown) => e)
    timers.find((x) => x.at === 10_000)!.fn()
    const err = await rejected
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('transcribe-live setup timed out')
    expect(ws.closed).toBe(true)
  })

  it('drain resolves on a binary final frame, without waiting for the 3s timer', async () => {
    FakeSocket.created = []
    const now = { t: 0 }; const timers: Array<{ at: number; fn: () => void }> = []
    const c = makeClient(now, timers)
    const got: string[] = []
    const p = c.connect({ onInterim: () => {}, onFinal: (t) => got.push('F:' + t), onStatus: () => {} })
    const ws = FakeSocket.created[0]
    ws.open(); ws.receive({ setupComplete: {} }); await p
    c.sendAudio(new Int16Array([1]))
    const endP = c.end()
    ws.onmessage?.({ data: Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: 'x' } } })) })
    await endP
    expect(got).toEqual(['F:x'])
    expect(ws.closed).toBe(true)
  })
})

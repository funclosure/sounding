import { describe, it, expect } from 'vitest'
import { elevenFile, ElevenLive, type LiveSocket } from '../src/live/elevenlabs'
import { WhisperTranscriber, type LiveText } from '../src/live/whisper-transcriber'

const RATE = 16_000
function audio(ms: number, amp: number): Int16Array[] {
  const chunks: Int16Array[] = []
  for (let left = (ms / 1000) * RATE; left > 0; left -= 1600) {
    const c = new Int16Array(Math.min(1600, left))
    for (let i = 0; i < c.length; i++) c[i] = i % 2 ? amp : -amp
    chunks.push(c)
  }
  return chunks
}

function fakeSocket() {
  const handlers: Record<string, (arg?: unknown) => void> = {}
  const sent: Array<{ commit: boolean; bytes: number }> = []
  const ws: LiveSocket = {
    readyState: 1,
    send: (d) => { const m = JSON.parse(d); sent.push({ commit: m.commit, bytes: Buffer.from(m.audio_base_64, 'base64').length }) },
    close: () => { ws.readyState = 3; handlers.close?.() },
    on: (ev, fn) => { handlers[ev] = fn },
  }
  const say = (m: object) => handlers.message?.(JSON.stringify(m))
  return { ws, sent, say, handlers }
}

describe('elevenFile', () => {
  it('posts the utterance as a wav with the key in a header and returns the text', async () => {
    let seen: { url: string; key: string; model: unknown; lang: unknown; file: Blob } | null = null
    const fn = elevenFile('k', (async (url: string, init: RequestInit) => {
      const f = init.body as FormData
      seen = { url, key: (init.headers as Record<string, string>)['xi-api-key'], model: f.get('model_id'), lang: f.get('language_code'), file: f.get('file') as Blob }
      return new Response(JSON.stringify({ text: 'hello there' }))
    }) as unknown as typeof fetch)
    expect(await fn(new Int16Array(1600), { language: 'zh' })).toBe('hello there')
    expect(seen).toMatchObject({ url: 'https://api.elevenlabs.io/v1/speech-to-text', key: 'k', model: 'scribe_v2', lang: 'zh' })
    expect(seen!.file.size).toBe(44 + 3200)
  })
  it('sends no language when it is left to the model, and throws on a refusal', async () => {
    let lang: unknown = 'unset'
    const ok = elevenFile('k', (async (_u: string, init: RequestInit) => { lang = (init.body as FormData).get('language_code'); return new Response('{"text":"x"}') }) as unknown as typeof fetch)
    await ok(new Int16Array(160), { language: 'auto' })
    expect(lang).toBeNull()
    const bad = elevenFile('k', (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch)
    await expect(bad(new Int16Array(160), { language: 'en' })).rejects.toThrow(/401/)
  })
})

describe('ElevenLive', () => {
  async function opened(now = () => 0) {
    const s = fakeSocket()
    const texts: string[] = []
    let url = ''
    const live = new ElevenLive('k', 'en', (u) => { url = u; return s.ws }, now)
    const p = live.open((t) => texts.push(t))
    s.say({ message_type: 'session_started' })
    await p
    return { live, texts, s, url: () => url }
  }
  it('opens the live model with manual cuts and passes its running text on', async () => {
    const r = await opened()
    expect(r.url()).toContain('model_id=scribe_v2_realtime')
    expect(r.url()).toContain('commit_strategy=manual')
    expect(r.url()).toContain('language_code=en')
    r.live.feed(new Int16Array(1600))
    r.s.say({ message_type: 'partial_transcript', text: 'so I' })
    expect(r.s.sent).toEqual([{ commit: false, bytes: 3200 }])
    expect(r.texts).toEqual(['so I'])
  })
  it('a cut rides on the next chunk, and text is dropped until the cut is confirmed', async () => {
    const r = await opened()
    r.live.feed(new Int16Array(160))
    r.live.cut(true)
    r.s.say({ message_type: 'partial_transcript', text: 'old words' })
    r.live.feed(new Int16Array(160))
    r.s.say({ message_type: 'partial_transcript', text: 'still old' })
    r.s.say({ message_type: 'committed_transcript', text: 'old words.' })
    r.s.say({ message_type: 'partial_transcript', text: 'new' })
    expect(r.s.sent.map((m) => m.commit)).toEqual([false, true])
    expect(r.texts).toEqual(['new'])
  })
  it('an unconfirmed cut stops hiding text after a moment', async () => {
    let t = 0
    const r = await opened(() => t)
    r.live.cut(true); r.live.feed(new Int16Array(160))
    t = 1000; r.s.say({ message_type: 'partial_transcript', text: 'early' })
    t = 1600; r.s.say({ message_type: 'partial_transcript', text: 'later' })
    expect(r.texts).toEqual(['later'])
  })
  it('a cut made mid-talk leaves the live model running and passes on only what it adds', async () => {
    const r = await opened()
    r.live.feed(new Int16Array(160))
    r.s.say({ message_type: 'partial_transcript', text: 'we talked about the off' })
    r.live.cut(false)
    r.live.feed(new Int16Array(160))
    r.s.say({ message_type: 'partial_transcript', text: 'we talked about the offer for an hour. She said' })
    r.s.say({ message_type: 'committed_transcript', text: 'whatever' })
    r.s.say({ message_type: 'partial_transcript', text: 'Fresh start' })
    expect(r.s.sent.map((m) => m.commit)).toEqual([false, false])
    expect(r.texts).toEqual(['we talked about the off', 'for an hour. She said', 'Fresh start'])
  })
  it('refuses to open when the key is turned away', async () => {
    const s = fakeSocket()
    const live = new ElevenLive('k', 'auto', () => s.ws)
    const p = live.open(() => {})
    s.say({ message_type: 'auth_error', error: 'You must be authenticated' })
    await expect(p).rejects.toThrow(/authenticated/)
  })
})

describe('WhisperTranscriber with live text', () => {
  it('shows the live text while speaking, keeps only the transcribe call, and cuts the live text at each pause', async () => {
    const events: string[] = []
    const calls: number[] = []
    let onText: (t: string) => void = () => {}
    let fed = 0, cuts = 0, closed = 0
    const live: LiveText = { open: async (f) => { onText = f }, feed: () => { fed++ }, cut: (paused) => { if (paused) cuts++ }, close: () => { closed++ } }
    const tr = new WhisperTranscriber({ language: 'en', live, rewrite: (t) => t.toUpperCase(), open: async () => async (pcm) => { calls.push(pcm.length); return 'kept words' } })
    await tr.connect({ onInterim: (t) => events.push(`interim:${t}`), onFinal: (t) => events.push(`final:${t}`), onStatus: () => {} })
    const feed = async (chunks: Int16Array[]) => { for (const c of chunks) { tr.sendAudio(c); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() } }
    onText('before anyone spoke')
    await feed(audio(2500, 3000))
    onText('running guess')
    await feed(audio(1000, 0))
    onText('after the pause')
    await tr.end()
    expect(events).toEqual(['interim:RUNNING GUESS', 'final:KEPT WORDS'])
    expect(calls.length).toBe(1) // no interim passes of its own
    expect(fed).toBe(35)
    expect(cuts).toBe(1)
    expect(closed).toBe(1)
  })
  it('live text for the next utterance waits until the previous final has landed', async () => {
    const events: string[] = []
    let onText: (t: string) => void = () => {}
    let release: (t: string) => void = () => {}
    const live: LiveText = { open: async (f) => { onText = f }, feed: () => {}, cut: () => {}, close: () => {} }
    const tr = new WhisperTranscriber({ language: 'en', live, open: async () => () => new Promise<string>((r) => { release = r }) })
    expect(tr.roughInterims).toBe(true)
    await tr.connect({ onInterim: (t) => events.push(`interim:${t}`), onFinal: (t) => events.push(`final:${t}`), onStatus: () => {} })
    const feed = async (chunks: Int16Array[]) => { for (const c of chunks) { tr.sendAudio(c); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() } }
    await feed(audio(1500, 3000)); await feed(audio(800, 0)) // first utterance closes; its final is still out
    await feed(audio(500, 3000))
    onText('second one, early'); onText('second one, a bit more')
    expect(events).toEqual([])
    release('first one'); await new Promise((r) => setTimeout(r, 0))
    expect(events).toEqual(['final:first one', 'interim:second one, a bit more'])
  })
})

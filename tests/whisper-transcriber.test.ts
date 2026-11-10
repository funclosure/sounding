import { describe, it, expect } from 'vitest'
import { WhisperTranscriber, cleanWhisperText } from '../src/live/whisper-transcriber'
import { whisperLanguage, inferenceForm, type TranscribeOptions } from '../src/live/whisper-server'
import type { TranscriberState } from '../src/live/transcriber'

const RATE = 16_000
/** `ms` of a steady tone at `amp` (0 = silence). 100ms chunks, like the worklet sends. */
function audio(ms: number, amp: number): Int16Array[] {
  const chunks: Int16Array[] = []
  for (let left = (ms / 1000) * RATE; left > 0; left -= 1600) {
    const c = new Int16Array(Math.min(1600, left))
    for (let i = 0; i < c.length; i++) c[i] = i % 2 ? amp : -amp
    chunks.push(c)
  }
  return chunks
}

interface Call { ms: number; opts: TranscribeOptions }
function rig(opts: { reply?: (call: Call, n: number) => string | Promise<string>; vocabulary?: string[] } = {}) {
  const calls: Call[] = []
  const events: string[] = []
  const statuses: TranscriberState[] = []
  const tr = new WhisperTranscriber({
    language: 'en', vocabulary: opts.vocabulary,
    open: async () => async (pcm, o) => {
      const call = { ms: Math.round((pcm.length / RATE) * 1000), opts: o }
      calls.push(call)
      return opts.reply ? opts.reply(call, calls.length) : `heard ${call.ms}`
    },
  })
  const feed = async (chunks: Int16Array[]) => { for (const c of chunks) { tr.sendAudio(c); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() } }
  const connect = () => tr.connect({ onInterim: (t) => events.push(`interim:${t}`), onFinal: (t) => events.push(`final:${t}`), onStatus: (s) => statuses.push(s) })
  return { tr, calls, events, statuses, feed, connect }
}

describe('WhisperTranscriber', () => {
  it('reports connecting, then listening once the model is open', async () => {
    const r = rig()
    await r.connect()
    expect(r.statuses).toEqual(['connecting', 'listening'])
  })

  it('never transcribes silence', async () => {
    const r = rig()
    await r.connect()
    await r.feed(audio(5000, 0))
    await r.tr.end()
    expect(r.calls).toHaveLength(0)
    expect(r.events).toEqual([])
  })

  it('gives cumulative interims while talking, then one final after a pause', async () => {
    const r = rig()
    await r.connect()
    await r.feed([...audio(500, 0), ...audio(3000, 4000), ...audio(1000, 0)])
    await r.tr.end()
    const interims = r.events.filter((e) => e.startsWith('interim:'))
    const finals = r.events.filter((e) => e.startsWith('final:'))
    expect(interims.length).toBeGreaterThanOrEqual(2)
    expect(finals).toHaveLength(1)
    expect(r.events.at(-1)).toBe(finals[0])
    // each pass covers the whole utterance so far: longer every time
    const lengths = r.calls.map((c) => c.ms)
    expect([...lengths].sort((a, b) => a - b)).toEqual(lengths)
    // the final holds the talk plus the pre-roll before it and the pause that closed it
    expect(lengths.at(-1)).toBeGreaterThanOrEqual(3000 + 300)
    expect(lengths.at(-1)).toBeLessThanOrEqual(3000 + 300 + 700 + 100)
  })

  it('drops a click too short to be speech', async () => {
    const r = rig()
    await r.connect()
    await r.feed([...audio(500, 0), ...audio(100, 6000), ...audio(1500, 0)])
    await r.tr.end()
    expect(r.calls).toHaveLength(0)
  })

  it('closes whatever is being spoken on end(), delivering the final before end() resolves', async () => {
    const r = rig()
    await r.connect()
    await r.feed(audio(1500, 4000))
    await r.tr.end()
    expect(r.events.at(-1)).toMatch(/^final:/)
  })

  it('splits a long run without a pause at its quietest moment and carries the rest over', async () => {
    const r = rig()
    await r.connect()
    // 13s of talk whose only dip (quieter, still above the speech floor) sits at 10.0–10.2s
    await r.feed([...audio(10_000, 4000), ...audio(200, 900), ...audio(2800, 4000), ...audio(1000, 0)])
    await r.tr.end()
    const finals = r.events.filter((e) => e.startsWith('final:')).map((e) => Number(e.split(' ')[1]))
    expect(finals).toHaveLength(2)
    expect(finals[0]).toBeGreaterThanOrEqual(10_000)
    expect(finals[0]).toBeLessThanOrEqual(10_200)
    // nothing lost or doubled: both finals together are all the audio from first voice to closing pause
    expect(finals[0] + finals[1]).toBeGreaterThanOrEqual(13_000)
    expect(finals[0] + finals[1]).toBeLessThanOrEqual(13_000 + 700 + 100)
  })

  it('discards an interim that lands after its utterance closed', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const r = rig({ reply: async (_c, n) => { if (n === 1) await gate; return n === 1 ? 'stale interim' : `pass ${n}` } })
    await r.connect()
    await r.feed([...audio(1500, 4000), ...audio(1000, 0)]) // interim 1 hangs; the pause closes the utterance meanwhile
    release()
    await r.tr.end()
    expect(r.events).not.toContain('interim:stale interim')
    expect(r.events.filter((e) => e.startsWith('final:'))).toHaveLength(1)
  })

  it('sends the context vocabulary and the previous final as the prompt', async () => {
    const r = rig({ vocabulary: ['Anneke', 'Kubernetes'], reply: (_c, n) => `sentence ${n}.` })
    await r.connect()
    await r.feed([...audio(1500, 4000), ...audio(1000, 0)])
    expect(r.calls[0].opts).toEqual({ language: 'en', prompt: 'Anneke, Kubernetes. ' })
    const before = r.calls.length
    await r.feed([...audio(1500, 4000), ...audio(1000, 0)])
    await r.tr.end()
    expect(r.calls[before].opts.prompt).toMatch(/^Anneke, Kubernetes\. sentence \d+\.$/)
  })

  it('keeps the sounding going when whisper fails: reconnecting, then listening again', async () => {
    const r = rig({ reply: (_c, n) => { if (n === 1) throw new Error('boom'); return 'back' } })
    await r.connect()
    await r.feed([...audio(1200, 4000), ...audio(1000, 0), ...audio(1200, 4000), ...audio(1000, 0)])
    await r.tr.end()
    expect(r.statuses).toEqual(['connecting', 'listening', 'reconnecting', 'listening'])
    expect(r.statuses).not.toContain('error')
    expect(r.events.some((e) => e === 'final:back' || e === 'interim:back')).toBe(true)
  })
})

describe('whisper helpers', () => {
  it('strips non-speech annotations', () => {
    expect(cleanWhisperText(' [BLANK_AUDIO] ')).toBe('')
    expect(cleanWhisperText('So (laughs) my sister *sighs* called. ♪')).toBe('So my sister called.')
  })
  it('maps language codes', () => {
    expect(whisperLanguage('en-US')).toBe('en')
    expect(whisperLanguage('zh-TW')).toBe('zh')
    expect(whisperLanguage('auto')).toBe('auto')
  })
  it('builds the inference form with a wav file, and a prompt only when there is one', () => {
    const f = inferenceForm(new Int16Array(1600), { language: 'en' })
    expect((f.get('file') as Blob).size).toBe(44 + 3200)
    expect(f.get('language')).toBe('en')
    expect(f.get('response_format')).toBe('json')
    expect(f.has('prompt')).toBe(false)
    expect(inferenceForm(new Int16Array(0), { language: 'auto', prompt: 'Anneke' }).get('prompt')).toBe('Anneke')
  })
})

describe('WhisperTranscriber — vocabulary added mid-session', () => {
  it('puts a corrected label in the prompt of the following passes, once', async () => {
    const r = rig({ vocabulary: ['Anneke'], reply: () => '' })
    await r.connect()
    r.tr.addVocabulary(['sounding board', 'Anneke'])
    await r.feed([...audio(1500, 4000), ...audio(1000, 0)])
    await r.tr.end()
    expect(r.calls[0].opts.prompt).toBe('Anneke, sounding board. ')
  })
})

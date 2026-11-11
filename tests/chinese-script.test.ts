import { describe, it, expect } from 'vitest'
import { scriptFor } from '../src/live/chinese-script'
import { isLang, langName } from '../src/live/langs'
import { whisperLanguage } from '../src/live/whisper-server'
import { WhisperTranscriber } from '../src/live/whisper-transcriber'

describe('the two Chinese scripts', () => {
  it('are separate choices, heard by whisper as the same language', () => {
    expect(isLang('zh-TW')).toBe(true)
    expect(isLang('zh-CN')).toBe(true)
    expect(langName('zh-TW')).toBe('繁體中文')
    expect(langName('zh-CN')).toBe('简体中文')
    expect(whisperLanguage('zh-TW')).toBe('zh')
    expect(whisperLanguage('zh-CN')).toBe('zh')
  })

  it('rewrites a mix into traditional characters, leaving other text alone', () => {
    const t = scriptFor('zh-TW')!
    expect(t('我们在讨论这个问题，還有 Sounding 的設計。')).toBe('我們在討論這個問題，還有 Sounding 的設計。')
  })

  it('rewrites a mix into simplified characters', () => {
    const s = scriptFor('zh-CN')!
    expect(s('我們在討論这个問題')).toBe('我们在讨论这个问题')
  })

  it('keeps the words that were said: characters change, vocabulary does not', () => {
    expect(scriptFor('zh-TW')!('软件')).toBe('軟件')
    expect(scriptFor('zh-CN')!('軟體')).toBe('软体')
  })

  it('leaves every other language untouched', () => {
    expect(scriptFor('en-US')).toBeUndefined()
    expect(scriptFor('ja-JP')).toBeUndefined()
    expect(scriptFor('auto')).toBeUndefined()
  })

  it('the transcriber reports the rewritten text and primes the next utterance with it', async () => {
    const prompts: Array<string | undefined> = []
    const finals: string[] = []
    const tr = new WhisperTranscriber({
      language: 'zh', rewrite: scriptFor('zh-TW'),
      open: async () => async (_pcm, o) => { prompts.push(o.prompt); return '这个问题' },
    })
    await tr.connect({ onInterim: () => {}, onFinal: (t) => finals.push(t), onStatus: () => {} })
    const tone = (ms: number, amp: number) => { const c = new Int16Array((ms / 1000) * 16_000); for (let i = 0; i < c.length; i++) c[i] = i % 2 ? amp : -amp; return c }
    for (let i = 0; i < 2; i++) { tr.sendAudio(tone(500, 4000)); tr.sendAudio(tone(900, 0)) }
    await tr.end()
    expect(finals).toEqual(['這個問題', '這個問題'])
    expect(prompts.at(-1)).toBe('這個問題')
  })
})

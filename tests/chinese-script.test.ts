import { describe, it, expect } from 'vitest'
import { scriptFor, chineseRewrite } from '../src/live/chinese-script'
import { scriptFromBrowser, effectiveScript } from '../src/live/script-pref'
import { Prefs } from '../src/own/prefs'
import { chineseRewriteFor } from '../src/own/host'
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

describe('Chinese heard while another language is listened for', () => {
  it('follows the listener\'s choice of characters, and leaves other text alone', () => {
    const t = chineseRewrite('traditional')!
    expect(t('我们去吃东西吧')).toBe('我們去吃東西吧')
    expect(t('we should rebuild the harbor wall')).toBe('we should rebuild the harbor wall')
    expect(t('I said 吃东西 to her')).toBe('I said 吃東西 to her')
    expect(chineseRewrite('simplified')!('我們去吃東西吧')).toBe('我们去吃东西吧')
    expect(chineseRewrite('heard')).toBeUndefined()
  })
  it('leaves Japanese as it is, told apart by its kana', () => {
    expect(chineseRewrite('traditional')!('東京の大学に行きます')).toBe('東京の大学に行きます')
  })
  it('lets a Chinese listening language decide, and the choice decide otherwise', () => {
    expect(scriptFor('en-US', 'traditional')!('吃东西')).toBe('吃東西')
    expect(scriptFor('auto', 'simplified')!('吃東西')).toBe('吃东西')
    expect(scriptFor('zh-CN', 'traditional')!('吃東西')).toBe('吃东西')
    expect(scriptFor('en-US')).toBeUndefined()
  })
})

describe('the default characters', () => {
  it('follow the browser\'s language', () => {
    expect(['zh-TW', 'zh-Hant', 'zh-HK', 'zh-MO', 'zh-Hant-TW'].map(scriptFromBrowser)).toEqual(Array(5).fill('traditional'))
    expect(['zh-CN', 'zh', 'zh-SG', 'zh-Hans'].map(scriptFromBrowser)).toEqual(Array(4).fill('simplified'))
    expect(['en-US', 'ja-JP', ''].map(scriptFromBrowser)).toEqual(Array(3).fill('heard'))
    expect(effectiveScript('zh-TW', 'simplified')).toBe('traditional')
    expect(effectiveScript('en-US', 'simplified')).toBe('simplified')
  })
  it('are kept per browser on the hosted page, and changed from the sheet', async () => {
    const m = new Map<string, string>()
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
    const prefs = new Prefs(kv, 'zh-TW')
    expect(prefs.script()).toBe('traditional')
    prefs.saveScript('heard')
    expect(new Prefs(kv, 'zh-TW').script()).toBe('heard')
    expect(new Prefs(kv).script()).toBe('heard')
    expect(new Prefs({ getItem: () => null, setItem: () => {}, removeItem: () => {} }).script()).toBe('heard')
  })
})

describe('fetching the tables on the hosted page', () => {
  it('waits for Chinese to be heard, then converts from the next text on', async () => {
    let loads = 0
    let ready!: () => void
    const loaded = new Promise<void>((r) => { ready = r })
    const load = async () => { loads++; await loaded; return import('../src/live/chinese-script') }
    const rewrite = (await chineseRewriteFor('traditional', false, load))!
    expect(rewrite('hello there')).toBe('hello there')
    expect(loads).toBe(0)
    expect(rewrite('吃东西')).toBe('吃东西') // heard before the tables are in: stays as heard
    expect(rewrite('吃东西')).toBe('吃东西')
    expect(loads).toBe(1)
    ready()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(rewrite('吃东西')).toBe('吃東西')
    expect(await chineseRewriteFor('heard', false, load)).toBeUndefined()
    expect((await chineseRewriteFor('simplified', true))!('吃東西')).toBe('吃东西')
  })
})

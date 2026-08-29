import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCastArgs, loadOrTranscribe } from '../src/cli/cast'
import type { FixtureScript } from '../src/replay/fixture'

describe('parseCastArgs', () => {
  it('parses positional audio path and interpreter flag', () => {
    expect(parseCastArgs(['recordings/memo.m4a', '-i', 'claude'])).toEqual({
      audioPath: 'recordings/memo.m4a',
      interpreter: 'claude',
      modelPath: 'models/ggml-large-v3-turbo.bin',
      threshold: undefined,
    })
  })
  it('accepts overrides', () => {
    const a = parseCastArgs(['x.m4a', '-i', 'gemini', '--model-path', 'models/ggml-base.bin', '--threshold', '0.55'])
    expect(a.modelPath).toBe('models/ggml-base.bin')
    expect(a.threshold).toBe(0.55)
  })
  it('rejects unknown interpreters and missing args', () => {
    expect(() => parseCastArgs(['x.m4a', '-i', 'gpt'])).toThrow(/interpreter/)
    expect(() => parseCastArgs([])).toThrow(/usage/i)
  })
})

describe('loadOrTranscribe', () => {
  const script: FixtureScript = { name: 'memo', description: 'd', endT: 5000, segments: [{ startT: 0, endT: 4000, text: 'hello' }], truth: {} }

  it('caches the transcript next to the recording and reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cast-'))
    const audio = join(dir, 'memo.m4a')
    writeFileSync(audio, 'fake-audio')
    let calls = 0
    const fake = async () => {
      calls += 1
      return script
    }
    const first = await loadOrTranscribe(audio, 'model.bin', fake)
    expect(first.segments).toEqual(script.segments)
    expect(existsSync(join(dir, 'memo.transcript.json'))).toBe(true)
    const second = await loadOrTranscribe(audio, 'model.bin', fake)
    expect(second.segments).toEqual(script.segments)
    expect(calls).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'memo.transcript.json'), 'utf8')).name).toBe('memo')
  })
})

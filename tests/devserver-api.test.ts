import { describe, it, expect } from 'vitest'
import { castArgv, soundingDevApi } from '../src/devserver/api'

describe('castArgv', () => {
  it('runs the cast CLI through tsx with the recording path and interpreter', () => {
    expect(castArgv('mic-20260905-113007', 'gemini')).toEqual([
      'tsx', 'src/cli/cast.ts', 'recordings/mic-20260905-113007.m4a', '-i', 'gemini',
    ])
  })
})

describe('soundingDevApi', () => {
  it('is a dev-only Vite plugin', () => {
    const p = soundingDevApi()
    expect(p.name).toBe('sounding-dev-api')
    expect(p.apply).toBe('serve')
    expect(typeof p.configureServer).toBe('function')
  })
})

import { describe, it, expect } from 'vitest'
import {
  isValidRecordingName,
  isInterpreterName,
  recordingPath,
  soundingPath,
  stampName,
  uniqueName,
} from '../src/devserver/paths'

describe('isValidRecordingName', () => {
  it('accepts stamp-style and plain names', () => {
    expect(isValidRecordingName('mic-20260905-113000')).toBe(true)
    expect(isValidRecordingName('synthetic-memo')).toBe(true)
    expect(isValidRecordingName('a')).toBe(true)
  })
  it('rejects traversal, separators, leading dots, empty, non-strings, over-long', () => {
    expect(isValidRecordingName('../x')).toBe(false)
    expect(isValidRecordingName('a/b')).toBe(false)
    expect(isValidRecordingName('a\\b')).toBe(false)
    expect(isValidRecordingName('.hidden')).toBe(false)
    expect(isValidRecordingName('a..b')).toBe(false)
    expect(isValidRecordingName('')).toBe(false)
    expect(isValidRecordingName(undefined)).toBe(false)
    expect(isValidRecordingName(42)).toBe(false)
    expect(isValidRecordingName('a'.repeat(82))).toBe(false)
  })
})

describe('isInterpreterName', () => {
  it('accepts the three interpreters and nothing else', () => {
    expect(isInterpreterName('gemini')).toBe(true)
    expect(isInterpreterName('claude')).toBe(true)
    expect(isInterpreterName('recurrence')).toBe(true)
    expect(isInterpreterName('whisper')).toBe(false)
    expect(isInterpreterName('')).toBe(false)
    expect(isInterpreterName(null)).toBe(false)
  })
})

describe('path builders', () => {
  it('build relative paths inside recordings/ and soundings/', () => {
    expect(recordingPath('mic-1')).toBe('recordings/mic-1.m4a')
    expect(soundingPath('mic-1', 'gemini')).toBe('soundings/mic-1.gemini.jsonl')
  })
})

describe('stampName', () => {
  it('formats local time as mic-YYYYMMDD-HHmmss', () => {
    const d = new Date(2026, 8, 5, 11, 30, 7) // local: 2026-09-05 11:30:07
    expect(stampName(d)).toBe('mic-20260905-113007')
  })
})

describe('uniqueName', () => {
  it('returns the base name when it does not exist', () => {
    expect(uniqueName('mic-1', () => false)).toBe('mic-1')
  })
  it('appends -2, -3, … until a free name is found', () => {
    const taken = new Set(['mic-1', 'mic-1-2'])
    expect(uniqueName('mic-1', (n) => taken.has(n))).toBe('mic-1-3')
  })
})

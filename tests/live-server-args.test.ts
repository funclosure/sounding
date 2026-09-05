import { describe, it, expect } from 'vitest'
import { parseArgs, isAllowedOrigin } from '../src/live/server'

describe('parseArgs', () => {
  it('accepts -i gemini --port 8787', () => {
    const a = parseArgs(['-i', 'gemini', '--port', '8787'])
    expect(a.interpreter).toBe('gemini')
    expect(a.port).toBe(8787)
  })

  it('rejects --headless without a source', () => {
    expect(() => parseArgs(['--headless'])).toThrow()
  })

  it('rejects --fixture without --fake-transcriber', () => {
    expect(() => parseArgs(['--fixture', 'circling'])).toThrow()
  })

  it('rejects --from with --fixture', () => {
    expect(() => parseArgs(['--from', 'a.m4a', '--fixture', 'circling', '--fake-transcriber'])).toThrow()
  })

  it('rejects --speed without --fake-transcriber', () => {
    expect(() => parseArgs(['--speed', '2'])).toThrow()
  })

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow()
  })

  it('defaults lang to en-US', () => {
    const a = parseArgs([])
    expect(a.lang).toBe('en-US')
  })

  it('accepts --lang <code>', () => {
    const a = parseArgs(['--lang', 'fr-FR'])
    expect(a.lang).toBe('fr-FR')
  })

  it('accepts --lang auto', () => {
    const a = parseArgs(['--lang', 'auto'])
    expect(a.lang).toBe('auto')
  })

  it('rejects --lang without a value', () => {
    expect(() => parseArgs(['--lang'])).toThrow()
  })
})

describe('isAllowedOrigin', () => {
  it('allows localhost and 127.0.0.1 origins, with or without a port', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isAllowedOrigin('http://localhost')).toBe(true)
  })

  it('rejects a missing origin, other hosts, and lookalike hosts', () => {
    expect(isAllowedOrigin(undefined)).toBe(false)
    expect(isAllowedOrigin('https://evil.example')).toBe(false)
    expect(isAllowedOrigin('http://localhost.evil.example')).toBe(false)
    expect(isAllowedOrigin('http://localhost:5173.evil')).toBe(false)
  })
})

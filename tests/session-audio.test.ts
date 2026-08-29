import { describe, it, expect } from 'vitest'
import { SoundingSession } from '../src/core/session'
import { ReadingDynamics } from '../src/salience/dynamics'
import { DEFAULT_SALIENCE_CONFIG } from '../src/salience/config'
import { TokenIdentityResolver } from '../src/salience/identity'
import type { AudioSegment, Interpreter, InterpreterInput, InterpretationResult } from '../src/interpret/port'

class RecordingAudioInterpreter implements Interpreter {
  readonly id = 'audio-recorder'
  readonly input = 'audio' as const
  received: InterpreterInput[] = []
  async interpret(input: InterpreterInput): Promise<InterpretationResult> {
    this.received.push(input)
    return { candidates: [], costUsd: 0, latencyMs: 0 }
  }
}

const seg = { segmentId: 'seg1', transcript: 'hello there', startT: 0, endT: 4000 }

function make(interpreter: Interpreter, audioSource?: ConstructorParameters<typeof SoundingSession>[4]) {
  const config = DEFAULT_SALIENCE_CONFIG
  const dynamics = new ReadingDynamics(new TokenIdentityResolver(), config)
  const s = new SoundingSession(interpreter, dynamics, config, 'audio-test', audioSource)
  s.drop()
  return s
}

describe('audioSource dispatch', () => {
  it('hands an audio interpreter the AudioSegment from audioSource', async () => {
    const interp = new RecordingAudioInterpreter()
    const window: AudioSegment = { kind: 'audio', segmentId: 'seg1', mimeType: 'audio/mpeg', data: new Uint8Array([1, 2, 3]), startT: 0, endT: 4000 }
    const s = make(interp, async (req) => {
      expect(req).toEqual({ segmentId: 'seg1', startT: 0, endT: 4000 })
      return window
    })
    await s.feedCommitted(4000, seg)
    expect(interp.received).toEqual([window])
  })

  it('throws a clear error when an audio interpreter has no audioSource', async () => {
    const s = make(new RecordingAudioInterpreter())
    await expect(s.feedCommitted(4000, seg)).rejects.toThrow(/no audioSource/)
  })
})

import type { ConceptCandidate, Ms } from '../core/types'

/**
 * Interpretation hints riding on a port input. Neither field carries
 * evidence for the reading on its own — they steer transcription/labelling
 * only. Never fed into ReadingDynamics directly.
 */
export interface InterpretationHints {
  context?: string
  follow?: string
}

export interface Transcript {
  kind: 'transcript'
  segmentId: string
  text: string
  startT: Ms
  endT: Ms
  hints?: InterpretationHints
}

export interface AudioSegment {
  kind: 'audio'
  segmentId: string
  mimeType: string      // e.g. 'audio/mpeg'
  data: Uint8Array      // encoded bytes of the audio window
  startT: Ms
  endT: Ms
  hints?: InterpretationHints
}

/**
 * The port. Input stays (AudioSegment | Transcript) even while only
 * transcripts flow through it — collapsing the union would weld shut the
 * audio-native question (see BRIEF.md, Unresolved).
 */
export type InterpreterInput = AudioSegment | Transcript

export interface InterpretationResult {
  candidates: ConceptCandidate[]
  costUsd: number
  latencyMs: number
}

export interface Interpreter {
  readonly id: string
  readonly input: 'transcript' | 'audio'
  interpret(input: InterpreterInput): Promise<InterpretationResult>
}

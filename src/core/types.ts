/** Session-relative milliseconds from drop. The engine never sees wall clock. */
export type Ms = number

/** What an interpreter proposes from one segment. Stateless; salience owns identity. */
export interface ConceptCandidate {
  label: string
  strength: number // 0-1, how strongly this segment supports the concept
  confidence: number // 0-1, how sure the interpreter is this is real (floor gate)
  source: string // interpreter id
  segmentId: string
}

/** A concept the reading tracks (surfaced or not). */
export interface Concept {
  id: string
  label: string
  weight: number // decayed accumulation of support
  confidence: number // max confidence ever seen
  firstSeenT: Ms
  lastSupportT: Ms
  /** Earlier labels of a renamed (or merged-in) concept. Identity still matches them, so the next mishearing lands here. */
  aliases?: string[]
  /** The speaker dismissed it: never surfaces, and candidates that resolve to it are dropped. */
  dismissed?: boolean
}

/** One mark on the chart. prominence is field-relative (sums to 1 across marks). */
export interface Mark {
  conceptId: string
  label: string
  prominence: number
  weight: number // raw decayed weight, for the inspector and decay assertions
}

/** The on-screen state of a sounding. slack = extended silence. */
export interface Reading {
  t: Ms
  slack: boolean
  marks: Mark[] // length <= capacity K, sorted by prominence desc
}

export type Transition =
  | { kind: 'appeared'; conceptId: string; label: string }
  | { kind: 'nudged'; conceptId: string; delta: number }
  | { kind: 'displaced'; conceptId: string; label: string; byConceptId: string }
  // a rename whose new label is another concept's: `from` is absorbed into `into`
  | { kind: 'merged'; fromConceptId: string; intoConceptId: string }
  | { kind: 'dismissed'; conceptId: string; label: string }
  | { kind: 'restored'; conceptId: string; label: string }
  | { kind: 'renamed'; conceptId: string; from: string; to: string }

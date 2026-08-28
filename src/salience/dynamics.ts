import type { Concept, ConceptCandidate, Ms, Reading, Transition } from '../core/types'
import type { IdentityResolver } from './identity'
import type { SalienceConfig } from './config'

/**
 * The app. Owns promotion and demotion under contention: decay, fixed
 * capacity, confidence floor, hysteresis (Task 7), fast-loop nudges (Task 7).
 * Pure function of the event stream — advances only via the timestamps it is
 * handed, never wall clock.
 */
export class ReadingDynamics {
  private concepts = new Map<string, Concept>()
  private surfaced: string[] = []
  private streaks = new Map<string, number>() // challenger conceptId -> consecutive qualifying ticks
  private pendingTransitions: Transition[] = []
  private lastT: Ms = 0
  private lastSpeechT: Ms = 0
  private nextConceptSeq = 1

  constructor(
    private readonly resolver: IdentityResolver,
    private readonly config: SalienceConfig,
  ) {}

  applyCandidates(t: Ms, candidates: ConceptCandidate[]): void {
    this.decayTo(t)
    this.lastSpeechT = t
    for (const cand of candidates) {
      const support = cand.strength * cand.confidence
      const existingId = this.resolver.resolve(cand, [...this.concepts.values()])
      if (existingId !== null) {
        const c = this.concepts.get(existingId)!
        c.weight += support
        c.confidence = Math.max(c.confidence, cand.confidence)
        c.lastSupportT = t
      } else {
        const id = `c${this.nextConceptSeq++}`
        this.concepts.set(id, {
          id, label: cand.label, weight: support,
          confidence: cand.confidence, firstSeenT: t, lastSupportT: t,
        })
      }
    }
  }

  nudge(_t: Ms, _pendingText: string): void {
    // fast-loop weight nudges — implemented in the hysteresis/nudge task
  }

  tick(t: Ms): { transitions: Transition[]; reading: Reading } {
    this.decayTo(t)
    const transitions = this.pendingTransitions
    this.pendingTransitions = []

    const surfacedSet = new Set(this.surfaced)
    const eligible = [...this.concepts.values()]
      .filter((c) => c.confidence >= this.config.confidenceFloor)
      .sort((a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : 1))

    // Fill free slots — appearing into an empty slot needs no hysteresis.
    for (const c of eligible) {
      if (this.surfaced.length >= this.config.capacity) break
      if (!surfacedSet.has(c.id)) {
        this.surfaced.push(c.id)
        surfacedSet.add(c.id)
        transitions.push({ kind: 'appeared', conceptId: c.id, label: c.label })
      }
    }

    this.contest(transitions, eligible, surfacedSet)

    const surfacedConcepts = this.surfaced.map((id) => this.concepts.get(id)!)
    const total = surfacedConcepts.reduce((s, c) => s + c.weight, 0) || 1
    const marks = surfacedConcepts
      .map((c) => ({ conceptId: c.id, label: c.label, prominence: c.weight / total, weight: c.weight }))
      .sort((a, b) => (b.prominence - a.prominence) || (a.conceptId < b.conceptId ? -1 : 1))

    return {
      transitions,
      reading: { t, slack: t - this.lastSpeechT > this.config.slackAfterMs, marks },
    }
  }

  private contest(_transitions: Transition[], _eligible: Concept[], _surfacedSet: Set<string>): void {
    // displacement under contention with hysteresis — implemented in Task 7
  }

  private decayTo(t: Ms): void {
    const dt = t - this.lastT
    if (dt <= 0) return
    const factor = Math.pow(2, -dt / this.config.halfLifeMs)
    for (const c of this.concepts.values()) c.weight *= factor
    this.lastT = t
  }
}

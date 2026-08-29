import type { Concept, ConceptCandidate, Ms, Reading, Transition } from '../core/types'
import type { IdentityResolver } from './identity'
import type { SalienceConfig } from './config'
import { tokenize } from '../core/text'

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

  async applyCandidates(t: Ms, candidates: ConceptCandidate[]): Promise<void> {
    this.decayTo(t)
    this.lastSpeechT = t
    for (const cand of candidates) {
      const support = cand.strength * cand.confidence
      const existingId = await this.resolver.resolve(cand, [...this.concepts.values()])
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

  nudge(t: Ms, pendingText: string): void {
    this.decayTo(t)
    this.lastSpeechT = t
    const pendingTokens = new Set(tokenize(pendingText))
    for (const id of this.surfaced) {
      const c = this.concepts.get(id)!
      // Fast-loop identity shares the slow loop's normalization: tokenize the
      // label (normalization + stopword removal) and fire on ANY overlap, so
      // natural-language labels from model interpreters keep the fast loop alive.
      const labelTokens = tokenize(c.label)
      if (labelTokens.length > 0 && labelTokens.some((tok) => pendingTokens.has(tok))) {
        c.weight += this.config.nudgeFactor
        this.pendingTransitions.push({ kind: 'nudged', conceptId: id, delta: this.config.nudgeFactor })
      }
    }
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

  private contest(transitions: Transition[], eligible: Concept[], surfacedSet: Set<string>): void {
    if (this.surfaced.length < this.config.capacity) return
    const incumbents = this.surfaced
      .map((id) => this.concepts.get(id)!)
      .sort((a, b) => (a.weight - b.weight) || (a.id < b.id ? -1 : 1))
    const weakest = incumbents[0]
    const bar = weakest.weight * (1 + this.config.hysteresisMargin)

    const challengers = eligible.filter((c) => !surfacedSet.has(c.id))
    for (const ch of challengers) {
      if (ch.weight > bar) {
        this.streaks.set(ch.id, (this.streaks.get(ch.id) ?? 0) + 1)
      } else {
        this.streaks.delete(ch.id)
      }
    }
    for (const id of [...this.streaks.keys()]) {
      if (!this.concepts.has(id) || surfacedSet.has(id)) this.streaks.delete(id)
    }

    // One displacement per tick: the strongest challenger with a full streak.
    // (challengers is already sorted by weight desc — it derives from eligible.)
    const ready = challengers.find((ch) => (this.streaks.get(ch.id) ?? 0) >= this.config.hysteresisTicks)
    if (ready) {
      this.surfaced = this.surfaced.filter((id) => id !== weakest.id)
      this.surfaced.push(ready.id)
      surfacedSet.delete(weakest.id)
      surfacedSet.add(ready.id)
      this.streaks.delete(ready.id)
      transitions.push({ kind: 'displaced', conceptId: weakest.id, label: weakest.label, byConceptId: ready.id })
      transitions.push({ kind: 'appeared', conceptId: ready.id, label: ready.label })
    }
  }

  private decayTo(t: Ms): void {
    const dt = t - this.lastT
    if (dt <= 0) return
    const factor = Math.pow(2, -dt / this.config.halfLifeMs)
    for (const c of this.concepts.values()) c.weight *= factor
    this.lastT = t
  }
}

import type { ConceptCandidate } from '../core/types'

const MAX_CANDIDATES = 8

const clamp01 = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** Defensive mapping from a model's JSON payload to ConceptCandidate[]. */
export function mapCandidates(parsed: unknown, source: string, segmentId: string): ConceptCandidate[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const raw = (parsed as { candidates?: unknown }).candidates
  if (!Array.isArray(raw)) return []
  const out: ConceptCandidate[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const label = String((item as { label?: unknown }).label ?? '').trim()
    if (label.length === 0) continue
    out.push({
      label,
      strength: clamp01((item as { strength?: unknown }).strength),
      confidence: clamp01((item as { confidence?: unknown }).confidence),
      source,
      segmentId,
    })
    if (out.length === MAX_CANDIDATES) break
  }
  return out
}

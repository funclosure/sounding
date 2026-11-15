// Per-provider pricing. The insurance from BRIEF.md: when the reading feels
// right, we know whether it cost 3c/min or 30c/min.
export interface LlmPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok?: number
  cacheReadPerMTok?: number
}

export const PRICING: Record<string, LlmPricing> = {
  // Anthropic first-party rates (verified 2026-08 via claude-api skill)
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  // From the claude-api reference, 2026-11: Sonnet 5.5 $2 / $10 with cache reads at $0.10; Haiku 5.5 $0.10 / $0.50
  // for prompts of 100K tokens or fewer, which every call here is. Cache-write rates are left to fall back to input.
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  // Verified 2026-08-29 against ai.google.dev/gemini-api/docs/pricing (Task 14
  // Step 1). gemini-3.7-flash is the current flagship flash-tier model and is
  // the one used throughout the official audio-understanding guide. Unlike
  // some preview/lite Gemini tiers (e.g. gemini-3-flash-preview: $1.00/MTok
  // audio input vs $0.50 text), 3.7-flash's pricing page lists ONE input rate
  // covering "text / image / video / audio" — no audio surcharge — so no
  // separate audio rate is modeled here. Standard-tier, paid rates shown are
  // promotional through 2026-12-31 (input $0.75->$1.50, output $3.75->$7.50
  // from 2027-01-01); using the current rate is the reasonable approximation
  // since llmCost has no time dimension. cacheWritePerMTok is left unset so
  // llmCost falls back to inputPerMTok — Gemini bills a first-time cache
  // write at the normal input rate, then a separate per-hour storage fee
  // (not modeled; llmCost only accounts for per-token read/write costs).
  // cacheReadPerMTok is the documented "context caching price".
  'gemini-3.7-flash': { inputPerMTok: 0.75, outputPerMTok: 3.75, cacheReadPerMTok: 0.075 },
}

export function llmCost(
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number },
): number {
  const p = PRICING[model]
  if (!p) throw new Error(`no pricing entry for model ${model} — add it to src/providers/pricing.ts`)
  return (
    (u.inputTokens * p.inputPerMTok +
      u.outputTokens * p.outputPerMTok +
      (u.cacheWriteTokens ?? 0) * (p.cacheWritePerMTok ?? p.inputPerMTok) +
      (u.cacheReadTokens ?? 0) * (p.cacheReadPerMTok ?? p.inputPerMTok)) /
    1_000_000
  )
}

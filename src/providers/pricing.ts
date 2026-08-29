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
  // UPDATE-ME: verify the current Gemini model id and audio-input pricing at
  // ai.google.dev/pricing when wiring Task 14 — values below are placeholders
  // from pre-cutoff knowledge and MUST be checked.
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
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

// Shared prompt block for interpretation hints (context brought before
// talking; a mark being followed; labels the speaker corrected or dismissed). Neither hint is evidence for a reading —
// the block text says so explicitly so the model doesn't inflate strength
// for things that only appear here.
import type { InterpretationHints } from '../interpret/port'

const MAX_CONTEXT = 1200

export function hintBlock(h: InterpretationHints | undefined): string {
  if (!h) return ''
  const parts: string[] = []
  if (h.context && h.context.trim()) {
    const c = h.context.trim()
    parts.push(`Context the speaker brought before talking. Names and terms here are likely to recur: use their exact spelling as labels. This context is NOT evidence of anything said — never report a concept only because it appears here.\n${c.length > MAX_CONTEXT ? c.slice(0, MAX_CONTEXT) + '…' : c}`)
  }
  if (h.follow && h.follow.trim()) parts.push(`The speaker is following "${h.follow.trim()}". If the talk touches it, report it and its evidence attentively. Do not invent support for it.`)
  if (h.corrections?.length) {
    parts.push(`The speaker corrected these labels. Where the talk means the same thing, use the corrected label, even if it sounds like the old one:\n${h.corrections.map((c) => `- "${c.from}" → "${c.to}"`).join('\n')}`)
  }
  if (h.dismissed?.length) {
    parts.push(`The speaker dismissed these as wrong. Do not report them or close variants:\n${h.dismissed.map((d) => `- "${d}"`).join('\n')}`)
  }
  return parts.join('\n\n')
}

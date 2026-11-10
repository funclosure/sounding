// What a sounding can lead to once it has ended: another reading of the same
// talk, a note to keep, or the next sounding carried on from this one.
// Pure — no DOM, no clock.

/** A reading: a named instruction for the wrap. `heard` has none of its own — it is whatever the speaker's saved instructions say. */
export interface Lens { key: string; label: string; says: string; prompt: string }

export const LENSES: readonly Lens[] = [
  { key: 'heard', label: 'what I heard', says: 'The summary you started with.', prompt: '' },
  {
    key: 'avoided', label: 'what I stepped around', says: 'What you came close to and did not say.',
    prompt: `Tell me what I stepped around, speaking to me as "you".
One sentence first: the thing I came close to and did not say.
Then at most three bullets, one line each: what I listed without weighing, what I quoted without answering, what I mentioned once and left.
Only from what I said. No preamble, no advice. 80 words at most.`,
  },
  {
    key: 'question', label: 'ask me a question', says: 'One question, from your own words, to answer next.',
    prompt: `Ask me one question, speaking to me as "you": the one my own words point at and I did not answer.
One sentence, nothing else. No preamble, no advice.`,
  },
  {
    key: 'next', label: 'what next', says: 'Only the moves you named yourself.',
    prompt: `Tell me what I could do next, speaking to me as "you".
One sentence first: whether I decided anything.
Then at most three bullets, one line each: only the moves I named myself.
No advice of your own. 60 words at most.`,
  },
]

export const CARRY_MAX_MARKS = 6
const CONTEXT_MAX_CHARS = 4000

/** The context the next sounding starts from: what stood out, what was said back, a question to answer, and whatever the speaker had brought themselves. */
export function carryContext(c: { marks: readonly string[]; wrap?: string; question?: string; brought?: string }): string {
  const parts: string[] = []
  if (c.question?.trim()) parts.push(`The question I am answering now:\n${c.question.trim()}`)
  if (c.marks.length) parts.push(`What stood out in my last sounding:\n${c.marks.map((m) => `- ${m}`).join('\n')}`)
  if (c.wrap?.trim()) parts.push(`What was said back to me:\n${c.wrap.trim()}`)
  if (c.brought?.trim()) parts.push(c.brought.trim())
  return parts.join('\n\n').slice(0, CONTEXT_MAX_CHARS)
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

/**
 * Which carried mark a newly heard label is a return to, or -1. The same
 * words in any case; one phrase inside the other; or a shared word long
 * enough to mean something ("stalling" ↔ "stalling again").
 */
export function matchCarried(label: string, carried: readonly string[]): number {
  const l = norm(label)
  if (!l) return -1
  const exact = carried.findIndex((c) => norm(c) === l)
  if (exact >= 0) return exact
  const within = carried.findIndex((c) => { const n = norm(c); return !!n && (n.includes(l) || l.includes(n)) })
  if (within >= 0) return within
  const words = new Set(l.split(' ').filter((w) => w.length > 4))
  return carried.findIndex((c) => norm(c).split(' ').some((w) => words.has(w)))
}

/** The sounding as a note: the words that stood out, then what was said back. Markdown, to paste anywhere. */
export function soundingNote(n: { title: string; marks: readonly string[]; wrap: string }): string {
  const parts = [`# ${n.title}`]
  if (n.marks.length) parts.push(n.marks.map((m) => `- ${m}`).join('\n'))
  if (n.wrap.trim()) parts.push(n.wrap.trim())
  return parts.join('\n\n') + '\n'
}

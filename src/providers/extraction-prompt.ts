// What Claude is asked when it finds the marks: the system prompt, the shape of
// the answer and the user turn. Kept apart from the interpreters so the page and
// the friends' relay (src/relay) can use them without the SDK or Node.
import { hintBlock } from './hints'
import type { InterpretationHints } from '../interpret/port'

export const SYSTEM_PROMPT = `You listen to a person thinking aloud and report concept candidates — the things this stretch of talk is actually about or keeps returning to.

Guidance:
- Prefer what recurs or carries weight over what merely sounds like a topic. A named person, a specific memory, a repeated image, or an unresolved worry beats a tidy abstract noun. If someone talking through a job decision keeps mentioning their sister, "sister" is a candidate even though it isn't the "topic".
- Do not report discourse or framing — "what I'm thinking", "this afternoon", "let me talk about", time-of-day, or the act of talking itself, the language being spoken, or whether the listener understands it. Report only the content being thought about.
- Labels are short (1-4 words), in the speaker's own vocabulary where possible.
- Write each label in the language and script the speaker is using. Chinese talk gets Chinese labels, in the same characters (traditional or simplified) as the talk; never translate a label into English. A name or term said in another language stays as it was said.
- strength (0 to 1): how strongly THIS window of talk supports the concept — recurrence, centrality, emphasis.
- confidence (0 to 1): how sure you are the concept is real and correctly labeled. Be honest: a missing candidate costs less than a wrong one.
- Return 0-8 candidates. Fewer, stronger candidates beat padding. Returning zero is fine for filler.`

export const CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          strength: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['label', 'strength', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const

export function buildUserPrompt(window: string[], hints?: InterpretationHints): string {
  const prior = window.slice(0, -1)
  const current = window.at(-1) ?? ''
  const base = `Recent talk (oldest first):\n${prior.join('\n')}\n\nNewest segment (interpret it in the context of the above):\n${current}`
  const block = hintBlock(hints)
  return block ? `${base}\n\n${block}` : base
}

// The setup sheet's wording: each fact the server reports, as a name and a plain line. Pure.
import type { Setup } from '../live/setup'

export function setupLines(s: Setup): Array<[string, string]> {
  const hears = s.transcriber === 'whisper' ? `Whisper${s.hearsModel ? ` (${s.hearsModel})` : ''}, on the machine itself. Your voice does not leave it.`
    : s.transcriber === 'gemini' ? 'Gemini, through the paid API.'
    : s.transcriber
  const thinks = s.interpreter === 'claude-sub' ? `Claude${s.thinksModel ? ` (${s.thinksModel})` : ''}, on your subscription.`
    : s.interpreter === 'claude' ? 'Claude, through the paid API.'
    : s.interpreter === 'gemini' ? 'Gemini, through the paid API. It listens to the sound itself.'
    : s.interpreter === 'recurrence' ? 'No model: the words you repeat.'
    : s.interpreter
  const wrap = s.interpreter === 'recurrence' ? 'Not written with this setup.'
    : `Claude, on your subscription, from ${s.ownInstructions ? 'your own instructions' : 'the default instructions'}.`
  return [
    ['hears with', hears],
    ['understands with', thinks],
    ['the wrap', wrap],
    ['language', s.lang],
    ['paid API', s.api ? 'Allowed. A paid provider can be started.' : 'Off. Nothing here can spend money.'],
  ]
}

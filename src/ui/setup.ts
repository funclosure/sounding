// The setup sheet's wording: each fact the server reports, as a name and a plain line. Pure.
import type { Setup } from '../live/setup'
import { langName } from '../live/langs'
import { w } from './words'

/** Each row: its name, its line, and (for the two that can be changed here) what tapping it opens. */
export function setupLines(s: Setup): Array<[string, string, ('instructions' | 'lang')?]> {
  const model = (m: string | null) => ({ model: m ? ` (${m})` : '' })
  const hears = s.transcriber === 'whisper' ? w('setup.whisper', model(s.hearsModel))
    : s.transcriber === 'gemini' ? w('setup.geminiHears')
    : s.transcriber
  const thinks = s.interpreter === 'claude-sub' ? w('setup.claudeSub', model(s.thinksModel))
    : s.interpreter === 'claude' ? w('setup.claudeApi')
    : s.interpreter === 'gemini' ? w('setup.geminiThinks')
    : s.interpreter === 'recurrence' ? w('setup.recurrence')
    : s.interpreter
  const wrap = s.interpreter === 'recurrence' ? w('setup.noWrap') : w(s.ownInstructions ? 'setup.wrapOwn' : 'setup.wrapDefault')
  return [
    [w('setup.hears'), hears],
    [w('setup.thinks'), thinks],
    [w('setup.wrap'), wrap, 'instructions'],
    [w('setup.language'), s.lang === 'auto' ? w('lang.auto.name') : langName(s.lang), 'lang'],
    [w('setup.api'), w(s.api ? 'setup.apiOn' : 'setup.apiOff')],
  ]
}

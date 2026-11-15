// The setup sheet's wording: each fact the server reports, as a name and a plain line. Pure.
import type { Setup } from '../live/setup'
import { langName } from '../live/langs'
import { w, isWord } from './words'

/** Each row: its name, its line, and (for the two that can be changed here) what tapping it opens. */
export type SetupPane = 'instructions' | 'lang' | 'keys' | 'model'
export function setupLines(s: Setup): Array<[string, string, SetupPane?]> {
  const model = (m: string | null) => ({ model: m ? ` (${m})` : '' })
  // The own-keys build: every row says whose key pays and where the sound and the words go.
  if (s.own) {
    const modelKey = `model.${s.thinksModel}`
    return [
      [w('setup.keys'), s.own.keys ? w('setup.keysIn', { claude: s.own.claudeHint, eleven: s.own.elevenHint }) : w('setup.keysMissing'), 'keys'],
      [w('setup.hears'), w('setup.ownHears')],
      [w('setup.thinks'), w('setup.ownThinks', { model: isWord(modelKey) ? w(modelKey) : (s.thinksModel ?? '') }), 'model'],
      [w('setup.wrap'), w(s.ownInstructions ? 'setup.ownWrapOwn' : 'setup.ownWrapDefault'), 'instructions'],
      [w('setup.language'), s.lang === 'auto' ? w('lang.auto.name') : langName(s.lang), 'lang'],
      [w('setup.kept'), w('setup.ownKept')],
    ]
  }
  const hears = s.transcriber === 'whisper' ? w('setup.whisper', model(s.hearsModel))
    : s.transcriber === 'gemini' ? w('setup.geminiHears')
    : s.transcriber === 'elevenlabs' ? w('setup.elevenHears')
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

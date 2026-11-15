// The setup sheet's wording: each fact the server reports, as a name and a plain line. Pure.
import type { Setup } from '../live/setup'
import { langName } from '../live/langs'
import { w, isWord, currentTongue, type WordKey } from './words'

/** Each row: its name, its line, and (for the two that can be changed here) what tapping it opens. */
export type SetupPane = 'instructions' | 'lang' | 'keys' | 'model'
export function setupLines(s: Setup): Array<[string, string, SetupPane?]> {
  const model = (m: string | null) => ({ model: m ? ` (${m})` : '' })
  // The own-keys build: every row says whose key pays and where the sound and the words go.
  if (s.own) {
    const modelKey = `model.${s.thinksModel}`
    const modelName = isWord(modelKey) ? w(modelKey) : (s.thinksModel ?? '')
    // A friend on an invite: whose accounts hear and think, and how much is left.
    const inv = s.own.invite
    if (inv && !s.own.keys) {
      const from = inv.from
      const until = new Date(inv.expiresAt).toLocaleDateString(currentTongue() === 'en' ? undefined : currentTongue(), { day: 'numeric', month: 'short' })
      return [
        [w('setup.invite'), inv.state === 'ok' ? w('setup.inviteIn', { from, left: String(inv.minutesLeft), minutes: String(inv.minutes), until }) : w(`invite.${inv.state}` as WordKey, { from })],
        [w('setup.keys'), w('setup.keysInvited'), 'keys'],
        [w('setup.hears'), w('setup.inviteHears', { from })],
        [w('setup.thinks'), w('setup.inviteThinks', { from, model: modelName }), 'model'],
        [w('setup.wrap'), w('setup.inviteWrap', { from }), 'instructions'],
        [w('setup.language'), s.lang === 'auto' ? w('lang.auto.name') : langName(s.lang), 'lang'],
        [w('setup.kept'), w('setup.ownKept')],
      ]
    }
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

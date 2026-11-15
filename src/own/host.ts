// The host for a sounding that runs in the page with the listener's own keys:
// ElevenLabs hears (live text for the screen, the file model for what is
// kept), Claude finds the marks and writes the wrap, and everything kept stays
// in this browser.
import type { LiveHost } from '../live/connection'
import { SoundingEngine } from '../live/engine'
import { Clock } from '../live/clock'
import { WhisperTranscriber } from '../live/whisper-transcriber'
import { elevenFile, ElevenLive } from '../live/elevenlabs'
import { whisperLanguage } from '../live/langs'
import { stampName } from '../devserver/paths'
import { TokenIdentityResolver } from '../salience/identity'
import type { Setup } from '../live/setup'
import { OwnClaudeInterpreter, ownClaude, ownWrap, type CreateMessage } from './claude'
import { browserElevenSocket } from './eleven-socket'
import { relayClaude, relayElevenFile, relayToken } from './invite'
import { keyHint, type Prefs } from './prefs'
import { effectiveScript, isChineseText, type ChineseScript } from '../live/script-pref'
import type { SoundingStore } from './store'

export interface OwnDeps {
  prefs: Prefs
  store: SoundingStore
  /** Stand-ins for tests; the defaults reach the real providers. */
  claude?: (key: string) => CreateMessage
  /** Claude through the friends' relay, for a device with an accepted invite. */
  relayClaude?: (device: string) => CreateMessage
  fetchFn?: typeof fetch
  elevenSocket?: ReturnType<typeof browserElevenSocket>
  now?: () => Date
}

export function ownSetup(prefs: Prefs): Setup {
  const wrap = prefs.wrapPrompt()
  const keys = prefs.keys()
  const inv = prefs.invite()?.invite
  return {
    transcriber: 'elevenlabs', hearsModel: null, interpreter: 'claude', thinksModel: prefs.model(), lang: prefs.lang(), script: prefs.script(), api: true,
    ownInstructions: !wrap.isDefault, instructions: wrap.prompt,
    own: {
      keys: prefs.hasKeys(), claudeHint: keyHint(keys.claude), elevenHint: keyHint(keys.eleven),
      ...(inv ? { invite: { from: inv.from, minutes: inv.minutes, minutesLeft: inv.minutesLeft, expiresAt: inv.expiresAt, state: inv.state } } : {}),
    },
  }
}

/**
 * The rewrite into the listener's characters. The tables are large (1.2 MB): fetched now when Chinese is what is
 * being listened for, and otherwise only when Chinese is first heard. The live text shows it about a second before
 * the utterance is kept, so the tables are usually in by then; anything heard before they arrive stays as heard.
 */
export async function chineseRewriteFor(script: ChineseScript, now: boolean, load = () => import('../live/chinese-script')): Promise<((text: string) => string) | undefined> {
  if (script === 'heard') return undefined
  if (now) return (await load()).chineseRewrite(script)
  let convert: ((text: string) => string) | undefined
  let asked = false
  return (text) => {
    if (convert) return convert(text)
    if (!asked && isChineseText(text)) { asked = true; void load().then((m) => { convert = m.chineseRewrite(script) }, () => { asked = false }) }
    return text
  }
}

export function ownHost(deps: OwnDeps): LiveHost {
  const { prefs, store } = deps
  const claudeFor = deps.claude ?? ownClaude
  const relayFor = deps.relayClaude ?? ((device: string) => relayClaude(device, deps.fetchFn))
  /** Own keys when both are in; otherwise an accepted invite, through the relay. */
  const thinker = (): CreateMessage | null => {
    const k = prefs.keys()
    if (k.claude && k.eleven) return claudeFor(k.claude)
    const inv = prefs.invite()
    return inv ? relayFor(inv.device) : null
  }
  return {
    lang: () => prefs.lang(),
    saveLang: (code) => prefs.saveLang(code),
    script: () => prefs.script(),
    saveScript: (s) => prefs.saveScript(s),
    wrapPrompt: () => prefs.wrapPrompt(),
    saveWrapPrompt: (text) => prefs.saveWrapPrompt(text),
    setup: () => ownSetup(prefs),
    async create(req, lang, send) {
      const keys = prefs.keys()
      const own = !!keys.claude && !!keys.eleven
      const invited = own ? null : prefs.invite()
      if (!own && !invited) throw new Error('both keys are needed before a sounding can start')
      const language = whisperLanguage(lang)
      const rewrite = await chineseRewriteFor(effectiveScript(lang, prefs.script()), lang.startsWith('zh'))
      const live = invited
        ? new ElevenLive(invited.device, language, deps.elevenSocket ?? browserElevenSocket(deps.fetchFn, undefined, relayToken(invited.device, deps.fetchFn)))
        : new ElevenLive(keys.eleven, language, deps.elevenSocket ?? browserElevenSocket(deps.fetchFn))
      const transcriber = new WhisperTranscriber({
        open: async () => (invited ? relayElevenFile(invited.device, deps.fetchFn) : elevenFile(keys.eleven, deps.fetchFn)),
        live,
        opening: 'reaching ElevenLabs', maxUtteranceMs: 8000, language, rewrite,
      })
      const create = thinker()!
      // A refused key ends the sounding with the reason: no mark would ever come, and the listener should know why.
      const interpreter = new OwnClaudeInterpreter(create, prefs.model(), (message) => send({ type: 'live.status', state: 'error', message }))
      const soundingId = `live-${stampName((deps.now ?? (() => new Date()))()).slice(4)}.claude`
      const sounding = new SoundingEngine({
        interpreter, identity: new TokenIdentityResolver(), transcriber, clock: new Clock(), send, soundingId, context: req.context,
        persist: async (id, jsonl) => { const name = `${id}.jsonl`; await store.put(name, jsonl); return name },
      })
      return { sounding, writer: ownWrap(create) }
    },
    writer: () => { const t = thinker(); return t ? ownWrap(t) : null },
    saveWrap: (name, text) => store.setWrap(name, text),
    listEarlier: () => store.list(),
    readEarlier: async (name) => { const k = await store.get(name); return k ? { logPath: name, events: k.events, wrap: k.wrap } : null },
    removeEarlier: (name) => store.remove(name),
    logPathOf: (name) => name,
    error: (line) => console.error(line),
  }
}

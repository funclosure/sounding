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
import { keyHint, type Prefs } from './prefs'
import type { SoundingStore } from './store'

export interface OwnDeps {
  prefs: Prefs
  store: SoundingStore
  /** Stand-ins for tests; the defaults reach the real providers. */
  claude?: (key: string) => CreateMessage
  fetchFn?: typeof fetch
  elevenSocket?: ReturnType<typeof browserElevenSocket>
  now?: () => Date
}

export function ownSetup(prefs: Prefs): Setup {
  const wrap = prefs.wrapPrompt()
  const keys = prefs.keys()
  return {
    transcriber: 'elevenlabs', hearsModel: null, interpreter: 'claude', thinksModel: prefs.model(), lang: prefs.lang(), api: true,
    ownInstructions: !wrap.isDefault, instructions: wrap.prompt,
    own: { keys: prefs.hasKeys(), claudeHint: keyHint(keys.claude), elevenHint: keyHint(keys.eleven) },
  }
}

export function ownHost(deps: OwnDeps): LiveHost {
  const { prefs, store } = deps
  const claudeFor = deps.claude ?? ownClaude
  return {
    lang: () => prefs.lang(),
    saveLang: (code) => prefs.saveLang(code),
    wrapPrompt: () => prefs.wrapPrompt(),
    saveWrapPrompt: (text) => prefs.saveWrapPrompt(text),
    setup: () => ownSetup(prefs),
    async create(req, lang, send) {
      const keys = prefs.keys()
      if (!keys.claude || !keys.eleven) throw new Error('both keys are needed before a sounding can start')
      const language = whisperLanguage(lang)
      // The Chinese script tables are large: fetched only when Chinese is what is being listened for.
      const rewrite = lang.startsWith('zh') ? (await import('../live/chinese-script')).scriptFor(lang) : undefined
      const transcriber = new WhisperTranscriber({
        open: async () => elevenFile(keys.eleven, deps.fetchFn),
        live: new ElevenLive(keys.eleven, language, deps.elevenSocket ?? browserElevenSocket(deps.fetchFn)),
        opening: 'reaching ElevenLabs', maxUtteranceMs: 8000, language, rewrite,
      })
      const create = claudeFor(keys.claude)
      // A refused key ends the sounding with the reason: no mark would ever come, and the listener should know why.
      const interpreter = new OwnClaudeInterpreter(create, prefs.model(), (message) => send({ type: 'live.status', state: 'error', message }))
      const soundingId = `live-${stampName((deps.now ?? (() => new Date()))()).slice(4)}.claude`
      const sounding = new SoundingEngine({
        interpreter, identity: new TokenIdentityResolver(), transcriber, clock: new Clock(), send, soundingId, context: req.context,
        persist: async (id, jsonl) => { const name = `${id}.jsonl`; await store.put(name, jsonl); return name },
      })
      return { sounding, writer: ownWrap(create) }
    },
    writer: () => { const k = prefs.keys().claude; return k ? ownWrap(claudeFor(k)) : null },
    saveWrap: (name, text) => store.setWrap(name, text),
    listEarlier: () => store.list(),
    readEarlier: async (name) => { const k = await store.get(name); return k ? { logPath: name, events: k.events, wrap: k.wrap } : null },
    removeEarlier: (name) => store.remove(name),
    logPathOf: (name) => name,
    error: (line) => console.error(line),
  }
}

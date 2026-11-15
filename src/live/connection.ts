// One page's conversation with the listener: start/stop/context/follow, the
// speaker's corrections, the wrap, earlier soundings and the setup, plus the
// microphone's PCM. Everything that touches a disk, a model or a key comes
// from the host, so the same conversation runs on the server (server.ts, over
// a WebSocket) and inside the page itself (src/own, with the listener's keys).
import type { SoundingEvent } from '../core/events'
import type { SoundingEngine, LiveMessage } from './engine'
import type { EarlierItem } from './earlier-core'
import { isEarlierName } from './earlier-core'
import { isLang } from './langs'
import type { Setup } from './setup'
import { spokenLanguage, validWrapPrompt, wrapMaterial, WRAP_PROMPT_MAX_CHARS, type WrapMaterial, type WrapWriter } from './wrap-core'

type Awaitable<T> = T | Promise<T>

const CONTEXT_MAX_CHARS = 4000
export const LABEL_MAX_CHARS = 60
/** A corrected label: a non-blank single line within the cap. Returns it trimmed, or null. */
export function validLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s.length > 0 && s.length <= LABEL_MAX_CHARS && !/[\r\n]/.test(s) ? s : null
}
/** true only for a validation-worthy string: within the length cap. Doesn't accept undefined — caller checks presence separately. */
function isValidContext(v: unknown): v is string {
  return typeof v === 'string' && v.length <= CONTEXT_MAX_CHARS
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface StartRequest { interpreter?: unknown; transcriber?: unknown; context?: string }

export interface LiveHost {
  /** The language to listen for, as chosen from the page or else the host's own default. */
  lang(): Awaitable<string>
  saveLang(code: string): Awaitable<void>
  wrapPrompt(): Awaitable<{ prompt: string; isDefault: boolean }>
  saveWrapPrompt(text: string): Awaitable<void>
  setup(): Awaitable<Setup>
  /** Builds the sounding a `start` asks for (not yet started) and the writer of its wrap. May warn through `send`. */
  create(req: StartRequest, lang: string, send: (m: LiveMessage) => void): Promise<{ sounding: SoundingEngine; writer: WrapWriter | null }>
  /** Once it is listening: a host that plays a recording in as the microphone does so here. */
  started?(push: (pcm: Int16Array) => void, stop: () => Promise<void>, fail: (e: unknown) => void): void
  /** The writer for an earlier sounding opened again. */
  writer(): WrapWriter | null
  /** Keeps the plain wrap beside its sounding. */
  saveWrap(logPath: string, text: string): Awaitable<void>
  listEarlier(): Awaitable<EarlierItem[]>
  readEarlier(name: string): Awaitable<{ logPath: string; events: SoundingEvent[]; wrap: string | null } | null>
  /** Removes a sounding. False if there is no such sounding. */
  removeEarlier(name: string): Awaitable<boolean>
  /** Where the sounding of that name is kept, as `SoundingEngine.stop()` and `readEarlier` report it. */
  logPathOf(name: string): string
  log?(line: string): void
  error?(line: string): void
}

export interface LiveConnection {
  /** A text frame from the page. */
  text(data: string): Promise<void>
  /** A binary frame: 16 kHz mono PCM from the microphone. */
  audio(pcm: Int16Array): void
  /** The page went away. */
  closed(): void
}

export function liveConnection(send: (m: LiveMessage) => void, host: LiveHost): LiveConnection {
  let live: SoundingEngine | null = null
  // The sounding that just ended on this connection, kept so the speaker can
  // adjust the instructions and have the same sounding wrapped again.
  let ended: { material: WrapMaterial; logPath: string; writer: WrapWriter } | null = null
  let wrapRun = 0
  /** The listening language the current sounding started with; the wrap is told to write in it. */
  let liveLang = 'auto'
  /** `once`: instructions for this one writing only (another reading of the same sounding); the saved ones are left alone. */
  const writeWrap = async (once?: string) => {
    const e = ended
    if (!e) return
    const run = ++wrapRun
    // Said before anything is awaited: the page must hear `writing` ahead of the `stopped` that follows a stop.
    send({ type: 'live.wrap', state: 'writing' })
    let prompt = '', isDefault = true
    try {
      ({ prompt, isDefault } = await host.wrapPrompt())
      const text = await e.writer(once || prompt, e.material)
      if (run !== wrapRun) return // a newer request (changed instructions) supersedes this one
      // only the plain wrap is kept beside the log; another reading is for the screen
      if (!once) await host.saveWrap(e.logPath, text)
      send({ type: 'live.wrap', state: 'done', text, prompt, isDefaultPrompt: isDefault })
    } catch (err) {
      if (run !== wrapRun) return
      host.error?.(`[wrap] ${errMsg(err)}`)
      send({ type: 'live.wrap', state: 'failed', message: errMsg(err), prompt, isDefaultPrompt: isDefault })
    }
  }
  // Tracks an in-flight `start` so a racing `stop` (an explicit stop
  // message, or the socket closing) waits for it to fully settle before
  // touching `live` — calling l.stop() while l.start() is still awaiting
  // transcriber.connect() would leak the timers/socket start() registers
  // right after that await resolves.
  let starting: Promise<void> | null = null
  // Tracks an in-flight `stop` so a racing `start` (a fresh `start`
  // message arriving while the previous sounding is still draining and
  // surfacing) waits for it to fully finish before creating a new
  // sounding on this connection — otherwise the old sounding's timers
  // are still running when the new one starts pushing audio, and frames
  // from both interleave into the ring/segmenter.
  let stopping: Promise<void> | null = null
  const sendSetup = async () => send({ type: 'live.setup', setup: await host.setup() })
  // The writer for the sounding currently live, fixed at its start.
  let liveWriter: WrapWriter | null = null
  const stop = async () => {
    if (starting) { try { await starting } catch { /* start already reported its own error */ } }
    if (!live) return
    const l = live; live = null
    const writer = liveWriter
    stopping = (async () => {
      try {
        const { logPath, summary } = await l.stop(); host.log?.(summary); host.log?.(`wrote ${logPath}`)
        const material = wrapMaterial(l.events())
        material.lang = spokenLanguage(material.transcript, liveLang)
        // Nothing said, nothing to say back.
        ended = writer && material.transcript ? { material, logPath, writer } : null
        // Not awaited: the page gets `writing`, then `stopped` at once, then the wrap when it is ready.
        // A wrap still in flight when the tab goes away is finished and saved all the same.
        if (ended) void writeWrap()
        send({ type: 'live.status', state: 'stopped', message: logPath })
      }
      catch (e) { send({ type: 'live.status', state: 'error', message: errMsg(e) }) }
    })()
    try { await stopping } finally { stopping = null }
  }
  const text = async (data: string) => {
    let msg: { type?: string; name?: unknown; interpreter?: string; transcriber?: unknown; label?: unknown; context?: unknown; text?: unknown; conceptId?: unknown; lang?: unknown }
    try { msg = JSON.parse(data) } catch { return }
    if (msg.type === 'start' && !live && !starting) {
      let context: string | undefined
      if (msg.context !== undefined) {
        if (isValidContext(msg.context)) context = msg.context
        else send({ type: 'live.status', state: 'warning', message: `context must be a string of at most ${CONTEXT_MAX_CHARS} characters, ignoring` })
      }
      starting = (async () => {
        liveLang = await host.lang()
        const made = await host.create({ interpreter: msg.interpreter, transcriber: msg.transcriber, context }, liveLang, send)
        // A prior sounding on this connection may still be draining and
        // surfacing (stop() in flight); let it finish before this one
        // starts pushing audio into a fresh sounding.
        if (stopping) { try { await stopping } catch { /* stop already reported its own error */ } }
        const l = made.sounding
        live = l
        liveWriter = made.writer
        await l.start()
        host.started?.((pcm) => live?.pushAudio(pcm), stop, (e) => send({ type: 'live.status', state: 'error', message: errMsg(e) }))
      })().catch((e) => { send({ type: 'live.status', state: 'error', message: errMsg(e) }); live = null })
      await starting
      starting = null
    } else if (msg.type === 'stop') {
      await stop()
    } else if (msg.type === 'wrap-prompt') {
      // The speaker's own instructions for the wrap ('' goes back to the default), then the sounding that just ended is wrapped again with them.
      const prompt = validWrapPrompt(msg.text)
      if (prompt === null) { send({ type: 'live.status', state: 'warning', message: `wrap instructions must be text of at most ${WRAP_PROMPT_MAX_CHARS} characters, ignoring` }); return }
      await host.saveWrapPrompt(prompt)
      await writeWrap()
    } else if (msg.type === 'rewrap') {
      // With `text`: the same sounding read with other instructions, this once. Nothing is saved.
      const once = msg.text === undefined ? '' : validWrapPrompt(msg.text)
      if (once === null) { send({ type: 'live.status', state: 'warning', message: `wrap instructions must be text of at most ${WRAP_PROMPT_MAX_CHARS} characters, ignoring` }); return }
      await writeWrap(once)
    } else if (msg.type === 'setup') {
      await sendSetup()
    } else if (msg.type === 'instructions') {
      // The wrap instructions, changed from the setup sheet ('' goes back to the default). Used from the next wrap on; nothing is rewritten.
      const prompt = validWrapPrompt(msg.text)
      if (prompt === null) { send({ type: 'live.status', state: 'warning', message: `wrap instructions must be text of at most ${WRAP_PROMPT_MAX_CHARS} characters, ignoring` }); return }
      await host.saveWrapPrompt(prompt)
      await sendSetup()
    } else if (msg.type === 'lang') {
      // The language to listen for, from the next sounding on.
      if (isLang(msg.lang)) await host.saveLang(msg.lang)
      await sendSetup()
    } else if (msg.type === 'earlier') {
      send({ type: 'live.earlier', items: await host.listEarlier() })
    } else if (msg.type === 'open') {
      // An earlier sounding, put back as it ended. Not while one is being listened to on this connection.
      if (live || starting || stopping || !isEarlierName(msg.name)) return
      const e = await host.readEarlier(msg.name)
      if (!e) { send({ type: 'live.status', state: 'warning', message: 'that sounding is no longer there' }); send({ type: 'live.earlier', items: await host.listEarlier() }); return }
      const material = wrapMaterial(e.events)
      material.lang = spokenLanguage(material.transcript, await host.lang())
      const writer = host.writer()
      wrapRun++ // a wrap still being written for the sounding shown before is no longer wanted
      ended = writer && material.transcript ? { material, logPath: e.logPath, writer } : null
      send({ type: 'live.opened', name: msg.name, events: e.events, said: !!ended })
      if (!ended) return
      if (e.wrap) { const { prompt, isDefault } = await host.wrapPrompt(); send({ type: 'live.wrap', state: 'done', text: e.wrap, prompt, isDefaultPrompt: isDefault }) }
      else await writeWrap()
    } else if (msg.type === 'remove') {
      if (live || starting || stopping || !isEarlierName(msg.name)) return
      let ok = false
      try { ok = await host.removeEarlier(msg.name) } catch (err) { host.error?.(`[remove] ${errMsg(err)}`) }
      if (ok) {
        host.log?.(`moved ${msg.name} to the Trash`)
        if (ended && ended.logPath === host.logPathOf(msg.name)) { ended = null; wrapRun++ }
      }
      send({ type: 'live.removed', name: msg.name, ok })
      send({ type: 'live.earlier', items: await host.listEarlier() })
    } else if (msg.type === 'context') {
      // A `context` message can race a still-in-flight `start` (the
      // browser drops it as soon as the socket opens, before the session
      // is up) — without waiting here, `live` is still null and the
      // message is silently dropped. Wait for `start` to settle (ignoring
      // its own error, which it already reported) and apply the context
      // once `live` exists.
      if (starting) { try { await starting } catch { /* start already reported its own error */ } }
      if (!live) return
      if (isValidContext(msg.text)) await live.setContext(msg.text)
      else send({ type: 'live.status', state: 'warning', message: `context must be a string of at most ${CONTEXT_MAX_CHARS} characters, ignoring` })
    } else if (msg.type === 'follow') {
      if (!live) return
      const raw = msg.conceptId
      if (raw !== null && typeof raw !== 'string') {
        send({ type: 'live.status', state: 'warning', message: 'follow conceptId must be a string or null, ignoring' })
        return
      }
      const { label } = await live.follow(raw)
      if (raw !== null && label === null) send({ type: 'live.status', state: 'warning', message: 'unknown concept, let go' })
    } else if (msg.type === 'dismiss' || msg.type === 'restore' || msg.type === 'rename') {
      // The speaker's corrections. Whatever changes reaches the page as log
      // events; only a request that changed nothing gets a warning back.
      if (!live) return
      if (typeof msg.conceptId !== 'string') { send({ type: 'live.status', state: 'warning', message: `${msg.type} needs a conceptId, ignoring` }); return }
      if (msg.type === 'rename') {
        const label = validLabel(msg.label)
        if (label === null) { send({ type: 'live.status', state: 'warning', message: `a label must be 1 to ${LABEL_MAX_CHARS} characters on one line, ignoring` }); return }
        if ((await live.rename(msg.conceptId, label)) === null) send({ type: 'live.status', state: 'warning', message: 'nothing to rename' })
      } else {
        const done = msg.type === 'dismiss' ? await live.dismiss(msg.conceptId) : await live.restore(msg.conceptId)
        if (done === null) send({ type: 'live.status', state: 'warning', message: `nothing to ${msg.type}` })
      }
    }
  }
  return { text, audio: (pcm) => live?.pushAudio(pcm), closed: () => void stop() }
}

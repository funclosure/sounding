// Regression test for the critical finding: a committed segment must not be
// dropped when the segmenter cuts while a previous interpreter call is still
// in flight. Drives LiveSounding directly, bypassing the server, so no
// network or subprocess is involved.
//
// Deviation from the brief's recipe: the brief describes driving this off a
// FakeTranscriber + FixtureScript. FakeTranscriber's 500ms-real interim timer
// and LiveSounding's 1000ms-real idle timer both come due at the same
// session instants here (both maxSegmentMs=8000 and the idle grid are
// multiples of 1000ms), so which one fires the cut would be decided by
// sub-ms setInterval scheduling — risking a flaky test where idle cuts first
// and the interim path that carries the bug never runs, so the pre-fix test
// would pass by accident. Chosen a priori from this timing analysis, not
// after observing a flake: a minimal hand-rolled Transcriber stub lets the
// test call onInterim at exact, non-grid-aligned session instants instead,
// which makes the repro deterministic.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, unlinkSync } from 'node:fs'
import { LiveSounding, type LiveMessage } from '../src/live/live-sounding'
import { Clock } from '../src/live/clock'
import { RecurrenceInterpreter } from '../src/interpret/recurrence'
import type { Transcriber, TranscriberCallbacks } from '../src/live/transcriber'
import type { InterpreterInput, InterpretationResult } from '../src/interpret/port'

class StubTranscriber implements Transcriber {
  cbs: TranscriberCallbacks | null = null
  async connect(cbs: TranscriberCallbacks): Promise<void> {
    this.cbs = cbs
    cbs.onStatus('listening')
  }
  sendAudio(): void {}
  async end(): Promise<void> {}
}

/**
 * Mimics TranscribeLiveClient.drain(): when audio was sent since the last
 * final, `end()` sends audioStreamEnd and dispatches the owed trailing final
 * through onFinal *before* its own promise resolves. Real drain code does
 * this synchronously inside the websocket's onmessage handler; this stub
 * reproduces that ordering directly.
 */
class DrainingStubTranscriber implements Transcriber {
  cbs: TranscriberCallbacks | null = null
  async connect(cbs: TranscriberCallbacks): Promise<void> {
    this.cbs = cbs
    cbs.onStatus('listening')
  }
  sendAudio(): void {}
  async end(): Promise<void> {
    this.cbs?.onFinal('six seven eight nine ten')
  }
}

const WORDS = Array.from({ length: 64 }, (_, i) => ['circle', 'loop', 'return', 'again', 'recur'][i % 5])
const words = (n: number) => WORDS.slice(0, n).join(' ')

describe('LiveSounding — atomic pending+commit enqueue', () => {
  it('does not drop a committed segment when an interpreter call overlaps the next cut', async () => {
    const clock = new Clock(10) // 10x session speed keeps the test fast
    const transcriber = new StubTranscriber()
    const messages: LiveMessage[] = []
    const soundingId = 'live-test-atomic-enqueue.recurrence'

    // Delay the interpreter by 9s of session time so a slow call overlaps
    // the next segmenter cut (cuts happen every ~8s of session time here).
    const original = RecurrenceInterpreter.prototype.interpret
    const spy = vi.spyOn(RecurrenceInterpreter.prototype, 'interpret').mockImplementation(
      async function (this: RecurrenceInterpreter, input: InterpreterInput): Promise<InterpretationResult> {
        await clock.sleep(9000)
        return original.call(this, input)
      },
    )

    const live = new LiveSounding({ interpreterName: 'recurrence', transcriber, clock, send: (m) => messages.push(m), soundingId })
    try {
      await live.start()
      const cbs = transcriber.cbs
      if (!cbs) throw new Error('transcriber never connected')

      // Cut 1 at t≈8500: first cut, queue is idle, always succeeds.
      await clock.sleep(8500)
      cbs.onInterim(words(40))

      // Cut 2 at t≈16600: arrives while cut 1's interpreter call (finishing
      // ~17500) is still in flight — this is the overlap that reproduces the
      // bug pre-fix.
      await clock.sleep(8100)
      cbs.onInterim(words(48))

      // Cut 3 at t≈24700: arrives while cut 2's interpreter call is still
      // in flight, same overlap again.
      await clock.sleep(8100)
      cbs.onInterim(words(56))

      await clock.sleep(2300)
      await live.stop()
    } finally {
      spy.mockRestore()
      const logPath = `soundings/${soundingId}.jsonl`
      if (existsSync(logPath)) unlinkSync(logPath)
    }

    const errors = messages.filter((m) => m.type === 'live.status' && m.state === 'error')
    expect(errors, JSON.stringify(errors)).toHaveLength(0)

    const committed = messages.filter((m): m is Extract<LiveMessage, { type: 'segment.committed' }> => m.type === 'segment.committed')
    const emitted = messages.filter((m): m is Extract<LiveMessage, { type: 'candidates.emitted' }> => m.type === 'candidates.emitted')
    expect(committed.length).toBeGreaterThanOrEqual(3)
    for (const c of committed) {
      expect(emitted.some((e) => e.segmentId === c.segmentId), `no candidates.emitted for ${c.segmentId}`).toBe(true)
    }
  }, 15_000)
})

describe('LiveSounding — drained trailing final on stop', () => {
  it('commits the final drained during transcriber.end() before surfacing', async () => {
    const clock = new Clock(10)
    const transcriber = new DrainingStubTranscriber()
    const messages: LiveMessage[] = []
    const soundingId = 'live-test-drained-final.recurrence'

    const live = new LiveSounding({ interpreterName: 'recurrence', transcriber, clock, send: (m) => messages.push(m), soundingId })
    try {
      await live.start()
      const cbs = transcriber.cbs
      if (!cbs) throw new Error('transcriber never connected')

      // A couple of interims well under the segmenter's 8s cut threshold, so
      // nothing commits before stop() drains the trailing final.
      await clock.sleep(500)
      cbs.onInterim(words(10))
      await clock.sleep(500)
      cbs.onInterim(words(20))

      // doStop() awaits transcriber.end(), which (like the real client's
      // drain) dispatches the owed trailing final through onFinal before its
      // own promise resolves.
      await live.stop()
    } finally {
      const logPath = `soundings/${soundingId}.jsonl`
      if (existsSync(logPath)) unlinkSync(logPath)
    }

    const errors = messages.filter((m) => m.type === 'live.status' && m.state === 'error')
    expect(errors, JSON.stringify(errors)).toHaveLength(0)

    const committedIdx = messages.findIndex(
      (m): m is Extract<LiveMessage, { type: 'segment.committed' }> =>
        m.type === 'segment.committed' && m.transcript === 'six seven eight nine ten',
    )
    expect(committedIdx, `no segment.committed for the drained final: ${JSON.stringify(messages.map((m) => m.type))}`).toBeGreaterThanOrEqual(0)
    const committed = messages[committedIdx] as Extract<LiveMessage, { type: 'segment.committed' }>

    const emittedIdx = messages.findIndex(
      (m): m is Extract<LiveMessage, { type: 'candidates.emitted' }> =>
        m.type === 'candidates.emitted' && m.segmentId === committed.segmentId,
    )
    expect(emittedIdx, 'no candidates.emitted for the drained final segment').toBeGreaterThan(committedIdx)

    const surfacedIdx = messages.findIndex((m) => m.type === 'sounding.surfaced')
    expect(surfacedIdx, 'no sounding.surfaced message').toBeGreaterThan(emittedIdx)
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('LiveSounding — context and follow', () => {
  it('context.brought is first after sounding.dropped, hints reach the interpreter, and follow resolves/loses labels', async () => {
    const clock = new Clock(10)
    const transcriber = new StubTranscriber()
    const messages: LiveMessage[] = []
    const soundingId = 'live-test-context-follow.recurrence'

    const seenInputs: InterpreterInput[] = []
    const spy = vi.spyOn(RecurrenceInterpreter.prototype, 'interpret').mockImplementation(
      async function (this: RecurrenceInterpreter, input: InterpreterInput): Promise<InterpretationResult> {
        seenInputs.push(input)
        return { candidates: [{ label: 'Trust Wallet', strength: 0.9, confidence: 0.9, source: this.id, segmentId: input.segmentId }], costUsd: 0, latencyMs: 0 }
      },
    )

    const live = new LiveSounding({ interpreterName: 'recurrence', transcriber, clock, send: (m) => messages.push(m), soundingId, context: 'Trust Wallet' })
    try {
      await live.start()
      const cbs = transcriber.cbs
      if (!cbs) throw new Error('transcriber never connected')

      expect(messages[0]?.type).toBe('sounding.dropped')
      expect(messages[1]?.type).toBe('context.brought')
      expect((messages[1] as Extract<LiveMessage, { type: 'context.brought' }>).text).toBe('Trust Wallet')

      cbs.onFinal('Trust Wallet is on my mind today')
      await waitFor(() => messages.some((m) => m.type === 'candidates.emitted'), 10_000)
      await waitFor(
        () => messages.some((m): m is Extract<LiveMessage, { type: 'reading.changed' }> => m.type === 'reading.changed' && m.reading.marks.some((mk) => mk.conceptId === 'c1')),
        10_000,
      )

      expect(seenInputs.length).toBeGreaterThanOrEqual(1)
      expect(seenInputs[0].hints?.context).toBe('Trust Wallet')

      const withMark = messages.find(
        (m): m is Extract<LiveMessage, { type: 'reading.changed' }> => m.type === 'reading.changed' && m.reading.marks.some((mk) => mk.conceptId === 'c1'),
      )!
      const c1 = withMark.reading.marks.find((mk) => mk.conceptId === 'c1')!

      const { label } = await live.follow('c1')
      expect(label).toBe(c1.label)
      const followed = messages.filter((m): m is Extract<LiveMessage, { type: 'mark.followed' }> => m.type === 'mark.followed').at(-1)!
      expect(followed.conceptId).toBe('c1')
      expect(followed.label).toBe(c1.label)

      const inputsBefore = seenInputs.length
      cbs.onFinal('more talk about the wallet')
      await waitFor(() => seenInputs.length > inputsBefore, 10_000)
      expect(seenInputs.at(-1)!.hints?.follow).toBe(c1.label)

      const { label: unknownLabel } = await live.follow('nope')
      expect(unknownLabel).toBeNull()
      const followed2 = messages.filter((m): m is Extract<LiveMessage, { type: 'mark.followed' }> => m.type === 'mark.followed').at(-1)!
      expect(followed2.conceptId).toBeNull()
      expect(followed2.label).toBeNull()

      await live.stop()
    } finally {
      spy.mockRestore()
      const logPath = `soundings/${soundingId}.jsonl`
      if (existsSync(logPath)) unlinkSync(logPath)
    }
  }, 20_000)

  it('follow() after callbacksClosed is ignored', async () => {
    const clock = new Clock(10)
    const transcriber = new StubTranscriber()
    const messages: LiveMessage[] = []
    const soundingId = 'live-test-follow-after-close.recurrence'

    const live = new LiveSounding({ interpreterName: 'recurrence', transcriber, clock, send: (m) => messages.push(m), soundingId })
    try {
      await live.start()
      await live.stop()
      const before = messages.filter((m) => m.type === 'mark.followed').length
      const { label } = await live.follow('anything')
      expect(label).toBeNull()
      const after = messages.filter((m) => m.type === 'mark.followed').length
      expect(after).toBe(before)
    } finally {
      const logPath = `soundings/${soundingId}.jsonl`
      if (existsSync(logPath)) unlinkSync(logPath)
    }
  })
})

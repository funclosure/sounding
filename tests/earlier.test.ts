import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { isEarlierName, listEarlier, readEarlier, removeEarlier } from '../src/live/earlier'
import { handleLiveConnection, parseArgs } from '../src/live/server'

const log = (said: string) => [
  { type: 'sounding.dropped', t: 0, soundingId: 'x' },
  ...(said ? [{ type: 'segment.committed', t: 4000, segmentId: 's1', transcript: said, startT: 0, endT: 4000 }] : []),
].map((e) => JSON.stringify(e)).join('\n')

function soundings() {
  const dir = mkdtempSync(join(tmpdir(), 'sounding-earlier-'))
  writeFileSync(join(dir, 'live-20261110-090000.claude-sub.jsonl'), log('the offer letter'))
  writeFileSync(join(dir, 'live-20261110-090000.claude-sub.wrap.md'), 'You kept coming back.\n')
  writeFileSync(join(dir, 'live-20261110-210000.claude-sub.jsonl'), log(''))
  writeFileSync(join(dir, 'synthetic-memo.claude.jsonl'), log('a fixture'))
  writeFileSync(join(dir, 'wrap-prompt.txt'), '')
  return dir
}

describe('earlier soundings on disk', () => {
  it('accepts only the names the app gives its own soundings', () => {
    expect(isEarlierName('live-20261110-090000.claude-sub.jsonl')).toBe(true)
    for (const bad of ['synthetic-memo.claude.jsonl', '../live-20261110-090000.claude-sub.jsonl', 'live-20261110-090000.claude-sub.wrap.md', 'live-20261110-090000..jsonl', 'wrap-prompt.txt', 7, null]) expect(isEarlierName(bad)).toBe(false)
  })
  it('lists them newest first, with when, how long and whether anything was said', () => {
    const items = listEarlier(soundings())
    expect(items.map((i) => i.name)).toEqual(['live-20261110-210000.claude-sub.jsonl', 'live-20261110-090000.claude-sub.jsonl'])
    expect(items[0]).toMatchObject({ at: '2026-11-10T21:00:00', said: false, durationMs: 0 })
    expect(items[1]).toMatchObject({ at: '2026-11-10T09:00:00', said: true, durationMs: 4000, marks: [] })
    expect(listEarlier(join(tmpdir(), 'no-such-soundings-dir'))).toEqual([])
  })
  it('reads one back with its saved wrap, and nothing by any other name', () => {
    const dir = soundings()
    const e = readEarlier('live-20261110-090000.claude-sub.jsonl', dir)!
    expect(e.events).toHaveLength(2)
    expect(e.wrap).toBe('You kept coming back.')
    expect(readEarlier('live-20261110-210000.claude-sub.jsonl', dir)!.wrap).toBeNull()
    expect(readEarlier('synthetic-memo.claude.jsonl', dir)).toBeNull()
    expect(readEarlier('live-20261111-000000.claude-sub.jsonl', dir)).toBeNull()
  })
  it('removes by moving the log and its wrap to the trash, never over something already there', () => {
    const dir = soundings()
    const trash = join(dir, 'trash')
    mkdirSync(trash)
    writeFileSync(join(trash, 'live-20261110-090000.claude-sub.jsonl'), 'older')
    expect(removeEarlier('live-20261110-090000.claude-sub.jsonl', dir, trash)).toBe(true)
    expect(existsSync(join(dir, 'live-20261110-090000.claude-sub.jsonl'))).toBe(false)
    expect(existsSync(join(dir, 'live-20261110-090000.claude-sub.wrap.md'))).toBe(false)
    expect(readdirSync(trash).sort()).toEqual(['live-20261110-090000.claude-sub 2.jsonl', 'live-20261110-090000.claude-sub.jsonl', 'live-20261110-090000.claude-sub.wrap.md'])
    expect(removeEarlier('live-20261110-090000.claude-sub.jsonl', dir, trash)).toBe(false)
    expect(removeEarlier('synthetic-memo.claude.jsonl', dir, trash)).toBe(false)
    expect(existsSync(join(dir, 'synthetic-memo.claude.jsonl'))).toBe(true)
  })
})

describe('earlier soundings over the live socket', () => {
  it('lists them, opens one with its saved wrap, reads it another way, and removes it', async () => {
    const dir = soundings()
    const trash = join(dir, 'trash')
    const prompts: string[] = []
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const args = parseArgs(['-i', 'recurrence'])
    wss.on('connection', (ws) => handleLiveConnection(ws, args, { soundingsDir: dir, trashDir: trash, promptDir: dir, wrap: async (instructions) => { prompts.push(instructions); return `wrap ${prompts.length}` } }))
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`)
    type Msg = { type: string; state?: string; text?: string; name?: string; ok?: boolean; said?: boolean; items?: Array<{ name: string }>; events?: unknown[] }
    const seen: Msg[] = []
    const next = (pred: (m: Msg) => boolean, from: number) => new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; saw ${seen.map((m) => m.type).join(' ')}`)), 4000)
      const check = () => { const hit = seen.slice(from).find(pred); if (hit) { clearTimeout(timer); ws.off('message', check); resolve(hit) } }
      ws.on('message', check)
      check()
    })
    ws.on('message', (d) => seen.push(JSON.parse(d.toString())))
    await new Promise<void>((r) => ws.once('open', () => r()))
    const name = 'live-20261110-090000.claude-sub.jsonl'

    ws.send(JSON.stringify({ type: 'earlier' }))
    expect((await next((m) => m.type === 'live.earlier', 0)).items).toHaveLength(2)

    let at = seen.length
    ws.send(JSON.stringify({ type: 'open', name }))
    expect(await next((m) => m.type === 'live.opened', at)).toMatchObject({ name, said: true })
    // the saved wrap comes back as it is: nothing is written again
    expect(await next((m) => m.type === 'live.wrap', at)).toMatchObject({ state: 'done', text: 'You kept coming back.' })
    expect(prompts).toEqual([])

    at = seen.length
    ws.send(JSON.stringify({ type: 'rewrap', text: 'What I stepped around.' }))
    expect(await next((m) => m.type === 'live.wrap' && m.state === 'done', at)).toMatchObject({ text: 'wrap 1' })
    // another reading is for the screen: the wrap beside the log stays the plain one
    expect(readEarlier(name, dir)!.wrap).toBe('You kept coming back.')

    at = seen.length
    ws.send(JSON.stringify({ type: 'open', name: '../wrap-prompt.txt' }))
    ws.send(JSON.stringify({ type: 'remove', name }))
    expect(await next((m) => m.type === 'live.removed', at)).toMatchObject({ name, ok: true })
    expect((await next((m) => m.type === 'live.earlier', at)).items!.map((i) => i.name)).toEqual(['live-20261110-210000.claude-sub.jsonl'])
    expect(seen.slice(at).some((m) => m.type === 'live.opened')).toBe(false)
    expect(existsSync(join(trash, name))).toBe(true)
    // it is gone, so there is nothing left to read again
    at = seen.length
    ws.send(JSON.stringify({ type: 'rewrap' }))
    ws.send(JSON.stringify({ type: 'earlier' }))
    await next((m) => m.type === 'live.earlier', at)
    expect(seen.slice(at).some((m) => m.type === 'live.wrap')).toBe(false)

    ws.close()
    await new Promise<void>((r) => wss.close(() => r()))
  })
})

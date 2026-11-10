// compare: two casts of the same recording, side by side.
//   bun run compare -- soundings/memo.claude.jsonl soundings/memo.gemini.jsonl
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { EventLog, type SoundingEvent } from '../core/events'
import { summarizeCounters } from '../replay/counters'

export interface NamedLog {
  name: string
  events: readonly SoundingEvent[]
}

const COL = 46

function finalMarks(events: readonly SoundingEvent[]): string[] {
  const last = [...events].reverse().find((e) => e.type === 'reading.changed')
  if (!last || last.type !== 'reading.changed') return ['(no reading)']
  return last.reading.marks.map((m) => `${m.label} ${(m.prominence * 100).toFixed(1)}%`)
}

function displacements(events: readonly SoundingEvent[]): string[] {
  const out: string[] = []
  const map = new Map<string, string>()
  for (const e of events) {
    if (e.type !== 'reading.changed') continue
    for (const tr of e.transitions) {
      if (tr.kind === 'appeared') map.set(tr.conceptId, tr.label)
    }
    for (const tr of e.transitions) {
      if (tr.kind === 'displaced') out.push(`${(e.t / 1000).toFixed(1)}s  ${tr.label} ⟶ ${map.get(tr.byConceptId) ?? tr.byConceptId}`)
    }
  }
  return out.length > 0 ? out : ['(none)']
}

function counters(events: readonly SoundingEvent[]): string[] {
  const c = summarizeCounters(events)
  return [`${c.callCount} calls`, `$${c.totalCostUsd.toFixed(4)}`, `mean ${Math.round(c.meanLatencyMs)}ms / max ${Math.round(c.maxLatencyMs)}ms`]
}

function twoColumns(left: string[], right: string[]): string {
  const rows = Math.max(left.length, right.length)
  const lines: string[] = []
  for (let i = 0; i < rows; i++) {
    lines.push(`  ${(left[i] ?? '').padEnd(COL)}${right[i] ?? ''}`)
  }
  return lines.join('\n')
}

export function formatComparison(a: NamedLog, b: NamedLog): string {
  const header = `  ${a.name.padEnd(COL)}${b.name}`
  return [
    'FINAL READING',
    header,
    twoColumns(finalMarks(a.events), finalMarks(b.events)),
    '',
    'DISPLACEMENTS',
    twoColumns(displacements(a.events), displacements(b.events)),
    '',
    'COST / LATENCY',
    twoColumns(counters(a.events), counters(b.events)),
  ].join('\n')
}

const isDirectRun = process.argv[1]?.endsWith('compare.ts')
if (isDirectRun) {
  const [pathA, pathB] = process.argv.slice(2)
  if (!pathA || !pathB) {
    console.error('usage: bun run compare -- <log-a.jsonl> <log-b.jsonl>')
    process.exit(1)
  }
  const load = (p: string): NamedLog => ({ name: basename(p, '.jsonl'), events: EventLog.fromJsonl(readFileSync(p, 'utf8')).all() })
  console.log(formatComparison(load(pathA), load(pathB)))
}

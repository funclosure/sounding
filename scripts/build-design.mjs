#!/usr/bin/env node
// Build the phone-first design prototype from a sounding log.
//   node scripts/build-design.mjs soundings/<name>.jsonl [docs/design/sounding-phone.html]
// The template is docs/design/sounding-phone.template.html. Keep private logs out of
// committed builds: the checked-in build uses the synthetic memo.
import { readFileSync, writeFileSync } from 'node:fs'

const STOP_SRC = readFileSync('src/core/text.ts', 'utf8')
const STOPWORDS = new Set([...STOP_SRC.slice(STOP_SRC.indexOf('STOPWORDS'), STOP_SRC.indexOf('])')).matchAll(/'([a-z]+)'/g)].map((m) => m[1]))
const normalize = (raw) => { let t = raw.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/'/g, ''); if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1); return t }
const heard = (delta) => delta.split(/\s+/).map((raw) => ({ raw: raw.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ''), n: normalize(raw) })).filter(({ raw, n }) => raw && n.length > 1 && !STOPWORDS.has(n)).map(({ raw }) => raw)

const [,, logPath, outPath = 'docs/design/sounding-phone.html'] = process.argv
if (!logPath) { console.error('usage: node scripts/build-design.mjs <sounding.jsonl> [out.html]'); process.exit(2) }
const ev = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

const readings = []; let lastKey = null; let lastT = -Infinity
for (const e of ev) {
  if (e.type !== 'reading.changed') continue
  const m = e.reading.marks.map((x) => ({ id: x.conceptId, l: x.label, p: Math.round(x.prominence * 1000) / 1000 }))
  const key = JSON.stringify(m.map((x) => [x.id, x.p]))
  const tr = e.transitions.filter((t) => t.kind !== 'nudged').map((t) => ({ k: t.kind, id: t.conceptId ?? t.intoConceptId, by: t.byConceptId ?? null, from: t.fromConceptId ?? null }))
  const s = Boolean(e.reading.slack)
  const changed = key !== lastKey || tr.length || (readings.length && readings.at(-1).s !== s)
  const idsChanged = !readings.length || JSON.stringify(m.map((x) => x.id)) !== JSON.stringify(readings.at(-1).m.map((x) => x.id))
  if (changed && (tr.length || e.t - lastT >= 400 || idsChanged)) { readings.push({ t: e.t, m, tr, s }); lastKey = key; lastT = e.t }
}
const heardEvents = ev.filter((e) => e.type === 'segment.pending').map((e) => ({ t: e.t, w: heard(e.text) })).filter((h) => h.w.length)
const labels = {}
for (const r of readings) for (const m of r.m) labels[m.id] ??= m.l
const data = {
  endT: ev.at(-1).t, readings, heard: heardEvents, labels,
  calls: ev.filter((e) => e.type === 'candidates.emitted').map((e) => ({ t: e.t, ms: e.latencyMs })),
  segments: ev.filter((e) => e.type === 'segment.committed').map((e) => ({ t: e.t, s: e.startT, text: e.transcript })),
  pending: ev.filter((e) => e.type === 'segment.pending').map((e) => ({ t: e.t, text: e.text })),
}
const tpl = readFileSync('docs/design/sounding-phone.template.html', 'utf8')
const src = `${logPath.replace(/^.*\//, '')}, ${Math.round(data.endT / 1000)}s, ${data.calls.length} interpretation calls`
writeFileSync(outPath, tpl.replace('__DATA__', JSON.stringify(data)).replace('__SOURCE__', src))
console.log(`wrote ${outPath}: ${readings.length} readings, ${heardEvents.length} heard bursts, ${Object.keys(labels).length} concepts, from ${src}`)

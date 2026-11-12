// The sounding as one picture to share: the words that stood out, then what was said back.
// This file only decides where everything goes (pure: the caller measures and draws),
// so the same layout can be tested without a canvas.

import { band, boxCeiling, clearingCeiling, poolRadius } from './board/dots'

export type Measure = (text: string, font: string) => number
export interface PictureInput {
  /** Most prominent first; `p` is each mark's share, as on the board. */
  marks: ReadonlyArray<{ label: string; p: number }>
  head: string
  wrap: string
  foot: string
  /** Where in its drift the dot field is caught; any number (the sounding's length gives each its own). */
  drift?: number
}
export interface PictureFonts { serif: string; mono: string }
export type PictureOp =
  | { kind: 'text'; text: string; x: number; y: number; font: string; color: 'ink' | 'quiet' | 'whisper'; align: 'left' | 'center' }
  | { kind: 'dot'; x: number; y: number; r: number }
  /** One dot of the field behind the words; `b` is what it has to say, as on the board. */
  | { kind: 'field'; x: number; y: number; b: number }
  | { kind: 'rule'; x: number; y: number; w: number }
export interface Picture { width: number; height: number; ops: PictureOp[] }

export const PICTURE_WIDTH = 1080
const PAD = 88
const MAX_MARKS = 6
const BODY_PX = 38
const BODY_LINE = 63
const BULLET_INDENT = 40
/** The picture is drawn about twice the size of the page, so the field's distances are too. */
export const FIELD_SCALE = 2
const FIELD_DOT = 24
/** The field in a picture is a little more awake than the page at rest: there is no pointer to bring it up. */
const FIELD_BREATH = 0.5
const FIELD_QUIET = 0.8

const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF\\u3000-\\u30FF'
const TOKEN = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, 'gu')
/** Marks that may never begin a line: they stay with what they close. */
const NO_START = /^[，。、；：！？）」』》〉…,.;:!?)]/

/** Breaks text to a width: between words for spaced scripts, between any two characters for Chinese and Japanese. */
export function breakLines(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const tok of text.trim().match(TOKEN) ?? []) {
    if (/^\s/.test(tok)) { if (line) line += ' '; continue }
    const next = line + tok
    if (!line || NO_START.test(tok) || measure(next) <= maxWidth) line = next
    else { lines.push(line.trimEnd()); line = tok }
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines
}

/** Where every word, dot and rule of the picture goes. Heights follow the content. */
export function layoutPicture(input: PictureInput, fonts: PictureFonts, measure: Measure, width = PICTURE_WIDTH): Picture {
  const ops: PictureOp[] = []
  const inner = width - PAD * 2
  let y = PAD + 64
  const pools: Array<{ x: number; y: number; halfW: number; halfH: number; p: number }> = []

  // the words, gathered: centred, the most prominent largest, each drawn in so it never runs past the edge
  input.marks.slice(0, MAX_MARKS).forEach((m, i) => {
    let px = Math.round(38 + Math.min(0.5, Math.max(0, m.p)) * 2 * 54)
    let font = `${px}px ${fonts.serif}`
    let wide = measure(m.label, font)
    if (wide > inner) { px = Math.max(24, Math.floor(px * (inner / wide))); font = `${px}px ${fonts.serif}`; wide = measure(m.label, font) }
    y += Math.round(px * 1.02)
    pools.push({ x: width / 2, y: y - px * 0.34, halfW: wide / 2, halfH: px * 0.56, p: Math.min(0.5, Math.max(0, m.p)) })
    ops.push({ kind: 'text', text: m.label, x: width / 2, y, font, color: i === 0 ? 'ink' : 'quiet', align: 'center' })
    y += Math.round(px * 0.3)
  })
  if (input.marks.length) { y += 44; ops.push({ kind: 'rule', x: PAD, y, w: inner }); y += 26 }

  const readingTop = y + 12
  y += 40
  ops.push({ kind: 'text', text: input.head, x: PAD, y, font: `24px ${fonts.mono}`, color: 'quiet', align: 'left' })
  y += 30

  const body = `${BODY_PX}px ${fonts.serif}`
  const bodyWidth = (t: string) => measure(t, body)
  for (const raw of input.wrap.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const bullet = /^[-•*]\s+(.*)$/.exec(line)
    const indent = bullet ? BULLET_INDENT : 0
    const rows = breakLines(bullet ? bullet[1] : line, inner - indent, bodyWidth)
    if (bullet) ops.push({ kind: 'dot', x: PAD + 10, y: y + BODY_LINE - 13, r: 6 })
    for (const row of rows) { y += BODY_LINE; ops.push({ kind: 'text', text: row, x: PAD + indent, y, font: body, color: 'ink', align: 'left' }) }
    y += bullet ? 12 : 22
  }

  y += 72
  ops.push({ kind: 'text', text: input.foot, x: PAD, y, font: `22px ${fonts.mono}`, color: 'whisper', align: 'left' })
  const height = y + PAD - 20
  const reading = { x: width / 2, y: (readingTop + height) / 2, halfW: inner / 2, halfH: (height - readingTop) / 2 }
  return { width, height, ops: [...fieldDots(width, readingTop, pools, reading, input.drift ?? 0), ...ops] }
}

/**
 * The board's dot field, held still: a pool gathers under each word (wider with its share), every word
 * sits in its own clearing, and nothing is drawn behind the reading. Worked out in the page's own
 * distances, then scaled up, so it is the same field the board shows.
 */
function fieldDots(width: number, bottom: number, pools: ReadonlyArray<{ x: number; y: number; halfW: number; halfH: number; p: number }>, reading: { x: number; y: number; halfW: number; halfH: number }, drift: number): PictureOp[] {
  const S = FIELD_SCALE
  const out: PictureOp[] = []
  for (let j = 0; j * FIELD_DOT * S <= bottom; j++) {
    for (let i = 0; i * FIELD_DOT * S <= width + FIELD_DOT * S; i++) {
      const x = i * FIELD_DOT + ((j % 2) * FIELD_DOT) / 2
      const y = j * FIELD_DOT
      let b = FIELD_BREATH * band(x, y, drift)
      let ceiling = boxCeiling(x - reading.x / S, y - reading.y / S, reading.halfW / S, reading.halfH / S)
      let keep = 1
      for (const p of pools) {
        const dx = x - p.x / S, dy = y - p.y / S, r = poolRadius(p.p)
        keep *= 1 - 0.8 * Math.exp(-(dx * dx + dy * dy) / (r * r))
        ceiling = Math.min(ceiling, clearingCeiling(dx, dy, p.halfW / S, p.halfH / S))
      }
      const blob = 1.08 * (1 - keep)
      b = Math.min((b + blob - b * blob) * FIELD_QUIET, ceiling)
      if (b >= 0.012) out.push({ kind: 'field', x: x * S, y: y * S, b })
    }
  }
  return out
}

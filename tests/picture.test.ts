import { describe, it, expect } from 'vitest'
import { breakLines, layoutPicture, PICTURE_WIDTH } from '../src/ui/picture'

// every character is as wide as its font is tall: enough to test where lines break
const px = (font: string) => parseInt(font, 10)
const measure = (t: string, font: string) => t.length * px(font)
const unit = (t: string) => t.length * 10

describe('breaking lines for the picture', () => {
  it('breaks spaced scripts between words', () => {
    expect(breakLines('you keep staring at the offer letter', 150, unit)).toEqual(['you keep', 'staring at the', 'offer letter'])
  })
  it('breaks Chinese between any two characters, and never starts a line with closing punctuation', () => {
    expect(breakLines('產品已經可以付款；怎麼推廣還沒有答案。', 80, unit)).toEqual(['產品已經可以付款；', '怎麼推廣還沒有答', '案。'])
  })
  it('keeps a Latin word whole inside Chinese', () => {
    expect(breakLines('把想學的 Domain 變成學習地圖', 100, unit)).toEqual(['把想學的', 'Domain 變成學', '習地圖'])
  })
  it('gives nothing for nothing', () => {
    expect(breakLines('   ', 100, unit)).toEqual([])
  })
})

describe('laying out the picture', () => {
  const fonts = { serif: 'S', mono: 'M' }
  const input = { marks: [{ label: 'APP 上線', p: 0.4 }, { label: 'Keeper', p: 0.1 }], head: '我聽見了…', wrap: '你一直回到的是推廣。\n- 兩個角色\n- 產品已經可以付款', foot: 'Sounding · 1:33' }
  const pic = layoutPicture(input, fonts, measure)
  const texts = pic.ops.filter((o) => o.kind === 'text')

  it('puts everything in, top to bottom, inside the picture', () => {
    expect(pic.width).toBe(PICTURE_WIDTH)
    expect(texts.map((t) => t.text)).toEqual(['APP 上線', 'Keeper', '我聽見了…', '你一直回到的是推廣。', '兩個角色', '產品已經可以付款', 'Sounding · 1:33'])
    expect(Math.max(...pic.ops.map((o) => o.y))).toBeLessThan(pic.height)
    expect(texts.map((t) => t.y)).toEqual([...texts.map((t) => t.y)].sort((a, b) => a - b))
  })
  it('makes the most prominent word the largest and the darkest, and gives each bullet its dot', () => {
    expect(px(texts[0].font)).toBeGreaterThan(px(texts[1].font))
    expect([texts[0].color, texts[1].color]).toEqual(['ink', 'quiet'])
    expect(pic.ops.filter((o) => o.kind === 'dot')).toHaveLength(2)
    expect(pic.ops.filter((o) => o.kind === 'rule')).toHaveLength(1)
  })
  it('draws a long word in so it stays inside the edges', () => {
    const long = layoutPicture({ ...input, marks: [{ label: 'data structure and algorithm', p: 0.5 }] }, fonts, measure)
    const first = long.ops.find((o) => o.kind === 'text')!
    expect(first.kind).toBe('text')
    expect(measure('data structure and algorithm', (first as { font: string }).font)).toBeLessThanOrEqual(PICTURE_WIDTH - 176)
  })
  it('grows with the wrap, and needs no rule when nothing stood out', () => {
    const more = layoutPicture({ ...input, wrap: input.wrap + '\n- 還有一件事' }, fonts, measure)
    expect(more.height).toBeGreaterThan(pic.height)
    expect(layoutPicture({ ...input, marks: [] }, fonts, measure).ops.some((o) => o.kind === 'rule')).toBe(false)
  })
  it('lays the dot field behind the words: around them, never under them, and never behind the reading', () => {
    const dots = pic.ops.filter((o) => o.kind === 'field')
    const rule = pic.ops.find((o) => o.kind === 'rule')!
    expect(dots.length).toBeGreaterThan(40)
    expect(pic.ops.findIndex((o) => o.kind !== 'field')).toBe(dots.length) // drawn first, under everything
    expect(Math.max(...dots.map((d) => d.y))).toBeLessThan(rule.y + 40)
    const top = texts[0], half = measure(top.text, top.font) / 2
    expect(dots.some((d) => Math.abs(d.x - top.x) < half && Math.abs(d.y - (top.y - px(top.font) * 0.34)) < px(top.font) * 0.5)).toBe(false)
    expect(layoutPicture({ ...input, drift: 40 }, fonts, measure).ops.filter((o) => o.kind === 'field')).not.toEqual(dots)
  })
})

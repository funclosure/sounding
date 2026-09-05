import type { Ms } from '../../core/types'
import type { laneSeries } from './model'

type Series = ReturnType<typeof laneSeries>

const NS = 'http://www.w3.org/2000/svg'
/** viewBox geometry — must match the svg's `viewBox="0 0 390 560"` in the markup. */
const W = 390
const H = 560
const L = 118
const R = 16
const TOP = 8
const AX = 22

function fmtClock(t: Ms): string {
  const s = Math.floor(t / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The chart: one lane per concept, a scrubbable time head. Ported from the
 * prototype's `series`/`buildChart`/`renderHead`/scrub handlers
 * (docs/design/sounding-phone.template.html).
 */
export function createLanes(svg: SVGSVGElement): {
  build(series: Series, endT: Ms): void
  head(now: Ms): void
  setLit(id: string | null): void
  onScrub(cb: (ms: Ms) => void): void
  onTapLane(cb: (id: string) => void): void
} {
  let endT: Ms = 1
  let lanes: Series = []
  let litId: string | null = null
  let scrubbing = false
  const scrubCbs: Array<(ms: Ms) => void> = []
  const tapCbs: Array<(id: string) => void> = []

  function xOf(ms: Ms): number {
    return L + (ms / endT) * (W - L - R)
  }

  function paintLit() {
    svg.querySelectorAll<SVGElement>('.area').forEach((p) => p.classList.toggle('lit', p.dataset.id === litId))
  }

  function build(series: Series, end: Ms) {
    lanes = series
    endT = Math.max(1, end)
    svg.innerHTML = ''

    const laneH = Math.min(30, (H - TOP - AX) / Math.max(1, lanes.length))
    lanes.forEach((lane, i) => {
      const y0 = TOP + i * laneH + laneH - 2
      const maxH = laneH * 0.9
      const pts = lane.points
      const d =
        'M' +
        xOf(pts[0][0]) +
        ',' +
        y0 +
        ' ' +
        pts.map(([ms, p]) => 'L' + xOf(ms).toFixed(1) + ',' + (y0 - Math.min(0.5, p) * 2 * maxH).toFixed(1)).join(' ') +
        ' L' +
        xOf(endT) +
        ',' +
        y0 +
        ' Z'
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', d)
      path.setAttribute('class', 'area')
      path.dataset.id = lane.id
      svg.appendChild(path)

      const base = document.createElementNS(NS, 'line')
      base.setAttribute('x1', String(L))
      base.setAttribute('x2', String(W - R))
      base.setAttribute('y1', String(y0 + 0.5))
      base.setAttribute('y2', String(y0 + 0.5))
      base.setAttribute('class', 'base')
      svg.appendChild(base)

      const label = document.createElementNS(NS, 'text')
      label.setAttribute('x', String(L - 8))
      label.setAttribute('y', String(y0 - 4))
      label.setAttribute('text-anchor', 'end')
      label.setAttribute('class', 'lane-label dim')
      label.dataset.id = lane.id
      label.textContent = lane.label.length > 17 ? lane.label.slice(0, 16) + '…' : lane.label
      label.addEventListener('pointerdown', (e) => e.stopPropagation())
      label.addEventListener('click', (e) => {
        e.stopPropagation()
        for (const cb of tapCbs) cb(lane.id)
      })
      svg.appendChild(label)
    })

    const axis = document.createElementNS(NS, 'g')
    axis.setAttribute('class', 'axis')
    for (let ms = 0; ms <= endT; ms += 30000) {
      const x = xOf(ms)
      const l = document.createElementNS(NS, 'line')
      l.setAttribute('x1', String(x))
      l.setAttribute('x2', String(x))
      l.setAttribute('y1', String(TOP))
      l.setAttribute('y2', String(H - AX + 4))
      axis.appendChild(l)
      const tx = document.createElementNS(NS, 'text')
      tx.setAttribute('x', String(x))
      tx.setAttribute('y', String(H - 6))
      tx.setAttribute('text-anchor', 'middle')
      tx.textContent = fmtClock(ms)
      axis.appendChild(tx)
    }
    svg.appendChild(axis)

    const headLine = document.createElementNS(NS, 'line')
    headLine.setAttribute('class', 'head')
    headLine.dataset.role = 'head'
    headLine.setAttribute('y1', String(TOP))
    headLine.setAttribute('y2', String(H - AX + 4))
    svg.appendChild(headLine)

    const headTime = document.createElementNS(NS, 'text')
    headTime.setAttribute('class', 'head-time')
    headTime.dataset.role = 'headtime'
    headTime.setAttribute('y', String(TOP + 10))
    svg.appendChild(headTime)

    paintLit()
    head(0)
  }

  function head(now: Ms) {
    const x = xOf(now)
    const headLine = svg.querySelector<SVGLineElement>('[data-role="head"]')
    if (!headLine) return
    headLine.setAttribute('x1', String(x))
    headLine.setAttribute('x2', String(x))
    const headTime = svg.querySelector<SVGTextElement>('[data-role="headtime"]')!
    headTime.setAttribute('x', String(x + (x > W - 60 ? -6 : 6)))
    headTime.setAttribute('text-anchor', x > W - 60 ? 'end' : 'start')
    headTime.textContent = fmtClock(now)
    svg.querySelectorAll<SVGElement>('.lane-label').forEach((l) => {
      const lane = lanes.find((s) => s.id === l.dataset.id)
      l.classList.toggle('dim', !!lane && lane.firstT > now)
    })
  }

  function setLit(id: string | null) {
    litId = id
    paintLit()
  }

  function msAt(clientX: number): Ms {
    const b = svg.getBoundingClientRect()
    const x = ((clientX - b.left) / b.width) * W
    return Math.max(0, Math.min(endT, ((x - L) / (W - L - R)) * endT))
  }

  svg.addEventListener('pointerdown', (e) => {
    scrubbing = true
    svg.setPointerCapture(e.pointerId)
    const ms = msAt(e.clientX)
    for (const cb of scrubCbs) cb(ms)
  })
  svg.addEventListener('pointermove', (e) => {
    if (!scrubbing) return
    const ms = msAt(e.clientX)
    for (const cb of scrubCbs) cb(ms)
  })
  svg.addEventListener('pointerup', () => {
    scrubbing = false
  })
  svg.addEventListener('pointercancel', () => {
    scrubbing = false
  })

  function onScrub(cb: (ms: Ms) => void) {
    scrubCbs.push(cb)
  }
  function onTapLane(cb: (id: string) => void) {
    tapCbs.push(cb)
  }

  return { build, head, setLit, onScrub, onTapLane }
}

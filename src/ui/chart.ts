// The shared reading chart: marks, inspector, and transition history. Used
// by both the replay page (main.ts) and the live page (live.ts).
import { layoutReading } from './layout'
import type { Reading, Transition, Ms } from '../core/types'

export interface ChartView {
  render(reading: Reading): void
  recordTransitions(t: Ms, transitions: readonly Transition[]): void
  reset(): void
}

export function fmt(t: Ms): string {
  const s = Math.floor(t / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function createChart(els: { chart: SVGSVGElement; inspector: HTMLElement; slackEl: HTMLElement }): ChartView {
  const history = new Map<string, Array<{ t: Ms; transition: Transition }>>()
  let selectedConceptId: string | null = null

  /** Record each transition in `history`, keyed by the concept it lands on. */
  function recordTransitions(t: Ms, transitions: readonly Transition[]) {
    for (const tr of transitions) {
      const id = tr.kind === 'merged' ? tr.intoConceptId : tr.conceptId
      if (!history.has(id)) history.set(id, [])
      history.get(id)!.push({ t, transition: tr })
    }
  }

  function renderReading(reading: Reading) {
    els.slackEl.hidden = !reading.slack
    const { width, height } = els.chart.getBoundingClientRect()
    const placed = layoutReading(reading, Math.max(width, 200), Math.max(height, 200))
    els.chart.innerHTML = ''
    for (const p of placed) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('class', p.conceptId === selectedConceptId ? 'mark selected' : 'mark')
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', String(p.x))
      circle.setAttribute('cy', String(p.y))
      circle.setAttribute('r', String(p.r))
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', String(p.x))
      text.setAttribute('y', String(p.y + 4))
      text.setAttribute('font-size', String(Math.max(11, p.r / 3)))
      text.textContent = p.label
      g.appendChild(circle)
      g.appendChild(text)
      g.addEventListener('click', () => {
        selectedConceptId = p.conceptId
        renderInspector(p.conceptId, p.label)
        renderReading(reading)
      })
      els.chart.appendChild(g)
    }
  }

  function describe(tr: Transition): string {
    switch (tr.kind) {
      case 'appeared': return 'appeared'
      case 'nudged': return `nudged +${tr.delta}`
      case 'displaced': return `displaced by ${tr.byConceptId}`
      case 'merged': return `absorbed ${tr.fromConceptId}`
      case 'dismissed': return 'dismissed by the speaker'
      case 'restored': return 'restored'
      case 'renamed': return `renamed from "${tr.from}"`
    }
  }

  function renderInspector(conceptId: string, label: string) {
    const entries = history.get(conceptId) ?? []
    els.inspector.innerHTML = `<h2>${label} <small>(${conceptId})</small></h2>`
    const ul = document.createElement('ul')
    for (const { t, transition } of entries) {
      const li = document.createElement('li')
      li.textContent = `${fmt(t)} — ${describe(transition)}`
      ul.appendChild(li)
    }
    els.inspector.appendChild(ul)
  }

  return {
    render: renderReading,
    recordTransitions,
    reset() { history.clear(); selectedConceptId = null; els.chart.innerHTML = ''; els.inspector.innerHTML = '<p>Click a mark to see its transition history.</p>'; els.slackEl.hidden = true },
  }
}

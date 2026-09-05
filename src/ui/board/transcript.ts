import type { TranscriptModel } from './model'

/**
 * The transcript pane: committed segments with 30s stamps, a pending tail,
 * and a caret. Ported from the prototype's `buildTranscript`/`renderTranscript`
 * (docs/design/sounding-phone.template.html), rebuilt fresh on every render
 * since `TranscriptModel` is already the full picture at a moment.
 */
export function createTranscript(el: HTMLElement): { render(m: TranscriptModel, autoscroll: boolean): void } {
  function render(m: TranscriptModel, autoscroll: boolean) {
    el.innerHTML = ''

    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'Nothing yet. Drop, and what you say appears here as it is heard.'
    el.appendChild(empty)

    let si = 0
    for (const seg of m.segments) {
      while (si < m.stamps.length && m.stamps[si].t <= seg.t) {
        const stamp = m.stamps[si]
        const st = document.createElement('span')
        st.className = 'stamp seg'
        st.textContent = stamp.label
        el.appendChild(st)
        si++
      }
      const s = document.createElement('span')
      s.className = 'seg'
      s.textContent = seg.text + ' '
      el.appendChild(s)
    }
    while (si < m.stamps.length) {
      const stamp = m.stamps[si]
      const st = document.createElement('span')
      st.className = 'stamp seg'
      st.textContent = stamp.label
      el.appendChild(st)
      si++
    }

    const pend = document.createElement('span')
    pend.className = 'pend'
    pend.textContent = m.pendingTail ? m.pendingTail + ' ' : ''
    el.appendChild(pend)

    const caret = document.createElement('span')
    caret.className = 'caret'
    el.appendChild(caret)

    empty.hidden = m.segments.length > 0 || m.pendingTail.length > 0

    if (autoscroll) el.scrollTop = el.scrollHeight
  }

  return { render }
}

import { SlotLayout } from './layout'
import { diffReadings } from './model'
import type { ReadingSnapshot } from './model'

export interface Board {
  apply(s: ReadingSnapshot, opts?: { instant?: boolean }): void
  seedGhosts(labels: Array<{ id: string; label: string }>): void
  clearGhosts(): void
  setLit(id: string | null): void
  reset(): void
  relayout(): void
  onTap(cb: (id: string) => void): void
}

/** How long a departing mark's sink/absorb animation runs before removal (ms). */
const DEPART_MS = 1900
/** How long the "arrive" buoy-line class stays on a fresh mark (ms). */
const ARRIVE_MS = 2700

/**
 * The board: a field of marks, positioned by `SlotLayout`, animated in and
 * out per `diffReadings`. Ported from the prototype's `applyReading`/
 * `showGhosts`/`follow` (docs/design/sounding-phone.template.html).
 */
export function createBoard(field: HTMLElement): Board {
  const layout = new SlotLayout()
  const live = new Map<string, HTMLElement>()
  let prev: ReadingSnapshot | null = null
  let litId: string | null = null
  let seeds: Array<{ id: string; label: string }> = []
  const tapCbs: Array<(id: string) => void> = []

  function emitTap(id: string) {
    for (const cb of tapCbs) cb(id)
  }

  function place(id: string, el: HTMLElement) {
    const w = field.clientWidth
    const h = field.clientHeight
    // Raw half-width, unclamped: `layout.position` is the single place that
    // clamps it against `w * 0.45` (see layout.ts).
    const half = el.getBoundingClientRect().width / 2 + 8
    const { x, y } = layout.position(id, { width: w, height: h }, half)
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }

  /** Makes `el` tappable/focusable and wires it to `emitTap(id)`. Only real marks get this. */
  function makeInteractive(el: HTMLElement, id: string) {
    el.tabIndex = 0
    el.addEventListener('click', () => emitTap(id))
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') emitTap(id)
    })
  }

  function makeMarkEl(id: string): HTMLElement {
    const el = document.createElement('p')
    el.className = 'mark'
    el.dataset.id = id
    return el
  }

  function seedGhosts(labels: Array<{ id: string; label: string }>) {
    seeds = labels
    for (const { id, label } of seeds) {
      if (live.has(id)) continue
      // Ghosts are inert context seeds: no click/keydown listeners, no
      // tabIndex. They become interactive only if/when `apply()` promotes
      // them to a real mark (see the `wasGhost` branch below).
      const el = makeMarkEl(id)
      el.classList.add('ghost')
      el.textContent = label
      el.style.fontSize = '17px'
      field.appendChild(el)
      live.set(id, el)
      place(id, el)
    }
  }

  function clearGhosts() {
    for (const [id, el] of [...live]) {
      if (!el.classList.contains('ghost')) continue
      live.delete(id)
      el.remove()
    }
    seeds = []
  }

  function paintLit() {
    for (const [id, el] of live) el.classList.toggle('lit', id === litId)
  }

  function setLit(id: string | null) {
    litId = id
    paintLit()
  }

  function apply(s: ReadingSnapshot, opts?: { instant?: boolean }) {
    const instant = !!opts?.instant
    if (instant) field.classList.add('instant')

    const diff = diffReadings(prev, s)

    for (const d of diff.departed) {
      const el = live.get(d.id)
      if (!el) continue
      live.delete(d.id)
      if (d.reason === 'displaced') {
        el.classList.add('sink')
        el.style.transform = 'translate(-50%, 60%)'
      } else {
        el.classList.add('absorbed')
      }
      setTimeout(() => el.remove(), instant ? 0 : DEPART_MS)
    }

    for (const m of s.marks) {
      let el = live.get(m.id)
      const size = Math.round(15 + Math.min(0.5, m.p) * 62)
      const wght = Math.round(320 + Math.min(0.5, m.p) * 760)
      const wasGhost = !!el && el.classList.contains('ghost')
      const fresh = !el || wasGhost

      if (!el) {
        el = makeMarkEl(m.id)
        makeInteractive(el, m.id)
        if (!instant) el.classList.add('arrive')
        el.textContent = m.label
        field.appendChild(el)
        live.set(m.id, el)
      } else if (wasGhost) {
        el.classList.remove('ghost')
        makeInteractive(el, m.id)
        if (!instant) el.classList.add('arrive')
        el.textContent = m.label
      }

      // `.field.instant .mark` disables transitions/animations by class, but
      // `.arrive`'s `animation: rise` still *starts* the instant this class
      // is added (a `none` -> `rise` animation-name change runs regardless
      // of `animation-duration`) — so an instant apply skips `.arrive` outright.
      if (fresh && !instant) {
        const arriving = el
        setTimeout(() => arriving.classList.remove('arrive'), ARRIVE_MS)
      }

      el.style.fontSize = `${size}px`
      el.style.fontVariationSettings = `"opsz" 144, "wght" ${wght}, "SOFT" 60`
      el.style.opacity = String(0.55 + Math.min(0.45, m.p))
      el.style.zIndex = String(Math.round(m.p * 100))
      if (fresh) el.style.transition = 'none'
      place(m.id, el)
      if (fresh) {
        void el.offsetWidth
        el.style.transition = ''
      }
      el.classList.toggle('lit', m.id === litId)
    }

    field.classList.toggle('slack', s.slack)
    prev = s

    if (instant) {
      void field.offsetWidth
      field.classList.remove('instant')
    }
  }

  function reset() {
    // Not just `live`'s elements: a departed mark is dropped from `live`
    // immediately but lingers in the DOM for its sink/absorb animation.
    field.replaceChildren()
    live.clear()
    layout.reset()
    prev = null
    litId = null
    field.classList.remove('slack', 'instant')
    seedGhosts(seeds)
  }

  /**
   * Recompute every live mark's position from the current field box (e.g.
   * after a viewport resize). Ghosts are repositioned without a transition;
   * real marks may animate to their new spot. Ported from the prototype's
   * `resize` handler (docs/design/sounding-phone.template.html).
   */
  function relayout() {
    for (const [id, el] of live) {
      const isGhost = el.classList.contains('ghost')
      if (isGhost) {
        const prevTransition = el.style.transition
        el.style.transition = 'none'
        place(id, el)
        void el.offsetWidth
        el.style.transition = prevTransition
      } else {
        place(id, el)
      }
    }
  }

  function onTap(cb: (id: string) => void) {
    tapCbs.push(cb)
  }

  return { apply, seedGhosts, clearGhosts, setLit, reset, relayout, onTap }
}

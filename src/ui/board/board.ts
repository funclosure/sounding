import { SlotLayout, separate, columnOrder, columnFontPx } from './layout'
import type { Placed } from './layout'
import { diffReadings } from './model'
import type { ReadingSnapshot } from './model'

export interface Board {
  apply(s: ReadingSnapshot, opts?: { instant?: boolean }): void
  seedGhosts(labels: Array<{ id: string; label: string }>): void
  clearGhosts(): void
  setLit(id: string | null): void
  reset(): void
  relayout(): void
  /**
   * The ending: the marks leave their slots and draw together into one
   * column at the top, strongest first. Stays that way (through later
   * readings and resizes) until `release()` or `reset()`.
   */
  gather(opts?: { instant?: boolean }): void
  release(): void
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
export function createBoard(field: HTMLElement, opts: { onColumn?: (bottom: number | null) => void } = {}): Board {
  const layout = new SlotLayout()
  const live = new Map<string, HTMLElement>()
  let prev: ReadingSnapshot | null = null
  let litId: string | null = null
  let seeds: Array<{ id: string; label: string }> = []
  const tapCbs: Array<(id: string) => void> = []
  let gathered = false

  function emitTap(id: string) {
    for (const cb of tapCbs) cb(id)
  }

  // Padding added to a mark's raw half-width before it's handed to
  // `layout.position`'s wall clamp (see `settleAll`, and layout.ts).
  const WALL_PAD = 8

  function place(id: string, el: HTMLElement) {
    const w = field.clientWidth
    const h = field.clientHeight
    // Raw half-width, unclamped: `layout.position` clamps it against
    // `w * 0.45` internally (see layout.ts). Only used for ghosts seeded
    // before any `apply()`/`relayout()` has run `settleAll`'s separation
    // pass over them.
    const half = el.getBoundingClientRect().width / 2 + WALL_PAD
    const { x, y } = layout.position(id, { width: w, height: h }, half)
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }

  /**
   * Recompute every live mark's (real + ghost) slot position, run one
   * `separate` pass over the whole field so no two marks' boxes overlap,
   * then commit final `left`/`top`. Ids in `instantIds` get their new
   * position applied with transitions suppressed for one frame (fresh
   * marks in `apply()`, every ghost in `relayout()`) so they jump instead
   * of animating in from the wrong spot.
   */
  function settleAll(instantIds: Set<string>) {
    if (gathered) return columnAll()
    const w = field.clientWidth
    const h = field.clientHeight
    const box = { width: w, height: h }

    const prevTransitions = new Map<string, string>()
    for (const id of instantIds) {
      const el = live.get(id)
      if (!el) continue
      prevTransitions.set(id, el.style.transition)
      el.style.transition = 'none'
    }

    const placed: Placed[] = []
    for (const [id, el] of live) {
      // Measured *after* font-size/weight are set for this apply, and with
      // the element's transform scale at its steady-state 1 — see place().
      const rect = el.getBoundingClientRect()
      const halfH = rect.height / 2
      // `layout.position`'s wall clamp (clampX) and `separate`'s own wall
      // clamp must agree on the same half-width, or a mark that `position`
      // placed flush against the padded wall gets re-clamped by `separate`
      // to a tighter (unpadded) bound and visibly snaps inward — so the
      // padded half-width is what `separate` receives as `halfW` too (it
      // also folds into `separate`'s pairwise-overlap test, which just
      // means two marks are held `WALL_PAD` px further apart than their
      // rendered edges strictly require — harmless).
      const halfW = rect.width / 2 + WALL_PAD
      const { x, y } = layout.position(id, box, halfW)
      placed.push({ id, x, y, halfW, halfH })
    }

    const separated = separate(placed, box)
    for (const p of separated) {
      const el = live.get(p.id)
      if (!el) continue
      el.style.left = `${p.x}px`
      el.style.top = `${p.y}px`
    }

    for (const id of instantIds) {
      const el = live.get(id)
      if (!el) continue
      void el.offsetWidth
      el.style.transition = prevTransitions.get(id) ?? ''
    }
  }

  /**
   * The gathered board: every mark of the last reading in one centred
   * column, ranked by prominence, a little smaller than on the open board so
   * the wrap has room underneath. Marks that would run past the upper half
   * step back (`away`), as do ghosts. Reports where the column ends.
   */
  function columnAll() {
    const w = field.clientWidth
    const h = field.clientHeight
    const order = columnOrder(prev?.marks ?? [])
    const rank = new Map(order.map((m, i) => [m.id, i]))
    let y = Math.max(22, Math.min(64, h * 0.09))
    const limit = Math.max(y + 60, h * 0.48)
    let full = false
    for (const m of order) {
      const el = live.get(m.id)
      if (!el) continue
      let size = columnFontPx(m.p, w < 640)
      // Width at the new size, from the width now: the font size may be mid-transition, so it cannot simply be measured.
      const nowPx = parseFloat(getComputedStyle(el).fontSize) || size
      const width = (el.offsetWidth * size) / nowPx
      if (width > w - 36) size = Math.max(13, Math.floor((size * (w - 36)) / width))
      const row = size * (w < 640 ? 1.38 : 1.45)
      if (full || (y + row > limit && rank.get(m.id)! > 0)) {
        full = true
        el.classList.add('away')
        continue
      }
      el.classList.remove('away')
      el.style.fontSize = `${size}px`
      el.style.left = `${w / 2}px`
      el.style.top = `${y + row / 2}px`
      y += row
    }
    for (const [id, el] of live) if (!rank.has(id)) el.classList.add('away')
    opts.onColumn?.(order.length ? y : null)
  }

  function gather(o?: { instant?: boolean }) {
    gathered = true
    field.classList.remove('slack')
    field.classList.add('gathered')
    if (o?.instant) field.classList.add('instant')
    columnAll()
    if (o?.instant) {
      void field.offsetWidth
      field.classList.remove('instant')
    }
  }

  function release() {
    if (!gathered) return
    gathered = false
    field.classList.remove('gathered')
    for (const el of live.values()) el.classList.remove('away')
    opts.onColumn?.(null)
    if (prev) {
      const p = prev
      prev = null
      apply(p)
    }
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
    const freshIds = new Set<string>()
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
      freshIds.add(id)
    }
    // `place()` above only slots each new ghost against the *current* live
    // set in first-appearance order — it never checks a new ghost against
    // marks seeded (or arrived) after it, so two ghosts seeded together, or
    // a ghost seeded onto a field that already has real marks, can still
    // overlap. Run the same separation pass `apply()`/`relayout()` use so
    // seeding after surfacing settles everyone, new ghosts included; the
    // new ghosts jump straight to their settled spot (never painted before
    // now, so nothing to glide from) while any already-live mark they
    // displace glides out of the way.
    if (freshIds.size > 0) settleAll(freshIds)
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

  function apply(s: ReadingSnapshot, o?: { instant?: boolean }) {
    const instant = !!o?.instant
    if (instant) field.classList.add('instant')

    const diff = diffReadings(prev, s)

    for (const d of diff.departed) {
      const el = live.get(d.id)
      if (!el) continue
      live.delete(d.id)
      if (d.reason === 'displaced' || d.reason === 'dismissed') {
        el.classList.add('sink')
        el.style.transform = 'translate(-50%, 60%)'
      } else {
        el.classList.add('absorbed')
      }
      setTimeout(() => el.remove(), instant ? 0 : DEPART_MS)
    }

    const freshIds = new Set<string>()

    for (const m of s.marks) {
      let el = live.get(m.id)
      const size = Math.round(15 + Math.min(0.5, m.p) * 62)
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
      } else if (el.textContent !== m.label) {
        // renamed by the speaker (or a scrub across a rename): same mark, new word
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
      // One weight throughout: size and ink strength carry prominence.
      el.style.opacity = String(0.5 + Math.min(0.5, m.p))
      el.style.zIndex = String(Math.round(m.p * 100))
      if (fresh) freshIds.add(m.id)
      el.classList.toggle('lit', m.id === litId)
    }

    prev = s
    // One separation pass over every live mark (real + ghost) so slot
    // placement's "first appearance" order can't leave two labels
    // overlapping. Gathered, the marks go to their column instead.
    settleAll(freshIds)

    field.classList.toggle('slack', s.slack && !gathered)

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
    if (gathered) opts.onColumn?.(null)
    gathered = false
    field.classList.remove('slack', 'instant', 'gathered')
    seedGhosts(seeds)
  }

  /**
   * Recompute every live mark's position from the current field box (e.g.
   * after a viewport resize). Ghosts are repositioned without a transition;
   * real marks may animate to their new spot. Ported from the prototype's
   * `resize` handler (docs/design/sounding-phone.template.html).
   */
  function relayout() {
    const ghostIds = new Set<string>()
    for (const [id, el] of live) {
      if (el.classList.contains('ghost')) ghostIds.add(id)
    }
    // Same separation pass as apply(): ghosts jump instantly (as before),
    // real marks animate to their resolved spot via the element's own
    // transition.
    settleAll(ghostIds)
  }

  function onTap(cb: (id: string) => void) {
    tapCbs.push(cb)
  }

  return { apply, seedGhosts, clearGhosts, setLit, reset, relayout, gather, release, onTap }
}

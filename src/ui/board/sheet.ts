export type Detent = 'peek' | 'medium' | 'large'

interface Drag {
  y: number
  start: number
  moved: boolean
  t0: number
  y0: number
}

/**
 * The bottom sheet: three detents (peek/medium/large), drag-to-resize, and
 * tabs. Ported from the prototype's `setDetent`/`fitBody`/drag handlers/
 * `showTab` (docs/design/sounding-phone.template.html).
 */
export function createSheet(
  root: HTMLElement,
  opts: { grab: HTMLElement; tabs: HTMLElement; body: HTMLElement; scrim: HTMLElement },
): { set(d: Detent): void; get(): Detent; showTab(name: string): void; onTab(cb: (name: string) => void): void } {
  const { grab, tabs, body, scrim } = opts
  let detent: Detent = 'peek'
  const tabCbs: Array<(name: string) => void> = []

  const DETENTS: Record<Detent, () => number> = {
    peek: () => root.clientHeight - 62,
    medium: () => Math.round(root.clientHeight * 0.5),
    large: () => Math.round(root.clientHeight * 0.09),
  }

  /** The sheet is full-height and translated; give the body exactly the visible height so panes fit at every detent. */
  function fitBody(translateY: number) {
    const header = grab.offsetHeight + tabs.offsetHeight
    body.style.height = `${Math.max(0, root.clientHeight - translateY - header)}px`
  }

  function set(d: Detent) {
    detent = d
    root.dataset.detent = d
    root.style.transform = `translateY(${DETENTS[d]()}px)`
    scrim.classList.toggle('on', d === 'large')
    fitBody(DETENTS[d]())
  }

  function get(): Detent {
    return detent
  }

  function showTab(name: string) {
    tabs.querySelectorAll<HTMLElement>('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)))
    body.querySelectorAll<HTMLElement>('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === name))
    for (const cb of tabCbs) cb(name)
  }

  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!b?.dataset.tab) return
    showTab(b.dataset.tab)
    if (detent === 'peek') set('medium')
  })

  let sdrag: Drag | null = null
  const onDown = (e: PointerEvent) => {
    sdrag = { y: e.clientY, start: DETENTS[detent](), moved: false, t0: performance.now(), y0: e.clientY }
    root.classList.add('dragging')
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!sdrag) return
    const dy = e.clientY - sdrag.y
    if (Math.abs(dy) > 4) sdrag.moved = true
    const y = Math.max(DETENTS.large(), Math.min(DETENTS.peek(), sdrag.start + dy))
    root.style.transform = `translateY(${y}px)`
    fitBody(y)
  }
  const onUp = (e: PointerEvent) => {
    if (!sdrag) return
    const d = sdrag
    sdrag = null
    root.classList.remove('dragging')
    const y = DETENTS[detent]() + (e.clientY - d.y)
    const v = (e.clientY - d.y0) / Math.max(1, performance.now() - d.t0) // px per ms
    if (!d.moved) {
      set(detent === 'peek' ? 'medium' : detent === 'medium' ? 'large' : 'peek')
      return
    }
    if (v < -0.6) {
      set(detent === 'peek' ? 'medium' : 'large')
      return
    }
    if (v > 0.6) {
      set(detent === 'large' ? 'medium' : 'peek')
      return
    }
    const keys: Detent[] = ['peek', 'medium', 'large']
    const best = keys.reduce((a, b) => (Math.abs(DETENTS[b]() - y) < Math.abs(DETENTS[a]() - y) ? b : a))
    set(best)
  }
  for (const el of [grab, tabs]) {
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }
  scrim.addEventListener('click', () => set('medium'))

  function onTab(cb: (name: string) => void) {
    tabCbs.push(cb)
  }

  return { set, get, showTab, onTab }
}

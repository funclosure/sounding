export type Side = 'left' | 'right'
export interface PanelSpec { side: Side; min: number; max: number; default: number; key: string }
export type PanelState = Record<Side, { open: boolean; width: number }>

export function clampWidth(spec: PanelSpec, w: number): number {
  if (!Number.isFinite(w)) return spec.default
  return Math.max(spec.min, Math.min(spec.max, Math.round(w)))
}
export function encodeState(s: PanelState): string {
  return JSON.stringify(s)
}
export function decodeState(raw: string | null, defaults: PanelState): PanelState {
  if (!raw) return defaults
  try {
    const p = JSON.parse(raw) as Partial<PanelState>
    const pick = (side: Side) => {
      const v = p?.[side]
      return v && typeof v.open === 'boolean' && Number.isFinite(v.width) ? { open: v.open, width: v.width } : defaults[side]
    }
    return { left: pick('left'), right: pick('right') }
  } catch {
    return defaults
  }
}

const KEY = 'sounding.panels'
export function createPanels(
  root: HTMLElement,
  specs: Record<Side, PanelSpec>,
  onChange: () => void,
): { open(side: Side, v?: boolean): void; isOpen(side: Side): boolean; toggle(side: Side): void } {
  const defaults: PanelState = { left: { open: false, width: specs.left.default }, right: { open: false, width: specs.right.default } }
  let state: PanelState
  try {
    state = decodeState(localStorage.getItem(KEY), defaults)
  } catch {
    state = defaults
  }
  state.left.width = clampWidth(specs.left, state.left.width)
  state.right.width = clampWidth(specs.right, state.right.width)
  const el = (side: Side) => root.querySelector<HTMLElement>(`.panel-${side}`)!
  const grip = (side: Side) => root.querySelector<HTMLElement>(`.panel-${side} .grip`)!
  const tab = (side: Side) => root.querySelector<HTMLElement>(`.edge.${side}`)!
  // Effective width per side: the user's chosen width, clamped so the
  // centre field (#field) keeps at least 320px even on a narrow window —
  // computed against the *other* panel's own effective width so the two
  // clamps don't reference each other's pre-clamp value.
  function effectiveWidth(side: Side): number {
    if (!state[side].open) return 0
    const other: Side = side === 'left' ? 'right' : 'left'
    const avail = root.clientWidth - (state[other].open ? state[other].width : 0) - 320
    return Math.min(state[side].width, Math.max(specs[side].min, avail))
  }
  function paint() {
    for (const side of ['left', 'right'] as Side[]) {
      const p = el(side)
      const w = effectiveWidth(side)
      p.style.width = `${w}px`
      p.classList.toggle('open', state[side].open)
      tab(side).setAttribute('aria-expanded', String(state[side].open))
      root.style.setProperty(`--${side}-w`, state[side].open ? `${w}px` : '0px')
    }
    try {
      // Persist the user's chosen width, not the effective (viewport-clamped)
      // one — resizing the window back out should restore what they picked.
      localStorage.setItem(KEY, encodeState(state))
    } catch {
      /* storage unavailable */
    }
    onChange()
  }
  function open(side: Side, v = true) {
    state[side].open = v
    paint()
  }
  for (const side of ['left', 'right'] as Side[]) {
    tab(side).addEventListener('click', () => open(side, !state[side].open))
    let drag: { x: number; w: number } | null = null
    const g = grip(side)
    g.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, w: state[side].width }
      g.setPointerCapture(e.pointerId)
      root.classList.add('resizing')
    })
    g.addEventListener('pointermove', (e) => {
      if (!drag) return
      const dx = e.clientX - drag.x
      state[side].width = clampWidth(specs[side], side === 'left' ? drag.w + dx : drag.w - dx)
      paint()
    })
    const end = () => {
      drag = null
      root.classList.remove('resizing')
    }
    g.addEventListener('pointerup', end)
    g.addEventListener('pointercancel', end)
  }
  const desktopMq = window.matchMedia('(min-width: 720px)')
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (!desktopMq.matches) return // the panels are hidden below 720px — T/C have no target to toggle
    if ((e.target as HTMLElement | null)?.closest?.('textarea, input')) return
    for (const side of ['left', 'right'] as Side[]) if (e.key.toLowerCase() === specs[side].key) open(side, !state[side].open)
  })
  window.addEventListener('resize', paint)
  paint()
  return { open, isOpen: (side: Side) => state[side].open, toggle: (side: Side) => open(side, !state[side].open) }
}

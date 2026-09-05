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
  function paint() {
    for (const side of ['left', 'right'] as Side[]) {
      const p = el(side)
      p.style.width = `${state[side].width}px`
      p.classList.toggle('open', state[side].open)
      tab(side).setAttribute('aria-expanded', String(state[side].open))
    }
    root.style.setProperty('--left-w', state.left.open ? `${state.left.width}px` : '0px')
    root.style.setProperty('--right-w', state.right.open ? `${state.right.width}px` : '0px')
    try {
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
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement | null)?.closest?.('textarea, input')) return
    for (const side of ['left', 'right'] as Side[]) if (e.key.toLowerCase() === specs[side].key) open(side, !state[side].open)
  })
  paint()
  return { open, isOpen: (side: Side) => state[side].open, toggle: (side: Side) => open(side, !state[side].open) }
}

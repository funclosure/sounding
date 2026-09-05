export function createPopover(anchor: HTMLElement, panel: HTMLElement): { open(): void; close(): void; isOpen(): boolean } {
  let on = false
  const place = () => {
    const a = anchor.getBoundingClientRect()
    const host = panel.offsetParent as HTMLElement | null
    const h = host ? host.getBoundingClientRect() : { left: 0, top: 0 }
    panel.style.left = `${a.left + a.width / 2 - h.left}px`
    panel.style.bottom = `${(h.top + (host?.clientHeight ?? window.innerHeight)) - a.top + 12}px`
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  const onDoc = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close()
  }
  function open() {
    on = true
    panel.hidden = false
    place()
    panel.classList.add('open')
    document.addEventListener('keydown', onKey)
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    window.addEventListener('resize', place)
  }
  function close() {
    if (!on) return
    on = false
    panel.classList.remove('open')
    setTimeout(() => {
      if (!on) panel.hidden = true
    }, 250)
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('mousedown', onDoc)
    window.removeEventListener('resize', place)
  }
  return { open, close, isOpen: () => on }
}

// The salience field behind the board: the dot landscape from funclosure.xyz,
// breathing while there is talk. Three things move it:
//   breath   — the drifting bands wake while words arrive and settle in silence
//   presence — a pool of dots gathers under each mark, larger with its prominence,
//              brighter for a moment when the mark is supported again
//   echo     — every heard word sends a ring out through the dots
// When a sounding ends the echo comes back: while the board is gathering, rings close in on the marks
// (`gather`), and the text of the wrap gets a clearing of its own (`clear`).
// It is quiet everywhere and turns vivid around the pointer, which is a patch of the field itself. A dot with nothing
// to say is not drawn, and each mark sits in a clearing so its label stays readable.
// Wall clock allowed: this is decoration, never part of the reading.

export interface Dots {
  /** Words just heard: wakes the breath and sends a ring from the voice. */
  heard(count: number): void
  /** A mark was supported (appeared or nudged up): its pool brightens and, unless `ring` is false, rings. */
  pulse(conceptId: string, ring?: boolean): void
  /** The ending: while on, rings close in on the marks, one after another. */
  gather(on: boolean): void
  stop(): void
}

export interface DotsOptions {
  /** The marks' container; live marks are read from it (`.mark[data-id]`). */
  field: HTMLElement
  /** Where plain words ring from. */
  voice: HTMLElement
  /** A block of text laid on the field (the wrap): no dots behind it while it is shown. */
  clear?: HTMLElement
}

const TAU = Math.PI * 2
const QUIET = 0.6
const VIVID = 1.45
const POINTER_REACH = 210
const POINTER_PATCH = 150
/** The pointer's share of its full effect when it is nowhere near a mark. */
const POINTER_OPEN = 0.22
const RING_LIFE_S = 2.6
/** An inward ring starts this far out and closes on its centre over its life. */
const INWARD_FROM = 500
const INWARD_EVERY_S = 0.95
/** How far a text block's clearing reaches past its box, in px. */
export const BOX_CLEAR = 56
/** How far the clearing reaches past a label's box, in px. */
export const CLEAR_X = 56
export const CLEAR_Y = 48

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const smoothstep = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a))
  return u * u * (3 - 2 * u)
}

/**
 * The ceiling a label puts on a dot at (dx, dy) from its centre: 0 behind and
 * just around the word (no dot at all), rising over a short edge to no limit
 * at the clearing's reach. Infinity outside it.
 */
export function clearingCeiling(dx: number, dy: number, halfW: number, halfH: number): number {
  const ax = Math.abs(dx) - halfW
  const ay = Math.abs(dy)
  const reachY = halfH + CLEAR_Y
  if (ay > reachY || ax > CLEAR_X) return Infinity
  const out = smoothstep(0.6, 1, Math.hypot(ay / reachY, Math.max(0, ax) / CLEAR_X))
  return out >= 1 ? Infinity : 1.6 * out * out
}

/**
 * The ceiling a block of text puts on a dot at (dx, dy) from its centre: no
 * dot behind the block or within a few px of it, rising to no limit at
 * `BOX_CLEAR` from its edge. Infinity outside that.
 */
export function boxCeiling(dx: number, dy: number, halfW: number, halfH: number): number {
  const d = Math.hypot(Math.max(0, Math.abs(dx) - halfW), Math.max(0, Math.abs(dy) - halfH))
  if (d >= BOX_CLEAR) return Infinity
  const out = smoothstep(8, BOX_CLEAR, d)
  return 1.6 * out * out
}

/** A mark's share of the field (0..1) from its rendered font size: the board sizes marks 15px + up to 31px by prominence. */
export function prominenceFromFontPx(px: number): number {
  return clamp((px - 15) / 62, 0, 0.5)
}

/** The undercurrent from funclosure.xyz: two warped sine bands, 0..0.34. */
export function band(x: number, y: number, t: number): number {
  const wx = x + 110 * Math.sin(y * 0.004 + t * 0.35)
  const wy = y + 85 * Math.sin(x * 0.003 - t * 0.28)
  const b = Math.sin(wx * 0.01 + t * 0.55) * Math.sin(wy * 0.013 - t * 0.42 + Math.sin(wx * 0.002 + t * 0.2) * 2)
  return 0.34 * Math.max(0, b) ** 2
}

interface Pool { id: string; x: number; y: number; halfW: number; halfH: number; prom: number; target: number; life: number; pulse: number; r: number; seen: boolean }
interface Ring { x: number; y: number; born: number; s: number; inward?: boolean }

const hex = (c: string): number[] => {
  const h = c.trim().replace('#', '')
  const full = h.length === 3 ? [...h].map((ch) => ch + ch).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0)
}
const mix = (p: number[], q: number[], u: number) =>
  `rgb(${Math.round(p[0] + (q[0] - p[0]) * u)},${Math.round(p[1] + (q[1] - p[1]) * u)},${Math.round(p[2] + (q[2] - p[2]) * u)})`

export function createDots(canvas: HTMLCanvasElement, o: DotsOptions): Dots {
  const g = canvas.getContext('2d')
  // Reduced motion: the field is movement and nothing else, so it stays off.
  if (!g || matchMedia('(prefers-reduced-motion: reduce)').matches) return { heard() {}, pulse() {}, gather() {}, stop() {} }

  let W = 0, H = 0, DOT = 24, cols = 0, rows = 0
  let eased = new Float32Array(0)
  let col = { dot: [0, 0, 0], accent: [0, 0, 0], hot: [0, 0, 0], alpha: 0.7 }
  const readColours = () => {
    const s = getComputedStyle(document.documentElement)
    col = {
      dot: hex(s.getPropertyValue('--ink-quiet')), accent: hex(s.getPropertyValue('--light')), hot: hex(s.getPropertyValue('--ink')),
      alpha: document.documentElement.classList.contains('dark') ? 0.95 : 0.7,
    }
  }
  const resize = () => {
    const r = canvas.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    W = r.width; H = r.height; DOT = W < 640 ? 28 : 24
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    cols = Math.ceil(W / DOT); rows = Math.ceil(H / DOT)
    eased = new Float32Array((rows + 1) * (cols + 1))
  }

  const pools = new Map<string, Pool>()
  const rings: Ring[] = []
  let activity = 0
  let lastWordAt = -1e9
  let flowT = 0
  let voice = { x: 0, y: 0 }
  let box: { x: number; y: number; halfW: number; halfH: number } | null = null
  let gathering = false
  let lastInwardAt = -1e9

  // The marks are the board's own elements; read where they are a few times a
  // second (they glide between slots over 1.4s, and the pools ease after them).
  const readMarks = () => {
    const c = canvas.getBoundingClientRect()
    for (const p of pools.values()) p.seen = false
    for (const el of Array.from(o.field.querySelectorAll<HTMLElement>('.mark[data-id]'))) {
      if (el.classList.contains('sink') || el.classList.contains('absorbed') || el.classList.contains('ghost') || el.classList.contains('away')) continue
      const id = el.dataset.id!
      const r = el.getBoundingClientRect()
      let p = pools.get(id)
      if (!p) { p = { id, x: 0, y: 0, halfW: 0, halfH: 0, prom: 0, target: 0, life: 0, pulse: 1, r: 50, seen: true }; pools.set(id, p) }
      p.seen = true
      p.x = r.left - c.left + r.width / 2
      p.y = r.top - c.top + r.height / 2
      p.halfW = r.width / 2
      p.halfH = r.height / 2
      p.target = prominenceFromFontPx(parseFloat(getComputedStyle(el).fontSize))
    }
    const v = o.voice.getBoundingClientRect()
    voice = { x: v.left - c.left + v.width / 2, y: v.top - c.top + v.height / 2 }
    const b = o.clear && !o.clear.hidden ? o.clear.getBoundingClientRect() : null
    box = b && b.width > 0 ? { x: b.left - c.left + b.width / 2, y: b.top - c.top + b.height / 2, halfW: b.width / 2, halfH: b.height / 2 } : null
  }

  // quiet everywhere, vivid around the pointer (or a finger while it is down)
  let px = -1e4, py = -1e4, tx = px, ty = py, near = 0, nearTarget = 0
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    tx = e.clientX - r.left; ty = e.clientY - r.top
    if (px < -1e3) { px = tx; py = ty }
    nearTarget = 1
  }
  const onUp = (e: PointerEvent) => { if (e.pointerType !== 'mouse') nearTarget = 0 }
  const onLeave = () => { nearTarget = 0 }

  let last = 0
  let lastRead = -1
  let raf = 0
  let running = false
  const frame = (ms: number) => {
    const t = ms / 1000
    const dt = Math.min(0.1, Math.max(0, t - last)); last = t
    if (t - lastRead > 0.12) { readMarks(); lastRead = t }
    const talking = t - lastWordAt < 1.3 ? 1 : 0
    activity += (talking - activity) * (1 - Math.exp(-dt / (talking ? 0.5 : 2.6)))
    flowT += dt * (0.3 + 0.9 * activity)
    const pk = 1 - Math.exp(-dt * 6)
    px += (tx - px) * pk; py += (ty - py) * pk
    near += (nearTarget - near) * (1 - Math.exp(-dt * 2.5))
    for (const p of pools.values()) {
      p.prom += ((p.seen ? p.target : 0) - p.prom) * (1 - Math.exp(-dt / 1.2))
      p.life += ((p.seen ? 1 : 0) - p.life) * (1 - Math.exp(-dt / 1.1))
      p.pulse *= Math.exp(-dt / 1.4)
      p.r = (46 + 190 * Math.sqrt(p.prom)) * (W < 640 ? 0.7 : 1)
      if (!p.seen && p.life < 0.02) pools.delete(p.id)
    }
    for (let i = rings.length - 1; i >= 0; i--) if (t - rings[i].born > RING_LIFE_S) rings.splice(i, 1)
    const live = [...pools.values()].filter((p) => p.life > 0.01)
    if (gathering && t - lastInwardAt > INWARD_EVERY_S) {
      // the echo coming back: toward the middle of the marks, or the upper field when there are none
      let cx = W / 2, cy = H * 0.3
      if (live.length) { cx = 0; cy = 0; for (const p of live) { cx += p.x / live.length; cy += p.y / live.length } }
      rings.push({ x: cx, y: cy, born: t, s: 0.55, inward: true })
      lastInwardAt = t
    }
    const amb = 0.3 + 1.25 * activity
    // How much the pointer may stir: fully beside a mark, only a little out in the open field.
    let beside = 0
    for (const p of live) beside = Math.max(beside, p.life * Math.exp(-((px - p.x) ** 2 + (py - p.y) ** 2) / ((p.r + 110) ** 2)))
    const stir = near * (POINTER_OPEN + (1 - POINTER_OPEN) * beside)

    g.clearRect(0, 0, W, H)
    const k = 1 - Math.exp(-dt / 0.28)
    let idx = 0
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++, idx++) {
        const x = i * DOT + ((j % 2) * DOT) / 2 // offset rows: the site's hex-ish grid
        const y = j * DOT
        let b = amb * band(x, y, flowT)
        let ceiling = Infinity
        let keep = 1
        for (const p of live) {
          const dx = x - p.x, dy = y - p.y, d2 = dx * dx + dy * dy
          if (d2 < p.r * p.r * 6) keep *= 1 - Math.min(0.97, p.life * (0.66 + 0.5 * p.pulse)) * Math.exp(-d2 / (p.r * p.r))
          const c = clearingCeiling(dx, dy, p.halfW, p.halfH)
          if (c < ceiling) ceiling = c
        }
        if (box) {
          const c = boxCeiling(x - box.x, y - box.y, box.halfW, box.halfH)
          if (c < ceiling) ceiling = c
        }
        // pools and rings screen over the bands, so overlaps merge instead of creasing
        const blob = 1.08 * (1 - keep)
        b = b + blob - b * blob
        for (const r of rings) {
          const age = t - r.born
          const d = Math.hypot(x - r.x, y - r.y) - (r.inward ? Math.max(0, INWARD_FROM - age * 190) : 20 + age * 190)
          if (d > 60 || d < -60) continue
          // an inward ring swells as it closes and is gone as it arrives
          const fade = r.inward ? Math.sin(Math.PI * Math.min(1, age / RING_LIFE_S)) ** 0.8 : (1 - age / RING_LIFE_S) ** 1.5
          const v = r.s * fade * Math.exp(-((d / 20) ** 2))
          b = b + v - b * v
        }
        const close = near < 0.01 ? 0 : near * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (POINTER_REACH * POINTER_REACH))
        const stirShare = near < 0.01 ? 0 : stir / near
        b *= QUIET + (VIVID - QUIET) * close * stirShare
        // the pointer is itself a patch of the field, as on the site: every dot near it comes up, not only those already saying something
        if (close > 0) {
          const pd2 = (x - px) ** 2 + (y - py) ** 2
          const v = 0.9 * stir * Math.exp(-pd2 / (POINTER_PATCH * POINTER_PATCH)) * (0.82 + 0.18 * Math.sin(t * 1.1 + x * 0.013 - y * 0.009))
          b = b + v - b * v
        }
        b = Math.min(b, ceiling)
        // no resting grid: only around the pointer does every dot show
        b = Math.max(Math.min(0.06 * close, ceiling), b)
        b = eased[idx] += (b - eased[idx]) * k
        if (b < 0.012) continue
        g.globalAlpha = col.alpha * (0.12 + 0.88 * Math.min(1, b)) * smoothstep(0.012, 0.09, b)
        g.fillStyle = b < 0.85 ? mix(col.dot, col.accent, smoothstep(0.38, 0.62, b)) : mix(col.accent, col.hot, smoothstep(0.95, 1.25, b))
        g.beginPath()
        g.arc(x, y, 1.2 + 5 * Math.min(b, 1.25), 0, TAU)
        g.fill()
      }
    }
    raf = requestAnimationFrame(frame)
  }
  const sync = () => {
    const want = !document.hidden
    if (want && !running) { last = performance.now() / 1000; raf = requestAnimationFrame(frame) }
    if (!want && running) cancelAnimationFrame(raf)
    running = want
  }

  const ro = new ResizeObserver(resize)
  const mo = new MutationObserver(readColours)
  ro.observe(canvas)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  addEventListener('pointermove', onMove, { passive: true })
  addEventListener('pointerup', onUp, { passive: true })
  addEventListener('pointercancel', onUp, { passive: true })
  document.documentElement.addEventListener('pointerleave', onLeave)
  document.addEventListener('visibilitychange', sync)
  readColours()
  resize()
  sync()

  return {
    heard(count) {
      if (count <= 0) return
      const t = performance.now() / 1000
      lastWordAt = t
      rings.push({ x: voice.x, y: voice.y, born: t, s: 0.3 })
    },
    pulse(conceptId, ring = true) {
      const p = pools.get(conceptId)
      if (!p) return
      p.pulse = 1
      if (ring) rings.push({ x: p.x, y: p.y, born: performance.now() / 1000, s: 0.7 })
    },
    gather(on) {
      gathering = on
    },
    stop() {
      cancelAnimationFrame(raf)
      running = false
      ro.disconnect(); mo.disconnect()
      removeEventListener('pointermove', onMove)
      removeEventListener('pointerup', onUp)
      removeEventListener('pointercancel', onUp)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', sync)
    },
  }
}

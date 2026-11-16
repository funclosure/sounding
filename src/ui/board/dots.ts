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
// The pointer also touches the dots: it nudges those near it aside, each tied to its place by a spring and never
// more than `FARTHEST` from it, and a moving pointer (or a tap on the bare board) sets off a ripple under them.
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

// The pointer's touch, as tuned in the ripple prototype.
/** How hard the pointer pushes the dots near it aside (under 1.16, so no dot passes another). */
export const NUDGE = 0.425
/** How far the push reaches, px: on a narrow board, on a wide one. */
const NUDGE_REACH_NARROW = 64
const NUDGE_REACH = 78
/** The farthest a dot goes from its place, px: a soft limit, the pull home growing the farther it goes. */
export const FARTHEST = 32
/** The spring tying a dot to its place: stiff enough to keep up with a hand, damped to a slight sway home. */
const SPRING_K = 121
const SPRING_C = 2 * (1 - 0.75 * 0.15) * Math.sqrt(SPRING_K)
/** How much the pointer stirs the wave field under the dots. */
const RIPPLE = 0.25
/** How fast a ripple runs (px/s), and how long it takes to die down to about a third (s). */
export const WAVE_SPEED = 322
export const WAVE_LASTS = 2
/** The wave field moves in steps of this many seconds, whatever the frame rate. */
export const WAVE_STEP = 1 / 60
const WAVE_SIGMA = 34
/** A tap on the bare board drops a ring into the field; lifting the finger lets one go the other way. */
const TAP = -1.1
const LIFT = 0.6
/** A dot shifts with the wave's slope (at most `WAVE_SHIFT` px) and lights with its height. */
const WAVE_TILT = 26
const WAVE_SHIFT = 14

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

export interface DotColours { dot: number[]; accent: number[]; hot: number[]; alpha: number }
/** The field's colours, from the mood the page is wearing. */
export function readDotColours(): DotColours {
  const s = getComputedStyle(document.documentElement)
  return {
    dot: hex(s.getPropertyValue('--ink-quiet')), accent: hex(s.getPropertyValue('--light')), hot: hex(s.getPropertyValue('--ink')),
    alpha: document.documentElement.classList.contains('dark') ? 0.95 : 0.7,
  }
}
/** How one dot is painted for what it has to say (b, about 0 to 1.25): fainter and smaller when quiet, the accent when loud. */
export function dotPaint(b: number, col: DotColours): { alpha: number; fill: string; r: number } {
  return {
    alpha: col.alpha * (0.12 + 0.88 * Math.min(1, b)) * smoothstep(0.012, 0.09, b),
    fill: b < 0.85 ? mix(col.dot, col.accent, smoothstep(0.38, 0.62, b)) : mix(col.accent, col.hot, smoothstep(0.95, 1.25, b)),
    r: 1.2 + 5 * Math.min(b, 1.25),
  }
}
/** A mark's pool reaches this far, from its share of the field. */
export const poolRadius = (prom: number): number => 46 + 190 * Math.sqrt(prom)

/** How far the pointer pushes a dot `d2` (px, squared) away from it: `strength` × `reach` right under it, gone by three reaches. */
export function nudgePush(d2: number, strength: number, reach: number): number {
  return d2 < 9 * reach * reach ? strength * reach * Math.exp(-d2 / (reach * reach)) : 0
}

/** The share of an offset `m` px long that a dot keeps under the soft limit: nearly all of a small one, and never past `limit`. */
export function tetherScale(m: number, limit: number): number {
  return m > 0.01 ? (limit * Math.tanh(m / limit)) / m : 1
}

/**
 * Lay a soft bump of `amt` into the wave field's motion around (x, y). The field has one cell per dot, on the
 * dots' grid of `cols` + 1 by `rows` + 1, `dot` px apart, with odd rows half a step over.
 */
export function disturb(v: Float32Array, cols: number, rows: number, dot: number, x: number, y: number, amt: number, sigma = WAVE_SIGMA): void {
  const n = cols + 1
  const reach = sigma * 3
  const j0 = Math.max(0, Math.floor((y - reach) / dot)), j1 = Math.min(rows, Math.ceil((y + reach) / dot))
  for (let j = j0; j <= j1; j++) {
    const off = ((j % 2) * dot) / 2
    const i0 = Math.max(0, Math.floor((x - reach - off) / dot)), i1 = Math.min(cols, Math.ceil((x + reach - off) / dot))
    for (let i = i0; i <= i1; i++) v[j * n + i] += amt * Math.exp(-((i * dot + off - x) ** 2 + (j * dot - y) ** 2) / (sigma * sigma))
  }
}

/**
 * One step of the wave field under the dots: `c2` is how far a ripple runs in a step, in cells, squared; `damp` the
 * share of its motion it keeps. Past the edge the field is still. Returns the largest height or motion left, so a
 * field gone flat can stop being stepped.
 */
export function stepWave(h: Float32Array, v: Float32Array, cols: number, rows: number, c2: number, damp: number): number {
  const n = cols + 1
  for (let j = 0, idx = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++, idx++) {
      const c = h[idx]
      const lap = (i > 0 ? h[idx - 1] : 0) + (i < cols ? h[idx + 1] : 0) + (j > 0 ? h[idx - n] : 0) + (j < rows ? h[idx + n] : 0) - 4 * c
      v[idx] = (v[idx] + c2 * lap) * damp
    }
  }
  let most = 0
  for (let k = 0; k < h.length; k++) {
    h[k] += v[k]
    most = Math.max(most, Math.abs(h[k]), Math.abs(v[k]))
  }
  return most
}

export function createDots(canvas: HTMLCanvasElement, o: DotsOptions): Dots {
  const g = canvas.getContext('2d')
  // Reduced motion: the field is movement and nothing else, so it stays off.
  if (!g || matchMedia('(prefers-reduced-motion: reduce)').matches) return { heard() {}, pulse() {}, gather() {}, stop() {} }

  let W = 0, H = 0, DOT = 24, cols = 0, rows = 0
  let eased = new Float32Array(0)
  // the wave field (height, motion) and each dot's offset from its place (and how fast it moves), one cell per dot
  let wh = new Float32Array(0), wv = new Float32Array(0)
  let ox = new Float32Array(0), oy = new Float32Array(0), vx = new Float32Array(0), vy = new Float32Array(0)
  let waveC2 = 0, waveLive = false, springsLive = false, waveAcc = 0
  const waveDamp = Math.exp(-WAVE_STEP / WAVE_LASTS)
  let col: DotColours = { dot: [0, 0, 0], accent: [0, 0, 0], hot: [0, 0, 0], alpha: 0.7 }
  const readColours = () => { col = readDotColours() }
  const resize = () => {
    const r = canvas.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    W = r.width; H = r.height; DOT = W < 640 ? 28 : 24
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    cols = Math.ceil(W / DOT); rows = Math.ceil(H / DOT)
    const size = (rows + 1) * (cols + 1)
    eased = new Float32Array(size)
    wh = new Float32Array(size); wv = new Float32Array(size)
    ox = new Float32Array(size); oy = new Float32Array(size); vx = new Float32Array(size); vy = new Float32Array(size)
    waveC2 = (WAVE_SPEED * WAVE_STEP / DOT) ** 2
    waveLive = false; springsLive = false
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
  // where the eased pointer was a frame ago, and how fast it goes (px/s): a ripple follows speed, not presence
  let lpx = px, lpy = py, pspeed = 0
  let touching = false
  const aim = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    tx = e.clientX - r.left; ty = e.clientY - r.top
  }
  // arriving (or a finger coming down somewhere new) puts the pointer there at once, rather than gliding across the field
  const arrive = () => { px = lpx = tx; py = lpy = ty; pspeed = 0 }
  const drop = (x: number, y: number, amt: number) => {
    if (!W) return
    disturb(wv, cols, rows, DOT, x, y, amt * RIPPLE)
    waveLive = true
  }
  // only the bare board takes a tap: not a word, a button or a panel
  const bare = (t: EventTarget | null) => t === o.field || t === canvas.parentElement
  const onMove = (e: PointerEvent) => {
    aim(e)
    if (px < -1e3 || near < 0.02) arrive()
    nearTarget = 1
  }
  const onDown = (e: PointerEvent) => {
    aim(e)
    if (px < -1e3 || e.pointerType !== 'mouse') arrive()
    if (!bare(e.target)) return
    nearTarget = 1
    touching = e.pointerType !== 'mouse'
    drop(tx, ty, TAP)
  }
  const onUp = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return
    if (touching) drop(px, py, LIFT)
    touching = false
    nearTarget = 0
  }
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
    const pk = 1 - Math.exp(-dt * 10)
    px += (tx - px) * pk; py += (ty - py) * pk
    near += (nearTarget - near) * (1 - Math.exp(-dt * 2.5))
    if (dt > 0) pspeed += (Math.hypot(px - lpx, py - lpy) / dt - pspeed) * (1 - Math.exp(-dt * 12))
    lpx = px; lpy = py
    // a moving pointer disturbs the wave field under it, more the faster it goes; a still one leaves it be
    waveAcc += dt
    let steps = 0
    while (waveAcc >= WAVE_STEP && steps < 4) {
      const s = near > 0.05 ? clamp(pspeed / 700) : 0
      if (s > 0.01) drop(px, py, -0.04 * s * near)
      if (waveLive && stepWave(wh, wv, cols, rows, waveC2, waveDamp) < 1e-4) { waveLive = false; wh.fill(0); wv.fill(0) }
      waveAcc -= WAVE_STEP; steps++
    }
    if (steps === 4) waveAcc = 0
    for (const p of pools.values()) {
      p.prom += ((p.seen ? p.target : 0) - p.prom) * (1 - Math.exp(-dt / 1.2))
      p.life += ((p.seen ? 1 : 0) - p.life) * (1 - Math.exp(-dt / 1.1))
      p.pulse *= Math.exp(-dt / 1.4)
      p.r = poolRadius(p.prom) * (W < 640 ? 0.7 : 1)
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
    // the nudge: how hard the pointer pushes and how far; the dots follow on their springs and swing home after
    const push = NUDGE * near
    const pushing = push > 0.002
    const reach = W < 640 ? NUDGE_REACH_NARROW : NUDGE_REACH
    const springing = pushing || springsLive
    const sdt = Math.min(dt, 1 / 30)
    let unsettled = 0

    g.clearRect(0, 0, W, H)
    const k = 1 - Math.exp(-dt / 0.28)
    const n = cols + 1
    let idx = 0
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++, idx++) {
        const x = i * DOT + ((j % 2) * DOT) / 2 // offset rows: the site's hex-ish grid
        const y = j * DOT
        // where the dot is drawn: pushed out of the pointer's way, tilted by the wave, never far from its place
        let offX = 0, offY = 0
        if (springing) {
          let aimX = 0, aimY = 0
          if (pushing) {
            const dx = x - px, dy = y - py, d2 = dx * dx + dy * dy
            const f = d2 > 0.01 ? nudgePush(d2, push, reach) : 0
            if (f > 0) { const d = Math.sqrt(d2); aimX = (dx / d) * f; aimY = (dy / d) * f }
          }
          vx[idx] += (SPRING_K * (aimX - ox[idx]) - SPRING_C * vx[idx]) * sdt; ox[idx] += vx[idx] * sdt
          vy[idx] += (SPRING_K * (aimY - oy[idx]) - SPRING_C * vy[idx]) * sdt; oy[idx] += vy[idx] * sdt
          offX = ox[idx]; offY = oy[idx]
          unsettled = Math.max(unsettled, Math.abs(offX), Math.abs(offY), 0.1 * Math.abs(vx[idx]), 0.1 * Math.abs(vy[idx]))
        }
        const wave = waveLive ? wh[idx] : 0
        if (waveLive) {
          const gx = ((i < cols ? wh[idx + 1] : 0) - (i > 0 ? wh[idx - 1] : 0)) / 2
          const gy = ((j < rows ? wh[idx + n] : 0) - (j > 0 ? wh[idx - n] : 0)) / 2
          offX += clamp(gx * WAVE_TILT, -WAVE_SHIFT, WAVE_SHIFT)
          offY += clamp(gy * WAVE_TILT, -WAVE_SHIFT, WAVE_SHIFT)
        }
        if (offX !== 0 || offY !== 0) { const s = tetherScale(Math.hypot(offX, offY), FARTHEST); offX *= s; offY *= s }
        const X = x + offX, Y = y + offY
        // what the dot has to say is read where it rests; the clearings, where it is drawn
        let b = amb * band(x, y, flowT)
        let ceiling = Infinity
        let keep = 1
        for (const p of live) {
          const dx = x - p.x, dy = y - p.y, d2 = dx * dx + dy * dy
          if (d2 < p.r * p.r * 6) keep *= 1 - Math.min(0.97, p.life * (0.66 + 0.5 * p.pulse)) * Math.exp(-d2 / (p.r * p.r))
          const c = clearingCeiling(X - p.x, Y - p.y, p.halfW, p.halfH)
          if (c < ceiling) ceiling = c
        }
        if (box) {
          const c = boxCeiling(X - box.x, Y - box.y, box.halfW, box.halfH)
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
        // the wave lights what it lifts
        if (wave !== 0) {
          const wl = 0.2 * Math.min(1, Math.abs(wave))
          b = b + wl - b * wl
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
        const paint = dotPaint(b, col)
        g.globalAlpha = paint.alpha
        g.fillStyle = paint.fill
        g.beginPath()
        g.arc(X, Y, paint.r, 0, TAU)
        g.fill()
      }
    }
    // home and still: stop working the springs until the pointer pushes again
    if (springing) {
      springsLive = pushing || unsettled > 0.02
      if (!springsLive) { ox.fill(0); oy.fill(0); vx.fill(0); vy.fill(0) }
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
  addEventListener('pointerdown', onDown, { passive: true })
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
      removeEventListener('pointerdown', onDown)
      removeEventListener('pointerup', onUp)
      removeEventListener('pointercancel', onUp)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', sync)
    },
  }
}

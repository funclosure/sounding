// Draws the app icon: "Ripples", a still frame of the salience field from
// funclosure.xyz. An ink source, then two returns, the second fainter, on the
// site's dot grid (rows one step apart, every other row half a step over) in
// the night mood. One fixed drawing for every size.
//
//   node scripts/icon.mjs            writes public/icon.svg (rounded) and public/icon-square.svg (full bleed)
//
// The PNGs in public/ are icon-square.svg rasterised at 180, 192 and 512 px.
import { writeFileSync } from 'node:fs'

// the site's dark mood: night ground, blue rings, a pale source
const PAPER = '#16161b', INK = '#e9e4da', QUIET = '#8c867a', LIGHT = '#7884b0'
const N = 9 // dots across
const MARGIN = 0.13
const SIZE = 512

const clamp = (x) => Math.min(1, Math.max(0, x))
const ss = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u) }
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
const mix = (p, q, t) => p.map((x, i) => x + (q[i] - x) * t)
const ring = (q, at, w) => Math.exp(-(((q - at) / w) ** 2))

// how present the point is, 0..1.2; q is its distance from the centre in grid steps
const salience = (q) => Math.max(1.2 * Math.exp(-((q / 0.45) ** 2)), 0.95 * ring(q, 2, 0.4), 0.6 * ring(q, 4, 0.45), 0.06)

const [paper, ink, quiet, light] = [PAPER, INK, QUIET, LIGHT].map(hex)
const D = (1 - 2 * MARGIN) / (N - 1)
const h = (N - 1) / 2
const dots = []
for (let j = 0; j < N; j++) {
  const odd = j % 2
  for (let i = 0; i < N - odd; i++) {
    const x = i - h + odd / 2
    const y = j - h
    const b = salience(Math.hypot(x, y))
    // the field's rule: a dot grows, darkens and firms up as its point becomes more present
    const colour = b < 0.85 ? mix(quiet, light, ss(0.42, 0.68, b)) : mix(light, ink, ss(0.95, 1.15, b))
    const flat = mix(paper, colour, 0.32 + 0.68 * Math.min(1, b)).map(Math.round)
    const r = Math.min(D * 0.49, D * (0.1 + 0.36 * b))
    const n = (v) => (v * SIZE).toFixed(1).replace(/\.0$/, '')
    dots.push(`<circle cx="${n(0.5 + x * D)}" cy="${n(0.5 + y * D)}" r="${n(r)}" fill="#${flat.map((c) => c.toString(16).padStart(2, '0')).join('')}"/>`)
  }
}

const svg = (rx) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" rx="${rx}" fill="${PAPER}"/>
${dots.join('\n')}
</svg>
`
writeFileSync('public/icon.svg', svg(Math.round(SIZE * 0.224)))
writeFileSync('public/icon-square.svg', svg(0))
console.log(`icon: ${dots.length} dots`)

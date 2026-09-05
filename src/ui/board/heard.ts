/** How long a heard word lingers before it's removed (ms). */
const WORD_LIFETIME_MS = 1700

/**
 * The heard-words layer: transcribed words flash and shrink over the board.
 * Ported from the prototype's `flash` (docs/design/sounding-phone.template.html).
 * Extraction of which words to flash is the server's job (`live.heard`) —
 * this just animates whatever it's given.
 */
export function createHeard(layer: HTMLElement): { flash(words: string[]): void; clear(): void } {
  function flash(words: string[]) {
    const w = layer.clientWidth
    const h = layer.clientHeight
    words.forEach((word, i) => {
      setTimeout(() => {
        const el = document.createElement('span')
        el.className = 'word'
        el.textContent = word
        el.style.left = `${w * (0.2 + Math.random() * 0.6)}px`
        el.style.top = `${h * (0.55 + Math.random() * 0.3)}px`
        el.style.fontSize = `${34 + Math.random() * 14}px`
        layer.appendChild(el)
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('gone')))
        setTimeout(() => el.remove(), WORD_LIFETIME_MS)
      }, i * 140)
    })
  }

  function clear() {
    layer.innerHTML = ''
  }

  return { flash, clear }
}

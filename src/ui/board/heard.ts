/** At most this many words of the utterance are on the line at once. */
const MAX_WORDS = 9
/** How long a line stays once nothing more has been heard (ms). */
const LINGER_MS = 2600
/** How long a finished line takes to lift away (ms); matches the CSS transition. */
const LEAVE_MS = 1200

/**
 * The end of an utterance that fits on the line: its last `maxWords` words,
 * fewer if they would run past `maxChars`. `start` is the index of the first
 * kept word, so a word keeps its place as the window slides.
 */
export function captionWindow(text: string, maxWords = MAX_WORDS, maxChars = 64): { start: number; words: string[] } {
  const all = text.trim().split(/\s+/).filter((w) => w.length > 0)
  let start = all.length
  let chars = 0
  while (start > 0 && all.length - start < maxWords) {
    const next = chars + all[start - 1].length + 1
    if (next > maxChars && start < all.length) break
    chars = next
    start--
  }
  return { start, words: all.slice(start) }
}

/** How strongly the word `fromEnd` places back from the newest is inked: the last few fully, older ones thinning out. */
export function captionInk(fromEnd: number): number {
  return fromEnd < 4 ? 0.95 : Math.max(0.12, 0.95 - (fromEnd - 3) * 0.17)
}

/**
 * The heard line: what is being said right now, as one quiet line above the
 * round control. Each utterance is a line of its own; the words trail off
 * behind the newest, and a finished line lifts away as the next one starts.
 * The server sends the utterance so far (`live.heard`); this only draws it.
 */
export function createHeard(layer: HTMLElement): { say(line: number, text: string): void; clear(): void } {
  let current: { line: number; el: HTMLElement; spans: Map<number, HTMLElement> } | null = null
  let linger: ReturnType<typeof setTimeout> | null = null

  function retire() {
    if (!current) return
    const el = current.el
    el.classList.add('past')
    setTimeout(() => el.remove(), LEAVE_MS)
    current = null
  }

  function say(line: number, text: string) {
    if (current && current.line !== line) retire()
    if (!current) {
      const el = document.createElement('p')
      el.className = 'line'
      layer.appendChild(el)
      current = { line, el, spans: new Map() }
    }
    const { el, spans } = current
    el.classList.remove('quiet')
    // about 8px a character at this size; the line never wraps
    const { start, words } = captionWindow(text, MAX_WORDS, Math.max(16, Math.floor(layer.clientWidth / 8.4) - 4))
    for (const [i, span] of spans) {
      if (i >= start && i < start + words.length) continue
      span.remove()
      spans.delete(i)
    }
    words.forEach((word, k) => {
      const i = start + k
      let span = spans.get(i)
      if (!span) {
        span = document.createElement('span')
        span.className = 'in'
        span.style.opacity = '0'
        // before its successor when the window has slid back (a revision shortened the utterance)
        el.insertBefore(span, spans.get(i + 1) ?? null)
        spans.set(i, span)
        void span.offsetWidth
        span.classList.remove('in')
      }
      if (span.textContent !== word) span.textContent = word
      span.style.opacity = String(captionInk(words.length - 1 - k))
    })
    if (linger) clearTimeout(linger)
    linger = setTimeout(() => el.classList.add('quiet'), LINGER_MS)
  }

  function clear() {
    if (linger) clearTimeout(linger)
    linger = null
    current = null
    layer.innerHTML = ''
  }

  return { say, clear }
}

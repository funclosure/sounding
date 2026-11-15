// The own-keys site's `_headers` file, for Cloudflare Pages. Runs at build time
// in Node (vite.config.ts), never in the page.
//
// The page holds the listener's two keys in localStorage, so the one thing a
// host must add is a strict Content-Security-Policy: nothing runs but the
// site's own scripts, and nothing is reached but the two providers. The inline
// mood script in live.html is allowed by its hash, worked out from the built
// HTML, so the policy follows the page instead of being kept by hand.
import { createHash } from 'node:crypto'

/** Everything the page talks to besides itself: the hearing and the thinking. */
export const OWN_CONNECT = ['https://api.anthropic.com', 'https://api.elevenlabs.io', 'wss://api.elevenlabs.io'] as const

/** The bodies of the inline scripts in a page (the ones without `src`), exactly as written. */
export function inlineScripts(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(m[1] ?? '')) continue
    if (m[2].trim()) out.push(m[2])
  }
  return out
}

/** A CSP source for one inline script. */
export const scriptHash = (body: string): string => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`

export function contentSecurityPolicy(html: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScripts(html).map(scriptHash).join(' ')}`.trim(),
    // the board sets inline styles as it draws
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${OWN_CONNECT.join(' ')}`,
    // the picture is drawn on a canvas and handed on as a blob
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * The whole `_headers` file. `noindex` keeps the address out of search while
 * the site is for you alone (step 4 of the hosting plan); drop it when the
 * site opens to other people.
 */
export function siteHeaders(html: string, opts: { noindex: boolean } = { noindex: true }): string {
  const all = [
    `Content-Security-Policy: ${contentSecurityPolicy(html)}`,
    'Referrer-Policy: no-referrer',
    'X-Content-Type-Options: nosniff',
    'Permissions-Policy: microphone=(self), camera=(), geolocation=()',
    'Cross-Origin-Opener-Policy: same-origin',
    ...(opts.noindex ? ['X-Robots-Tag: noindex, nofollow'] : []),
  ]
  return [
    '/*', ...all.map((h) => `  ${h}`), '',
    // file names under /assets carry their content hash, so they never change
    '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', '',
  ].join('\n')
}

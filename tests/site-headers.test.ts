// The own-keys site's security headers: the page keeps two keys, so only its own scripts run.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { contentSecurityPolicy, inlineScripts, OWN_CONNECT, scriptHash, siteHeaders } from '../src/own/site-headers'

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(name + ' ')) ?? ''

describe('site headers', () => {
  it('finds inline scripts and skips ones loaded by src', () => {
    const html = '<script>a()</script><script type="module" src="/x.js"></script><script nonce="n">\n b()\n</script><script> </script>'
    expect(inlineScripts(html)).toEqual(['a()', '\n b()\n'])
  })

  it('hashes a script the way a browser checks it', () => {
    expect(scriptHash('a()')).toBe(`'sha256-${createHash('sha256').update('a()').digest('base64')}'`)
  })

  it('allows the page’s own inline script by hash, and nothing inline or evaluated besides', () => {
    const html = readFileSync('live.html', 'utf8')
    const scripts = inlineScripts(html)
    expect(scripts.length).toBeGreaterThan(0)
    const csp = contentSecurityPolicy(html)
    const script = directive(csp, 'script-src')
    for (const s of scripts) expect(script).toContain(scriptHash(s))
    expect(script).not.toContain('unsafe-inline')
    expect(script).not.toContain('unsafe-eval')
  })

  it('lets the page reach only itself and the two providers', () => {
    expect(directive(contentSecurityPolicy(''), 'connect-src')).toBe(`connect-src 'self' ${OWN_CONNECT.join(' ')}`)
    expect(contentSecurityPolicy('')).toContain("frame-ancestors 'none'")
  })

  it('keeps the site out of search until told otherwise, and caches hashed assets for good', () => {
    expect(siteHeaders('')).toContain('X-Robots-Tag: noindex')
    expect(siteHeaders('', { noindex: false })).not.toContain('X-Robots-Tag')
    expect(siteHeaders('')).toMatch(/\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/)
    expect(siteHeaders('')).toContain('Permissions-Policy: microphone=(self)')
  })
})

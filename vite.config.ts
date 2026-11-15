import { copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { soundingDevApi } from './src/devserver/api'
import { DEFAULT_LIVE_PORT, LIVE_SOCKET_PATH } from './src/live/socket-path'

/**
 * `--mode own` builds the own-keys page: the same live.html, but its script is
 * src/own/main.ts, which runs the listener inside the page on the visitor's
 * own keys. Nothing of it is in the default build.
 */
function ownEntry(): Plugin {
  return {
    name: 'sounding-own-entry',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('/src/ui/live.ts', '/src/own/main.ts') },
    // The site has one page, so it is also what the bare address opens.
    closeBundle() { if (existsSync(join(OWN_OUT, 'live.html'))) copyFileSync(join(OWN_OUT, 'live.html'), join(OWN_OUT, 'index.html')) },
  }
}
const OWN_OUT = resolve(__dirname, 'dist-own')

export default defineConfig(({ mode }) => ({
  plugins: mode === 'own' ? [ownEntry()] : [soundingDevApi()],
  // The own-keys page is a site of static files; tailscale serve may front it while it is tried out.
  preview: { allowedHosts: ['.ts.net'] },
  server: {
    // The live board connects to its own origin; in dev that is Vite, which
    // hands the socket to `bun run live`. The browser's Origin header passes
    // through unchanged, so the live server's localhost check still applies.
    proxy: { [LIVE_SOCKET_PATH]: { target: `ws://127.0.0.1:${DEFAULT_LIVE_PORT}`, ws: true } },
  },
  build: mode === 'own'
    ? { outDir: OWN_OUT, rollupOptions: { input: { live: resolve(__dirname, 'live.html') } } }
    : {
        rollupOptions: {
          input: {
            main: resolve(__dirname, 'index.html'),
            live: resolve(__dirname, 'live.html'),
          },
        },
      },
}))

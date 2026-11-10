import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { soundingDevApi } from './src/devserver/api'
import { DEFAULT_LIVE_PORT, LIVE_SOCKET_PATH } from './src/live/socket-path'

export default defineConfig({
  plugins: [soundingDevApi()],
  server: {
    // The live board connects to its own origin; in dev that is Vite, which
    // hands the socket to `bun run live`. The browser's Origin header passes
    // through unchanged, so the live server's localhost check still applies.
    proxy: { [LIVE_SOCKET_PATH]: { target: `ws://127.0.0.1:${DEFAULT_LIVE_PORT}`, ws: true } },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        live: resolve(__dirname, 'live.html'),
      },
    },
  },
})

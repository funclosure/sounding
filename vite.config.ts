import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { soundingDevApi } from './src/devserver/api'

export default defineConfig({
  plugins: [soundingDevApi()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        live: resolve(__dirname, 'live.html'),
      },
    },
  },
})

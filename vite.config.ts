import { defineConfig } from 'vite'
import { soundingDevApi } from './src/devserver/api'

export default defineConfig({
  plugins: [soundingDevApi()],
})

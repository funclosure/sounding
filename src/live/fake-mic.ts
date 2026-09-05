// Feeds a recording as if it were the microphone: ffmpeg → 16k s16le mono on
// stdout, delivered in 100ms chunks on the session clock. Dev/tuning only.
import { spawn } from 'node:child_process'
import type { Clock } from './clock'

const CHUNK_BYTES = 3200

export function streamFile(path: string, clock: Clock, onChunk: (pcm: Int16Array) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    ff.stdout.on('data', (d: Buffer) => chunks.push(d))
    ff.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    ff.on('error', (e) => reject(e.message.includes('ENOENT') ? new Error('ffmpeg not found in PATH — install with: brew install ffmpeg') : e))
    ff.on('close', async (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr}`))
      const all = Buffer.concat(chunks)
      for (let off = 0; off + 2 <= all.length; off += CHUNK_BYTES) {
        const slice = all.subarray(off, Math.min(off + CHUNK_BYTES, all.length))
        const pcm = new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length - (slice.length % 2)))
        onChunk(pcm)
        await clock.sleep(100)
      }
      resolve()
    })
  })
}

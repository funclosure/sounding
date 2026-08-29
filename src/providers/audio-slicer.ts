// ffmpeg-based audio windowing for audio-native interpretation. The window
// gives the model recent prosodic context, mirroring the recurrence window.
import { spawn } from 'node:child_process'
import type { Ms } from '../core/types'
import type { AudioSegment } from '../interpret/port'
import type { AudioSource } from '../core/session'

export const AUDIO_WINDOW_MS: Ms = 30_000

export function sliceWindow(endT: Ms): { fromMs: number; toMs: number } {
  return { fromMs: Math.max(0, endT - AUDIO_WINDOW_MS), toMs: endT }
}

export function makeAudioSource(audioPath: string): AudioSource {
  return async (seg) => {
    const { fromMs, toMs } = sliceWindow(seg.endT)
    const data = await ffmpegSlice(audioPath, fromMs, toMs)
    return { kind: 'audio', segmentId: seg.segmentId, mimeType: 'audio/mpeg', data, startT: seg.startT, endT: seg.endT }
  }
}

function ffmpegSlice(audioPath: string, fromMs: number, toMs: number): Promise<Uint8Array> {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(fromMs / 1000),
    '-i', audioPath,
    '-t', String((toMs - fromMs) / 1000),
    '-ac', '1', '-f', 'mp3', 'pipe:1',
  ]
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new Error('ffmpeg not found in PATH — install with: brew install ffmpeg'))
      else reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)))
      else reject(new Error(`ffmpeg exited with ${code}:\n${stderr}`))
    })
  })
}

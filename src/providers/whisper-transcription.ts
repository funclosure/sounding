// Local whisper.cpp transcription (whisper-cli via Homebrew). Chosen over
// hosted Whisper (Groq is geo-blocked from this network); ASR-measured
// timestamps are load-bearing — they are the spine of the event timeline.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { existsSync } from 'node:fs'
import type { FixtureScript } from '../replay/fixture'

export interface WhisperJson {
  transcription: Array<{ offsets: { from: number; to: number }; text: string }>
}

const MIN_SEGMENT_MS = 100
const TAIL_PAD_MS = 2000

export function whisperJsonToFixtureScript(json: WhisperJson, name: string): FixtureScript {
  const segments = json.transcription
    .map((s) => ({
      startT: s.offsets.from,
      endT: Math.max(s.offsets.to, s.offsets.from + MIN_SEGMENT_MS),
      text: s.text.trim(),
    }))
    .filter((s) => s.text.length > 0)
  const endT = (segments.at(-1)?.endT ?? 0) + TAIL_PAD_MS
  return { name, description: `transcribed from ${name}`, endT, segments, truth: {} }
}

export async function transcribeRecording(audioPath: string, modelPath: string): Promise<FixtureScript> {
  if (!existsSync(modelPath)) {
    throw new Error(
      `whisper model not found at ${modelPath}\nDownload it once with:\n` +
        `  mkdir -p models && curl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${basename(modelPath)}`,
    )
  }
  const tmp = await mkdtemp(join(tmpdir(), 'sounding-'))
  try {
    const wav = join(tmp, 'audio.wav')
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', wav])
    const outBase = join(tmp, 'out')
    await run('whisper-cli', ['-m', modelPath, '-f', wav, '-l', 'auto', '-oj', '-of', outBase, '--no-prints'])
    const json = JSON.parse(await readFile(`${outBase}.json`, 'utf8')) as WhisperJson
    return whisperJsonToFixtureScript(json, basename(audioPath).replace(/\.[^.]+$/, ''))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new Error(`${cmd} not found in PATH — install with: brew install ${cmd === 'whisper-cli' ? 'whisper-cpp' : cmd}`))
      else reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with ${code}:\n${stderr}`))
    })
  })
}

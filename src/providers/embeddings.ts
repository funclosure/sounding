// Local sentence embeddings. Provider layer: allowed to touch network
// (one-time model download to the HF cache) and filesystem.
import { pipeline } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | null = null
const cache = new Map<string, Float32Array>()

function getExtractor() {
  extractorPromise ??= pipeline('feature-extraction', MODEL_ID)
  return extractorPromise
}

export async function embed(text: string): Promise<Float32Array> {
  const hit = cache.get(text)
  if (hit) return hit
  const extractor = await getExtractor()
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  const vec = new Float32Array(output.data as unknown as Float32Array)
  cache.set(text, vec)
  return vec
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

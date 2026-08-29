// Local sentence embeddings. Provider layer: allowed to touch network
// (one-time model download to the HF cache) and filesystem.
import { pipeline } from '@huggingface/transformers'

// Xenova/all-MiniLM-L6-v2 was tried first but gave only a 0.0037 margin between
// the drift group's critical bridge (grief<->losing, 0.4569) and the worst
// cross-worry false-merge risk (car<->laptop, 0.4532) — too thin to trust.
// bge-small-en-v1.5 widens that margin to 0.0757 (grief<->losing 0.6561 vs
// rent<->vacation 0.5804 as the worst cross-worry sim). See
// .superpowers/sdd/task-s2-10-report.md for the full measured matrices.
const MODEL_ID = 'Xenova/bge-small-en-v1.5'

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

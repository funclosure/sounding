// Pure name validation and path building for the dev-server API.
// No I/O here; the plugin (api.ts) does the reading and spawning.

export const INTERPRETERS = ['gemini', 'claude', 'recurrence'] as const
export type InterpreterName = (typeof INTERPRETERS)[number]

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

export function isValidRecordingName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..')
}

export function isInterpreterName(x: unknown): x is InterpreterName {
  return typeof x === 'string' && (INTERPRETERS as readonly string[]).includes(x)
}

export function recordingPath(name: string): string {
  return `recordings/${name}.m4a`
}

export function soundingPath(name: string, interp: InterpreterName): string {
  return `soundings/${name}.${interp}.jsonl`
}

export function stampName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `mic-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Append `-2`, `-3`, … to `base` until `exists` reports the name is free. */
export function uniqueName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base
  let i = 2
  while (exists(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

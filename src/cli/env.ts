// API keys and the switch that keeps them unused.
//
// SOUNDING_API=off (set by the always-on server unless it runs with
// --allow-api) means nothing in this process or its children may spend API
// credit: .env isn't loaded, and every paid provider refuses to start. Unset
// or anything else keeps today's behaviour, so dev runs are unchanged.

/** true unless SOUNDING_API=off. */
export function apiAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOUNDING_API !== 'off'
}

export function apiOffMessage(what: string): string {
  return `${what} spends API credit, and API use is off on this server — restart it with --allow-api to opt in`
}

/** Paid providers call this before they touch a key. */
export function assertApiAllowed(what: string): void {
  if (!apiAllowed()) throw new Error(apiOffMessage(what))
}

// Load a gitignored .env from the project root into process.env, if present.
// Never overrides variables already exported in the shell (Node's --env-file
// semantics). Skipped entirely while API use is off.
export function loadDotEnv(): void {
  if (!apiAllowed()) return
  try {
    process.loadEnvFile()
  } catch {
    // no .env — keys must come from the shell
  }
}

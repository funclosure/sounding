// Load a gitignored .env from the project root into process.env, if present.
// Never overrides variables already exported in the shell (Node's --env-file semantics).
export function loadDotEnv(): void {
  try {
    process.loadEnvFile()
  } catch {
    // no .env — keys must come from the shell
  }
}

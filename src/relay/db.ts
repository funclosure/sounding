// The few parts of Cloudflare D1 the relay uses, so it needs no Cloudflare
// types and the tests can stand in a local SQLite database for it.
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}
export interface D1 {
  prepare(sql: string): D1Stmt
  batch(statements: D1Stmt[]): Promise<unknown[]>
}

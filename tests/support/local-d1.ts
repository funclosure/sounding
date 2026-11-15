// A local SQLite database standing in for Cloudflare D1, with the relay's tables.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { D1, D1Stmt } from '../../src/relay/db'

export function localD1(): D1 {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../../src/relay/schema.sql', import.meta.url), 'utf8'))
  const stmt = (sql: string, args: unknown[] = []): D1Stmt => ({
    bind: (...v) => stmt(sql, v),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) as T) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
  })
  return { prepare: (sql) => stmt(sql), batch: async (s) => { const out = []; for (const x of s) out.push(await x.run()); return out } }
}

-- The friends' relay (src/relay/relay.ts). Apply once:
--   bunx wrangler@4.148.0 d1 execute sounding-friends --remote --file src/relay/schema.sql
-- An invite's link token and a claimed device's secret are kept only as SHA-256
-- hashes, so this table alone opens nothing.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  from_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  device_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  minutes INTEGER NOT NULL,
  heard_ms INTEGER NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS months (
  month TEXT PRIMARY KEY,
  spent_usd REAL NOT NULL DEFAULT 0
);

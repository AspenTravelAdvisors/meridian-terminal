/**
 * CREATE statements matching `schema.ts`. Every statement is idempotent so a cold serverless instance can run them
 * all before its first query. Add new columns as `ALTER TABLE … ADD COLUMN IF NOT EXISTS` at the end; never edit or
 * reorder existing statements.
 */
export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    recovery_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    transports JSONB,
    device_type TEXT,
    backed_up BOOLEAN NOT NULL DEFAULT FALSE,
    label TEXT,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS credentials_user ON credentials (user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    user_agent TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    kind TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_docs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    rev INTEGER NOT NULL,
    data JSONB NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT,
    created_at BIGINT NOT NULL,
    last_ok_at BIGINT,
    failures INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions (user_id)`,
  `CREATE TABLE IF NOT EXISTS alert_state (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_id TEXT NOT NULL,
    last_fired_bar BIGINT,
    last_fired_at BIGINT,
    last_checked_at BIGINT,
    last_error TEXT,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, alert_id)
  )`,
  `CREATE TABLE IF NOT EXISTS alert_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_id TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    at BIGINT NOT NULL,
    bar_t BIGINT NOT NULL,
    message TEXT NOT NULL,
    provisional BOOLEAN NOT NULL DEFAULT FALSE,
    delivered JSONB NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS alert_events_user_at ON alert_events (user_id, at)`,
  `CREATE TABLE IF NOT EXISTS server_kv (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
];

import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

/**
 * Postgres schema (Neon on Vercel, PGlite locally). Times are epoch milliseconds in BIGINT columns, ids are opaque
 * text, and every user-owned row carries `user_id`, so the schema is multi-user from the start. `ddl.ts` holds the
 * matching CREATE statements; `db.test.ts` runs both against a real Postgres engine (PGlite).
 */
const ms = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  createdAt: ms('created_at').notNull(),
  /** SHA-256 of the one-time recovery code shown at sign-up (null once used until a new one is generated) */
  recoveryHash: text('recovery_hash'),
});

/** WebAuthn passkeys. `id` is the base64url credential id; `publicKey` is the base64url COSE key. */
export const credentials = pgTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: ms('counter').notNull().default(0),
    transports: jsonb('transports').$type<string[]>(),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up').notNull().default(false),
    label: text('label'),
    createdAt: ms('created_at').notNull(),
    lastUsedAt: ms('last_used_at'),
  },
  (t) => [index('credentials_user').on(t.userId)],
);

/** Sign-in sessions. Only a SHA-256 of the cookie token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ms('created_at').notNull(),
    expiresAt: ms('expires_at').notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

/** Pending WebAuthn challenges (serverless instances share no memory, so they live here for a few minutes). */
export const challenges = pgTable('challenges', {
  id: text('id').primaryKey(),
  challenge: text('challenge').notNull(),
  kind: text('kind').notNull(), // 'register' | 'login' | 'add'
  userId: text('user_id'),
  username: text('username'),
  expiresAt: ms('expires_at').notNull(),
});

/** Synced client state: one JSON document per persisted store (watchlists, alerts, portfolio, …). */
export const userDocs = pgTable(
  'user_docs',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    rev: integer('rev').notNull(),
    data: jsonb('data').notNull(),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Web Push subscriptions (one per browser/device that enabled notifications). */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    label: text('label'),
    createdAt: ms('created_at').notNull(),
    lastOkAt: ms('last_ok_at'),
    failures: integer('failures').notNull().default(0),
  },
  (t) => [index('push_user').on(t.userId)],
);

/**
 * Server-side alert bookkeeping, kept apart from the synced alerts document so the scheduler never has to
 * write into a document the user is editing.
 */
export const alertState = pgTable(
  'alert_state',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    alertId: text('alert_id').notNull(),
    lastFiredBar: ms('last_fired_bar'),
    lastFiredAt: ms('last_fired_at'),
    lastCheckedAt: ms('last_checked_at'),
    lastError: text('last_error'),
    /** 'once' alerts that fired, or expired alerts */
    done: boolean('done').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.alertId] })],
);

export const alertEvents = pgTable(
  'alert_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    alertId: text('alert_id').notNull(),
    name: text('name').notNull(),
    symbol: text('symbol').notNull(),
    interval: text('interval').notNull(),
    at: ms('at').notNull(),
    barT: ms('bar_t').notNull(),
    message: text('message').notNull(),
    provisional: boolean('provisional').notNull().default(false),
    delivered: jsonb('delivered').$type<string[]>().notNull(),
  },
  (t) => [index('alert_events_user_at').on(t.userId, t.at)],
);

/** Small server-wide settings: generated VAPID keys, scheduler heartbeat and lock. */
export const serverKv = pgTable('server_kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ms('updated_at').notNull(),
});

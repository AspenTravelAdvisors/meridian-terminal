import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { ServerEnv } from '../http';
import { DDL } from './ddl';
import * as schema from './schema';

export { schema };
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Database for accounts, sync and server-side alerts.
 *  - DATABASE_URL / POSTGRES_URL set → Postgres over Neon's HTTP driver (what Vercel's Neon integration injects).
 *  - otherwise, off Vercel → embedded PGlite (real Postgres compiled to WASM) in MERIDIAN_DATA_DIR
 *    (default `.meridian-data/`), so `pnpm dev` and `pnpm serve` work with no setup.
 *  - otherwise (Vercel without a database) → null: account features report themselves as not configured.
 */
let pending: Promise<Db | null> | null = null;
let installed: Db | null | undefined;

export function databaseUrl(env: ServerEnv): string | undefined {
  return env.DATABASE_URL || env.POSTGRES_URL || undefined;
}

export function getDb(env: ServerEnv): Promise<Db | null> {
  if (installed !== undefined) return Promise.resolve(installed);
  pending ??= connect(env).catch((e) => {
    pending = null; // retry on the next request rather than caching a failure
    throw e;
  });
  return pending;
}

/** Tests (and embedders) supply their own database. Pass undefined to go back to env-based connection. */
export function installDb(db: Db | null | undefined): void {
  installed = db;
  pending = null;
}

async function connect(env: ServerEnv): Promise<Db | null> {
  const url = databaseUrl(env);
  let db: Db;
  if (url) {
    const { neon } = await import('@neondatabase/serverless');
    const { drizzle } = await import('drizzle-orm/neon-http');
    db = drizzle(neon(url), { schema }) as unknown as Db;
  } else if (env.VERCEL) {
    return null;
  } else {
    db = await openPglite(env.MERIDIAN_DATA_DIR || '.meridian-data/pg');
  }
  await migrate(db);
  return db;
}

/** Embedded Postgres; `dir` undefined = in-memory (tests). */
export async function openPglite(dir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  if (dir) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
  }
  const client = new PGlite(dir);
  return drizzle(client, { schema }) as unknown as Db;
}

/** Idempotent schema bootstrap (CREATE … IF NOT EXISTS), run once per cold start. */
export async function migrate(db: Db): Promise<void> {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
}

/** Random URL-safe id (crypto-strong). */
export function newId(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString('base64url');
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('base64url');
}

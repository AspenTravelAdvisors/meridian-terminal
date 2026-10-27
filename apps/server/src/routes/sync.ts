import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { requireDb, requireUser } from '../auth';
import { schema } from '../db';
import { HttpError, type ServerEnv, assertSameOrigin, body, json, query, rateLimit } from '../http';

/**
 * Cloud sync of the browser's persisted stores. Each store is one JSON document with a revision number; a write
 * names the revision it was based on and is refused (409-style result, with the server copy) when another device
 * wrote in between, so the client can merge instead of silently overwriting.
 */
const { userDocs } = schema;

/** Persisted store keys that sync (matches the `name` of each zustand persist store in apps/web). */
export const SYNC_KEYS = [
  'meridian.workspace',
  'meridian.layouts',
  'meridian.settings',
  'meridian.drawings',
  'meridian.watchlists',
  'meridian.recents',
  'meridian.alerts',
  'meridian.portfolio',
  'meridian.journal',
  'meridian.scripts',
  'meridian.studyDefaults',
] as const;
export type SyncKey = (typeof SYNC_KEYS)[number];

const MAX_DOC = 3_000_000;

async function pull(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'sync', 240);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const { since } = query(req, z.object({ since: z.coerce.number().int().min(0).default(0) }));
  const rows = await db
    .select({ key: userDocs.key, rev: userDocs.rev, updatedAt: userDocs.updatedAt, data: userDocs.data })
    .from(userDocs)
    .where(and(eq(userDocs.userId, user.id), gt(userDocs.updatedAt, since)));
  return json({ docs: rows, serverTime: Date.now() });
}

const pushBody = z.object({
  docs: z
    .array(z.object({ key: z.enum(SYNC_KEYS), baseRev: z.number().int().min(0), data: z.unknown() }))
    .min(1)
    .max(SYNC_KEYS.length),
});

async function push(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'sync', 240);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const b = await body(req, pushBody, 4_000_000);
  const now = Date.now();
  const results = [];
  for (const d of b.docs) {
    if (d.data === undefined || d.data === null) throw new HttpError(400, `${d.key}: empty document`);
    if (JSON.stringify(d.data).length > MAX_DOC) throw new HttpError(413, `${d.key} is larger than ${MAX_DOC / 1e6} MB`);
    const written =
      d.baseRev === 0
        ? await db.insert(userDocs).values({ userId: user.id, key: d.key, rev: 1, data: d.data, updatedAt: now }).onConflictDoNothing().returning({ rev: userDocs.rev })
        : await db
            .update(userDocs)
            .set({ data: d.data, rev: d.baseRev + 1, updatedAt: now })
            .where(and(eq(userDocs.userId, user.id), eq(userDocs.key, d.key), eq(userDocs.rev, d.baseRev)))
            .returning({ rev: userDocs.rev });
    if (written.length) results.push({ key: d.key, ok: true, rev: written[0].rev, updatedAt: now });
    else {
      const [cur] = await db.select({ rev: userDocs.rev, updatedAt: userDocs.updatedAt, data: userDocs.data }).from(userDocs).where(and(eq(userDocs.userId, user.id), eq(userDocs.key, d.key)));
      results.push({ key: d.key, ok: false, server: cur ?? null });
    }
  }
  return json({ results, serverTime: now });
}

export const syncRoutes = {
  '/api/sync': { GET: pull, POST: push },
};

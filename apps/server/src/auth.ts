import { and, eq, gt, lt } from 'drizzle-orm';
import { type Db, getDb, newId, schema, sha256 } from './db';
import { HttpError, type ServerEnv } from './http';

const { sessions, users } = schema;

const DAY = 86_400_000;
export const SESSION_DAYS = 120;

/** `__Host-` cookies must be Secure; plain http (localhost dev) uses the bare name. */
const cookieName = (req: Request) => (new URL(req.url).protocol === 'https:' ? '__Host-mt_session' : 'mt_session');

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function sessionCookie(req: Request, token: string | null): string {
  const secure = new URL(req.url).protocol === 'https:';
  const base = `${cookieName(req)}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return token ? `${base}; Max-Age=${SESSION_DAYS * 86_400}` : `${base}; Max-Age=0`;
}

export async function requireDb(env: ServerEnv): Promise<Db> {
  const db = await getDb(env);
  if (!db) throw new HttpError(503, 'accounts are not configured on this deployment (add a Postgres database: see docs/ACCOUNTS.md)');
  return db;
}

/** Start a session for `userId`; returns the Set-Cookie header value. */
export async function startSession(db: Db, req: Request, userId: string, now = Date.now()): Promise<string> {
  const token = newId(32);
  await db.insert(sessions).values({ idHash: await sha256(token), userId, createdAt: now, expiresAt: now + SESSION_DAYS * DAY, userAgent: (req.headers.get('user-agent') ?? '').slice(0, 200) });
  // opportunistic cleanup of expired sessions
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  return sessionCookie(req, token);
}

export async function endSession(db: Db, req: Request): Promise<string> {
  const token = readCookie(req, cookieName(req));
  if (token) await db.delete(sessions).where(eq(sessions.idHash, await sha256(token)));
  return sessionCookie(req, null);
}

export interface SessionUser {
  id: string;
  username: string;
  createdAt: number;
}

/** The signed-in user, or null. Sliding expiry: a session used in its last 30 days is extended. */
export async function currentUser(db: Db, req: Request, now = Date.now()): Promise<SessionUser | null> {
  const token = readCookie(req, cookieName(req));
  if (!token) return null;
  const idHash = await sha256(token);
  const rows = await db
    .select({ id: users.id, username: users.username, createdAt: users.createdAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, now)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  if (r.expiresAt - now < 30 * DAY) await db.update(sessions).set({ expiresAt: now + SESSION_DAYS * DAY }).where(eq(sessions.idHash, idHash));
  return { id: r.id, username: r.username, createdAt: r.createdAt };
}

export async function requireUser(db: Db, req: Request): Promise<SessionUser> {
  const u = await currentUser(db, req);
  if (!u) throw new HttpError(401, 'sign in required');
  return u;
}

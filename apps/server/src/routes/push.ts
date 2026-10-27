import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import { z } from 'zod';
import { requireDb, requireUser } from '../auth';
import { type Db, schema } from '../db';
import { HttpError, type ServerEnv, assertSameOrigin, body, json, rateLimit } from '../http';
import { assertPublicHttps } from './notify';

/**
 * Web Push: alerts reach phones and desktops with every Meridian tab closed. On iPhone and iPad this needs iOS 16.4+
 * and Meridian added to the Home Screen (Share → Add to Home Screen); the notification then comes from the
 * installed app. VAPID keys come from the environment or are generated once and kept in the database.
 */
const { pushSubscriptions, serverKv } = schema;

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export async function getVapid(db: Db, env: ServerEnv): Promise<Vapid> {
  const subject = env.VAPID_SUBJECT || 'mailto:alerts@meridian.invalid';
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject };
  const read = async () => (await db.select({ value: serverKv.value }).from(serverKv).where(eq(serverKv.key, 'vapid')))[0]?.value as Omit<Vapid, 'subject'> | undefined;
  let keys = await read();
  if (!keys) {
    // first use: generate, insert unless another instance won the race, then read whichever was stored
    await db.insert(serverKv).values({ key: 'vapid', value: webpush.generateVAPIDKeys(), updatedAt: Date.now() }).onConflictDoNothing();
    keys = await read();
  }
  if (!keys) throw new HttpError(500, 'could not initialize push keys');
  return { ...keys, subject };
}

export interface PushMessage {
  title: string;
  body: string;
  /** notifications with the same tag replace each other */
  tag?: string;
  /** opened when the notification is tapped */
  url?: string;
}

/** Send to every subscription the user has. Gone subscriptions (404/410) are removed. Returns the number delivered. */
export async function pushToUser(db: Db, env: ServerEnv, userId: string, msg: PushMessage, now = Date.now()): Promise<{ sent: number; failed: number }> {
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  if (!subs.length) return { sent: 0, failed: 0 };
  const v = await getVapid(db, env);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 3600, urgency: 'high', vapidDetails: v, timeout: 8000 });
        sent++;
        await db.update(pushSubscriptions).set({ lastOkAt: now, failures: 0 }).where(eq(pushSubscriptions.endpoint, s.endpoint));
      } catch (e) {
        failed++;
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410 || s.failures >= 20) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint));
        else await db.update(pushSubscriptions).set({ failures: s.failures + 1 }).where(eq(pushSubscriptions.endpoint, s.endpoint));
      }
    }),
  );
  return { sent, failed };
}

async function key(_req: Request, env: ServerEnv): Promise<Response> {
  const db = await requireDb(env);
  return json({ publicKey: (await getVapid(db, env)).publicKey });
}

const subBody = z.object({
  subscription: z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }),
  label: z.string().max(80).optional(),
});

async function subscribe(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'push', 30);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const b = await body(req, subBody);
  await assertPublicHttps(b.subscription.endpoint); // the server will POST here
  const row = { userId: user.id, p256dh: b.subscription.keys.p256dh, auth: b.subscription.keys.auth, label: b.label ?? null, failures: 0 };
  await db
    .insert(pushSubscriptions)
    .values({ endpoint: b.subscription.endpoint, createdAt: Date.now(), ...row })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row });
  return json({ ok: true, devices: await devices(db, user.id) });
}

async function unsubscribe(req: Request, env: ServerEnv): Promise<Response> {
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const b = await body(req, z.object({ endpoint: z.string().max(2000) }));
  const [s] = await db.select({ userId: pushSubscriptions.userId }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, b.endpoint));
  if (s?.userId === user.id) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, b.endpoint));
  return json({ ok: true, devices: await devices(db, user.id) });
}

async function test(req: Request, env: ServerEnv): Promise<Response> {
  rateLimit(req, 'push-test', 6);
  assertSameOrigin(req);
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const r = await pushToUser(db, env, user.id, { title: 'Meridian test notification', body: 'Alerts will arrive like this, even with Meridian closed.', tag: 'meridian-test', url: '/' });
  return json(r);
}

async function list(req: Request, env: ServerEnv): Promise<Response> {
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  return json({ devices: await devices(db, user.id) });
}

function devices(db: Db, userId: string) {
  return db
    .select({ endpoint: pushSubscriptions.endpoint, label: pushSubscriptions.label, createdAt: pushSubscriptions.createdAt, lastOkAt: pushSubscriptions.lastOkAt })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
}

export const pushRoutes = {
  '/api/push/key': { GET: key },
  '/api/push/devices': { GET: list },
  '/api/push/subscribe': { POST: subscribe },
  '/api/push/unsubscribe': { POST: unsubscribe },
  '/api/push/test': { POST: test },
};

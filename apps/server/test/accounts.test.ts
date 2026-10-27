import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, handle, installDb, openPglite, migrate, runAlerts } from '../src';
import { startSession } from '../src/auth';
import { schema } from '../src/db';

/** Real Postgres semantics (PGlite in memory): schema DDL, upserts, conditional updates, cascades. */
let db: Db;
const env = {};
const noNet = (async () => new Response('offline', { status: 503 })) as unknown as typeof fetch;
const BASE = 'http://localhost';

async function signedInUser(username: string): Promise<{ id: string; cookie: string }> {
  const id = `u_${username}`;
  await db.insert(schema.users).values({ id, username, createdAt: 1 });
  const set = await startSession(db, new Request(BASE), id);
  return { id, cookie: set.split(';')[0] };
}
const call = (path: string, cookie: string, init: { method?: string; body?: unknown; origin?: string } = {}) =>
  handle(
    new Request(`${BASE}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { cookie, 'Content-Type': 'application/json', ...(init.origin ? { origin: init.origin } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
    env,
    noNet,
  );

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  await migrate(db); // idempotent
  installDb(db);
});
afterAll(() => installDb(undefined));

describe('accounts', () => {
  it('reports configuration and lets only the first account sign up without an invite code', async () => {
    const before = (await (await call('/api/account', '')).json()) as { configured: boolean; user: null; signup: { open: boolean; needsCode: boolean } };
    expect(before).toMatchObject({ configured: true, user: null, signup: { open: true, needsCode: false } });
    const opts = await call('/api/account/register/options', '', { body: { username: 'Brian' } });
    expect(opts.status).toBe(200);
    const o = (await opts.json()) as { challengeId: string; options: { rp: { id: string }; user: { name: string }; authenticatorSelection: { residentKey: string } } };
    expect(o.options.rp.id).toBe('localhost');
    expect(o.options.user.name).toBe('brian');
    expect(o.options.authenticatorSelection.residentKey).toBe('required');
    await signedInUser('owner');
    const closed = await call('/api/account/register/options', '', { body: { username: 'someone' } });
    expect(closed.status).toBe(403);
  });

  it('rejects bad usernames, unknown sessions and cross-origin writes', async () => {
    expect((await call('/api/account/register/options', '', { body: { username: 'a' } })).status).toBe(400);
    expect((await call('/api/sync', 'mt_session=nope')).status).toBe(401);
    const u = await signedInUser('csrf');
    expect((await call('/api/sync', u.cookie, { body: { docs: [{ key: 'meridian.settings', baseRev: 0, data: {} }] }, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('recovery codes sign in once', async () => {
    const { sha256 } = await import('../src/db');
    await db.insert(schema.users).values({ id: 'u_rec', username: 'rec', createdAt: 1, recoveryHash: await sha256('ABCDEFGHJKLMNPQRSTUV') });
    const r1 = await call('/api/account/recover', '', { body: { username: 'rec', code: 'abcde-fghjk-lmnpq-rstuv' } });
    expect(r1.status).toBe(200);
    expect(r1.headers.get('set-cookie')).toMatch(/mt_session=.+HttpOnly; SameSite=Lax/);
    expect((await call('/api/account/recover', '', { body: { username: 'rec', code: 'abcde-fghjk-lmnpq-rstuv' } })).status).toBe(400);
  });
});

describe('sync', () => {
  it('stores documents per user with revision checks', async () => {
    const a = await signedInUser('sync-a');
    const b = await signedInUser('sync-b');
    const put = (u: { cookie: string }, baseRev: number, data: unknown) => call('/api/sync', u.cookie, { body: { docs: [{ key: 'meridian.watchlists', baseRev, data }] } }).then((r) => r.json() as Promise<{ results: { ok: boolean; rev?: number; server?: { rev: number; data: unknown } }[] }>);
    expect((await put(a, 0, { state: { v: 1 } })).results[0]).toMatchObject({ ok: true, rev: 1 });
    expect((await put(a, 1, { state: { v: 2 } })).results[0]).toMatchObject({ ok: true, rev: 2 });
    // a stale write (another device wrote rev 2 meanwhile) is refused and gets the server copy back
    const stale = (await put(a, 1, { state: { v: 'stale' } })).results[0];
    expect(stale).toMatchObject({ ok: false, server: { rev: 2, data: { state: { v: 2 } } } });
    // documents are private to their user
    const pullB = (await (await call('/api/sync', b.cookie)).json()) as { docs: unknown[] };
    expect(pullB.docs).toEqual([]);
    const pullA = (await (await call('/api/sync?since=0', a.cookie)).json()) as { docs: { key: string; rev: number; data: unknown }[] };
    expect(pullA.docs).toEqual([expect.objectContaining({ key: 'meridian.watchlists', rev: 2, data: { state: { v: 2 } } })]);
    // unknown keys are refused
    expect((await call('/api/sync', a.cookie, { body: { docs: [{ key: 'evil', baseRev: 0, data: 1 }] } })).status).toBe(400);
  });

  it('deleting an account removes everything it owns', async () => {
    const u = await signedInUser('leaver');
    await call('/api/sync', u.cookie, { body: { docs: [{ key: 'meridian.settings', baseRev: 0, data: { state: {} } }] } });
    expect((await call('/api/account/delete', u.cookie, { body: { confirm: 'nope' } })).status).toBe(400);
    expect((await call('/api/account/delete', u.cookie, { body: { confirm: 'leaver' } })).status).toBe(200);
    expect(await db.select().from(schema.userDocs).where(eq(schema.userDocs.userId, u.id))).toEqual([]);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, u.id))).toEqual([]);
  });
});

describe('server-side alert scheduler', () => {
  const NOW = Date.UTC(2026, 9, 27, 18, 0);
  const alert = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `SIM ${id}`,
    symbol: 'SIM:DEMO',
    interval: '1D',
    condition: { kind: 'price', op: 'above', value: 0 },
    mode: 'every_bar',
    timing: 'close',
    channels: { app: true, browser: false },
    enabled: true,
    createdAt: 1,
    ...extra,
  });

  it('evaluates synced alerts once per bar, honours once-mode and runs scripts in the sandbox', async () => {
    const u = await signedInUser('alerts');
    const script = { id: 'sc1', name: 'always', code: "signal(series(() => 1), { id: 'ALWAYS', dir: 'bull' })", inputs: {} };
    const docs = [
      { key: 'meridian.alerts', baseRev: 0, data: { state: { alerts: [alert('a1'), alert('a2', { mode: 'once' }), alert('a3', { enabled: false }), alert('a4', { condition: { kind: 'script', scriptId: 'sc1', signal: 'ALWAYS' } })] } } },
      { key: 'meridian.scripts', baseRev: 0, data: { state: { scripts: [script] } } },
    ];
    expect((await call('/api/sync', u.cookie, { body: { docs } })).status).toBe(200);

    const r1 = await runAlerts(db, env, noNet, NOW);
    expect(r1).toMatchObject({ ran: true, evaluated: 3, fired: 3, errors: 0 });
    // too soon: skipped by the lock
    expect((await runAlerts(db, env, noNet, NOW + 10_000)).ran).toBe(false);
    // same closed bar a minute later: nothing fires again
    const r2 = await runAlerts(db, env, noNet, NOW + 60_000);
    expect(r2).toMatchObject({ ran: true, fired: 0 });
    expect(r2.evaluated).toBe(2); // the fired once-alert is no longer evaluated

    const act = (await (await call('/api/alerts/activity?since=0', u.cookie)).json()) as { events: { alertId: string; delivered: string[] }[]; states: { alertId: string; done: boolean }[]; scheduler: { lastRunAt: number } };
    expect(act.events.map((e) => e.alertId).sort()).toEqual(['a1', 'a2', 'a4']);
    expect(act.events[0].delivered).toContain('server');
    expect(act.states.find((s) => s.alertId === 'a2')?.done).toBe(true);
    expect(act.scheduler.lastRunAt).toBe(NOW + 60_000);
  });

  it('records errors for alerts it cannot evaluate', async () => {
    const u = await signedInUser('alerts-bad');
    await call('/api/sync', u.cookie, { body: { docs: [{ key: 'meridian.alerts', baseRev: 0, data: { state: { alerts: [alert('b1', { condition: { kind: 'drawing', drawingId: 'gone', op: 'crosses_above' } })] } } }] } });
    const r = await runAlerts(db, env, noNet, NOW + 120_000);
    expect(r.errors).toBeGreaterThanOrEqual(1);
    const [st] = await db.select().from(schema.alertState).where(eq(schema.alertState.alertId, 'b1'));
    expect(st.lastError).toMatch(/drawing was deleted/);
  });

  it('requires the cron secret when one is set', async () => {
    const r = await handle(new Request(`${BASE}/api/cron/alerts`), { CRON_SECRET: 's3cret' }, noNet);
    expect(r.status).toBe(401);
    const ok = await handle(new Request(`${BASE}/api/cron/alerts`, { headers: { authorization: 'Bearer s3cret' } }), { CRON_SECRET: 's3cret' }, noNet);
    expect(ok.status).toBe(200);
  });
});

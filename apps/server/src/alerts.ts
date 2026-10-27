import { type Interval, INTERVALS, fetchBars } from '@meridian/data';
import { type AlertSpec, type Bar, alertBars, alertPayload, evaluateAlert, shouldFire } from '@meridian/engine';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { type Db, newId, schema } from './db';
import { type ServerEnv, mapLimit } from './http';
import { sendEmail, sendWebhook } from './routes/notify';
import { pushToUser } from './routes/push';
import { runScriptIsolated } from './scriptSandbox';

/**
 * Server-side alert scheduler. Reads every account's synced alerts, fetches each (symbol, interval) once,
 * evaluates with the same `evaluateAlert` the browser uses, delivers (push / webhook / e-mail) and records the
 * firing so it happens once per bar no matter which side saw it first. Triggered by /api/cron/alerts.
 */
const { alertEvents, alertState, serverKv, userDocs } = schema;

/** Runs closer together than this are skipped (also what makes an unauthenticated trigger harmless). */
export const MIN_GAP_MS = 45_000;
const BUDGET_MS = 45_000;

interface Persisted<T> {
  state?: T;
}
type AlertsDoc = Persisted<{ alerts?: AlertSpec[] }>;
type DrawingsDoc = Persisted<{ bySymbol?: Record<string, { id: string; type: string; points: { t: number; p: number }[] }[]> }>;
type ScriptsDoc = Persisted<{ scripts?: { id: string; code: string; inputs?: Record<string, number> }[] }>;

export interface RunSummary {
  ran: boolean;
  reason?: string;
  at: number;
  users: number;
  alerts: number;
  evaluated: number;
  fired: number;
  errors: number;
  ms: number;
}

/** Take the scheduler lock: succeeds only when the previous run started at least MIN_GAP_MS ago. */
async function acquire(db: Db, now: number): Promise<boolean> {
  const rows = await db
    .insert(serverKv)
    .values({ key: 'cron.lock', value: { at: now }, updatedAt: now })
    .onConflictDoUpdate({ target: serverKv.key, set: { value: { at: now }, updatedAt: now }, setWhere: lt(serverKv.updatedAt, now - MIN_GAP_MS) })
    .returning({ key: serverKv.key });
  return rows.length > 0;
}

export async function schedulerStatus(db: Db): Promise<RunSummary | null> {
  const [r] = await db.select({ value: serverKv.value }).from(serverKv).where(eq(serverKv.key, 'cron.alerts'));
  return (r?.value as RunSummary | undefined) ?? null;
}

const isInterval = (s: string): s is Interval => (INTERVALS as readonly string[]).includes(s);

export async function runAlerts(db: Db, env: ServerEnv, fetcher: typeof fetch, now = Date.now()): Promise<RunSummary> {
  const t0 = Date.now();
  const summary: RunSummary = { ran: true, at: now, users: 0, alerts: 0, evaluated: 0, fired: 0, errors: 0, ms: 0 };
  if (!(await acquire(db, now))) return { ...summary, ran: false, reason: 'a run started less than 45 s ago' };

  const docs = await db
    .select({ userId: userDocs.userId, key: userDocs.key, data: userDocs.data })
    .from(userDocs)
    .where(inArray(userDocs.key, ['meridian.alerts', 'meridian.drawings', 'meridian.scripts']));
  const byUser = new Map<string, { alerts: AlertSpec[]; drawings?: DrawingsDoc; scripts?: ScriptsDoc }>();
  for (const d of docs) {
    const u = byUser.get(d.userId) ?? { alerts: [] };
    if (d.key === 'meridian.alerts') u.alerts = ((d.data as AlertsDoc).state?.alerts ?? []).filter((a) => a && a.enabled);
    if (d.key === 'meridian.drawings') u.drawings = d.data as DrawingsDoc;
    if (d.key === 'meridian.scripts') u.scripts = d.data as ScriptsDoc;
    byUser.set(d.userId, u);
  }
  const work = [...byUser].filter(([, u]) => u.alerts.length);
  summary.users = work.length;
  if (!work.length) return finish(db, summary, t0);

  const states = await db.select().from(alertState).where(inArray(alertState.userId, work.map(([id]) => id)));
  const stateOf = new Map(states.map((s) => [`${s.userId}/${s.alertId}`, s]));

  // one bar request per market, shared by every alert (and every user) watching it
  const markets = new Map<string, { symbol: string; interval: Interval }>();
  for (const [, u] of work)
    for (const a of u.alerts) {
      summary.alerts++;
      if (isInterval(a.interval)) markets.set(`${a.symbol}|${a.interval}`, { symbol: a.symbol, interval: a.interval });
    }
  const bars = new Map<string, Bar[] | Error>();
  await mapLimit([...markets], 6, async ([k, m]) => {
    if (Date.now() - t0 > BUDGET_MS) return;
    try {
      bars.set(k, (await fetchBars(m.symbol, m.interval, { limit: 500, now }, fetcher, env)).bars);
    } catch (e) {
      bars.set(k, e instanceof Error ? e : new Error(String(e)));
    }
  });

  for (const [userId, u] of work)
    for (const a of u.alerts) {
      if (Date.now() - t0 > BUDGET_MS) break;
      const st = stateOf.get(`${userId}/${a.id}`);
      // a fired 'once' alert stays quiet until the user re-arms it (resume/edit stamps rearmedAt)
      if (st?.done && !((a.rearmedAt ?? 0) > (st.lastFiredAt ?? 0))) continue;
      const patch: Partial<typeof alertState.$inferInsert> = { lastCheckedAt: now };
      try {
        if (a.expires && a.expires < now) {
          patch.lastError = 'expired';
        } else {
          const got = bars.get(`${a.symbol}|${a.interval}`);
          if (!got) throw new Error(isInterval(a.interval) ? 'skipped: run time budget reached' : `unsupported interval ${a.interval}`);
          if (got instanceof Error) throw got;
          const view = alertBars(a, got);
          const c = a.condition;
          const drawing = c.kind === 'drawing' ? u.drawings?.state?.bySymbol?.[a.symbol]?.find((d) => d.id === c.drawingId) : undefined;
          let scriptSignals: { i: number; id: string }[] | undefined;
          if (c.kind === 'script') {
            const script = u.scripts?.state?.scripts?.find((s) => s.id === c.scriptId);
            if (!script) throw new Error('script was deleted');
            const r = await runScriptIsolated(script.code, view, script.inputs ?? {});
            if (r.error) throw new Error(`script: ${r.error}`);
            scriptSignals = r.signals;
          }
          const hit = evaluateAlert(a, view, { drawing, scriptSignals });
          summary.evaluated++;
          patch.lastError = null;
          const last = Math.max(st?.lastFiredBar ?? -Infinity, a.lastFiredBar ?? -Infinity);
          if (shouldFire(hit, Number.isFinite(last) ? last : undefined)) {
            const delivered = await deliver(db, env, fetcher, userId, a, hit, now);
            await db.insert(alertEvents).values({ id: newId(), userId, alertId: a.id, name: a.name, symbol: a.symbol, interval: a.interval, at: now, barT: hit.barT, message: hit.message, provisional: hit.provisional, delivered });
            patch.lastFiredBar = hit.barT;
            patch.lastFiredAt = now;
            patch.done = a.mode === 'once';
            summary.fired++;
          }
        }
      } catch (e) {
        summary.errors++;
        patch.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
      await db
        .insert(alertState)
        .values({ userId, alertId: a.id, ...patch })
        .onConflictDoUpdate({ target: [alertState.userId, alertState.alertId], set: patch });
    }

  // keep the event log bounded: 90 days
  await db.delete(alertEvents).where(lt(alertEvents.at, now - 90 * 86_400_000));
  return finish(db, summary, t0);
}

async function finish(db: Db, summary: RunSummary, t0: number): Promise<RunSummary> {
  summary.ms = Date.now() - t0;
  await db
    .insert(serverKv)
    .values({ key: 'cron.alerts', value: summary, updatedAt: summary.at })
    .onConflictDoUpdate({ target: serverKv.key, set: { value: summary, updatedAt: summary.at } });
  return summary;
}

async function deliver(db: Db, env: ServerEnv, fetcher: typeof fetch, userId: string, a: AlertSpec, hit: NonNullable<ReturnType<typeof evaluateAlert>>, now: number): Promise<string[]> {
  const delivered: string[] = ['server'];
  const payload = alertPayload(a, hit);
  // a browser notification asked for in the alert also goes out as push, so it arrives with the tab closed
  if (a.channels.push || a.channels.browser) {
    const r = await pushToUser(db, env, userId, { title: `🔔 ${a.name}`, body: hit.message + (hit.provisional ? ' (provisional)' : ''), tag: a.id, url: `/?symbol=${encodeURIComponent(a.symbol)}&interval=${encodeURIComponent(a.interval)}` }, now).catch(() => ({ sent: 0, failed: 1 }));
    if (r.sent) delivered.push(`push×${r.sent}`);
  }
  if (a.channels.webhook)
    try {
      if ((await sendWebhook(a.channels.webhook, payload, fetcher)).ok) delivered.push('webhook');
    } catch {
      /* recorded as not delivered */
    }
  if (a.channels.email)
    try {
      const text = `${hit.message}\n\nBar: ${payload.barTime}${hit.provisional ? ' (provisional)' : ''}\n\nInformational only — not investment advice.`;
      if ((await sendEmail(env, a.channels.email, `Meridian alert: ${a.name}`, text, fetcher)).ok) delivered.push('email');
    } catch {
      /* recorded as not delivered */
    }
  return delivered;
}

/** Fired events and per-alert state for one user, for the browser to merge into its alert list and log. */
export async function alertActivity(db: Db, userId: string, since: number) {
  const [events, states] = await Promise.all([
    db
      .select()
      .from(alertEvents)
      .where(and(eq(alertEvents.userId, userId), sql`${alertEvents.at} > ${since}`))
      .orderBy(desc(alertEvents.at))
      .limit(200),
    db.select().from(alertState).where(eq(alertState.userId, userId)),
  ]);
  return { events, states };
}

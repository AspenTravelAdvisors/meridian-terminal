import { z } from 'zod';
import { alertActivity, runAlerts, schedulerStatus } from '../alerts';
import { requireDb, requireUser } from '../auth';
import { HttpError, type ServerEnv, json, query } from '../http';

/**
 * GET|POST /api/cron/alerts — one scheduler pass. Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`;
 * any other scheduler (cron-job.org, Upstash QStash, a GitHub Action, a Raspberry Pi) can call it the same way or
 * with `?key=`. Without CRON_SECRET the endpoint is open, which is harmless: runs closer than 45 s apart are skipped
 * and a run only evaluates and delivers alerts that are actually due.
 */
async function cron(req: Request, env: ServerEnv, fetcher: typeof fetch): Promise<Response> {
  if (env.CRON_SECRET) {
    const auth = req.headers.get('authorization');
    const key = new URL(req.url).searchParams.get('key');
    if (auth !== `Bearer ${env.CRON_SECRET}` && key !== env.CRON_SECRET) throw new HttpError(401, 'bad cron secret');
  }
  const db = await requireDb(env);
  return json(await runAlerts(db, env, fetcher));
}

/** GET /api/alerts/activity?since= — server firings and alert state for the signed-in user, plus scheduler health. */
async function activity(req: Request, env: ServerEnv): Promise<Response> {
  const db = await requireDb(env);
  const user = await requireUser(db, req);
  const { since } = query(req, z.object({ since: z.coerce.number().int().min(0).default(0) }));
  const [a, sched] = await Promise.all([alertActivity(db, user.id, since), schedulerStatus(db)]);
  return json({ ...a, scheduler: sched ? { lastRunAt: sched.at, evaluated: sched.evaluated, fired: sched.fired, errors: sched.errors } : null, serverTime: Date.now() });
}

export const alertRoutes = {
  '/api/cron/alerts': { GET: cron, POST: cron },
  '/api/alerts/activity': { GET: activity },
};

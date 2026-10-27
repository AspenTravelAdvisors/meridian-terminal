import { HttpError, type ServerEnv, corsHeaders, errorResponse, json } from './http';
import { accountRoutes } from './routes/account';
import { alertRoutes } from './routes/alerts';
import { analystRoute } from './routes/analyst';
import { barsRoute, healthRoute, quotesRoute, searchRoute } from './routes/market';
import { notifyRoute } from './routes/notify';
import { pushRoutes } from './routes/push';
import { matrixRoute, scanRoute } from './routes/scan';
import { syncRoutes } from './routes/sync';

export type { ServerEnv } from './http';
export { ruleBasedBriefing } from './routes/analyst';
export { installDb, openPglite, migrate, type Db } from './db';
export { runAlerts } from './alerts';

type Handler = (req: Request, env: ServerEnv, fetcher: typeof fetch) => Promise<Response> | Response;

const ROUTES: Record<string, { GET?: Handler; POST?: Handler }> = {
  '/api/health': { GET: healthRoute },
  '/api/bars': { GET: barsRoute },
  '/api/search': { GET: searchRoute },
  '/api/quotes': { GET: quotesRoute },
  '/api/scan': { POST: scanRoute },
  '/api/matrix': { POST: matrixRoute },
  '/api/analyst': { POST: analystRoute },
  '/api/notify': { POST: notifyRoute },
  ...accountRoutes,
  ...syncRoutes,
  ...pushRoutes,
  ...alertRoutes,
};

/** Framework-agnostic entry point: Vercel function, Vite dev middleware and the standalone Node server all call this. */
export async function handle(req: Request, env: ServerEnv = process.env as ServerEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let res: Response;
  try {
    const route = ROUTES[path];
    if (!route) throw new HttpError(404, `no route ${path}`);
    const h = route[req.method as 'GET' | 'POST'];
    if (!h) throw new HttpError(405, 'method not allowed');
    res = await h(req, env, fetcher);
  } catch (e) {
    res = errorResponse(e);
  }
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export { json };

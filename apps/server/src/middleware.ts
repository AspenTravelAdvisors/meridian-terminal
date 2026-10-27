/**
 * Vercel Routing Middleware entry (edge runtime): runs the site password gate in front of every static file and
 * every /api route. Bundled by scripts/build-vercel.mjs, which fills in the two build-time constants below.
 */
import { gate } from './gate';

/** true for production builds: a missing SITE_PASSWORD locks the site instead of leaving it open */
declare const __GATE_REQUIRED__: boolean;
/** security headers from scripts/headers.mjs, for the gate's own responses */
declare const __GATE_HEADERS__: Record<string, string>;

export default async function middleware(req: Request): Promise<Response> {
  const res = await gate(req, { SITE_PASSWORD: process.env.SITE_PASSWORD, CRON_SECRET: process.env.CRON_SECRET }, { required: __GATE_REQUIRED__, headers: __GATE_HEADERS__ });
  // `x-middleware-next` lets the request continue to the static files / API function.
  return res ?? new Response(null, { headers: { 'x-middleware-next': '1' } });
}

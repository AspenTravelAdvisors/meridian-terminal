import { ZodError, type ZodType } from 'zod';

export interface ServerEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  ALPACA_KEY_ID?: string;
  ALPACA_SECRET_KEY?: string;
  TWELVE_DATA_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  RESEND_API_KEY?: string;
  ALERT_EMAIL_FROM?: string;
  /** comma-separated addresses alert emails may go to; email is off when unset */
  ALERT_EMAIL_TO?: string;
  /** Postgres for accounts, sync and server-side alerts (Vercel's Neon integration sets one of these) */
  DATABASE_URL?: string;
  POSTGRES_URL?: string;
  /** local PGlite data directory when no DATABASE_URL is set (default .meridian-data/pg) */
  MERIDIAN_DATA_DIR?: string;
  /** set by Vercel at runtime */
  VERCEL?: string;
  /** invite code required to create an account; when unset only the first account can be created */
  SIGNUP_CODE?: string;
  /** shared secret for /api/cron/alerts (Vercel Cron sends it as a Bearer token) */
  CRON_SECRET?: string;
  /** Web Push keys; generated and stored in the database when unset */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export function json(body: unknown, init: { status?: number; cache?: string; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': init.cache ?? 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...init.headers,
    },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message, detail: e.detail }, { status: e.status });
  if (e instanceof ZodError) return json({ error: 'invalid request', detail: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, { status: 400 });
  const status = typeof (e as { status?: number })?.status === 'number' ? (e as { status: number }).status : 500;
  const msg = e instanceof Error ? e.message : 'internal error';
  // never echo secrets: provider errors only contain provider names + HTTP status text
  return json({ error: status >= 500 && !(e as { provider?: string })?.provider ? 'internal error' : msg }, { status: status >= 400 && status < 600 ? status : 500 });
}

export function query<T>(req: Request, schema: ZodType<T>): T {
  const u = new URL(req.url);
  return schema.parse(Object.fromEntries(u.searchParams.entries()));
}

export async function body<T>(req: Request, schema: ZodType<T>, maxBytes = 200_000): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'request too large');
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  return schema.parse(data);
}

/** Same-origin by default; extra origins via ALLOWED_ORIGINS (comma-separated). */
export function corsHeaders(req: Request, env: ServerEnv): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin) return {};
  const self = new URL(req.url).origin;
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin === self || allowed.includes(origin) || allowed.includes('*'))
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
  return {};
}

/**
 * Cookie-authenticated writes must come from this site. SameSite=Lax already keeps the session cookie off
 * cross-site POSTs; this rejects them outright when the browser reports an Origin.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'cross-origin request refused');
}

/** Best-effort per-instance rate limiter (serverless instances are short-lived; this only blunts bursts). */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(req: Request, key: string, perMinute: number, now = Date.now()): void {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
  const k = `${key}:${ip}`;
  const b = buckets.get(k);
  if (!b || b.reset < now) {
    buckets.set(k, { n: 1, reset: now + 60_000 });
    if (buckets.size > 5000) buckets.clear();
    return;
  }
  if (++b.n > perMinute) throw new HttpError(429, 'rate limit exceeded — try again in a minute');
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Site password gate. One shared password (SITE_PASSWORD) protects every page and every /api route.
 * Runs as Vercel Routing Middleware in production (scripts/build-vercel.mjs) and in front of `pnpm serve`.
 * Web-standard only (Request/Response/Web Crypto), so the same code runs at the edge, in Node and in tests.
 *
 * Session: an HttpOnly cookie `v1.<expiry ms>.<HMAC-SHA256>` keyed by the password, so changing the password
 * signs everyone out. Returns null when the request may continue to the site or API.
 */

export const LOGIN_PATH = '/__login';
export const LOGOUT_PATH = '/__logout';
export const SESSION_COOKIE = 'meridian_session';
/** Set on 401 responses so the app can tell "signed out" apart from other 401s and send the user to sign in. */
export const AUTH_HEADER = 'x-meridian-auth';

const SESSION_MS = 30 * 86_400_000;
const ATTEMPTS_PER_MINUTE = 10;

export interface GateEnv {
  SITE_PASSWORD?: string;
}

export interface GateOptions {
  /** true in production: with no SITE_PASSWORD set, refuse everything instead of serving the site open */
  required: boolean;
  /** clock override for tests */
  now?: number;
  /** headers added to every response the gate produces (security headers) */
  headers?: Record<string, string>;
}

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();
const hmacKey = (password: string): Promise<CryptoKey> => {
  let k = keys.get(password);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(`meridian-session-v1:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keys.set(password, k);
  }
  return k;
};

async function mac(password: string, data: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(password), enc.encode(data)));
  let s = '';
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string comparison (both inputs are fixed-length MACs). */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function validSession(cookieHeader: string | null, password: string, now: number): Promise<boolean> {
  const raw = cookieHeader
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const m = raw && /^v1\.(\d{1,16})\.([A-Za-z0-9_-]+)$/.exec(raw);
  if (!m || Number(m[1]) <= now) return false;
  return same(m[2], await mac(password, `v1.${m[1]}`));
}

// Best-effort per-address attempt limit (per edge/Node instance). A long passphrase is the real defence.
const attempts = new Map<string, { n: number; reset: number }>();
export const resetLoginLimits = (): void => attempts.clear();
function tooManyAttempts(ip: string, now: number): boolean {
  const a = attempts.get(ip);
  if (!a || a.reset < now) {
    attempts.set(ip, { n: 1, reset: now + 60_000 });
    if (attempts.size > 5000) attempts.clear();
    return false;
  }
  return ++a.n > ATTEMPTS_PER_MINUTE;
}

/** Only same-site paths: "/x" but never "//host" or "/\host". */
const safeNext = (next: string | null): string => (next && /^\/(?![/\\])/.test(next) ? next : '/');

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(next: string, message = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Meridian Terminal · Sign in</title>
<style>
:root{color-scheme:light dark;--bg:#f6f8fa;--card:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--accent:#0969da;--err:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--accent:#4493f8;--err:#f85149}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
form{width:100%;max-width:340px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted)}label{display:block;font-size:13px;margin-bottom:6px}
input{width:100%;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{margin-top:14px;width:100%;font-size:16px;padding:10px;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:var(--err);margin:10px 0 0;font-size:14px}
</style></head><body>
<form method="post" action="${LOGIN_PATH}">
<h1>Meridian Terminal</h1><p>Private workspace. Enter the site password.</p>
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Sign in</button>
${message ? `<p class="err" role="alert">${esc(message)}</p>` : ''}
</form></body></html>`;
}

export async function gate(req: Request, env: GateEnv, opts: GateOptions): Promise<Response | null> {
  const now = opts.now ?? Date.now();
  const url = new URL(req.url);
  const api = url.pathname.startsWith('/api/');
  const respond = (body: string | null, status: number, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...opts.headers, 'Cache-Control': 'no-store', ...headers } });
  const html = (body: string, status: number) => respond(body, status, { 'Content-Type': 'text/html; charset=utf-8' });

  const password = env.SITE_PASSWORD ?? '';
  if (!password) {
    if (!opts.required) return null;
    return api
      ? respond(JSON.stringify({ error: 'site password is not configured' }), 503, { 'Content-Type': 'application/json' })
      : html('<!doctype html><title>Meridian Terminal</title><p>This deployment is locked: set SITE_PASSWORD and redeploy.</p>', 503);
  }

  const secure = url.protocol === 'https:' ? '; Secure' : '';
  if (url.pathname === LOGOUT_PATH) {
    return respond(null, 303, { Location: LOGIN_PATH, 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0` });
  }

  if (url.pathname === LOGIN_PATH) {
    if (req.method !== 'POST') return html(loginPage(safeNext(url.searchParams.get('next'))), 200);
    const form = new URLSearchParams(await req.text());
    const next = safeNext(form.get('next'));
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
    if (tooManyAttempts(ip, now)) return html(loginPage(next, 'Too many attempts. Wait a minute and try again.'), 429);
    const given = form.get('password') ?? '';
    if (!same(await mac(password, `pw:${given}`), await mac(password, `pw:${password}`))) return html(loginPage(next, 'Wrong password.'), 401);
    const exp = now + SESSION_MS;
    const value = `v1.${exp}.${await mac(password, `v1.${exp}`)}`;
    return respond(null, 303, {
      Location: next,
      'Set-Cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
    });
  }

  if (await validSession(req.headers.get('cookie'), password, now)) return null;
  if (api) return respond(JSON.stringify({ error: 'sign-in required' }), 401, { 'Content-Type': 'application/json', [AUTH_HEADER]: 'required' });
  if (req.method === 'GET' || req.method === 'HEAD') return respond(null, 302, { Location: `${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}` });
  return respond(null, 401, { [AUTH_HEADER]: 'required' });
}

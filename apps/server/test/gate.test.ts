import { describe, expect, it } from 'vitest';
import { AUTH_HEADER, LOGIN_PATH, LOGOUT_PATH, SESSION_COOKIE, gate, resetLoginLimits } from '../src/gate';

const ENV = { SITE_PASSWORD: 'correct horse battery staple' };
const NOW = Date.UTC(2026, 9, 27);
const opts = { required: true, now: NOW };

const get = (path: string, cookie?: string) => new Request(`https://app.test${path}`, { headers: cookie ? { cookie } : {} });
const login = (password: string, next = '/', ip = '198.51.100.1') =>
  new Request(`https://app.test${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
    body: new URLSearchParams({ password, next }).toString(),
  });
/** Signs in and returns the `name=value` cookie pair the browser would send back. */
async function session(now = NOW): Promise<string> {
  const res = (await gate(login(ENV.SITE_PASSWORD), ENV, { ...opts, now }))!;
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('site password gate', () => {
  it('sends a signed-out page request to the sign-in page, keeping where it was going', async () => {
    const res = (await gate(get('/chart?symbol=SPY'), ENV, opts))!;
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${LOGIN_PATH}?next=%2Fchart%3Fsymbol%3DSPY`);
  });

  it('answers a signed-out API request with 401 and the auth marker, never data', async () => {
    const res = (await gate(get('/api/quotes?symbols=SPY'), ENV, opts))!;
    expect(res.status).toBe(401);
    expect(res.headers.get(AUTH_HEADER)).toBe('required');
    expect(await res.json()).toEqual({ error: 'sign-in required' });
  });

  it('serves the sign-in form without a session, uncached', async () => {
    const res = (await gate(get(LOGIN_PATH), ENV, opts))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('type="password"');
  });

  it('rejects a wrong password with 401 and no cookie', async () => {
    resetLoginLimits();
    const res = (await gate(login('guess'), ENV, opts))!;
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('signs in with the right password: HttpOnly, Secure, SameSite=Lax cookie for 30 days, back to `next`', async () => {
    resetLoginLimits();
    const res = (await gate(login(ENV.SITE_PASSWORD, '/chart?x=1'), ENV, opts))!;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/chart?x=1');
    const c = res.headers.get('set-cookie')!;
    expect(c.startsWith(`${SESSION_COOKIE}=v1.`)).toBe(true);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) expect(c).toContain(attr);
  });

  it('never redirects off-site after sign-in', async () => {
    resetLoginLimits();
    for (const next of ['//evil.example/x', 'https://evil.example/', '/\\evil.example']) {
      const res = (await gate(login(ENV.SITE_PASSWORD, next), ENV, opts))!;
      expect(res.headers.get('location')).toBe('/');
    }
  });

  it('lets a signed-in request through to the site and the API', async () => {
    resetLoginLimits();
    const cookie = await session();
    expect(await gate(get('/', cookie), ENV, opts)).toBeNull();
    expect(await gate(get('/api/bars?symbol=SPY', `other=1; ${cookie}`), ENV, opts)).toBeNull();
  });

  it('rejects a tampered, expired or other-password session', async () => {
    resetLoginLimits();
    const cookie = await session();
    const tampered = cookie.replace(/v1\.(\d+)/, (_, exp) => `v1.${Number(exp) + 1}`);
    expect((await gate(get('/api/x', tampered), ENV, opts))!.status).toBe(401);
    const day = 86_400_000;
    expect((await gate(get('/api/x', cookie), ENV, { ...opts, now: NOW + 31 * day }))!.status).toBe(401);
    expect((await gate(get('/api/x', cookie), { SITE_PASSWORD: 'changed' }, opts))!.status).toBe(401);
  });

  it('signs out by clearing the cookie', async () => {
    const res = (await gate(get(LOGOUT_PATH), ENV, opts))!;
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('limits password attempts per address', async () => {
    resetLoginLimits();
    for (let k = 0; k < 10; k++) expect((await gate(login('guess', '/', '203.0.113.9'), ENV, opts))!.status).toBe(401);
    expect((await gate(login(ENV.SITE_PASSWORD, '/', '203.0.113.9'), ENV, opts))!.status).toBe(429);
    expect((await gate(login(ENV.SITE_PASSWORD, '/', '203.0.113.10'), ENV, opts))!.status).toBe(303);
  });

  it('fails closed when required but no password is set', async () => {
    const res = (await gate(get('/'), {}, opts))!;
    expect(res.status).toBe(503);
    expect((await gate(get('/api/x'), {}, opts))!.status).toBe(503);
  });

  it('is open when not required and no password is set (local development)', async () => {
    expect(await gate(get('/api/x'), {}, { required: false, now: NOW })).toBeNull();
  });

  it('lets the alert scheduler through only with the cron secret', async () => {
    const env = { ...ENV, CRON_SECRET: 'cron-secret-123' };
    const cron = (init: RequestInit = {}, q = '') => new Request(`https://app.test/api/cron/alerts${q}`, init);
    expect(await gate(cron({ headers: { authorization: 'Bearer cron-secret-123' } }), env, opts)).toBeNull();
    expect(await gate(cron({}, '?key=cron-secret-123'), env, opts)).toBeNull();
    expect((await gate(cron({ headers: { authorization: 'Bearer wrong' } }), env, opts))!.status).toBe(401);
    // the secret opens only the scheduler, not the rest of the API
    expect((await gate(new Request('https://app.test/api/quotes', { headers: { authorization: 'Bearer cron-secret-123' } }), env, opts))!.status).toBe(401);
    // no CRON_SECRET configured: the scheduler stays behind the password
    expect((await gate(cron({ headers: { authorization: 'Bearer ' } }), ENV, opts))!.status).toBe(401);
  });

  it('adds the given security headers to its own responses', async () => {
    const res = (await gate(get(LOGIN_PATH), ENV, { ...opts, headers: { 'X-Content-Type-Options': 'nosniff' } }))!;
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

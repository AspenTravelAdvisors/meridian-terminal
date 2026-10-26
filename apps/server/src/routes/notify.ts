import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { HttpError, type ServerEnv, body, json, rateLimit } from '../http';

/**
 * POST /api/notify — relays alert deliveries the browser cannot make itself (most webhook targets reject
 * cross-origin requests). Guarded against SSRF: https only, public hosts only (checked after DNS
 * resolution), no redirects, small payloads, rate limited.
 */
const notifyBody = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('webhook'), url: z.string().url().max(2000), payload: z.record(z.string(), z.unknown()) }),
  z.object({ channel: z.literal('email'), to: z.string().email().max(200), subject: z.string().max(200), text: z.string().max(5000) }),
]);

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function assertPublicHttps(raw: string, resolve: (h: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((r) => r.address)): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new HttpError(400, 'webhook URL must use https');
  if (u.username || u.password) throw new HttpError(400, 'credentials in URL are not allowed');
  if (u.port && u.port !== '443') throw new HttpError(400, 'only port 443 is allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new HttpError(400, 'private host');
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addrs.length) throw new HttpError(400, 'host does not resolve');
  if (addrs.some(isPrivateAddress)) throw new HttpError(400, 'private address');
  return u;
}

export async function notifyRoute(req: Request, env: ServerEnv & { RESEND_API_KEY?: string; ALERT_EMAIL_FROM?: string }, fetcher: typeof fetch): Promise<Response> {
  rateLimit(req, 'notify', 30);
  const b = await body(req, notifyBody, 20_000);
  if (b.channel === 'webhook') {
    const url = await assertPublicHttps(b.url);
    const r = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'MeridianTerminal-Alerts/0.1' }, body: JSON.stringify(b.payload), redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return json({ ok: r.ok, status: r.status });
  }
  if (!env.RESEND_API_KEY) throw new HttpError(501, 'email delivery is not configured (set RESEND_API_KEY)');
  const r = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.ALERT_EMAIL_FROM ?? 'Meridian Alerts <alerts@resend.dev>', to: [b.to], subject: b.subject, text: b.text }),
    signal: AbortSignal.timeout(8000),
  });
  return json({ ok: r.ok, status: r.status });
}

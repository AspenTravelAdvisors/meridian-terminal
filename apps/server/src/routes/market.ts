import { INTERVALS, SYMBOL_RE, fetchBars, fetchQuotes, searchSymbols, toWire } from '@meridian/data';
import { z } from 'zod';
import { databaseUrl } from '../db';
import { HttpError, type ServerEnv, json, query, rateLimit } from '../http';

const barsQuery = z.object({
  symbol: z.string().regex(SYMBOL_RE, 'invalid symbol'),
  interval: z.enum(INTERVALS).default('1D'),
  to: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1500),
  adjust: z.enum(['split', 'all', 'none']).default('split'),
});

/** GET /api/bars — normalized OHLCV through the provider chain. */
export async function barsRoute(req: Request, env: ServerEnv, fetcher: typeof fetch, now = Date.now()): Promise<Response> {
  rateLimit(req, 'bars', 240, now);
  const q = query(req, barsQuery);
  const r = await fetchBars(q.symbol, q.interval, { to: q.to, limit: q.limit, adjust: q.adjust, now }, fetcher, env);
  const historical = q.to !== undefined && q.to < now - 86_400_000;
  const intraday = ['1m', '5m', '15m', '30m', '1h', '4h'].includes(q.interval);
  // CDN caching: history is immutable; live windows refresh quickly
  const cache = historical ? 'public, s-maxage=86400, stale-while-revalidate=604800' : intraday ? 'public, s-maxage=15, stale-while-revalidate=60' : 'public, s-maxage=120, stale-while-revalidate=600';
  return json({ ...r, bars: r.bars.map(toWire), serverTime: now }, { cache, headers: { 'X-Meridian-Provider': r.provider } });
}

/** GET /api/search?q= */
export async function searchRoute(req: Request, _env: ServerEnv, fetcher: typeof fetch): Promise<Response> {
  rateLimit(req, 'search', 120);
  const { q } = query(req, z.object({ q: z.string().max(40).default('') }));
  return json({ results: await searchSymbols(q, fetcher) }, { cache: 'public, s-maxage=3600, stale-while-revalidate=86400' });
}

/** GET /api/quotes?symbols=A,B,C */
export async function quotesRoute(req: Request, _env: ServerEnv, fetcher: typeof fetch, now = Date.now()): Promise<Response> {
  rateLimit(req, 'quotes', 120, now);
  const { symbols } = query(req, z.object({ symbols: z.string().max(2000) }));
  const list = symbols.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new HttpError(400, 'no symbols');
  if (list.length > 60) throw new HttpError(400, 'at most 60 symbols');
  for (const s of list) if (!SYMBOL_RE.test(s)) throw new HttpError(400, `invalid symbol ${s}`);
  return json({ quotes: await fetchQuotes(list, fetcher, now), serverTime: now }, { cache: 'public, s-maxage=20, stale-while-revalidate=60' });
}

export function healthRoute(_req: Request, env: ServerEnv): Response {
  return json({
    ok: true,
    service: 'meridian-terminal',
    analyst: env.ANTHROPIC_API_KEY ? 'anthropic' : 'rule-based',
    providers: { yahoo: true, binance: true, coinbase: true, stooq: true, sim: true, alpaca: !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY), twelvedata: !!env.TWELVE_DATA_API_KEY },
    accounts: databaseUrl(env) ? 'postgres' : env.VERCEL ? 'off' : 'embedded',
    email: !!env.RESEND_API_KEY,
  });
}

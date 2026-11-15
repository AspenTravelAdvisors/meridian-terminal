import { SYMBOL_RE, fetchPositioning, type PositioningKind } from '@meridian/data';
import { z } from 'zod';
import { HttpError, type ServerEnv, json, query, rateLimit } from '../http';

const kinds = ['funding', 'openInterest', 'longShort', 'shortInterest', 'daysToCover'] as const;

const qSchema = z.object({
  symbol: z.string().regex(SYMBOL_RE, 'invalid symbol'),
  kind: z.enum(kinds),
  interval: z.string().max(8).optional(),
  from: z.coerce.number().int().positive().optional(),
});

/** GET /api/positioning?symbol=&kind=funding|openInterest|longShort|shortInterest|daysToCover */
export async function positioningRoute(req: Request, _env: ServerEnv, fetcher: typeof fetch, now = Date.now()): Promise<Response> {
  rateLimit(req, 'positioning', 120, now);
  const q = query(req, qSchema);
  try {
    const series = await fetchPositioning(q.symbol, q.kind as PositioningKind | 'daysToCover', { interval: q.interval, fromMs: q.from, signal: req.signal }, fetcher);
    // CDN: short interest changes twice a month; funding/OI refresh often
    const cache =
      q.kind === 'shortInterest' || q.kind === 'daysToCover'
        ? 'public, s-maxage=3600, stale-while-revalidate=86400'
        : 'public, s-maxage=120, stale-while-revalidate=600';
    return json({ ...series, serverTime: now }, { cache, headers: { 'X-Meridian-Provider': series.source } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(502, msg);
  }
}

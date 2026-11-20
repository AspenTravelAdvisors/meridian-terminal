import { SYMBOL_RE, fetchNews } from '@meridian/data';
import { z } from 'zod';
import { HttpError, type ServerEnv, json, query, rateLimit } from '../http';

const qSchema = z.object({
  symbol: z.string().regex(SYMBOL_RE, 'invalid symbol'),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
});

/** GET /api/news?symbol=&from=&to= — rated company, industry and market-wide events for the News study. */
export async function newsRoute(req: Request, env: ServerEnv, fetcher: typeof fetch, now = Date.now()): Promise<Response> {
  rateLimit(req, 'news', 60, now);
  const q = query(req, qSchema);
  try {
    const feed = await fetchNews(q.symbol, { fromMs: q.from, toMs: q.to ?? now, secUserAgent: env.SEC_USER_AGENT?.trim() || undefined, now, signal: req.signal }, fetcher);
    // filings land a few times a quarter; the calendar changes only with a deploy
    return json({ ...feed, serverTime: now }, { cache: 'public, s-maxage=3600, stale-while-revalidate=86400', headers: { 'X-Meridian-Provider': feed.sources.join(',') } });
  } catch (e) {
    throw new HttpError(502, e instanceof Error ? e.message : String(e));
  }
}

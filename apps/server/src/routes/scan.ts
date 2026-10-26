import { INTERVALS, SYMBOL_RE, fetchBars } from '@meridian/data';
import { DEFAULT_MATRIX_WEIGHTS, getStudy, matrixCell, scanBars } from '@meridian/engine';
import { z } from 'zod';
import { HttpError, type ServerEnv, body, json, mapLimit, rateLimit } from '../http';

const scanBody = z.object({
  symbols: z.array(z.string().regex(SYMBOL_RE)).min(1).max(40),
  interval: z.enum(INTERVALS).default('1D'),
  studies: z
    .array(z.object({ id: z.string().max(60), cfg: z.record(z.string(), z.unknown()).optional() }))
    .max(12)
    .default([{ id: 'td-sequential' }, { id: 'td-combo' }]),
  signals: z.array(z.string().max(60)).max(50).optional(),
  lookback: z.number().int().min(0).max(500).default(10),
  limit: z.number().int().min(50).max(2000).default(500),
  adjust: z.enum(['split', 'all', 'none']).default('split'),
});

/**
 * POST /api/scan — run studies across a universe server-side (the exact engine code the browser runs).
 * Bars are fetched with bounded concurrency; per-symbol failures are reported per row.
 */
export async function scanRoute(req: Request, env: ServerEnv, fetcher: typeof fetch, now = Date.now()): Promise<Response> {
  rateLimit(req, 'scan', 20, now);
  const b = await body(req, scanBody);
  for (const s of b.studies) if (!getStudy(s.id)) throw new HttpError(400, `unknown study ${s.id}`);
  const t0 = Date.now();
  const rows = await mapLimit(b.symbols, 6, async (symbol) => {
    try {
      const r = await fetchBars(symbol, b.interval, { limit: b.limit, adjust: b.adjust, now }, fetcher, env);
      return { ...scanBars(r.symbol, r.bars, b.studies, { lookback: b.lookback, signals: b.signals }), name: r.info.name, simulated: r.simulated, provider: r.provider };
    } catch (e) {
      return { symbol, error: e instanceof Error ? e.message : String(e), last: NaN, changePct: NaN, bars: 0, statuses: {}, signals: [] };
    }
  });
  return json({ interval: b.interval, rows, ms: Date.now() - t0 });
}

const matrixBody = z.object({
  symbols: z.array(z.string().regex(SYMBOL_RE)).min(1).max(20),
  intervals: z.array(z.enum(INTERVALS)).min(1).max(6).default(['1h', '4h', '1D', '1W', '1M']),
  weights: z
    .object({ setup: z.number(), setup9: z.number(), countdown: z.number(), cd13: z.number(), combo: z.number(), combo13: z.number() })
    .partial()
    .optional(),
});

/** POST /api/matrix — symbols × timeframes Sequential/Combo state. */
export async function matrixRoute(req: Request, env: ServerEnv, fetcher: typeof fetch, now = Date.now()): Promise<Response> {
  rateLimit(req, 'matrix', 20, now);
  const b = await body(req, matrixBody);
  if (b.symbols.length * b.intervals.length > 90) throw new HttpError(400, 'at most 90 cells per request');
  const w = { ...DEFAULT_MATRIX_WEIGHTS, ...b.weights };
  const pairs = b.symbols.flatMap((s) => b.intervals.map((iv) => [s, iv] as const));
  const cells = await mapLimit(pairs, 8, async ([symbol, interval]) => {
    try {
      const r = await fetchBars(symbol, interval, { limit: 400, now }, fetcher, env);
      return { symbol, interval, cell: matrixCell(r.bars.filter((x) => x.final !== false), w), simulated: r.simulated };
    } catch (e) {
      return { symbol, interval, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return json({ cells });
}

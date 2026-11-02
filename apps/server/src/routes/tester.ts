import { INTERVALS, SYMBOL_RE, fetchBars } from '@meridian/data';
import { type RuleSet, TEST_EXPORT_SCHEMA, type TestRunCsvPart, buildTestRun, getStudy, replayQuery, ruleIntervals, testRunCsv, walkForward } from '@meridian/engine';
import { z } from 'zod';
import { HttpError, type ServerEnv, json, mapLimit, query, rateLimit } from '../http';

const csvList = (max: number, min = 1) =>
  z
    .string()
    .max(2000)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().max(60)).min(min).max(max));
const jsonParam = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .max(4000)
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema);

const strategySchema = z.object({
  exitOnOpposite: z.boolean(),
  stop: z.enum(['none', 'pct', 'atr', 'level']),
  stopPct: z.number().min(0).max(100),
  atrMult: z.number().min(0).max(50),
  atrLength: z.number().int().min(1).max(500),
  timeStopBars: z.number().int().min(0).max(10_000),
  takeProfitPct: z.number().min(0).max(1000),
  feesBps: z.number().min(0).max(1000),
  slippageBps: z.number().min(0).max(1000),
  entryAt: z.enum(['nextOpen', 'close']),
  exitAt: z.enum(['nextOpen', 'close']).optional(),
  allowShort: z.boolean(),
  capital: z.number().positive().max(1e12).optional(),
  sizing: z.object({ mode: z.enum(['percentEquity', 'fixedDollar', 'riskPercent', 'fixedShares']), value: z.number().positive().max(1e12) }).optional(),
  maxPositions: z.number().int().min(1).max(100).optional(),
  wholeShares: z.boolean().optional(),
  commission: z.number().min(0).max(10_000).optional(),
  gapFill: z.enum(['open', 'level']).optional(),
  sameBar: z.enum(['stopFirst', 'targetFirst', 'nearerOpen']).optional(),
  stopOnEntryBar: z.boolean().optional(),
});

const operand = z.union([
  z.object({ kind: z.literal('price'), field: z.enum(['o', 'h', 'l', 'c']) }),
  z.object({ kind: z.literal('line'), study: z.string().max(60), cfg: z.record(z.string(), z.unknown()).optional(), output: z.string().max(60) }),
  z.object({ kind: z.literal('value'), value: z.number() }),
]);
const condition = z.union([
  z.object({ kind: z.literal('signal'), interval: z.enum(INTERVALS).optional(), study: z.string().max(60), cfg: z.record(z.string(), z.unknown()).optional(), signal: z.string().max(60), withinBars: z.number().int().min(0).max(500) }),
  z.object({ kind: z.literal('compare'), interval: z.enum(INTERVALS).optional(), left: operand, op: z.enum(['>', '<', '>=', '<=', 'crossesAbove', 'crossesBelow']), right: operand }),
]);
const group = z.object({ combine: z.enum(['all', 'any']), conditions: z.array(condition).min(1).max(8) });
const rulesSchema = z.object({ trigger: z.enum(['rising', 'every']), longEntry: group.optional(), shortEntry: group.optional(), longExit: group.optional(), shortExit: group.optional() });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const wfSchema = z.object({
  trainYears: z.number().int().min(1).max(50),
  testYears: z.number().int().min(1).max(20),
  anchored: z.boolean().default(false),
  param: z.object({ key: z.string().max(60), values: z.array(z.union([z.number(), z.string().max(60), z.boolean()])).min(1).max(12) }).optional(),
  metric: z.enum(['eventMean', 'strategyReturn']).default('eventMean'),
  metricHorizon: z.number().int().min(1).max(999),
  minEvents: z.number().int().min(0).max(10_000).default(10),
});

const testerQuery = z.object({
  symbol: z.string().regex(SYMBOL_RE, 'invalid symbol'),
  interval: z.enum(INTERVALS).default('1D'),
  study: z.string().max(60),
  signals: csvList(50, 0).optional().default([]),
  horizons: csvList(12)
    .transform((xs) => xs.map(Number))
    .pipe(z.array(z.number().int().min(1).max(999)))
    .default([1, 5, 10, 20, 60]),
  cfg: jsonParam(z.record(z.string(), z.unknown())).optional(),
  strategy: jsonParam(strategySchema).optional(),
  seed: z.coerce.number().int().default(11),
  samples: z.coerce.number().int().min(0).max(5000).default(600),
  bars: z.coerce.number().int().min(50).max(5000).default(5000),
  adjust: z.enum(['split', 'all', 'none']).default('split'),
  /** epoch ms: only bars strictly before this (pins the data; exports set it) */
  to: z.coerce.number().int().positive().optional(),
  /** evaluation window, inclusive (studies warm up on earlier bars) */
  from: isoDate.optional(),
  until: isoDate.optional(),
  /** walk-forward instead of a single run; `symbols` pools several (comma separated, max 10) */
  wf: jsonParam(wfSchema).optional(),
  /** combined rules (study=rules) */
  rules: jsonParam(rulesSchema).optional(),
  symbols: csvList(10).optional(),
  format: z.enum(['json', 'csv']).default('json'),
  part: z.enum(['summary', 'signals', 'events', 'trades', 'equity']).default('summary'),
});

/**
 * GET /api/tester — read-only, deterministic rerun of a Signal Tester run with the same engine code as the browser.
 * Returns the full run record (JSON) or one CSV part. Same query + same data → byte-identical output; the record's
 * bars hash shows when a provider revised the history inside the window.
 */
export async function testerRoute(req: Request, env: ServerEnv, fetcher: typeof fetch, now = Date.now()): Promise<Response> {
  rateLimit(req, 'tester', 30, now);
  const q = query(req, testerQuery);
  if (q.study.startsWith('script:')) throw new HttpError(400, 'script studies run in the browser only; export them from the Signal Tester');
  if (q.study === 'rules' ? !q.rules : !getStudy(q.study)) throw new HttpError(400, q.study === 'rules' ? 'study=rules needs a rules parameter' : `unknown study ${q.study}`);
  if (q.wf) return walkForwardResponse(q, env, fetcher, now);
  const r = await fetchBars(q.symbol, q.interval, { to: q.to, limit: q.bars, adjust: q.adjust, now }, fetcher, env);
  const bars = r.bars.filter((b) => b.final !== false);
  // higher-timeframe bars the rules read, over the same span
  const aux: Record<string, typeof bars> = {};
  if (q.rules)
    for (const iv of ruleIntervals(q.rules as RuleSet, q.interval)) {
      const x = await fetchBars(q.symbol, iv as (typeof INTERVALS)[number], { to: q.to, limit: 5000, adjust: q.adjust, now }, fetcher, env);
      aux[iv] = x.bars.filter((b) => b.final !== false);
    }
  if (bars.length < 2) throw new HttpError(422, 'not enough closed bars in the window');
  let run;
  try {
    run = buildTestRun(
      bars,
      { symbol: r.symbol, interval: q.interval, study: q.study, studyConfig: q.cfg ?? {}, signals: q.signals, horizons: q.horizons, baseline: { seed: q.seed, samples: q.samples }, strategy: q.strategy ?? null, ...(q.from || q.until ? { window: { from: q.from, to: q.until } } : {}), ...(q.rules ? { rules: q.rules as RuleSet } : {}) },
      { provider: r.provider, adjust: r.adjust, simulated: r.simulated, requestedBars: q.bars },
      { aux },
    );
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
  // a pinned window in the past is immutable apart from provider revisions
  const cache = q.to !== undefined && q.to < now - 86_400_000 ? 'public, s-maxage=3600, stale-while-revalidate=86400' : 'no-store';
  const headers = { 'X-Meridian-Run': run.hashes.run, 'X-Meridian-Engine': run.engineVersion };
  if (q.format === 'csv')
    return new Response(testRunCsv([run], q.part as TestRunCsvPart), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `inline; filename="${r.symbol.replace(/[^\w.-]+/g, '_')}-${q.part}.csv"`, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', ...headers },
    });
  return json({ schema: TEST_EXPORT_SCHEMA, runs: [run], replay: `/api/tester?${replayQuery(run)}` }, { cache, headers });
}

/** Walk-forward over calendar-year folds; one symbol or several pooled. JSON only. */
async function walkForwardResponse(q: z.infer<typeof testerQuery>, env: ServerEnv, fetcher: typeof fetch, now: number): Promise<Response> {
  if (q.format === 'csv') throw new HttpError(400, 'walk-forward results are JSON only');
  const symbols = q.symbols ?? [q.symbol];
  for (const s of symbols) if (!SYMBOL_RE.test(s)) throw new HttpError(400, `invalid symbol ${s}`);
  const series = await mapLimit(symbols, 4, async (s) => {
    const r = await fetchBars(s, q.interval, { to: q.to, limit: q.bars, adjust: q.adjust, now }, fetcher, env);
    return { symbol: r.symbol, bars: r.bars.filter((b) => b.final !== false), source: { provider: r.provider, adjust: r.adjust, simulated: r.simulated, requestedBars: q.bars } };
  });
  try {
    const result = walkForward(series, { interval: q.interval, study: q.study, studyConfig: q.cfg ?? {}, signals: q.signals, horizons: q.horizons, baseline: { seed: q.seed, samples: q.samples }, strategy: q.strategy ?? null }, q.wf!);
    return json(result, { headers: { 'X-Meridian-Engine': result.engineVersion } });
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
}

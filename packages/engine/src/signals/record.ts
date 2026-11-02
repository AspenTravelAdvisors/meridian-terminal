import { resolveConfig } from '../core/params';
import { computeStudy } from '../core/runner';
import type { Bar, SignalDir } from '../core/types';
import { getStudy } from '../registry';
import { type RuleSet, evaluateRules, intervalMs } from './rules';
import { type BarRange, type HorizonStats, type StrategyConfig, eventStudy, runStrategy } from './tester';
import { type CI, type RandomTiming, type TradeStats, bootstrapMeanCI, exposureMatchedReturn, pTwoSided, randomTimingBenchmark, tradeStats } from './uncertainty';

// A test run as a self-describing, reproducible record: everything needed to rerun it (spec, resolved study
// parameters, data window, engine version) plus everything it produced (signals, per-event returns, trades,
// per-bar equity). The browser Signal Tester and GET /api/tester both build it here, so their output is identical.

/** Keep in step with packages/engine/package.json (a test enforces it). */
export const ENGINE_VERSION = '0.3.0';
export const TEST_RUN_SCHEMA = 'meridian.test-run/1';
export const TEST_EXPORT_SCHEMA = 'meridian.test-export/1';

export type StrategyParams = Omit<StrategyConfig, 'entries' | 'stopLevels' | 'exits'>;

/** Inclusive evaluation window, YYYY-MM-DD; either end may be omitted. */
export interface TestWindow {
  from?: string;
  to?: string;
}

export interface YearRow {
  year: number;
  /** signals in the year */
  signals: number;
  /** per horizon: events with a full horizon, their mean return (%) and hit rate */
  n: number[];
  mean: number[];
  hitRate: number[];
}

export interface TestRunSpec {
  symbol: string;
  interval: string;
  /** study id, `rules` for combined rules (see `rules`), or `script:<name>` for a saved Meridian Script (events precomputed) */
  study: string;
  /** study parameters; built-in studies are resolved to the full set, defaults included */
  studyConfig: Record<string, unknown>;
  signals: string[];
  horizons: number[];
  baseline: { seed: number; samples: number };
  /** null = event study only */
  strategy: StrategyParams | null;
  /** evaluate only this date window (studies still warm up on earlier bars); omitted = all bars */
  window?: TestWindow;
  /** combined entry / exit rules when study = 'rules' */
  rules?: RuleSet;
}

export interface TestRunSource {
  provider: string;
  adjust: string;
  simulated: boolean;
  /** bars asked for; `data.bars` is how many came back */
  requestedBars: number;
  /** hash of a script's source when the study is a script */
  scriptHash?: string;
}

export interface TestRunEvent {
  i: number;
  dir: SignalDir;
  id: string;
}

export interface TestRunRecord {
  schema: typeof TEST_RUN_SCHEMA;
  engineVersion: string;
  /** not cryptographic: for telling runs apart. run = spec + bars + engine version */
  hashes: { spec: string; bars: string; run: string };
  spec: TestRunSpec;
  /** `from`/`to`/`bars` describe every bar loaded; `evaluated` the window results cover (the rest is warm-up) */
  data: TestRunSource & {
    symbol: string;
    interval: string;
    bars: number;
    from: string;
    to: string;
    fromT: number;
    toT: number;
    evaluated: { from: string; to: string; bars: number; warmupBars: number };
    /** higher-timeframe bars read by combined rules (only bars closed by the last base bar) */
    aux?: { interval: string; bars: number; from: string; to: string }[];
  };
  signals: { i: number; t: number; date: string; id: string; dir: SignalDir }[];
  eventStudy: {
    entry: 'signal bar close';
    /** bear signals are measured short, all others long */
    population: { measuredLong: number; measuredShort: number };
    /** per horizon, with a seeded bootstrap 95% interval for the mean and a two-sided p-value of its t-statistic */
    horizons: (Omit<HorizonStats, 'returns'> & { ci95: CI; p: number })[];
    /** one row per signal; returns[k] is for horizons[k], null where it runs past the last bar */
    events: { date: string; id: string; dir: SignalDir; measured: 'long' | 'short'; entry: number; returns: (number | null)[] }[];
    byYear: YearRow[];
  };
  /** combined rules: base bars on which each condition was true, per group (all loaded bars) */
  diagnostics?: { trueBars: Record<string, number[]> };
  strategy: null | {
    population: { trades: number; long: number; short: number; buySignals: number; sellSignals: 'entries' | 'exits' | 'ignored'; ruleExits?: number };
    stats: ReturnType<typeof runStrategy>['stats'];
    tradeStats: TradeStats;
    /** what the same exposure earned without the timing: buy & hold, buy & hold at the average exposure, random dates */
    benchmarks: { buyHoldPct: number; exposureMatchedPct: number; avgGrossExposure: number; randomTiming: RandomTiming };
    trades: { entryDate: string; exitDate: string; entryT: number; exitT: number; side: 'long' | 'short'; entry: number; exit: number; retPct: number; reason: string; shares: number; notional: number; pnl: number; gap?: boolean; ambiguous?: boolean }[];
    /** one row per bar (per day on daily bars): equity multiple and buy & hold multiple */
    /** `equity` is a multiple of starting capital, `value` the same in dollars */
    equity: { date: string; t: number; equity: number; value: number; buyHold: number }[];
    byYear: { year: number; returnPct: number; trades: number; maxDrawdownPct: number }[];
  };
}

// ── Deterministic helpers ───────────────────────────────────────────────────
/** JSON with object keys sorted at every level (typed arrays become arrays, non-finite numbers null). */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return typeof x === 'number' && !Number.isFinite(x) ? null : x;
    if (ArrayBuffer.isView(x)) return Array.from(x as unknown as ArrayLike<number>, norm);
    if (Array.isArray(x)) return x.map(norm);
    const o = x as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, norm(o[k])]),
    );
  };
  return JSON.stringify(norm(v));
}

/** 106-bit non-cryptographic string hash (two cyrb53 lanes), as 28 hex digits. */
export function hashString(s: string): string {
  const lane = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return lane(0) + lane(0x9e3779b9);
}

const barsHash = (bars: readonly Bar[]) => hashString(bars.map((b) => `${b.t},${b.o},${b.h},${b.l},${b.c},${b.v}`).join(';'));

/** Dates: YYYY-MM-DD for daily and slower bars, full UTC time for intraday. */
const dateFn = (interval: string) => (/^\d*[DWM]$/.test(interval) ? (t: number) => new Date(t).toISOString().slice(0, 10) : (t: number) => `${new Date(t).toISOString().slice(0, 19)}Z`);

// ── Builder ─────────────────────────────────────────────────────────────────
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Bar indices of an inclusive date window (YYYY-MM-DD, either end optional); null when no bar falls inside. */
export function windowRange(bars: readonly Bar[], w?: TestWindow): BarRange | null {
  let start = 0;
  let end = bars.length - 1;
  if (w?.from) while (start <= end && isoDay(bars[start].t) < w.from) start++;
  if (w?.to) while (end >= start && isoDay(bars[end].t) > w.to) end--;
  return start <= end ? { start, end } : null;
}

type Lines = { riskBuy?: ArrayLike<number>; riskSell?: ArrayLike<number> };

/** A built-in study's selected signals and risk lines, with its parameters resolved (defaults filled in). */
export function studyEvents(bars: readonly Bar[], study: string, cfg: Record<string, unknown>, signals: readonly string[]): { config: Record<string, unknown>; events: TestRunEvent[]; lines: Lines } {
  const def = getStudy(study);
  if (!def) throw new Error(`unknown study ${study}`);
  const config = resolveConfig(def, cfg);
  const r = computeStudy(def, config, bars);
  const want = new Set(signals);
  return {
    config,
    events: r.signals.filter((s) => want.has(s.id)).map((s) => ({ i: s.i, dir: s.dir, id: s.id })),
    // risk lines double as stop levels for the strategy
    lines: { riskBuy: r.lines.cdrisk_buy ?? r.lines.risk_buy, riskSell: r.lines.cdrisk_sell ?? r.lines.risk_sell },
  };
}

/** Per calendar year (UTC): events, mean return and hit rate at each horizon. Purged events (null) don't count. */
export function eventsByYear(rows: readonly { date: string; returns: readonly (number | null)[] }[], horizons: readonly number[]): YearRow[] {
  const by = new Map<number, (number | null)[][]>();
  for (const r of rows) {
    const y = Number(r.date.slice(0, 4));
    const arr = by.get(y) ?? [];
    arr.push(r.returns.slice());
    by.set(y, arr);
  }
  return [...by.keys()]
    .sort((x, y) => x - y)
    .map((year) => {
      const rs = by.get(year)!;
      const col = (k: number) => rs.map((r) => r[k]).filter((x): x is number => x !== null);
      return {
        year,
        signals: rs.length,
        n: horizons.map((_, k) => col(k).length),
        mean: horizons.map((_, k) => {
          const c = col(k);
          return c.length ? c.reduce((x, y) => x + y, 0) / c.length : NaN;
        }),
        hitRate: horizons.map((_, k) => {
          const c = col(k);
          return c.length ? c.filter((x) => x > 0).length / c.length : NaN;
        }),
      };
    });
}

/**
 * Run the event study (and strategy, when `spec.strategy` is set) on closed bars and return the full record.
 * Built-in studies are computed here; scripts pass their `events` in. With `spec.window`, studies still warm up on
 * the bars before it, but only signals inside the window count, each only if its horizon also ends inside it, and the
 * strategy closes any open trade on the window's last bar: nothing after the window is read.
 */
export function buildTestRun(
  bars: readonly Bar[],
  spec: TestRunSpec,
  source: TestRunSource,
  pre?: { events?: TestRunEvent[]; lines?: Lines; barsHash?: string; aux?: Record<string, readonly Bar[]> },
): TestRunRecord {
  let all: TestRunEvent[];
  let exits: TestRunEvent[] = [];
  let diagnostics: TestRunRecord['diagnostics'];
  let lines: Lines = pre?.lines ?? {};
  let studyConfig = spec.studyConfig;
  // higher-timeframe bars, cut to those closed by the last base bar so a later fetch hashes the same
  const baseMs = spec.rules ? intervalMs(spec.interval) : 0;
  const lastClose = bars.length ? bars[bars.length - 1].t + baseMs : -Infinity;
  const aux = Object.fromEntries(Object.entries(pre?.aux ?? {}).map(([iv, b]) => [iv, b.filter((x) => x.t + intervalMs(iv) <= lastClose)]));
  if (pre?.events) all = pre.events.slice().sort((a, b) => a.i - b.i);
  else if (spec.study === 'rules') {
    if (!spec.rules) throw new Error('study "rules" needs a rule set');
    const r = evaluateRules({ bars, intervalMs: baseMs }, spec.rules, Object.fromEntries(Object.entries(aux).map(([iv, b]) => [iv, { bars: b, intervalMs: intervalMs(iv) }])), spec.interval);
    all = r.entries;
    exits = r.exits;
    diagnostics = { trueBars: r.trueBars };
  } else {
    const r = studyEvents(bars, spec.study, spec.studyConfig, spec.signals);
    ({ config: studyConfig, events: all, lines } = r);
  }
  const fullSpec: TestRunSpec = { ...spec, studyConfig };
  if (!spec.window) delete fullSpec.window;
  const range = windowRange(bars, spec.window);
  if (!range) throw new Error(`no bars between ${spec.window?.from ?? 'the start'} and ${spec.window?.to ?? 'the end'}`);
  const { start, end } = range;
  const events = all.filter((e) => e.i >= start && e.i <= end);
  const date = dateFn(spec.interval);
  const n = bars.length;

  const es = eventStudy(bars, events, spec.horizons, { seed: spec.baseline.seed, baselineSamples: spec.baseline.samples, range });
  const eventRows = events.map((e) => {
    const sign = e.dir === 'bear' ? -1 : 1;
    const entry = bars[e.i].c;
    return {
      date: date(bars[e.i].t),
      id: e.id,
      dir: e.dir,
      measured: sign > 0 ? ('long' as const) : ('short' as const),
      entry,
      returns: spec.horizons.map((h) => (e.i + h <= end ? (sign * 100 * (bars[e.i + h].c - entry)) / entry : null)),
    };
  });

  let strategy: TestRunRecord['strategy'] = null;
  if (spec.strategy) {
    const s = spec.strategy;
    const r = runStrategy(bars, { ...s, entries: events, exits, stopLevels: { long: lines.riskBuy, short: lines.riskSell } }, range);
    const c0 = bars[start].c;
    const equity = Array.from(r.equity, (v, k) => ({ date: date(bars[start + k].t), t: bars[start + k].t, equity: v, value: v * r.stats.startCapital, buyHold: bars[start + k].c / c0 }));
    const trades = r.trades.map((t) => ({ entryDate: date(bars[start + t.entryI].t), exitDate: date(bars[start + t.exitI].t), entryT: bars[start + t.entryI].t, exitT: bars[start + t.exitI].t, side: t.dir > 0 ? ('long' as const) : ('short' as const), entry: t.entry, exit: t.exit, retPct: t.ret, reason: t.reason, shares: t.shares, notional: t.notional, pnl: t.pnl, ...(t.gap ? { gap: true } : {}), ...(t.ambiguous ? { ambiguous: true } : {}) }));
    strategy = {
      population: {
        trades: r.trades.length,
        long: r.trades.filter((t) => t.dir > 0).length,
        short: r.trades.filter((t) => t.dir < 0).length,
        buySignals: events.filter((e) => e.dir === 'bull').length,
        sellSignals: s.allowShort ? 'entries' : s.exitOnOpposite ? 'exits' : 'ignored',
        ...(spec.rules ? { ruleExits: r.trades.filter((t) => t.reason === 'exit').length } : {}),
      },
      stats: r.stats,
      tradeStats: tradeStats(r.trades, spec.baseline.seed),
      benchmarks: {
        buyHoldPct: r.stats.buyHold,
        exposureMatchedPct: exposureMatchedReturn(bars.slice(start, end + 1), r.stats.avgGrossExposure),
        avgGrossExposure: r.stats.avgGrossExposure,
        randomTiming: randomTimingBenchmark(bars.slice(start, end + 1), r.trades, { seed: spec.baseline.seed, samples: 500, costBps: s.feesBps + s.slippageBps }),
      },
      trades,
      equity,
      byYear: strategyByYear(equity, trades),
    };
  }

  const specHash = hashString(canonicalJson(fullSpec));
  const auxKeys = Object.keys(aux).sort();
  const bHash = auxKeys.length ? hashString([pre?.barsHash ?? barsHash(bars), ...auxKeys.map((k) => `${k}:${barsHash(aux[k])}`)].join('|')) : (pre?.barsHash ?? barsHash(bars));
  return {
    schema: TEST_RUN_SCHEMA,
    engineVersion: ENGINE_VERSION,
    hashes: { spec: specHash, bars: bHash, run: hashString(`${ENGINE_VERSION}|${specHash}|${bHash}`) },
    spec: fullSpec,
    data: {
      ...source,
      symbol: spec.symbol,
      interval: spec.interval,
      bars: n,
      from: n ? date(bars[0].t) : '',
      to: n ? date(bars[n - 1].t) : '',
      fromT: bars[0]?.t ?? NaN,
      toT: bars[n - 1]?.t ?? NaN,
      evaluated: { from: date(bars[start].t), to: date(bars[end].t), bars: end - start + 1, warmupBars: start },
      ...(auxKeys.length ? { aux: auxKeys.map((iv) => ({ interval: iv, bars: aux[iv].length, from: aux[iv].length ? isoDay(aux[iv][0].t) : '', to: aux[iv].length ? isoDay(aux[iv][aux[iv].length - 1].t) : '' })) } : {}),
    },
    signals: events.map((e) => ({ i: e.i, t: bars[e.i].t, date: date(bars[e.i].t), id: e.id, dir: e.dir })),
    eventStudy: {
      entry: 'signal bar close',
      population: { measuredLong: events.filter((e) => e.dir !== 'bear').length, measuredShort: events.filter((e) => e.dir === 'bear').length },
      horizons: es.horizons.map(({ returns, ...h }) => ({ ...h, ci95: bootstrapMeanCI(returns, { seed: spec.baseline.seed }), p: pTwoSided(h.t) })),
      events: eventRows,
      byYear: eventsByYear(eventRows, spec.horizons),
    },
    ...(diagnostics ? { diagnostics } : {}),
    strategy,
  };
}

/** Strategy return per calendar year (equity at the year's last bar vs. the previous year's), trades by exit year. */
function strategyByYear(equity: readonly { date: string; equity: number }[], trades: readonly { exitDate: string; retPct: number }[]) {
  const out: { year: number; returnPct: number; trades: number; maxDrawdownPct: number }[] = [];
  let prevEnd = equity[0]?.equity ?? 1;
  let k = 0;
  while (k < equity.length) {
    const year = Number(equity[k].date.slice(0, 4));
    let peak = prevEnd;
    let mdd = 0;
    let last = prevEnd;
    for (; k < equity.length && Number(equity[k].date.slice(0, 4)) === year; k++) {
      last = equity[k].equity;
      peak = Math.max(peak, last);
      mdd = Math.min(mdd, last / peak - 1);
    }
    out.push({ year, returnPct: 100 * (last / prevEnd - 1), trades: trades.filter((t) => Number(t.exitDate.slice(0, 4)) === year).length, maxDrawdownPct: 100 * mdd });
    prevEnd = last;
  }
  return out;
}

// ── Walk-forward ────────────────────────────────────────────────────────────
export interface WalkForwardSpec {
  trainYears: number;
  testYears: number;
  /** true: every training window starts at the first year; false: it rolls forward with the test window */
  anchored: boolean;
  /** optional study parameter picked on each training window, then frozen for the following test window */
  param?: { key: string; values: (number | string | boolean)[] };
  /** what "best" means on the training window */
  metric: 'eventMean' | 'strategyReturn';
  /** horizon (bars) for eventMean; must be one of spec.horizons */
  metricHorizon: number;
  /** a candidate needs at least this many training events (eventMean) or trades (strategyReturn) */
  minEvents: number;
}

export interface PeriodSummary {
  from: string;
  to: string;
  symbols: number;
  horizons: { horizon: number; n: number; mean: number; median: number; hitRate: number }[];
  /** mean strategy return across symbols, when the spec has a strategy */
  strategyReturnPct: number | null;
  trades: number;
}

export interface WalkForwardFold {
  fold: number;
  train: PeriodSummary;
  /** null when no candidate met minEvents on the training window */
  test: PeriodSummary | null;
  chosen: number | string | boolean | null;
  candidates: { value: number | string | boolean | null; metric: number; n: number }[];
}

export interface WalkForwardResult {
  schema: 'meridian.walk-forward/1';
  engineVersion: string;
  spec: Omit<TestRunSpec, 'symbol' | 'window'> & { symbols: string[] };
  walkForward: WalkForwardSpec;
  hashes: { spec: string; bars: string[] };
  folds: WalkForwardFold[];
  /** every test window pooled: the out-of-sample record */
  outOfSample: PeriodSummary | null;
  /** parameter evaluations made on training windows (folds × candidates) */
  trials: number;
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

function summarize(runs: readonly TestRunRecord[], horizons: readonly number[], from: string, to: string): PeriodSummary {
  const strat = runs.filter((r) => r.strategy);
  return {
    from,
    to,
    symbols: runs.length,
    horizons: horizons.map((horizon, k) => {
      const xs = runs.flatMap((r) => r.eventStudy.events.map((e) => e.returns[k]).filter((x): x is number => x !== null));
      return { horizon, n: xs.length, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN, median: median(xs), hitRate: xs.length ? xs.filter((x) => x > 0).length / xs.length : NaN };
    }),
    strategyReturnPct: strat.length ? strat.reduce((a, r) => a + r.strategy!.stats.totalReturn, 0) / strat.length : null,
    trades: strat.reduce((a, r) => a + r.strategy!.stats.trades, 0),
  };
}

/**
 * Walk-forward test over calendar-year folds: on each training window pick the best candidate value of one study
 * parameter (or just measure, with no parameter), freeze it, and evaluate it on the next, unseen test window. Signals
 * are pooled across symbols. Built-in studies only.
 */
export function walkForward(series: readonly { bars: readonly Bar[]; source: TestRunSource; symbol: string }[], spec: Omit<TestRunSpec, 'symbol' | 'window'>, wf: WalkForwardSpec): WalkForwardResult {
  const k = spec.horizons.indexOf(wf.metricHorizon);
  if (wf.metric === 'eventMean' && k < 0) throw new Error(`metric horizon ${wf.metricHorizon} is not one of the horizons`);
  if (wf.metric === 'strategyReturn' && !spec.strategy) throw new Error('strategyReturn needs strategy settings');
  if (!(wf.trainYears >= 1 && wf.testYears >= 1)) throw new Error('train and test windows need at least one year each');
  if (spec.rules || spec.study === 'rules') throw new Error('walk-forward runs a single study; combined rules are not supported yet');
  const live = series.filter((s) => s.bars.length > 1);
  const bHashes = live.map((s) => barsHash(s.bars));
  const values: (number | string | boolean | null)[] = wf.param?.values.length ? wf.param.values : [null];
  // one study computation per candidate value and symbol; folds only filter by date
  const computed = values.map((v) => live.map((s) => studyEvents(s.bars, spec.study, v === null ? spec.studyConfig : { ...spec.studyConfig, [wf.param!.key]: v }, spec.signals)));
  const runsFor = (ci: number, w: TestWindow) =>
    live.flatMap((s, si) => {
      const c = computed[ci][si];
      try {
        return [buildTestRun(s.bars, { ...spec, symbol: s.symbol, studyConfig: c.config, window: w }, s.source, { events: c.events, lines: c.lines, barsHash: bHashes[si] })];
      } catch {
        return []; // no bars for this symbol in the window
      }
    });
  const year = (t: number) => new Date(t).getUTCFullYear();
  const first = Math.min(...live.map((s) => year(s.bars[0].t)));
  const lastDay = live.map((s) => isoDay(s.bars[s.bars.length - 1].t)).sort().pop() ?? '';
  const folds: WalkForwardFold[] = [];
  const oosRuns: TestRunRecord[] = [];
  for (let f = 0; ; f++) {
    const testStart = first + wf.trainYears + f * wf.testYears;
    if (`${testStart}-01-01` > lastDay || f > 200) break;
    const trainW = { from: `${wf.anchored ? first : first + f * wf.testYears}-01-01`, to: `${testStart - 1}-12-31` };
    const testW = { from: `${testStart}-01-01`, to: `${testStart + wf.testYears - 1}-12-31` };
    const candidates = values.map((value, ci) => {
      const runs = runsFor(ci, trainW);
      const sum = summarize(runs, spec.horizons, trainW.from, trainW.to);
      const n = wf.metric === 'eventMean' ? sum.horizons[k].n : sum.trades;
      const metric = n >= wf.minEvents ? (wf.metric === 'eventMean' ? sum.horizons[k].mean : (sum.strategyReturnPct ?? NaN)) : NaN;
      return { value, metric, n, sum };
    });
    let best = -1;
    candidates.forEach((c, ci) => {
      if (Number.isFinite(c.metric) && (best < 0 || c.metric > candidates[best].metric)) best = ci;
    });
    // the training summary shown is the chosen candidate's (or the first's, when none qualified)
    const trainSum = candidates[Math.max(0, best)].sum;
    let test: PeriodSummary | null = null;
    if (best >= 0) {
      const runs = runsFor(best, testW);
      oosRuns.push(...runs);
      test = summarize(runs, spec.horizons, testW.from, testW.to);
    }
    folds.push({ fold: f + 1, train: trainSum, test, chosen: best >= 0 ? values[best] : null, candidates: candidates.map(({ value, metric, n }) => ({ value, metric, n })) });
  }
  const tested = folds.filter((f) => f.test);
  return {
    schema: 'meridian.walk-forward/1',
    engineVersion: ENGINE_VERSION,
    spec: { ...spec, symbols: live.map((s) => s.symbol) },
    walkForward: wf,
    hashes: { spec: hashString(canonicalJson({ spec, wf, symbols: live.map((s) => s.symbol) })), bars: bHashes },
    folds,
    outOfSample: tested.length ? summarize(oosRuns, spec.horizons, tested[0].test!.from, tested[tested.length - 1].test!.to) : null,
    trials: folds.length * values.length,
  };
}

/** Query string for GET /api/tester that reruns `r` on the same data: its bar count ending strictly before `to`, and its evaluation window (`from` / `until`). */
export function replayQuery(r: TestRunRecord): string {
  const q = new URLSearchParams({
    symbol: r.spec.symbol,
    interval: r.spec.interval,
    study: r.spec.study,
    signals: r.spec.signals.join(','),
    horizons: r.spec.horizons.join(','),
    cfg: canonicalJson(r.spec.studyConfig),
    seed: String(r.spec.baseline.seed),
    samples: String(r.spec.baseline.samples),
    // the closed bars actually used (a forming bar dropped from the original request must not pull in an older one)
    bars: String(r.data.bars),
    adjust: r.data.adjust,
    to: String(r.data.toT + 1),
  });
  if (r.spec.strategy) q.set('strategy', canonicalJson(r.spec.strategy));
  if (!r.spec.signals.length) q.delete('signals');
  if (r.spec.rules) q.set('rules', canonicalJson(r.spec.rules));
  if (r.spec.window?.from) q.set('from', r.spec.window.from);
  if (r.spec.window?.to) q.set('until', r.spec.window.to);
  return q.toString();
}

// ── CSV ─────────────────────────────────────────────────────────────────────
export type TestRunCsvPart = 'summary' | 'signals' | 'events' | 'trades' | 'equity';

const cell = (v: unknown): string => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = typeof v === 'object' ? canonicalJson(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = (header: string[], body: unknown[][]) => [header, ...body].map((r) => r.map(cell).join(',')).join('\n') + '\n';

/** One CSV per part covering every run; each row starts with the run hash and symbol so files can be joined. */
export function testRunCsv(runs: readonly TestRunRecord[], part: TestRunCsvPart): string {
  const key = (r: TestRunRecord) => [r.hashes.run, r.data.symbol];
  switch (part) {
    case 'signals':
      return rows(['run_hash', 'symbol', 'date', 'signal', 'direction'], runs.flatMap((r) => r.signals.map((s) => [...key(r), s.date, s.id, s.dir])));
    case 'events': {
      const hs = runs[0]?.spec.horizons ?? [];
      return rows(['run_hash', 'symbol', 'date', 'signal', 'direction', 'measured', 'entry_close', ...hs.map((h) => `ret_${h}`)], runs.flatMap((r) => r.eventStudy.events.map((e) => [...key(r), e.date, e.id, e.dir, e.measured, e.entry, ...e.returns])));
    }
    case 'trades':
      return rows(['run_hash', 'symbol', 'entry_date', 'exit_date', 'side', 'entry', 'exit', 'shares', 'notional', 'pnl', 'return_pct', 'exit_reason', 'gap_fill', 'stop_and_target_same_bar'], runs.flatMap((r) => (r.strategy?.trades ?? []).map((t) => [...key(r), t.entryDate, t.exitDate, t.side, t.entry, t.exit, t.shares, t.notional, t.pnl, t.retPct, t.reason, !!t.gap, !!t.ambiguous])));
    case 'equity':
      return rows(['run_hash', 'symbol', 'date', 'equity', 'buy_hold', 'equity_value'], runs.flatMap((r) => (r.strategy?.equity ?? []).map((e) => [...key(r), e.date, e.equity, e.buyHold, e.value])));
    case 'summary':
      return rows(
        ['run_hash', 'symbol', 'key', 'value'],
        runs.flatMap((r) => {
          const kv: [string, unknown][] = [
            ['schema', r.schema],
            ['engine_version', r.engineVersion],
            ['spec_hash', r.hashes.spec],
            ['bars_hash', r.hashes.bars],
            ['interval', r.data.interval],
            ['provider', r.data.provider],
            ['adjust', r.data.adjust],
            ['simulated', r.data.simulated],
            ['requested_bars', r.data.requestedBars],
            ['bars', r.data.bars],
            ['from', r.data.from],
            ['to', r.data.to],
            ['study', r.spec.study],
            ['study_config', r.spec.studyConfig],
            ['script_hash', r.data.scriptHash],
            ['signals', r.spec.signals.join(' ')],
            ['horizons', r.spec.horizons.join(' ')],
            ['baseline_seed', r.spec.baseline.seed],
            ['baseline_samples', r.spec.baseline.samples],
            ['event_entry', r.eventStudy.entry],
            ['events_measured_long', r.eventStudy.population.measuredLong],
            ['events_measured_short', r.eventStudy.population.measuredShort],
            ...r.eventStudy.horizons.flatMap((h): [string, unknown][] => [
              [`h${h.horizon}_n`, h.n],
              [`h${h.horizon}_mean_pct`, h.mean],
              [`h${h.horizon}_median_pct`, h.median],
              [`h${h.horizon}_hit_rate`, h.hitRate],
              [`h${h.horizon}_baseline_mean_pct`, h.baseline?.mean],
              [`h${h.horizon}_edge_pct`, h.edge],
            ]),
            ['strategy', r.spec.strategy],
            ...(r.strategy ? (Object.entries(r.strategy.population).map(([k, v]) => [`strategy_${k}`, v]) as [string, unknown][]) : []),
            ...(r.strategy ? (Object.entries(r.strategy.stats).map(([k, v]) => [`strategy_${k}`, v]) as [string, unknown][]) : []),
          ];
          return kv.map(([k, v]) => [...key(r), k, v]);
        }),
      );
  }
}

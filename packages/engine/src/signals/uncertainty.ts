import type { Bar } from '../core/types';
import { mulberry32 } from './tester';

// How sure can we be? Seeded bootstrap intervals, p-values with a correction for how many variations were tried, and
// benchmarks that take the same amount of market exposure, so a strategy is judged against what its exposure alone
// would have earned. Deterministic: every random draw comes from a seed.

export interface CI {
  lo: number;
  hi: number;
  level: number;
  samples: number;
}

/** Percentile-bootstrap confidence interval for the mean (seeded). */
export function bootstrapMeanCI(xs: readonly number[], opts: { seed?: number; samples?: number; level?: number } = {}): CI {
  const samples = opts.samples ?? 2000;
  const level = opts.level ?? 0.95;
  const n = xs.length;
  if (!n) return { lo: NaN, hi: NaN, level, samples };
  const rnd = mulberry32(opts.seed ?? 7);
  const means = new Float64Array(samples);
  for (let k = 0; k < samples; k++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += xs[Math.floor(rnd() * n)];
    means[k] = s / n;
  }
  means.sort();
  const q = (p: number) => means[Math.min(samples - 1, Math.max(0, Math.round(p * (samples - 1))))];
  return { lo: q((1 - level) / 2), hi: q(1 - (1 - level) / 2), level, samples };
}

/** Standard normal CDF (Hart / West, double precision). */
function phi(x: number): number {
  const a = Math.abs(x);
  let c: number;
  if (a > 37) c = 0;
  else {
    const e = Math.exp((-a * a) / 2);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-2 * a + 0.700383064443688;
      b = b * a + 6.37396220353165;
      b = b * a + 33.912866078383;
      b = b * a + 112.079291497871;
      b = b * a + 221.213596169931;
      b = b * a + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * a + 1.75566716318264;
      b = b * a + 16.064177579207;
      b = b * a + 86.7807322029461;
      b = b * a + 296.564248779674;
      b = b * a + 637.333633378831;
      b = b * a + 793.826512519948;
      b = b * a + 440.413735824752;
      c /= b;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

/** Two-sided p-value of a t-statistic (normal approximation; overlapping horizons make it optimistic). */
export const pTwoSided = (t: number) => (Number.isFinite(t) ? 2 * (1 - phi(Math.abs(t))) : NaN);

/** Chance that the best of `trials` independent tries reaches p by luck alone (Šidák). */
export const trialAdjustedP = (p: number, trials: number) => (Number.isFinite(p) ? Math.min(1, 1 - (1 - p) ** Math.max(1, trials)) : NaN);

export interface TradeStats {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  /** average win ÷ |average loss| */
  payoff: number;
  /** average return per trade (= winRate × avgWin + lossRate × avgLoss) */
  expectancyPct: number;
  expectancyUsd: number;
  expectancyCI: CI;
}

/** Win/loss profile of a trade list (a zero-return trade counts as a loss). */
export function tradeStats(trades: readonly { ret: number; pnl: number }[], seed = 7): TradeStats {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const w = trades.filter((t) => t.ret > 0);
  const l = trades.filter((t) => t.ret <= 0);
  const avgWinPct = avg(w.map((t) => t.ret));
  const avgLossPct = avg(l.map((t) => t.ret));
  return {
    n: trades.length,
    wins: w.length,
    losses: l.length,
    winRate: trades.length ? w.length / trades.length : NaN,
    avgWinPct,
    avgLossPct,
    avgWinUsd: avg(w.map((t) => t.pnl)),
    avgLossUsd: avg(l.map((t) => t.pnl)),
    payoff: w.length && l.length && avgLossPct !== 0 ? avgWinPct / Math.abs(avgLossPct) : NaN,
    expectancyPct: avg(trades.map((t) => t.ret)),
    expectancyUsd: avg(trades.map((t) => t.pnl)),
    expectancyCI: bootstrapMeanCI(trades.map((t) => t.ret), { seed }),
  };
}

/** Buy & hold scaled to a constant fraction of equity (the strategy's average exposure), compounded bar by bar, in %. */
export function exposureMatchedReturn(bars: readonly Bar[], fraction: number): number {
  let eq = 1;
  for (let i = 1; i < bars.length; i++) eq *= 1 + (fraction * (bars[i].c - bars[i - 1].c)) / bars[i - 1].c;
  return 100 * (eq - 1);
}

export interface RandomTiming {
  samples: number;
  /** average trade return (%) when the same trades are placed at random dates */
  median: number;
  p05: number;
  p95: number;
  strategyAvgTradePct: number;
  /** share of random placements whose average trade did worse than the strategy's */
  strategyPercentile: number;
}

/**
 * The same trades (count, side, holding period, costs) started on random bars, close to close. If the strategy's real
 * timing is no better than chance, its average trade lands in the middle of this distribution.
 */
export function randomTimingBenchmark(bars: readonly Bar[], trades: readonly { dir: 1 | -1; entryI: number; exitI: number; ret: number }[], opts: { seed?: number; samples?: number; costBps?: number } = {}): RandomTiming {
  const samples = opts.samples ?? 500;
  const cost = (opts.costBps ?? 0) / 10_000;
  const n = bars.length;
  const strat = trades.length ? trades.reduce((a, t) => a + t.ret, 0) / trades.length : NaN;
  if (!trades.length || n < 2) return { samples: 0, median: NaN, p05: NaN, p95: NaN, strategyAvgTradePct: strat, strategyPercentile: NaN };
  const rnd = mulberry32(opts.seed ?? 11);
  const avgs = new Float64Array(samples);
  for (let k = 0; k < samples; k++) {
    let s = 0;
    for (const t of trades) {
      const h = Math.min(n - 1, Math.max(0, t.exitI - t.entryI));
      const i = Math.floor(rnd() * (n - h));
      const gross = (t.dir * (bars[i + h].c - bars[i].c)) / bars[i].c;
      s += 100 * ((1 + gross) * (1 - cost) * (1 - cost) - 1);
    }
    avgs[k] = s / trades.length;
  }
  avgs.sort();
  const q = (p: number) => avgs[Math.round(p * (samples - 1))];
  let below = 0;
  for (const a of avgs) if (a < strat) below++;
  return { samples, median: q(0.5), p05: q(0.05), p95: q(0.95), strategyAvgTradePct: strat, strategyPercentile: below / samples };
}

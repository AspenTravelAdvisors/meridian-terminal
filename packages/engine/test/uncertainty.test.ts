import { describe, expect, it } from 'vitest';
import { bootstrapMeanCI, buildTestRun, exposureMatchedReturn, pTwoSided, randomTimingBenchmark, runStrategy, tradeStats, trialAdjustedP } from '../src';
import { randomWalk } from './helpers';

describe('trade statistics', () => {
  it('computes average win / loss, expectancy and payoff by hand', () => {
    const t = [
      { ret: 4, pnl: 400 },
      { ret: -2, pnl: -200 },
      { ret: 6, pnl: 600 },
      { ret: -1, pnl: -100 },
    ];
    const s = tradeStats(t);
    expect(s).toMatchObject({ n: 4, wins: 2, losses: 2, winRate: 0.5, avgWinPct: 5, avgLossPct: -1.5, avgWinUsd: 500, avgLossUsd: -150, payoff: 5 / 1.5 });
    // expectancy = 0.5 × 5 + 0.5 × (−1.5) = 1.75 % per trade; in dollars 175
    expect(s.expectancyPct).toBeCloseTo(1.75, 12);
    expect(s.expectancyUsd).toBeCloseTo(175, 12);
    expect(tradeStats([]).n).toBe(0);
    expect(tradeStats([]).expectancyPct).toBeNaN();
  });
});

describe('sample uncertainty', () => {
  it('bootstraps a seeded, reproducible confidence interval around the mean', () => {
    const xs = randomWalk(200, 5).map((b, i, a) => (i ? (100 * (b.c - a[i - 1].c)) / a[i - 1].c : 0));
    const a = bootstrapMeanCI(xs, { seed: 3 });
    expect(a).toEqual(bootstrapMeanCI(xs, { seed: 3 }));
    const mean = xs.reduce((x, y) => x + y, 0) / xs.length;
    expect(a.lo).toBeLessThan(mean);
    expect(a.hi).toBeGreaterThan(mean);
    // roughly mean ± 1.96 standard errors for a sample this size
    const sd = Math.sqrt(xs.reduce((x, y) => x + (y - mean) ** 2, 0) / (xs.length - 1));
    const se = sd / Math.sqrt(xs.length);
    expect(a.hi - a.lo).toBeGreaterThan(2 * 1.96 * se * 0.8);
    expect(a.hi - a.lo).toBeLessThan(2 * 1.96 * se * 1.2);
    // wider with fewer observations
    const small = bootstrapMeanCI(xs.slice(0, 20), { seed: 3 });
    expect(small.hi - small.lo).toBeGreaterThan(a.hi - a.lo);
    expect(bootstrapMeanCI([], {})).toEqual({ lo: NaN, hi: NaN, level: 0.95, samples: 2000 });
  });

  it('turns t-statistics into p-values and adjusts them for the number of trials', () => {
    expect(pTwoSided(1.959964)).toBeCloseTo(0.05, 5);
    expect(pTwoSided(0)).toBeCloseTo(1, 10);
    expect(trialAdjustedP(0.05, 1)).toBeCloseTo(0.05, 12);
    // best of 10 tries at p = 0.05 each: 1 − 0.95^10
    expect(trialAdjustedP(0.05, 10)).toBeCloseTo(1 - 0.95 ** 10, 12);
    expect(trialAdjustedP(0.2, 50)).toBeLessThanOrEqual(1);
  });
});

describe('benchmarks matched to exposure', () => {
  const bars = randomWalk(1500, 8);
  const entries = bars.map((_, i) => i).filter((i) => i % 45 === 0).map((i) => ({ i, dir: 'bull' as const }));
  const cfg = { entries, exitOnOpposite: false, stop: 'none' as const, stopPct: 0, atrMult: 2, atrLength: 14, timeStopBars: 15, takeProfitPct: 0, feesBps: 2, slippageBps: 3, entryAt: 'nextOpen' as const, allowShort: false };

  it('holds the underlying at the strategy’s average exposure', () => {
    const r = runStrategy(bars, cfg);
    expect(r.stats.avgGrossExposure).toBeGreaterThan(0);
    expect(r.stats.avgGrossExposure).toBeLessThan(r.stats.exposure + 1e-9);
    // fully exposed → plain buy & hold; zero exposure → nothing
    const bh = (100 * (bars[1499].c - bars[0].c)) / bars[0].c;
    expect(exposureMatchedReturn(bars, 1)).toBeCloseTo(bh, 8);
    expect(exposureMatchedReturn(bars, 0)).toBe(0);
    const half = exposureMatchedReturn(bars, 0.5);
    expect(Math.abs(half)).toBeLessThan(Math.abs(bh) + 1e-9);
  });

  it('replays the same trades at random dates', () => {
    const r = runStrategy(bars, cfg);
    const a = randomTimingBenchmark(bars, r.trades, { seed: 9, samples: 300, costBps: 5 });
    expect(a).toEqual(randomTimingBenchmark(bars, r.trades, { seed: 9, samples: 300, costBps: 5 }));
    expect(a.samples).toBe(300);
    expect(a.p05).toBeLessThanOrEqual(a.median);
    expect(a.median).toBeLessThanOrEqual(a.p95);
    expect(a.strategyPercentile).toBeGreaterThanOrEqual(0);
    expect(a.strategyPercentile).toBeLessThanOrEqual(1);
    // the same trades at their real dates sit where they belong in the distribution
    const avg = r.trades.reduce((x, t) => x + t.ret, 0) / r.trades.length;
    expect(a.strategyAvgTradePct).toBeCloseTo(avg, 10);
  });

  it('adds uncertainty and benchmarks to the run record', () => {
    const rec = buildTestRun(bars, { symbol: 'SIM:X', interval: '1D', study: 'td-sequential', studyConfig: {}, signals: ['SEQ_BUY_SETUP_9', 'SEQ_SELL_SETUP_9'], horizons: [5, 20], baseline: { seed: 2, samples: 100 }, strategy: { ...cfg, entries: undefined } as never }, { provider: 'sim', adjust: 'split', simulated: true, requestedBars: 1500 });
    const h = rec.eventStudy.horizons[1];
    expect(h.ci95.lo).toBeLessThan(h.mean);
    expect(h.ci95.hi).toBeGreaterThan(h.mean);
    expect(h.p).toBeCloseTo(pTwoSided(h.t), 12);
    const s = rec.strategy!;
    expect(s.tradeStats.n).toBe(s.stats.trades);
    expect(s.benchmarks.exposureMatchedPct).toBeCloseTo(exposureMatchedReturn(bars, s.stats.avgGrossExposure), 8);
    expect(s.benchmarks.randomTiming.samples).toBeGreaterThan(0);
    expect(s.tradeStats.expectancyCI.lo).toBeLessThanOrEqual(s.tradeStats.expectancyPct);
  });
});

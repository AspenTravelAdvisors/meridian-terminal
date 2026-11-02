import { describe, expect, it } from 'vitest';
import { type Bar, type StrategyConfig, hashString, runStrategy } from '../src';
import { randomWalk } from './helpers';

// ── regression: with the new options at their defaults (and no entry-bar stop check, which is new), the dollar-accounting
// simulator reproduces the trades and returns of the earlier one-position simulator. Pins were taken after a full
// field-by-field comparison (1e-9) against that simulator's output.
const bars = randomWalk(3000, 17);
const ev = bars.map((_, i) => i).filter((i) => i % 37 === 0 || i % 53 === 0).map((i) => ({ i, dir: (i % 2 ? 'bear' : 'bull') as 'bull' | 'bear' }));
const exits = bars.map((_, i) => i).filter((i) => i % 41 === 0).map((i) => ({ i, dir: (i % 3 ? 'bull' : 'bear') as 'bull' | 'bear' }));
const levels = { long: Float64Array.from(bars, (b) => b.l * 0.97), short: Float64Array.from(bars, (b) => b.h * 1.03) };
const CASES: [string, Omit<StrategyConfig, 'entries'>, { start: number; end: number } | undefined][] = [];
for (const stop of ['none', 'pct', 'atr', 'level'] as const)
  for (const entryAt of ['nextOpen', 'close'] as const)
    for (const allowShort of [true, false])
      for (const exitAt of ['close', 'nextOpen'] as const)
        CASES.push([`${stop}-${entryAt}-${allowShort}-${exitAt}`, { exits, exitAt, exitOnOpposite: true, stop, stopPct: 3, atrMult: 2, atrLength: 14, stopLevels: levels, timeStopBars: 25, takeProfitPct: 6, feesBps: 2, slippageBps: 3, entryAt, allowShort }, undefined]);
CASES.push(['range', { exitOnOpposite: false, stop: 'pct', stopPct: 4, atrMult: 2, atrLength: 14, timeStopBars: 0, takeProfitPct: 0, feesBps: 1, slippageBps: 1, entryAt: 'nextOpen', allowShort: true }, { start: 700, end: 2100 }]);
const PINS: Record<string, [string, number]> = {
  'none-nextOpen-true-close': ['03de94c06d816819a3f2fda4450f', -39.772621],
  'none-nextOpen-true-nextOpen': ['08cd5166f865660a548f25f7221c', -39.772621],
  'none-nextOpen-false-close': ['14b8425e339e7e19aa9cbf036fec', -28.952987],
  'none-nextOpen-false-nextOpen': ['0a72fe79fcb9821f459204b2221a', -28.952987],
  'none-close-true-close': ['1cbb0b34247c8b0780cbe063ce9f', -37.401081],
  'none-close-true-nextOpen': ['089097894964b11bf18e8a17f3c2', -41.752208],
  'none-close-false-close': ['0612fe3ac673071b5db84c7ee689', -29.35122],
  'none-close-false-nextOpen': ['158229496fa3d616818ee979ee35', -29.35122],
  'pct-nextOpen-true-close': ['1dcecb9e5ca04c0944f599727119', -34.385761],
  'pct-nextOpen-true-nextOpen': ['19479ced9c37e50f2f7deafe5173', -34.385761],
  'pct-nextOpen-false-close': ['0e5c778fb351b306b7a5330a8ce9', 2.530353],
  'pct-nextOpen-false-nextOpen': ['129df939aa70571eb3770bdf0802', 2.530353],
  'pct-close-true-close': ['1adf10e84041a111247542bd1772', -31.009435],
  'pct-close-true-nextOpen': ['05633e9d54fea411ae9305907e46', -27.614681],
  'pct-close-false-close': ['07b9e8c56794b30f0db47221f84a', 3.247842],
  'pct-close-false-nextOpen': ['0af1106a9363b6141f018db21da2', 3.247842],
  'atr-nextOpen-true-close': ['1e2818c6d652b91147e54ede584b', -44.981201],
  'atr-nextOpen-true-nextOpen': ['137ca4cf85ca0304f6c7cb08f7fc', -44.981201],
  'atr-nextOpen-false-close': ['13f7e900db414b00dd998b17ce7d', -17.581819],
  'atr-nextOpen-false-nextOpen': ['09fd2919b172f417ddce7ffd27d2', -17.581819],
  'atr-close-true-close': ['1f7443c274a73c0148e7d200ea85', -42.439083],
  'atr-close-true-nextOpen': ['0c142ea0869f4515863fb9bb167b', -35.038364],
  'atr-close-false-close': ['1ec2f4334ddfa605427efea5c100', -18.441861],
  'atr-close-false-nextOpen': ['05be9e2808a3071510b2c6ebea43', -18.441861],
  'level-nextOpen-true-close': ['1595b192e54fb007352967b375cd', -25.271522],
  'level-nextOpen-true-nextOpen': ['0a01319b7fbf87143400c7ee4111', -25.271522],
  'level-nextOpen-false-close': ['0ed5c7c8d5aebb04b35821a90bec', -1.181881],
  'level-nextOpen-false-nextOpen': ['1e133bca66a0bc145d33a099f12b', -1.181881],
  'level-close-true-close': ['18574ded500ddf02d005a6076f0e', -23.609358],
  'level-close-true-nextOpen': ['0f39097ff2bd17120837f9489dc2', -20.091672],
  'level-close-false-close': ['1c3841966f8947003a6e178d2b07', -4.296027],
  'level-close-false-nextOpen': ['11fa59c0434f9700a0f5b179e447', -4.296027],
  'range': ['1aeb556757596a1616ab12b12b82', -15.894595],
};

describe('strategy simulator: regression', () => {
  it('reproduces the earlier simulator on 33 configurations', () => {
    for (const [k, c, r] of CASES) {
      const x = runStrategy(bars, { ...c, entries: ev, stopOnEntryBar: false }, r);
      expect(hashString(x.trades.map((t) => `${t.entryI},${t.exitI},${t.dir},${t.reason}`).join(';')), k).toBe(PINS[k][0]);
      expect(x.stats.totalReturn, k).toBeCloseTo(PINS[k][1], 5);
    }
  });
});

// ── capital and execution assumptions, on hand-built bars
const D = 86_400_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: Date.UTC(2024, 0, 1) + i * D, o, h, l, c, v: 1 });
const base: Omit<StrategyConfig, 'entries'> = { exitOnOpposite: false, stop: 'pct', stopPct: 5, atrMult: 2, atrLength: 14, timeStopBars: 0, takeProfitPct: 10, feesBps: 0, slippageBps: 0, entryAt: 'nextOpen', allowShort: false };
const long0 = [{ i: 0, dir: 'bull' as const }];

describe('strategy simulator: capital and execution', () => {
  it('accounts in dollars from the starting capital', () => {
    const b = [bar(0, 100, 101, 99, 100), bar(1, 100, 104, 99, 103), bar(2, 103, 106, 102, 105)];
    const r = runStrategy(b, { ...base, entries: long0, stop: 'none', takeProfitPct: 0, capital: 10_000, feesBps: 10, commission: 1 });
    const t = r.trades[0];
    // 10,000 at 100 → 100 shares; exit at the last close 105; 10 bps each side; $1 commission each way
    expect(t).toMatchObject({ entry: 100, exit: 105, shares: 100, notional: 10_000, reason: 'end' });
    expect(t.pnl).toBeCloseTo(10_000 * (1.05 * 0.999 * 0.999 - 1) - 2, 8);
    expect(r.stats.endCapital).toBeCloseTo(10_000 + t.pnl, 8);
    expect(r.stats.totalReturn).toBeCloseTo((100 * t.pnl) / 10_000, 8);
    expect(r.equity[2]).toBeCloseTo(r.stats.endCapital / 10_000, 12);
  });

  it('sizes by percent of equity, dollars, shares or risk to the stop', () => {
    const b = [bar(0, 100, 101, 99, 100), bar(1, 100, 102, 99, 101), bar(2, 101, 102, 100, 101)];
    const at = (sizing: StrategyConfig['sizing'], extra: Partial<StrategyConfig> = {}) => runStrategy(b, { ...base, entries: long0, capital: 50_000, sizing, ...extra }).trades[0];
    expect(at({ mode: 'percentEquity', value: 25 }).notional).toBeCloseTo(12_500, 8);
    expect(at({ mode: 'fixedDollar', value: 7_000 }).notional).toBeCloseTo(7_000, 8);
    expect(at({ mode: 'fixedShares', value: 30 }).shares).toBe(30);
    // risk 1% of 50,000 = 500 to a stop 5 below the 100 entry → 100 shares
    expect(at({ mode: 'riskPercent', value: 1 }).shares).toBeCloseTo(100, 8);
    // never more than equity
    expect(at({ mode: 'fixedDollar', value: 1e9 }).notional).toBeCloseTo(50_000, 8);
    expect(at({ mode: 'percentEquity', value: 33 }, { wholeShares: true }).shares).toBe(165);
    const noStop = runStrategy(b, { ...base, entries: long0, stop: 'none', sizing: { mode: 'riskPercent', value: 1 } });
    expect(noStop.trades).toHaveLength(0);
    expect(noStop.stats.skipped.noStop).toBe(1);
  });

  it('allows overlapping positions up to a limit without leverage', () => {
    const b = Array.from({ length: 12 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
    const entries = [0, 1, 2, 3, 4].map((i) => ({ i, dir: 'bull' as const }));
    const one = runStrategy(b, { ...base, entries, stop: 'none', takeProfitPct: 0, timeStopBars: 6 });
    expect(one.stats.maxConcurrent).toBe(1);
    expect(one.stats.skipped.maxPositions).toBeGreaterThan(0);
    const three = runStrategy(b, { ...base, entries, stop: 'none', takeProfitPct: 0, timeStopBars: 6, maxPositions: 3, sizing: { mode: 'percentEquity', value: 40 } });
    expect(three.stats.maxConcurrent).toBe(3);
    expect(three.trades).toHaveLength(3);
    // the third position only gets what is left: 100% − 40% − 40% of equity
    const [a, c, d] = three.trades;
    expect(a.notional + c.notional + d.notional).toBeLessThanOrEqual(100_000 * 1.03);
    expect(d.notional).toBeLessThan(a.notional);
    expect(three.stats.endCapital - 100_000).toBeCloseTo(three.trades.reduce((x, t) => x + t.pnl, 0), 6);
  });

  it('fills a gap through the stop at the open, or at the stop if declared', () => {
    // long at 100 (stop 95); bar 2 opens at 90, below the stop
    const b = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 98, 99), bar(2, 90, 92, 89, 91)];
    const open = runStrategy(b, { ...base, entries: long0 });
    expect(open.trades[0]).toMatchObject({ exit: 90, reason: 'stop', gap: true });
    expect(open.stats.gapExits).toBe(1);
    expect(runStrategy(b, { ...base, entries: long0, gapFill: 'level' }).trades[0].exit).toBe(95);
  });

  it('declares which of stop and target fills when one candle touches both', () => {
    // long at 100: stop 95, target 110; bar 2 trades 94 → 111 from an open of 108 (nearer the target)
    const b = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 98, 99), bar(2, 108, 111, 94, 100)];
    const run = (sameBar?: StrategyConfig['sameBar']) => runStrategy(b, { ...base, entries: long0, sameBar });
    expect(run().trades[0]).toMatchObject({ exit: 95, reason: 'stop', ambiguous: true });
    expect(run().stats.ambiguousExits).toBe(1);
    for (const rule of ['targetFirst', 'nearerOpen'] as const) {
      expect(run(rule).trades[0].reason).toBe('target');
      expect(run(rule).trades[0].exit).toBeCloseTo(110, 10);
    }
    const low = [b[0], b[1], bar(2, 96, 111, 94, 100)];
    expect(runStrategy(low, { ...base, entries: long0, sameBar: 'nearerOpen' }).trades[0].reason).toBe('stop');
  });

  it('checks the entry bar itself when entering at its open', () => {
    // signal at 0, entry at bar 1's open (100), which then trades down to 94 (stop 95)
    const b = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 94, 97), bar(2, 97, 99, 96, 98)];
    expect(runStrategy(b, { ...base, entries: long0 }).trades[0]).toMatchObject({ entryI: 1, exitI: 1, exit: 95, reason: 'stop' });
    expect(runStrategy(b, { ...base, entries: long0, stopOnEntryBar: false }).trades[0]).toMatchObject({ exitI: 2, reason: 'end' });
  });
});

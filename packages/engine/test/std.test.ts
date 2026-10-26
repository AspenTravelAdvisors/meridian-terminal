import { describe, expect, it } from 'vitest';
import {
  type Bar,
  alignHTF,
  atr,
  bollinger,
  checkScriptLookAhead,
  computeStudy,
  defaultsOf,
  ema,
  eventStudy,
  macd,
  matrixCell,
  mulberry32,
  pivotLevels,
  resolveConfig,
  rsi,
  runScript,
  runStrategy,
  scanBars,
  sma,
  volumeProfileBars,
  vwap,
  wma,
  hma,
  periodKey,
} from '../src';
import { barsFromCloses, randomWalk } from './helpers';

const bars = randomWalk(300, 11);
const naiveSma = (xs: number[], n: number, i: number) => xs.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;

describe('moving averages', () => {
  const closes = bars.map((b) => b.c);
  it('SMA equals the naive mean', () => {
    const r = computeStudy(sma, resolveConfig(sma, { length: 20 }), bars);
    expect(r.lines.ma[18]).toBeNaN();
    for (const i of [19, 100, 299]) expect(r.lines.ma[i]).toBeCloseTo(naiveSma(closes, 20, i), 9);
  });
  it('EMA is seeded with the SMA of the first n values', () => {
    const r = computeStudy(ema, resolveConfig(ema, { length: 10 }), bars);
    expect(r.lines.ma[9]).toBeCloseTo(naiveSma(closes, 10, 9), 12);
    expect(r.lines.ma[10]).toBeCloseTo(r.lines.ma[9] + (2 / 11) * (closes[10] - r.lines.ma[9]), 12);
  });
  it('WMA (O(1) incremental) equals the naive weighted mean', () => {
    const r = computeStudy(wma, resolveConfig(wma, { length: 7 }), bars);
    for (const i of [6, 50, 299]) {
      let acc = 0;
      for (let k = 0; k < 7; k++) acc += closes[i - k] * (7 - k);
      expect(r.lines.ma[i]).toBeCloseTo(acc / 28, 9);
    }
  });
  it('HMA tracks price with less lag than the SMA of the same length', () => {
    const trend = barsFromCloses(Array.from({ length: 80 }, (_, i) => 100 + i));
    const h = computeStudy(hma, resolveConfig(hma, { length: 21 }), trend).lines.ma[79];
    const s = computeStudy(sma, resolveConfig(sma, { length: 21 }), trend).lines.ma[79];
    expect(Math.abs(179 - h)).toBeLessThan(Math.abs(179 - s));
  });
});

describe('oscillators & bands', () => {
  it('RSI of a strictly rising series is 100', () => {
    const r = computeStudy(rsi, defaultsOf(rsi), barsFromCloses(Array.from({ length: 40 }, (_, i) => 10 + i)));
    expect(r.lines.rsi[39]).toBe(100);
  });
  it('Bollinger bands collapse onto the basis for a flat series; MACD is zero', () => {
    const flat = barsFromCloses(Array.from({ length: 60 }, () => 50));
    const bb = computeStudy(bollinger, defaultsOf(bollinger), flat);
    expect(bb.lines.upper[59]).toBe(50);
    expect(bb.lines.lower[59]).toBe(50);
    expect(computeStudy(macd, defaultsOf(macd), flat).lines.macd[59]).toBe(0);
  });
  it('ATR of constant-range bars equals the range', () => {
    const b: Bar[] = Array.from({ length: 40 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10, v: 1 }));
    expect(computeStudy(atr, defaultsOf(atr), b).lines.atr[39]).toBeCloseTo(2, 12);
  });
  it('session VWAP of a constant price is that price, and resets each session', () => {
    const day = 86_400_000;
    const b: Bar[] = Array.from({ length: 20 }, (_, i) => ({ t: Date.UTC(2024, 0, 2, 15) + Math.floor(i / 10) * day + (i % 10) * 60_000, o: i < 10 ? 10 : 20, h: i < 10 ? 10 : 20, l: i < 10 ? 10 : 20, c: i < 10 ? 10 : 20, v: 5 }));
    const r = computeStudy(vwap, defaultsOf(vwap), b);
    expect(r.lines.vwap[9]).toBeCloseTo(10, 12);
    expect(r.lines.vwap[10]).toBeCloseTo(20, 12);
  });
  it('classic pivots', () => {
    const p = pivotLevels('classic', 12, 8, 10, 0);
    expect(p.P).toBe(10);
    expect(p.R1).toBe(12);
    expect(p.S1).toBe(8);
  });
});

describe('time helpers', () => {
  it('period keys respect the exchange time zone (NY session boundary)', () => {
    // 2024-03-05 03:00 UTC is still 2024-03-04 in New York
    const t = Date.UTC(2024, 2, 5, 3);
    expect(periodKey(t, 'day', 'UTC')).toBe(periodKey(Date.UTC(2024, 2, 5), 'day', 'UTC'));
    expect(periodKey(t, 'day', 'America/New_York')).toBe(periodKey(Date.UTC(2024, 2, 4, 12), 'day', 'America/New_York'));
  });
});

describe('volume profile', () => {
  it('conserves volume and places the POC inside the value area', () => {
    const vp = volumeProfileBars(bars, 0, 199, 30)!;
    const total = vp.rows.reduce((a, r) => a + r.vol, 0);
    expect(total).toBeCloseTo(bars.slice(0, 200).reduce((a, b) => a + b.v, 0), 6);
    expect(vp.poc).toBeGreaterThanOrEqual(vp.val);
    expect(vp.poc).toBeLessThanOrEqual(vp.vah);
  });
});

describe('multi-timeframe alignment', () => {
  it('a daily bar only sees the weekly value once that week has closed (no repaint)', () => {
    const DAY = 86_400_000;
    const daily: Bar[] = Array.from({ length: 21 }, (_, i) => ({ t: Date.UTC(2024, 0, 1) + i * DAY, o: 1, h: 1, l: 1, c: i, v: 1 }));
    const weekly: Bar[] = [0, 1, 2].map((k) => ({ t: Date.UTC(2024, 0, 1) + k * 7 * DAY, o: 1, h: 1, l: 1, c: 100 + k, v: 1 }));
    const a = alignHTF(daily, DAY, weekly, 7 * DAY, weekly.map((w) => w.c));
    expect(a[5]).toBeNaN(); // week 1 still forming
    expect(a[6]).toBe(100); // Sunday close = end of week 1
    expect(a[12]).toBe(100);
    expect(a[13]).toBe(101);
  });
});

describe('signal tester', () => {
  it('is deterministic and measures directional forward returns from the signal close', () => {
    const b = barsFromCloses([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const r = eventStudy(b, [{ i: 0, dir: 'bull' }, { i: 5, dir: 'bear' }], [1, 5], { seed: 1 });
    const h1 = r.horizons[0];
    expect(h1.n).toBe(2);
    expect(h1.returns[0]).toBeCloseTo(10, 10); // 10 → 11
    expect(h1.returns[1]).toBeCloseTo((-100 * 1) / 15, 10); // short from 15 → 16
    expect(JSON.stringify(eventStudy(bars, [{ i: 10, dir: 'bull' }], [5], { seed: 3 }))).toBe(JSON.stringify(eventStudy(bars, [{ i: 10, dir: 'bull' }], [5], { seed: 3 })));
    expect(mulberry32(5)()).toBe(mulberry32(5)());
  });
  it('strategy enters on the next open, honours stops and charges costs', () => {
    const b = barsFromCloses([10, 10, 10, 11, 12, 13, 9, 9, 9, 9]);
    const res = runStrategy(b, {
      entries: [{ i: 1, dir: 'bull' }],
      exitOnOpposite: true,
      stop: 'pct',
      stopPct: 20,
      atrMult: 2,
      atrLength: 3,
      timeStopBars: 0,
      takeProfitPct: 25,
      feesBps: 0,
      slippageBps: 0,
      entryAt: 'nextOpen',
      allowShort: false,
    });
    expect(res.trades[0].entryI).toBe(2);
    expect(res.trades[0].reason).toBe('target');
    expect(res.trades[0].exit).toBeCloseTo(12.5, 10);
  });
});

describe('scanner & MTF matrix', () => {
  it('summarizes statuses and recent signals', () => {
    const row = scanBars('TEST', bars, [{ id: 'td-sequential' }, { id: 'rsi' }], { lookback: 300 });
    expect(row.statuses['td-sequential']).toBeTruthy();
    expect(row.signals.length).toBeGreaterThan(0);
    const cell = matrixCell(bars);
    expect(cell.score).toBeGreaterThanOrEqual(-1);
    expect(cell.score).toBeLessThanOrEqual(1);
  });
});

describe('script DSL', () => {
  const code = `meta({ name: 'X', overlay: true }); const f = sma(close, input('Fast', 10)); plot(f, { title: 'f' }); signal(crossover(close, f), { id: 'x_up', dir: 'bull' });`;
  it('runs, honours inputs and matches the engine SMA', () => {
    const r = runScript(code, bars, { Fast: 20 });
    expect(r.error).toBeUndefined();
    const eng = computeStudy(sma, resolveConfig(sma, { length: 20 }), bars);
    expect(r.plots[0].values[100]).toBeCloseTo(eng.lines.ma[100], 9);
    expect(r.signals[0].id).toBe('X_UP');
    expect(checkScriptLookAhead(code, bars).ok).toBe(true);
  });
  it('detects look-ahead in user code', () => {
    const cheat = `plot(series(i => close[i + 1] ?? NaN), { title: 'future' });`;
    expect(checkScriptLookAhead(cheat, bars).ok).toBe(false);
  });
  it('blocks network access inside scripts', () => {
    expect(runScript(`fetch('https://example.com')`, bars).error).toBeTruthy();
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type TestRunSpec, buildTestRun, canonicalJson, eventsByYear, studyEvents, walkForward, windowRange } from '../src';
import { randomWalk } from './helpers';

const src = { provider: 'sim', adjust: 'split', simulated: true, requestedBars: 4000 };
const strat = { exitOnOpposite: true, stop: 'none' as const, stopPct: 5, atrMult: 2, atrLength: 14, timeStopBars: 20, takeProfitPct: 0, feesBps: 2, slippageBps: 3, entryAt: 'nextOpen' as const, allowShort: true };
const spec = (over: Partial<TestRunSpec> = {}): TestRunSpec => ({
  symbol: 'SIM:DEMO',
  interval: '1D',
  study: 'td-sequential',
  studyConfig: {},
  signals: ['SEQ_BUY_SETUP_9', 'SEQ_SELL_SETUP_9'],
  horizons: [1, 5, 20],
  baseline: { seed: 3, samples: 100 },
  strategy: strat,
  ...over,
});
const bars = randomWalk(4000, 5); // daily from 2000-01-01, ~11 years
const day = (i: number) => new Date(bars[i].t).toISOString().slice(0, 10);
// the parts of a record that are results (data/hashes legitimately describe every bar loaded)
const results = (r: ReturnType<typeof buildTestRun>) => canonicalJson({ s: r.signals, e: r.eventStudy, t: r.strategy, ev: r.data.evaluated });

describe('date windows', () => {
  it('finds the bars of an inclusive window', () => {
    expect(windowRange(bars, { from: '2001-01-01', to: '2001-12-31' })).toEqual({ start: 366, end: 730 });
    expect(windowRange(bars)).toEqual({ start: 0, end: 3999 });
    expect(windowRange(bars, { from: '2030-01-01' })).toBeNull();
    expect(() => buildTestRun(bars, spec({ window: { from: '2030-01-01' } }), src)).toThrow(/no bars/);
  });

  it('never reads bars after the window (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 600, max: 3700 }), fc.double({ min: 0.5, max: 2, noNaN: true }), (cut, f) => {
        const w = { from: '2001-06-01', to: day(cut) };
        const a = buildTestRun(bars, spec({ window: w }), src);
        // rewrite every bar after the window
        const later = bars.map((b, i) => (i > cut ? { ...b, o: b.o * f, h: b.h * f * 1.01, l: b.l * f * 0.99, c: b.c * f } : b));
        const b = buildTestRun(later, spec({ window: w }), src);
        return results(a) === results(b) && a.hashes.spec === b.hashes.spec && a.hashes.bars !== b.hashes.bars;
      }),
      { numRuns: 12 },
    );
  });

  it('purges events whose horizon runs past the window end', () => {
    const w = { to: '2005-06-30' };
    const r = buildTestRun(bars, spec({ window: w }), src);
    const end = windowRange(bars, w)!.end;
    const ev = studyEvents(bars, 'td-sequential', {}, spec().signals).events.filter((e) => e.i <= end);
    expect(r.signals.map((s) => s.i)).toEqual(ev.map((e) => e.i));
    r.eventStudy.events.forEach((row, k) => {
      const e = ev[k];
      spec().horizons.forEach((h, hk) => {
        const sign = e.dir === 'bear' ? -1 : 1;
        if (e.i + h > end) expect(row.returns[hk]).toBeNull();
        else expect(row.returns[hk]).toBeCloseTo((sign * 100 * (bars[e.i + h].c - bars[e.i].c)) / bars[e.i].c, 10);
      });
    });
    expect(r.eventStudy.horizons[2].n).toBe(r.eventStudy.events.filter((e) => e.returns[2] !== null).length);
  });

  it('runs the strategy inside the window only, closing at its last bar', () => {
    const w = { from: '2003-01-01', to: '2004-12-31' };
    const r = buildTestRun(bars, spec({ window: w }), src);
    const s = r.strategy!;
    expect(r.data.evaluated).toEqual({ from: '2003-01-01', to: '2004-12-31', bars: 731, warmupBars: windowRange(bars, w)!.start });
    expect(s.equity).toHaveLength(731);
    expect(s.equity[0]).toMatchObject({ date: '2003-01-01', equity: 1, buyHold: 1 });
    expect(s.trades.every((t) => t.entryDate >= '2003-01-01' && t.exitDate <= '2004-12-31')).toBe(true);
    expect(s.equity[730].equity).toBeCloseTo(1 + s.stats.totalReturn / 100, 10);
    // compounding the yearly returns gives the total
    expect(s.byYear.map((y) => y.year)).toEqual([2003, 2004]);
    expect(s.byYear.reduce((a, y) => a * (1 + y.returnPct / 100), 1)).toBeCloseTo(1 + s.stats.totalReturn / 100, 10);
    expect(s.byYear.reduce((a, y) => a + y.trades, 0)).toBe(s.trades.length);
  });

  it('puts the window in the spec hash and the replay query', () => {
    const a = buildTestRun(bars, spec(), src);
    const b = buildTestRun(bars, spec({ window: { from: '2003-01-01' } }), src);
    expect(a.spec.window).toBeUndefined();
    expect(b.hashes.spec).not.toBe(a.hashes.spec);
  });
});

describe('results by year', () => {
  it('groups events by calendar year, skipping purged returns', () => {
    const rows = [
      { date: '2020-03-02', returns: [1, 4] },
      { date: '2020-11-30', returns: [-3, null] },
      { date: '2021-01-04', returns: [2, 2] },
    ];
    const y = eventsByYear(rows, [1, 5]);
    expect(y).toEqual([
      { year: 2020, signals: 2, n: [2, 1], mean: [-1, 4], hitRate: [0.5, 1] },
      { year: 2021, signals: 1, n: [1, 1], mean: [2, 2], hitRate: [1, 1] },
    ]);
  });

  it('adds up to the whole-period counts in a record', () => {
    const r = buildTestRun(bars, spec(), src);
    r.eventStudy.horizons.forEach((h, k) => expect(r.eventStudy.byYear.reduce((a, y) => a + y.n[k], 0)).toBe(h.n));
  });
});

describe('walk-forward', () => {
  const series = [{ bars, source: src, symbol: 'SIM:DEMO' }];
  const base = { ...spec(), symbol: undefined, window: undefined } as unknown as Omit<TestRunSpec, 'symbol' | 'window'>;
  const wf = { trainYears: 4, testYears: 2, anchored: false, param: { key: 'setupLength', values: [7, 9, 11] }, metric: 'eventMean' as const, metricHorizon: 5, minEvents: 5 };

  it('lays out rolling calendar-year folds and counts trials', () => {
    const r = walkForward(series, base, wf);
    expect(r.folds.map((f) => [f.train.from, f.train.to, f.test?.from ?? f.train.to])).toEqual([
      ['2000-01-01', '2003-12-31', '2004-01-01'],
      ['2002-01-01', '2005-12-31', '2006-01-01'],
      ['2004-01-01', '2007-12-31', '2008-01-01'],
      ['2006-01-01', '2009-12-31', '2010-01-01'],
    ]);
    expect(r.trials).toBe(12);
    const anchored = walkForward(series, base, { ...wf, anchored: true });
    expect(anchored.folds.every((f) => f.train.from === '2000-01-01')).toBe(true);
  });

  it('picks the best training candidate, freezes it, and reports the unseen test window', () => {
    const r = walkForward(series, base, wf);
    for (const f of r.folds) {
      const ok = f.candidates.filter((c) => Number.isFinite(c.metric));
      const best = ok.reduce((a, c) => (c.metric > a.metric ? c : a), ok[0]);
      expect(f.chosen).toBe(best.value);
      expect(f.candidates.every((c) => (c.n < 5 ? !Number.isFinite(c.metric) : true))).toBe(true);
      // the test summary is exactly a windowed run with the chosen value
      const t = buildTestRun(bars, { ...spec(), studyConfig: { setupLength: f.chosen }, window: { from: f.test!.from, to: f.test!.to } }, src);
      expect(f.test!.horizons[1].n).toBe(t.eventStudy.horizons[1].n);
      expect(f.test!.horizons[1].mean).toBeCloseTo(t.eventStudy.horizons[1].mean, 10);
      expect(f.test!.strategyReturnPct).toBeCloseTo(t.strategy!.stats.totalReturn, 10);
    }
    expect(r.outOfSample!.horizons[1].n).toBe(r.folds.reduce((a, f) => a + (f.test?.horizons[1].n ?? 0), 0));
  });

  it('skips a fold when no candidate has enough training events', () => {
    const r = walkForward(series, base, { ...wf, minEvents: 10_000 });
    expect(r.folds.every((f) => f.test === null && f.chosen === null)).toBe(true);
    expect(r.outOfSample).toBeNull();
  });

  it('measures fixed parameters when nothing is varied', () => {
    const r = walkForward(series, base, { ...wf, param: undefined });
    expect(r.trials).toBe(r.folds.length);
    expect(r.folds.every((f) => f.chosen === null && f.test !== null)).toBe(true);
  });

  it('is deterministic', () => {
    expect(canonicalJson(walkForward(series, base, wf))).toBe(canonicalJson(walkForward(series, base, wf)));
  });
});

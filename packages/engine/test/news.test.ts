import { describe, expect, it } from 'vitest';
import { type Bar, bucketEvents, computeStudy, newsEvents, resolveConfig } from '../src';
import { barsFromCloses } from './helpers';

const DAY = 86_400_000;

describe('bucketEvents', () => {
  const b = barsFromCloses([10, 11, 12, 13]);
  it('puts each event on the bar it happens in, keeping the max per bar', () => {
    const ev = [
      { t: b[1].t + 3_600_000, v: 1 },
      { t: b[1].t + 7_200_000, v: 3 },
      { t: b[3].t, v: 2 },
    ];
    const a = bucketEvents(b, DAY, ev);
    expect(Number.isNaN(a[0])).toBe(true);
    expect(a[1]).toBe(3);
    expect(Number.isNaN(a[2])).toBe(true);
    expect(a[3]).toBe(2);
  });

  it('moves an event that falls between bars (weekend, overnight) onto the next bar, never an earlier one', () => {
    // bars every 2 days, 1-day long: a gap day between each
    const g: Bar[] = b.map((x, i) => ({ ...x, t: b[0].t + i * 2 * DAY }));
    const a = bucketEvents(g, DAY, [{ t: g[1].t + DAY + 3_600_000, v: 2 }]);
    expect(a[2]).toBe(2);
    expect(Number.isNaN(a[1])).toBe(true);
  });

  it('drops events before the first bar and after the last bar closes', () => {
    const a = bucketEvents(b, DAY, [
      { t: b[0].t - 5 * DAY, v: 3 },
      { t: b[3].t + DAY + 1, v: 3 },
    ]);
    expect([...a].every((v) => Number.isNaN(v))).toBe(true);
  });
});

/*
 * Hand-computed fixture (barsFromCloses: open = prior close, high/low = body ± 0.5).
 *   bar:   0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17
 *   close 10 11 12 13 14 15 16 17 18 12 11 10  9 10 12 14 16 18
 * Price flips (INDICATORS §1.1, lookback 4):
 *   bar 9  bearish: C8=18 > C4=14 and C9=12 < C5=15   ✓ (no other bearish flip)
 *   bar 14 bullish: C13=10 < C9=12 and C14=12 > C10=11 ✓ (bar 13 fails C13 > C9; bar 15 fails C14 < C10)
 * Reaction = true range ÷ mean true range of the up-to-14 bars before it:
 *   bar 9:  TR = 18.5 − 11.5 = 7;  prior TRs 1, 2×8 → mean 17/9 = 1.89 → 3.7×
 *   bar 14: TR = 12.5 − 9.5 = 3;   prior TRs 1, 2×8, 7, 2×4 → mean 32/14 = 2.29 → 1.31×
 *   bar 15: TR = 14.5 − 11.5 = 3;  prior (bars 1–14) 2×8, 7, 2×4, 3 → mean 34/14 = 2.43 → 1.24×
 */
const drop = [10, 11, 12, 13, 14, 15, 16, 17, 18, 12, 11, 10, 9, 10, 12, 14, 16, 18];

function run(cfg: Record<string, unknown>, aux: Record<string, number[]>, closes = drop) {
  const bars = barsFromCloses(closes);
  const a = Object.fromEntries(Object.entries(aux).map(([k, v]) => [k, Float64Array.from({ length: bars.length }, (_, i) => v[i] ?? NaN)]));
  return computeStudy(newsEvents, resolveConfig(newsEvents, cfg), bars, { aux: a, intervalMs: DAY });
}
const at = (n: number, i: number, v: number) => {
  const a = Array<number>(n).fill(NaN);
  a[i] = v;
  return a;
};

describe('news-events study', () => {
  it('marks a market event that lands on a bearish flip with a big reaction, known on the same bar', () => {
    const r = run({}, { newsMarket: at(drop.length, 9, 3) });
    expect(r.markers).toHaveLength(1);
    const m = r.markers[0];
    expect(m.i).toBe(9);
    expect(m.at).toBe(9);
    expect(m.text).toBe('MKT');
    expect(m.pos).toBe('above');
    expect(r.signals.map((s) => [s.i, s.id, s.dir])).toEqual([[9, 'NEWS_AT_FLIP_DOWN', 'bear']]);
    expect(r.lines.news[9]).toBe(-4);
  });

  it('waits for a flip that comes after the event, then marks the event bar (known at the flip bar)', () => {
    // a ticker event on bar 12, the bullish flip on bar 14 (2 bars later); the bar-9 flip is 3 bars away, outside a 2-bar window
    const r = run({ requireReaction: false, flipWindow: 2 }, { newsTicker: at(drop.length, 12, 2) });
    expect(r.markers.map((m) => [m.i, m.at, m.text, m.pos])).toEqual([[12, 14, 'CO', 'below']]);
    expect(r.signals.map((s) => [s.i, s.id])).toEqual([[14, 'NEWS_AT_FLIP_UP']]);
  });

  it('ignores events with no flip inside the window', () => {
    // bar 4 is in a steady rise: nearest flip is bar 9 (5 bars away)
    const r = run({ requireReaction: false }, { newsMarket: at(drop.length, 4, 3) });
    expect(r.markers).toHaveLength(0);
    // …unless the flip requirement is turned off
    const r2 = run({ requireReaction: false, requireFlip: false }, { newsMarket: at(drop.length, 4, 3) });
    expect(r2.markers.map((m) => [m.i, m.text, m.pos])).toEqual([[4, 'MKT', 'above']]);
    expect(r2.signals.map((s) => s.id)).toEqual(['NEWS_EVENT']);
  });

  it('needs a real price reaction: quiet bars do not qualify even at a flip', () => {
    // bars 14 and 15 (the reaction window) move 1.31× and 1.24× their average range
    const r = run({ reactionAtr: 1.32 }, { newsTicker: at(drop.length, 14, 3) });
    expect(r.markers).toHaveLength(0);
    expect(run({}, { newsTicker: at(drop.length, 14, 3) }).markers).toHaveLength(0);
    const r2 = run({ reactionAtr: 1.3 }, { newsTicker: at(drop.length, 14, 3) });
    expect(r2.markers.map((m) => [m.i, m.at])).toEqual([[14, 14]]);
  });

  it('filters by weight and by scope', () => {
    expect(run({ minWeight: 3 }, { newsMarket: at(drop.length, 9, 2) }).markers).toHaveLength(0);
    expect(run({ market: false }, { newsMarket: at(drop.length, 9, 3) }).markers).toHaveLength(0);
    const both = run({}, { newsMarket: at(drop.length, 9, 3), newsIndustry: at(drop.length, 9, 2) });
    expect(both.markers.map((m) => m.text)).toEqual(['IND+MKT']);
    expect(both.lines.news[9]).toBe(-6);
  });

  it('is empty without aux (no fabrication)', () => {
    const r = run({}, {});
    expect(r.markers).toHaveLength(0);
    expect(r.signals).toHaveLength(0);
  });

  it('reports the latest qualified event in its status', () => {
    const r = run({}, { newsMarket: at(drop.length, 9, 3) });
    expect(r.status?.chips[0]).toMatchObject({ dir: 'bear' });
    expect(r.status?.values?.barsSince).toBe(drop.length - 1 - 9);
  });
});

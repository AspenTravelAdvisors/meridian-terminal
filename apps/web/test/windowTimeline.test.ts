import { describe, expect, it } from 'vitest';
import { findAlignments, type WindowItem, windowItems } from '../src/lib/windowTimeline';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
// Monday 2026-11-16 00:00 UTC
const MON = Date.UTC(2026, 10, 16);

const item = (p: Partial<WindowItem> & Pick<WindowItem, 'tf' | 'from' | 'to'>): WindowItem => ({ side: 'buy', kind: 'seq13', minBars: 1, estBars: 1, count: 12, ...p });

describe('windowItems — Exhaustion Window values to calendar spans', () => {
  it('returns nothing when no count is in progress', () => {
    expect(windowItems('1D', { buy9: null, sell9: null, buy13Min: null }, MON, '24x7')).toEqual([]);
  });

  it('spans from the open of the earliest bar to the end of the estimated bar (24x7 daily)', () => {
    const [x] = windowItems('1D', { buy13Min: 3, buy13Est: 6 }, MON, '24x7');
    expect(x).toMatchObject({ tf: '1D', side: 'buy', kind: 'seq13', minBars: 3, estBars: 6, count: 10 });
    expect(x.from).toBe(MON + 3 * DAY);
    expect(x.to).toBe(MON + 7 * DAY);
  });

  it('skips weekends on an exchange calendar and does not stretch a Friday bar over them', () => {
    // last closed bar Thu 2026-11-19; 1 ahead = Fri 20th, 2 ahead = Mon 23rd
    const thu = Date.UTC(2026, 10, 19);
    const [x] = windowItems('1D', { sell9: 1 }, thu, 'NYSE');
    expect(x.kind).toBe('setup9');
    expect(x.count).toBe(8);
    expect(x.from).toBe(Date.UTC(2026, 10, 20));
    expect(x.to).toBe(Date.UTC(2026, 10, 21));
    const [y] = windowItems('1D', { sell13Min: 2, sell13Est: 2 }, thu, 'NYSE');
    expect(y.from).toBe(Date.UTC(2026, 10, 23));
  });

  it('weekly bars span whole weeks; a setup 9 is one bar', () => {
    const xs = windowItems('1W', { buy9: 2, combobuy13Min: 1, combobuy13Est: 4 }, MON, 'NYSE');
    const nine = xs.find((v) => v.kind === 'setup9')!;
    const combo = xs.find((v) => v.kind === 'combo13')!;
    expect([nine.from, nine.to]).toEqual([MON + 2 * WEEK, MON + 3 * WEEK]);
    expect([combo.from, combo.to]).toEqual([MON + WEEK, MON + 5 * WEEK]);
  });

  it('an estimate below the earliest (or missing) collapses to the earliest bar', () => {
    const [x] = windowItems('1D', { buy13Min: 4, buy13Est: null }, MON, '24x7');
    expect(x.estBars).toBe(4);
    expect(x.to - x.from).toBe(DAY);
  });
});

describe('findAlignments — overlap across timeframes', () => {
  it('needs two different timeframes; Sequential and Combo on one timeframe do not align', () => {
    const a = item({ tf: '1D', from: MON, to: MON + 5 * DAY });
    const b = item({ tf: '1D', kind: 'combo13', from: MON + DAY, to: MON + 6 * DAY });
    expect(findAlignments([a, b])).toEqual([]);
  });

  it('a daily band inside a weekly band aligns for the length of the daily band', () => {
    const w = item({ tf: '1W', from: MON, to: MON + 3 * WEEK });
    const d = item({ tf: '1D', from: MON + 8 * DAY, to: MON + 12 * DAY });
    const out = findAlignments([d, w]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ side: 'buy', from: MON + 8 * DAY, to: MON + 12 * DAY, tfs: ['1W', '1D'] });
    expect(out[0].items).toEqual(expect.arrayContaining([d, w]));
  });

  it('keeps buy and sell apart', () => {
    const w = item({ tf: '1W', side: 'buy', from: MON, to: MON + WEEK });
    const d = item({ tf: '1D', side: 'sell', from: MON, to: MON + DAY });
    expect(findAlignments([w, d])).toEqual([]);
  });

  it('touching spans (end-exclusive) do not align', () => {
    const w = item({ tf: '1W', from: MON, to: MON + WEEK });
    const d = item({ tf: '1D', from: MON + WEEK, to: MON + WEEK + DAY });
    expect(findAlignments([w, d])).toEqual([]);
  });

  it('splits where the set of timeframes changes and merges where it does not', () => {
    const m = item({ tf: '1M', from: MON, to: MON + 30 * DAY });
    const w = item({ tf: '1W', from: MON + 7 * DAY, to: MON + 21 * DAY });
    const d1 = item({ tf: '1D', kind: 'seq13', from: MON + 10 * DAY, to: MON + 12 * DAY });
    const d2 = item({ tf: '1D', kind: 'combo13', from: MON + 11 * DAY, to: MON + 14 * DAY });
    const out = findAlignments([m, w, d1, d2]);
    expect(out.map((a) => [(a.from - MON) / DAY, (a.to - MON) / DAY, a.tfs.join('+')])).toEqual([
      [7, 10, '1M+1W'],
      [10, 14, '1M+1W+1D'],
      [14, 21, '1M+1W'],
    ]);
    expect(out[1].items).toEqual(expect.arrayContaining([m, w, d1, d2]));
  });
});

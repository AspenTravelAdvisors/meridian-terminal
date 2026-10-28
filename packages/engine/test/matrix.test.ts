import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATRIX_WEIGHTS,
  type MatrixCell,
  type MatrixWeights,
  matrixCell,
  matrixScore,
  rowConfluence,
} from '../src';
import { barsFromCloses } from './helpers';

/** Same steady decline as sequential.test.ts: buy setup 9 on bar 16, Combo buy 13 on bar 20, Sequential buy 13 on bar 28. */
const decline = (n = 31) => Array.from({ length: n }, (_, i) => (i <= 5 ? 10 + i : 15 - 0.5 * (i - 5)));
/** Exact mirror (30 − close): every buy event above becomes the matching sell event on the same bar. */
const rise = (n = 31) => decline(n).map((c) => 30 - c);

// default weights: setup 0.5, setup9 1, countdown 1, cd13 2, combo 0.75, combo13 1.5 → total 6.75
const TOT = 6.75;
const ZERO: MatrixWeights = { setup: 0, setup9: 0, countdown: 0, cd13: 0, combo: 0, combo13: 0 };

describe('MTF matrix cell — hand-computed fixture', () => {
  it('returns a neutral placeholder with fewer than 10 bars', () => {
    expect(matrixCell(barsFromCloses(decline(9)))).toEqual({ label: '—', dir: 'neutral', score: 0, detail: {} });
  });

  it('bar 16: setup 9, countdown 1 and Combo 9 all contribute', () => {
    const c = matrixCell(barsFromCloses(decline(17)));
    // setup 9/9·0.5 + fresh 9·1 + CD 1/13·1 + Combo 9/13·0.75
    expect(c.score).toBeCloseTo((0.5 + 1 + 1 / 13 + (0.75 * 9) / 13) / TOT, 12);
    expect(c.label).toBe('B-CD1 B9 Cb9');
    expect(c.dir).toBe('bull');
  });

  it('bar 20: a Combo 13 counts under the combo13 weight, not as a Sequential 13', () => {
    const c = matrixCell(barsFromCloses(decline(21)));
    // setup 13 → capped 1·0.5; 9 is 4 bars old (> 3) → 0; CD 5/13·1; no Sequential 13; Combo 13 fresh → 1.5
    expect(c.score).toBeCloseTo((0.5 + 5 / 13 + 1.5) / TOT, 12);
    expect(c.detail.barsSinceBuy13).toBeNull();
    expect(c.detail.barsSinceBuyCombo13).toBe(0);
    expect(c.label).toBe('B-CD5 B13 Cb13');
  });

  it('bar 28: a Sequential 13 is seen even though an older Combo 13 is on record', () => {
    const c = matrixCell(barsFromCloses(decline(29)));
    // setup 21 → 0.5; Sequential 13 fresh → 2; Combo 13 is 8 bars old → 0
    expect(c.score).toBeCloseTo((0.5 + 2) / TOT, 12);
    expect(c.detail.barsSinceBuy13).toBe(0);
    expect(c.detail.barsSinceBuyCombo13).toBe(8);
    expect(c.label).toBe('B13 B21');
  });

  it('mirrors exactly on the sell side', () => {
    for (const n of [17, 21, 29]) {
      const b = matrixCell(barsFromCloses(decline(n)));
      const s = matrixCell(barsFromCloses(rise(n)));
      expect(s.score).toBeCloseTo(-b.score, 12);
      expect(s.dir).toBe('bear');
      expect(s.label).toBe(b.label.replace(/B/g, 'S').replace(/Cb/g, 'Cs'));
    }
  });

  it('honours every weight, including combo13', () => {
    const bars = barsFromCloses(decline(21));
    expect(matrixCell(bars, { ...ZERO, combo13: 1 }).score).toBe(1);
    expect(matrixCell(bars, { ...ZERO, cd13: 1 }).score).toBe(0);
    expect(matrixCell(bars, ZERO).score).toBe(0);
  });

  it('matrixScore re-weights a cell from its detail exactly as matrixCell scored it', () => {
    for (const n of [12, 17, 21, 25, 29, 31]) {
      const bars = barsFromCloses(decline(n));
      for (const w of [
        DEFAULT_MATRIX_WEIGHTS,
        { ...ZERO, combo13: 1 },
        { ...DEFAULT_MATRIX_WEIGHTS, cd13: 5, setup: 0 },
      ]) {
        const c = matrixCell(bars, w);
        expect(matrixScore(c.detail, w)).toBe(c.score);
      }
    }
  });
});

describe('row confluence', () => {
  const cell = (score: number): MatrixCell => ({ label: '', dir: 'neutral', score, detail: {} });

  it('is the timeframe-weighted mean of cell scores, scaled to ±100', () => {
    // (3·0.5 + 1·(−0.25)) / (3 + 1) = 0.3125
    expect(rowConfluence([cell(0.5), cell(-0.25)], [3, 1])).toBeCloseTo(31.25, 12);
  });

  it('skips missing cells (and their weight) and defaults a missing weight to 1', () => {
    expect(rowConfluence([cell(0.5), null, cell(-0.25)], [3, 100])).toBeCloseTo(((1.5 - 0.25) / 4) * 100, 12);
    expect(rowConfluence([null, null], [1, 1])).toBe(0);
  });
});

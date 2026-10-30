import { describe, expect, it } from 'vitest';
import { type Bar, bestBand, computeStudy, countdownEta, defaultsOf, exhaustionWindow, exhaustionZone, ichimoku, resolveConfig, sequential } from '../src';
import { barsFromCloses, randomWalk } from './helpers';

/**
 * Steady decline (traced by hand in sequential.test.ts / composite.test.ts): buy setup bars 8–16, Sequential CD1 on bar 16
 * and buy 13 on bar 28; Combo counts from setup bar 1 (bar 8), reaching 9 on bar 16 and 13 on bar 20. Every bar qualifies.
 */
const decline = (n = 31) => Array.from({ length: n }, (_, i) => (i <= 5 ? 10 + i : 15 - 0.5 * (i - 5)));
const mirror = (closes: number[]) => closes.map((c) => 30 - c);

/** Status values on bar i, read from a run that ends there. */
function statusAt(def: typeof exhaustionZone | typeof exhaustionWindow, cfg: Record<string, unknown>, bars: Bar[], i: number) {
  const r = computeStudy(def, resolveConfig(def, cfg), bars.slice(0, i + 1));
  return { values: r.status!.values as Record<string, number | string | null>, result: r };
}

describe('bestBand — densest band of levels at or below the reference', () => {
  const L = (src: string, p: number, w = 1) => ({ src, p, w });

  it('returns null when no level qualifies', () => {
    expect(bestBand([], 100, 2, 50)).toBeNull();
    // above the reference, too far below it, non-finite or zero weight
    expect(bestBand([L('a', 101), L('b', 40), L('c', NaN), L('d', 95, 0)], 100, 2, 50)).toBeNull();
  });

  it('a single level is a band of zero height', () => {
    expect(bestBand([L('a', 95)], 100, 2, 50)).toEqual({ lo: 95, hi: 95, score: 1, srcs: ['a'] });
  });

  it('picks the band holding the most weight', () => {
    // 98 alone (1) vs 90 + 89 + 88.5 within 2 (3)
    const b = bestBand([L('a', 98), L('b', 90), L('c', 89), L('d', 88.5)], 100, 2, 50);
    expect(b).toEqual({ lo: 88.5, hi: 90, score: 3, srcs: ['b', 'c', 'd'] });
  });

  it('weights beat counts', () => {
    // 98 (weight 3) vs 90 + 89 (weight 2)
    expect(bestBand([L('a', 98, 3), L('b', 90), L('c', 89)], 100, 2, 50)?.srcs).toEqual(['a']);
  });

  it('breaks ties toward the reference (the nearer band)', () => {
    expect(bestBand([L('far', 80), L('near', 97)], 100, 2, 50)?.srcs).toEqual(['near']);
  });

  it('the band edge is inclusive', () => {
    expect(bestBand([L('a', 95), L('b', 93)], 100, 2, 50)?.srcs).toEqual(['a', 'b']);
    expect(bestBand([L('a', 95), L('b', 92.999)], 100, 2, 50)?.score).toBe(1);
  });

  it('only bands holding minCount levels compete, so a heavy lone level cannot hide a cluster', () => {
    const lv = [L('tdst', 106, 2), L('cloud', 111.5), L('kijun', 110.1, 0.5)];
    expect(bestBand(lv, 112, 2, 50)?.srcs).toEqual(['tdst']);
    expect(bestBand(lv, 112, 2, 50, 2)).toEqual({ lo: 110.1, hi: 111.5, score: 1.5, srcs: ['cloud', 'kijun'] });
    expect(bestBand(lv, 112, 2, 50, 3)).toBeNull();
  });

  it('a level exactly at the reference counts; one just above does not', () => {
    expect(bestBand([L('a', 100)], 100, 2, 50)?.hi).toBe(100);
    expect(bestBand([L('a', 100.0001)], 100, 2, 50)).toBeNull();
  });
});

describe('countdownEta — earliest and estimated bars to the final countdown bar', () => {
  it('every bar qualified so far: estimate = earliest = bars remaining', () => {
    // count 1 on its first bar (startI 16, i 16) → 12 to go
    expect(countdownEta(1, 16, 16, 13, 0.25)).toEqual([12, 12]);
  });

  it('half the bars qualified: estimate doubles the remaining bars', () => {
    // count 4 over bars 10–17 (8 bars) → rate 0.5, 9 to go → 18
    expect(countdownEta(4, 10, 17, 13, 0.25)).toEqual([9, 18]);
  });

  it('rounds the estimate up', () => {
    // count 2 over 3 bars → rate 2/3, 11 to go → 16.5 → 17
    expect(countdownEta(2, 0, 2, 13, 0.25)).toEqual([11, 17]);
  });

  it('floors the rate at minRate (no qualifying bar yet)', () => {
    expect(countdownEta(0, 0, 4, 13, 0.25)).toEqual([13, 52]);
    expect(countdownEta(0, 0, 4, 13, 0.5)).toEqual([13, 26]);
  });

  it('a pending final bar (deferred 13) is at least one bar away', () => {
    expect(countdownEta(12, 0, 11, 13, 0.25)).toEqual([1, 1]);
    expect(countdownEta(13, 0, 12, 13, 0.25)).toEqual([1, 1]);
  });
});

describe('Exhaustion Window — hand-computed fixture', () => {
  const bars = barsFromCloses(decline());
  const r = computeStudy(exhaustionWindow, defaultsOf(exhaustionWindow), bars);
  const L = r.lines;

  it('bar 12: buy setup at 5 → setup 9 in 4 bars; no countdown yet', () => {
    expect(L.buy9[12]).toBe(4);
    expect(L.buy13_min[12]).toBeNaN();
    expect(L.cbuy13_min[12]).toBeNaN();
  });

  it('projects the setup 9 onto the bar where it actually completes', () => {
    for (let i = 8; i < 16; i++) expect(i + L.buy9[i]).toBe(16);
    expect(L.buy9[16]).toBeNaN(); // complete; the extension is not projected
  });

  it('bar 16: Sequential CD 1 → 13 in 12 bars; Combo at 9 → 13 in 4 bars', () => {
    expect([L.buy13_min[16], L.buy13_est[16]]).toEqual([12, 12]);
    expect([L.cbuy13_min[16], L.cbuy13_est[16]]).toEqual([4, 4]);
  });

  it('projects each 13 onto the bar where it actually completes', () => {
    for (let i = 16; i < 28; i++) expect(i + L.buy13_min[i]).toBe(28);
    for (let i = 16; i < 20; i++) expect(i + L.cbuy13_min[i]).toBe(20);
    expect(L.cbuy13_min[20]).toBeNaN();
    expect(L.buy13_min[28]).toBeNaN();
  });

  it('never projects the sell side in a pure decline', () => {
    for (const k of ['sell9', 'sell13_min', 'sell13_est', 'csell13_min', 'csell13_est']) for (let i = 0; i < bars.length; i++) expect(L[k][i]).toBeNaN();
  });

  it('fires WINDOW_BUY_NEAR once per approach (Combo on bar 17, Sequential on bar 25)', () => {
    expect(r.signals.map((s) => [s.id, s.i, s.label])).toEqual([
      ['WINDOW_BUY_NEAR', 17, 'Combo 13 in ≥3 bars'],
      ['WINDOW_BUY_NEAR', 25, 'Seq 13 in ≥3 bars'],
    ]);
  });

  it('draws future time marks at the projected bars, from the last bar', () => {
    const { result } = statusAt(exhaustionWindow, {}, bars, 16);
    expect(result.geometry.timeMarks).toEqual([
      { i: 28, label: 'B13', color: 'bull' },
      { i: 20, label: 'Combo B13', color: 'bullAlt' },
    ]);
    // bar 12: only the setup 9
    expect(statusAt(exhaustionWindow, {}, bars, 12).result.geometry.timeMarks).toEqual([{ i: 16, label: 'B9', color: 'bull' }]);
  });

  it('mirrors on the sell side', () => {
    const m = computeStudy(exhaustionWindow, defaultsOf(exhaustionWindow), barsFromCloses(mirror(decline())));
    expect(m.lines.sell9[12]).toBe(4);
    expect([m.lines.sell13_min[16], m.lines.csell13_min[16]]).toEqual([12, 4]);
    expect(m.signals.map((s) => [s.id, s.i])).toEqual([
      ['WINDOW_SELL_NEAR', 17],
      ['WINDOW_SELL_NEAR', 25],
    ]);
    expect(statusAt(exhaustionWindow, {}, barsFromCloses(mirror(decline())), 16).result.geometry.timeMarks).toEqual([
      { i: 28, label: 'S13', color: 'bear' },
      { i: 20, label: 'Combo S13', color: 'bearAlt' },
    ]);
  });
});

describe('Exhaustion Zone — hand-computed fixture', () => {
  const bars = barsFromCloses(decline());

  it('bar 17: the buy setup risk (7.5) is the only level; one level is not a zone by default', () => {
    // lowest true low of setup bars 8–16 is bar 16's 9.0; its true range is 10.5 − 9.0 = 1.5 → risk 7.5
    const { values, result } = statusAt(exhaustionZone, {}, bars, 17);
    expect(values['buy.setupRisk']).toBe(7.5);
    for (const k of ['buy.tdst', 'buy.cdRisk', 'buy.cloud', 'buy.tdLines', 'buy.propulsion']) expect(values[k]).toBeNull();
    // the Kijun sits above the close throughout a steady decline
    expect(values['buy.kijun'] === null || (values['buy.kijun'] as number) > bars[17].c).toBe(true);
    expect(values.buyLevels).toBe(0);
    expect(result.lines.buy_hi[17]).toBeNaN();
  });

  it('with minLevels 1 the zone is the level padded by padAtr × ATR', () => {
    const { values, result } = statusAt(exhaustionZone, { minLevels: 1 }, bars, 17);
    const atr = values.atr as number;
    expect(result.lines.buy_hi[17]).toBeCloseTo(7.5 + 0.25 * atr, 12);
    expect(result.lines.buy_lo[17]).toBeCloseTo(7.5 - 0.25 * atr, 12);
    expect(values.buySources).toBe('setupRisk');
    // drawn from the bar the zone appeared (bar 16: the buy 9 set the risk level) to 8 bars past the last bar
    const [top, bottom] = result.geometry.segments!;
    expect(top).toMatchObject({ i1: 16, i2: 25, p1: result.lines.buy_hi[17], p2: result.lines.buy_hi[17], color: 'bull', label: 'Buy zone (1)' });
    expect(bottom).toMatchObject({ i1: 16, i2: 25, p1: result.lines.buy_lo[17], label: undefined });
  });

  it('drops a level once the close is below it', () => {
    // bar 22 closes at 6.5, under the 7.5 risk level
    const { values, result } = statusAt(exhaustionZone, { minLevels: 1 }, bars, 22);
    expect(values.buyLevels).toBe(0);
    expect(result.lines.buy_hi[22]).toBeNaN();
  });

  it('fires ZONE_BUY_TEST when a bar trades into the prior bar’s zone, once per visit', () => {
    const r = computeStudy(exhaustionZone, resolveConfig(exhaustionZone, { minLevels: 1 }), bars);
    // bar 18's zone top is 7.5 + 0.25·ATR with ATR between 1 and 2 (true ranges are 1–2 here) → 7.75…8.0
    const atr18 = statusAt(exhaustionZone, { minLevels: 1 }, bars, 18).values.atr as number;
    expect(atr18).toBeGreaterThan(1);
    expect(atr18).toBeLessThan(2);
    // bar 18's low 8.0 stays above bar 17's zone; bar 19's low 7.5 trades into bar 18's zone
    expect(r.signals.filter((s) => s.id === 'ZONE_BUY_TEST').map((s) => s.i)).toEqual([19]);
  });

  it('mirrors on the sell side', () => {
    const m = barsFromCloses(mirror(decline()));
    const { values, result } = statusAt(exhaustionZone, { minLevels: 1 }, m, 17);
    expect(values['sell.setupRisk']).toBe(22.5);
    expect(result.lines.sell_lo[17]).toBeCloseTo(22.5 - 0.25 * (values.atr as number), 12);
    const r = computeStudy(exhaustionZone, resolveConfig(exhaustionZone, { minLevels: 1 }), m);
    expect(r.signals.filter((s) => s.id === 'ZONE_SELL_TEST').map((s) => s.i)).toEqual([19]);
  });
});

describe('Exhaustion Zone — sources match their own studies', () => {
  const bars = randomWalk(600, 5);
  const seqCfg = defaultsOf(sequential);
  const seq = computeStudy(sequential, seqCfg, bars);
  const ich = computeStudy(ichimoku, defaultsOf(ichimoku), bars);
  const disp = (defaultsOf(ichimoku) as { displacement: number }).displacement;
  const below = (v: number, c: number) => (Number.isFinite(v) && v <= c ? v : null);
  const above = (v: number, c: number) => (Number.isFinite(v) && v >= c ? v : null);

  it.each([150, 299, 420, 599])('bar %i: TDST, risk levels and Kijun are the Sequential / Ichimoku values on the right side of the close', (i) => {
    const { values } = statusAt(exhaustionZone, {}, bars, i);
    const c = bars[i].c;
    expect(values['buy.tdst']).toBe(below(seq.lines.tdst_sup[i], c));
    expect(values['sell.tdst']).toBe(above(seq.lines.tdst_res[i], c));
    expect(values['buy.setupRisk']).toBe(below(seq.lines.risk_buy[i], c));
    expect(values['sell.setupRisk']).toBe(above(seq.lines.risk_sell[i], c));
    expect(values['buy.cdRisk']).toBe(below(seq.lines.cdrisk_buy[i], c));
    expect(values['sell.cdRisk']).toBe(above(seq.lines.cdrisk_sell[i], c));
    expect(values['buy.kijun']).toBe(below(ich.lines.kijun[i], c));
    expect(values['sell.kijun']).toBe(above(ich.lines.kijun[i], c));
    // the cloud at bar i was computed `displacement` bars earlier
    const top = Math.max(ich.lines.senkouA[i - disp], ich.lines.senkouB[i - disp]);
    const bot = Math.min(ich.lines.senkouA[i - disp], ich.lines.senkouB[i - disp]);
    expect(values['buy.cloud']).toBe(c > top ? top : c >= bot ? bot : null);
    expect(values['sell.cloud']).toBe(c < bot ? bot : c <= top ? top : null);
  });

  it('the zone is the best band of those levels, padded', () => {
    const cfg = resolveConfig(exhaustionZone, {}) as { zoneAtr: number; padAtr: number; maxDistAtr: number; minLevels: number };
    for (const i of [150, 299, 420, 599]) {
      const { values, result } = statusAt(exhaustionZone, {}, bars, i);
      const atr = values.atr as number;
      const lv = ['tdst', 'setupRisk', 'cdRisk', 'cloud', 'kijun', 'tdLines', 'propulsion']
        .map((k) => ({ src: k, p: values[`buy.${k}`] as number | null, w: values[`w.${k}`] as number }))
        .filter((l): l is { src: string; p: number; w: number } => l.p !== null);
      const b = bestBand(lv, bars[i].c, cfg.zoneAtr * atr, cfg.maxDistAtr * atr, cfg.minLevels);
      if (!b) expect(result.lines.buy_hi[i]).toBeNaN();
      else {
        expect(result.lines.buy_hi[i]).toBeCloseTo(b.hi + cfg.padAtr * atr, 9);
        expect(result.lines.buy_lo[i]).toBeCloseTo(b.lo - cfg.padAtr * atr, 9);
        expect(values.buySources).toBe(b.srcs.join(','));
      }
    }
  });
});

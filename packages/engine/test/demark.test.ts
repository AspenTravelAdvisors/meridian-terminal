import { describe, expect, it } from 'vitest';
import {
  type Bar,
  combo,
  computeStudy,
  defaultsOf,
  demarker1,
  demarker2,
  dwave,
  ichimoku,
  projectFrom,
  propulsion,
  rangeProjection,
  rei,
  resolveConfig,
  sequential,
  tdLines,
  tdPoints,
  trendFactor,
  Engine,
} from '../src';
import { barsFromCloses, randomWalk } from './helpers';

const decline = (n = 31) => Array.from({ length: n }, (_, i) => (i <= 5 ? 10 + i : 15 - 0.5 * (i - 5)));

/** Bars whose high/low hug the close (h = c + 0.5, l = c − 0.5, o = c): strict swing highs follow closes. */
const tight = (closes: number[]): Bar[] => closes.map((c, i) => ({ t: Date.UTC(2024, 0, 1) + i * 86_400_000, o: c, h: c + 0.5, l: c - 0.5, c, v: 100 }));

/** Piecewise-linear closes through the given [bars, target] legs. */
function legs(start: number, spec: [number, number][]): number[] {
  const out = [start];
  let v = start;
  for (const [n, to] of spec) {
    const step = (to - v) / n;
    for (let k = 1; k <= n; k++) out.push(+(v + step * k).toFixed(6));
    v = to;
  }
  return out;
}

describe('DeMark-style Combo', () => {
  const bars = barsFromCloses(decline());
  const r = computeStudy(combo, defaultsOf(combo), bars);

  it('starts the countdown on setup bar 1, evaluated retroactively when the setup completes', () => {
    // setup bars 8…16; every bar from 8 on meets all four combo conditions in a steady decline
    expect(r.lines.combo[15]).toBe(0); // setup not yet complete → no countdown known
    expect(r.lines.combo[16]).toBe(-9); // bars 8…16 counted at once on the bar-9 close
    const nums = r.markers.filter((m) => m.at === 16).map((m) => m.i);
    expect(nums).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('completes COMBO_BUY_13 on bar 20', () => {
    expect(r.signals.find((s) => s.id === 'COMBO_BUY_13')?.i).toBe(20);
    expect(r.lines.combo[20]).toBe(-13);
  });

  it('v2 relaxes the rules from countdown 11: only a lower close than the previous countdown bar is needed', () => {
    const closes = decline(19); // CD10 at bar 17 (bars 8…17)
    // bar 19: close below CD10's close but with a HIGHER low than bar 18 → strict fails, v2 counts
    const b = barsFromCloses(closes);
    const last = b[b.length - 1];
    b.push({ t: last.t + 86_400_000, o: last.c, h: last.c + 0.2, l: last.l + 0.3, c: last.c - 0.1, v: 1 });
    const strict = computeStudy(combo, defaultsOf(combo), b);
    const v2 = computeStudy(combo, resolveConfig(combo, { comboVersion: 'v2' }), b);
    expect(Math.abs(v2.lines.combo[19])).toBe(Math.abs(strict.lines.combo[19]) + 1);
  });
});

describe('DeMark-style DeMarker I', () => {
  it('matches a hand-computed value', () => {
    const H = [10, 11, 12, 11, 13];
    const L = [9, 10, 9, 8, 10];
    const bars: Bar[] = H.map((h, i) => ({ t: i * 60_000, o: (h + L[i]) / 2, h, l: L[i], c: (h + L[i]) / 2, v: 1 }));
    const r = computeStudy(demarker1, resolveConfig(demarker1, { length: 3 }), bars);
    // i=3: ΣDeMax(1..3) = 1+1+0 = 2, ΣDeMin = 0+1+1 = 2 → 50
    expect(r.lines.dem1[3]).toBeCloseTo(50, 12);
    // i=4: ΣDeMax(2..4) = 1+0+2 = 3, ΣDeMin = 1+1+0 = 2 → 60
    expect(r.lines.dem1[4]).toBeCloseTo(60, 12);
  });

  it('suppresses reversal signals after an over-long stay in the zone (duration analysis)', () => {
    const closes = legs(100, [[40, 60], [10, 70]]);
    const r = computeStudy(demarker1, resolveConfig(demarker1, { maxDuration: 5 }), barsFromCloses(closes));
    expect(r.signals.some((s) => s.id === 'DEM1_OS_EXTREME')).toBe(true);
    expect(r.signals.some((s) => s.id === 'DEM1_OS_EXIT')).toBe(false);
    expect(r.signals.some((s) => s.id === 'DEM1_OS_EXIT_EXTREME')).toBe(true);
  });
});

describe('DeMark-style DeMarker II', () => {
  it('stays within 0–100 and the true-range basis is honoured', () => {
    // randomWalk opens at the prior close (true low = low), so lift every 4th bar whole to create gaps
    const bars = randomWalk(120, 3).map((b, i) => (i % 4 ? b : { ...b, o: b.o * 1.02, h: b.h * 1.02, l: b.l * 1.02, c: b.c * 1.02 }));
    const plain = computeStudy(demarker2, defaultsOf(demarker2), bars);
    const tr = computeStudy(demarker2, resolveConfig(demarker2, { rangeBasis: 'true' }), bars);
    for (const r of [plain, tr]) for (const v of r.lines.dem2) if (Number.isFinite(v)) expect(v >= 0 && v <= 100).toBe(true);
    expect(Array.from(plain.lines.dem2)).not.toEqual(Array.from(tr.lines.dem2));
  });

  it('uses the plain low and high: BP = max(0, H − prior C) + (C − L), SP = max(0, prior C − L) + (H − C)', () => {
    // Bars 1 and 2 each gap up the same way: prior C, open +1, high +2, low +0.5, close +1.5 → BP = 2 + 1 = 3,
    // SP = 0 + 0.5 = 0.5 → 3 / 3.5 over the 2-bar window. (The true low would be the prior close, giving BP = 3.5.)
    const bars: Bar[] = [
      { t: 0, o: 10, h: 10, l: 10, c: 10, v: 1 },
      { t: 1, o: 11, h: 12, l: 10.5, c: 11.5, v: 1 },
      { t: 2, o: 12.5, h: 13.5, l: 12, c: 13, v: 1 },
    ];
    const r = computeStudy(demarker2, resolveConfig(demarker2, { length: 2 }), bars);
    expect(r.lines.dem2[2]).toBeCloseTo((100 * 3) / 3.5, 10);
    // Two gaps down with the clamp off: BP = (8.5 − 10) + 0.2 and (6 − 7.2) + 0.2 → negative sum, value below 0.
    const gap: Bar[] = [bars[0], { t: 1, o: 8, h: 8.5, l: 7, c: 7.2, v: 1 }, { t: 2, o: 5.5, h: 6, l: 4.5, c: 4.7, v: 1 }];
    const raw = computeStudy(demarker2, resolveConfig(demarker2, { length: 2, clampPriorClose: false }), gap);
    expect(raw.lines.dem2[2]).toBeLessThan(0);
    // clamped (default): BP = 0.2 + 0.2, SP = (3 + 1.3) + (2.7 + 1.3) → 0.4 / 8.7
    expect(computeStudy(demarker2, resolveConfig(demarker2, { length: 2 }), gap).lines.dem2[2]).toBeCloseTo((100 * 0.4) / 8.7, 10);
  });
});

describe('DeMark-style Range Projection', () => {
  const ctx = (o: number, h: number, l: number, c: number, prevC = o) => {
    const e = new Engine([], 0);
    e.update({ t: 0, o: prevC, h: prevC, l: prevC, c: prevC, v: 1 });
    e.update({ t: 1, o, h, l, c, v: 1 });
    return e.store.ctx;
  };
  it('C < O: X = H + 2L + C', () => {
    const p = projectFrom(ctx(11, 12, 10, 10.5), 1, 'open');
    expect(p.hi).toBeCloseTo(42.5 / 2 - 10, 12);
    expect(p.lo).toBeCloseTo(42.5 / 2 - 12, 12);
  });
  it('C > O: X = 2H + L + C', () => {
    const p = projectFrom(ctx(10.5, 12, 10, 11.5), 1, 'open');
    expect(p.hi).toBeCloseTo((24 + 10 + 11.5) / 2 - 10, 12);
  });
  it('C = O: X = H + L + 2C, and the priorClose basis compares with the prior close', () => {
    expect(projectFrom(ctx(11, 12, 10, 11), 1, 'open').hi).toBeCloseTo((12 + 10 + 22) / 2 - 10, 12);
    // prior close 12 > C=11 → C < ref branch under priorClose
    expect(projectFrom(ctx(11, 12, 10, 11, 12), 1, 'priorClose').branch).toContain('X = H + 2L + C');
  });
  it('plots tolerance levels at the open ± k × prior true range', () => {
    const bars: Bar[] = [
      { t: 0, o: 10, h: 12, l: 9, c: 11, v: 1 },
      { t: 1, o: 11, h: 11.5, l: 10.5, c: 11, v: 1 },
    ];
    const r = computeStudy(rangeProjection, defaultsOf(rangeProjection), bars);
    expect(r.lines.up_tol[1]).toBeCloseTo(11 + 0.15 * 3, 12);
    expect(r.lines.dn_tol[1]).toBeCloseTo(11 - 0.15 * 3, 12);
  });
  it('sequences intrabar touches from live ticks (projected high before down tolerance → expect above)', () => {
    const e = new Engine([{ def: rangeProjection, cfg: defaultsOf(rangeProjection) }], 60_000);
    e.update({ t: 0, o: 10, h: 12, l: 10, c: 11.8, v: 1 }); // PH for next bar = (2·12 + 10 + 11.8)/2 − 10 = 17.9 → wait, use ratio below
    const ph = projectFrom(e.store.ctx, 0, 'open').hi;
    e.update({ t: 60_000, o: 11.8, h: ph + 0.01, l: 11.8, c: ph, v: 1, final: false }); // touches PH first
    e.update({ t: 60_000, o: 11.8, h: ph + 0.01, l: 5, c: 9, v: 1, final: false }); // later dumps through DnTol
    e.update({ t: 60_000, o: 11.8, h: ph + 0.01, l: 5, c: 9, v: 1, final: true });
    const r = e.results()[0];
    expect(r.signals.some((s) => s.id === 'RP_EXPECT_ABOVE' && s.i === 1)).toBe(true);
    expect(r.lines.rp_state[1]).toBe(1);
  });
});

describe('DeMark-style REI', () => {
  it('is bounded to ±100', () => {
    const r = computeStudy(rei, defaultsOf(rei), barsFromCloses(legs(100, [[40, 150], [40, 90], [30, 120]])));
    for (const v of r.lines.rei) if (Number.isFinite(v)) expect(Math.abs(v)).toBeLessThanOrEqual(100 + 1e-9);
  });
});

describe('DeMark-style Points / Lines / Trend Factor', () => {
  const closes = [1, 2, 5, 2, 1, 3, 4, 3, 2, 6, 2, 1];
  const bars = tight(closes);
  it('confirms a level-2 point high n bars later', () => {
    const r = computeStudy(tdPoints, defaultsOf(tdPoints), bars);
    const highs = r.signals.filter((s) => s.id === 'TDP_HIGH');
    expect(highs.map((s) => s.i)).toEqual([4, 8, 11]); // pivots at 2, 6, 9 confirmed two bars later
    expect(r.markers.find((m) => m.at === 4)?.i).toBe(2);
  });
  it('draws a supply line through descending point highs and flags a break', () => {
    const c = legs(100, [[10, 120], [10, 100], [8, 112], [8, 98], [12, 125]]);
    const r = computeStudy(tdLines, resolveConfig(tdLines, { level: 2 }), tight(c));
    expect(r.signals.some((s) => s.id.startsWith('TDL_SUPPLY_BREAK'))).toBe(true);
  });
  it('trend factor levels step by 5.56% from the pivot', () => {
    const r = computeStudy(trendFactor, resolveConfig(trendFactor, { pivotMode: 'manual', manualPivot: 100 }), bars);
    expect(r.lines.up2[5]).toBeCloseTo(111.12, 10);
    expect(r.lines.dn4[5]).toBeCloseTo(77.76, 10);
  });
});

describe('DeMark-style D-Wave', () => {
  it('labels a clean five-wave advance and locks wave C', () => {
    const c = legs(100, [
      [60, 60], // decline → origin
      [30, 100], // wave 1
      [25, 80], // wave 2
      [40, 140], // wave 3
      [25, 120], // wave 4
      [30, 160], // wave 5
      [25, 130], // A
      [15, 145], // B
      [40, 100], // C
    ]);
    const r = computeStudy(dwave, defaultsOf(dwave), barsFromCloses(c));
    const seq = r.signals.filter((s) => s.id.startsWith('DWAVE_') && !s.id.startsWith('DWAVE_DOWN')).map((s) => s.id);
    const order = ['DWAVE_1_START', 'DWAVE_3_START', 'DWAVE_5_START', 'DWAVE_5_COMPLETE', 'DWAVE_C_LOCKED'];
    let k = 0;
    for (const id of seq) if (id === order[k]) k++;
    expect(k).toBe(order.length);
  });
  it('shifts wave 2 right when wave 4 undercuts wave 2', () => {
    const c = legs(100, [
      [60, 60],
      [30, 100],
      [25, 80],
      [40, 140],
      [40, 75], // "wave 4" below wave 2's low → wave 2 shifts here, wave 3 discarded
    ]);
    const r = computeStudy(dwave, defaultsOf(dwave), barsFromCloses(c));
    const piv = r.geometry.pivots ?? [];
    expect(piv.find((p) => p.label === '3')).toBeUndefined();
    const two = piv.find((p) => p.label === '2');
    expect(two && two.price).toBeLessThan(80);
    // the shifted wave keeps a "+" where it was first recognised (the original wave-2 area, above its new low)
    expect(two?.first).toBeDefined();
    expect(two!.first!.i).toBeLessThan(two!.i);
    expect(two!.first!.price).toBeGreaterThan(two!.price);
  });
  it('re-evaluates wave 1 to the old wave-3 peak when wave 2 shifts right', () => {
    // BTC 4H, Sep–Oct 2026 (VERIFY_LOG note 7): after wave 4 undercut wave 2, a bounce above the old wave 1 but below the
    // old wave 3 moved wave 1 to that lower, later high. Wave 1 is the highest high since it began, so it must be the
    // wave-3 peak (close 140, bar 155), and the bounce to 110 must not move it.
    const c = legs(100, [
      [60, 60],
      [30, 100],
      [25, 80],
      [40, 140],
      [40, 75], // below wave 2's low (80), above the origin (60)
      [15, 110], // above the old wave 1 (100), below the old wave 3 (140)
    ]);
    const r = computeStudy(dwave, resolveConfig(dwave, { direction: 'up' }), barsFromCloses(c));
    const piv = r.geometry.pivots ?? [];
    const one = piv.find((p) => p.label === '1');
    expect(one?.i).toBe(155);
    expect(one?.price).toBe(140.5);
    // "+" stays where wave 1 was first recognised, in the first advance
    expect(one?.first?.i).toBeLessThan(91);
    expect(one!.first!.price).toBeLessThan(101);
    expect(piv.find((p) => p.label === '2')?.price).toBeLessThan(80);
    expect(piv.find((p) => p.label === '3')).toBeUndefined();
  });

  it('an N-bar high is a high at or above each of the previous N highs (ties count by default)', () => {
    // Bars 0–21 fall (high 121 − i, low 2 below) → origin on bar 21 (low 98). Bars 22–32 hold high 99.5; bars 33 and
    // 34 both reach 100. Bar 34 ties the highest of the previous 13 highs (bars 21 and 33) → a 13-bar high by default.
    // The strict alternative needs a high above the previous 12, which bar 33's tie blocks.
    const H = [...Array.from({ length: 22 }, (_, i) => 121 - i), ...Array<number>(11).fill(99.5), 100, 100];
    const bars = H.map((h, i) => {
      const l = i <= 21 ? h - 2 : 98.5;
      return { t: Date.UTC(2024, 0, 1) + i * 86_400_000, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1000 };
    });
    const first = (cfg: Record<string, unknown>) =>
      computeStudy(dwave, resolveConfig(dwave, cfg), bars).signals.filter((s) => s.id === 'DWAVE_1_START').map((s) => s.i);
    expect(first({})).toEqual([34]);
    expect(first({ nBarTest: 'abovePriorNMinus1' })).toEqual([]);
  });
});

describe('DeMark-style Propulsion', () => {
  it('projects trigger P + M and target P + 2M from a qualifying pullback', () => {
    const c = legs(110, [[10, 100], [10, 120], [4, 112], [12, 135]]);
    const r = computeStudy(propulsion, defaultsOf(propulsion), tight(c));
    // A = 100 − 0.5 (low), B = 120.5 (high), M = 21 × 0.236, P = 111.5
    const M = (120.5 - 99.5) * 0.236;
    const trig = r.signals.find((s) => s.id === 'PROP_UP_TRIGGER');
    expect(trig).toBeDefined();
    expect(trig!.price).toBeCloseTo(111.5 + M, 9);
    const hit = r.signals.find((s) => s.id === 'PROP_UP_TARGET_HIT');
    expect(hit!.price).toBeCloseTo(111.5 + 2 * M, 9);
  });
});

describe('Ichimoku', () => {
  it('Tenkan/Kijun are range midpoints; Senkou spans are flagged for forward displacement', () => {
    const bars = barsFromCloses(legs(100, [[80, 140], [60, 90]]));
    const cfg = defaultsOf(ichimoku);
    const r = computeStudy(ichimoku, cfg, bars);
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = 50 - 8; k <= 50; k++) {
      hh = Math.max(hh, bars[k].h);
      ll = Math.min(ll, bars[k].l);
    }
    expect(r.lines.tenkan[50]).toBeCloseTo((hh + ll) / 2, 12);
    expect(r.outputs.find((o) => o.id === 'senkouA')).toMatchObject({ offset: 26 });
    expect(r.outputs.find((o) => o.id === 'chikou')).toMatchObject({ offset: -26 });
    expect(r.signals.some((s) => s.id.startsWith('ICHI_TK_CROSS_BEAR'))).toBe(true);
  });
});

describe('Sequential options', () => {
  it('bar1TrueExtreme TDST uses only setup bar 1', () => {
    const closes = decline();
    const bars = barsFromCloses(closes);
    bars[10] = { ...bars[10], h: 20 }; // spike inside the setup
    const all = computeStudy(sequential, defaultsOf(sequential), bars);
    const one = computeStudy(sequential, resolveConfig(sequential, { tdstMode: 'bar1TrueExtreme' }), bars);
    expect(all.lines.tdst_res[16]).toBe(20);
    expect(one.lines.tdst_res[16]).toBe(14.5);
  });
});

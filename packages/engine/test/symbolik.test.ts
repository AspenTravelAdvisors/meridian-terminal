import { describe, expect, it } from 'vitest';
import { type Bar, combo, computeStudy, defaultsOf, differential, openPatterns, rangeProjection, rebo, resolveConfig, sequential, tdLines, tdMa1, tdMa2, tdPoints, trendFactor } from '../src';
import { barsFromCloses } from './helpers';

/**
 * Rules reconciled with Symbolik's DeMARK documentation (docs/VERIFY_LOG.md notes 4–5). Each fixture is small enough
 * to trace by hand; the comments give the arithmetic.
 */

const SEQ = defaultsOf(sequential);
const up = (xs: number[], k = 100) => xs.map((v) => v + k);

/** Closes 10→15 (bars 0–5), then a steady 0.5 decline: buy setup on bars 8–16, countdown 1…13 on bars 16–28. */
function decline(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i <= 5 ? 10 + i : 15 - 0.5 * (i - 5));
  return out;
}

const ids = (r: ReturnType<typeof computeStudy>, id: string) => r.signals.filter((s) => s.id === id).map((s) => s.i);

describe('Sequential — TDST cancellation uses the whole bar (true low above TDST resistance)', () => {
  // TDST resistance = 114.5. Bar 21 closes 115 but opens 107.5 (true low 107) → close-only test cancels, whole-bar does not.
  // Bar 22: true low = min(114.5, 115) = 114.5, not above. Bar 23: true low = min(115.5, 116) = 115.5 > 114.5 → cancel.
  const bars = barsFromCloses(up([...decline(21), 15, 16, 17]));

  it('default (trueExtreme) cancels on bar 23 only', () => {
    expect(ids(computeStudy(sequential, SEQ, bars), 'SEQ_BUY_CD_CANCEL')).toEqual([23]);
  });

  it('close test still available: cancels on bar 21', () => {
    expect(ids(computeStudy(sequential, resolveConfig(sequential, { tdstCancelTest: 'close' }), bars), 'SEQ_BUY_CD_CANCEL')).toEqual([21]);
  });

  it('Combo shares the same rule', () => {
    // Combo counts every bar of this decline from setup bar 1, so give it room to still be running on bar 21.
    const r = computeStudy(combo, resolveConfig(combo, { countdownLength: 30 }), bars);
    expect(ids(r, 'COMBO_BUY_CD_CANCEL')).toEqual([23]);
  });
});

describe('Setup perfection is strict', () => {
  // Setup bars 1–9 on bars 8–16: closes 13.5, 13, 12.5, 12, 11.5, 11, 10.5, 10.5, 10.6 (+100).
  // Lows: bar 6 = 110.5, bar 7 = 110, bar 8 = 110, bar 9 = 110 → bars 8/9 only TIE the low of bar 7 → not perfected.
  const bars = barsFromCloses(up([10, 11, 12, 13, 14, 15, 14.5, 14, 13.5, 13, 12.5, 12, 11.5, 11, 10.5, 10.5, 10.6]));
  const r = computeStudy(sequential, SEQ, bars);

  it('a tie with bars 6–7 does not perfect the 9', () => {
    expect(r.lines.setup[16]).toBe(-9);
    expect(ids(r, 'SEQ_BUY_SETUP_PERFECTED')).toEqual([]);
    expect(r.markers.find((m) => m.i === 16 && m.text === '9')?.style).toBe('hollow');
  });
});

describe('Recycling — 100%–200% size test and the 22-bar long setup', () => {
  it('the setup that started the countdown running to 22 does not recycle it', () => {
    // One unbroken decline: setup from bar 8 reaches 22 on bar 29 while a 30-bar countdown is still running.
    const bars = barsFromCloses(up(decline(40)));
    const r = computeStudy(sequential, resolveConfig(sequential, { countdownLength: 30 }), bars);
    expect(r.lines.setup[29]).toBe(-22);
    expect(ids(r, 'SEQ_BUY_CD_RECYCLE')).toEqual([]);
  });

  // Setup 1 (bars 8–16, 0.5 steps, size 5.5) starts the countdown. Bar 21 bounces to 9.5 (> C17 = 9) and ends it;
  // bar 22 (8 < C18 = 8.5) flips into setup 2, which falls 1.5 a bar (size 14.5 ≈ 2.6× → too big for the size
  // test). Its 22nd bar is bar 43; the countdown (5 on bars 16–20, then one per bar from 23) is 26 by then.
  const closes = [...decline(21), 9.5, 8];
  for (let k = 1; k <= 25; k++) closes.push(8 - 1.5 * k);
  const bars = barsFromCloses(up(closes, 200));

  it('a later setup reaching 22 recycles the countdown', () => {
    const r = computeStudy(sequential, resolveConfig(sequential, { countdownLength: 30 }), bars);
    expect(r.lines.setup[22]).toBe(-1);
    expect(r.lines.setup[43]).toBe(-22);
    expect(ids(r, 'SEQ_BUY_CD_RECYCLE')).toEqual([43]);
    expect(r.signals.find((s) => s.id === 'SEQ_BUY_CD_RECYCLE')?.label).toContain('22');
    expect(r.markers.some((m) => m.i === 43 && m.text === 'R')).toBe(true);
  });

  it('the long-setup trigger can be turned off or moved', () => {
    expect(ids(computeStudy(sequential, resolveConfig(sequential, { countdownLength: 30, recycleOnLongSetup: false }), bars), 'SEQ_BUY_CD_RECYCLE')).toEqual([]);
    expect(ids(computeStudy(sequential, resolveConfig(sequential, { countdownLength: 30, recycleSetupCount: 18 }), bars), 'SEQ_BUY_CD_RECYCLE')).toEqual([39]);
  });

  it('a factor of 3 lets setup 2 recycle by size at its 9 (bar 30)', () => {
    const r = computeStudy(sequential, resolveConfig(sequential, { countdownLength: 30, recycleFactor: 3 }), bars);
    expect(ids(r, 'SEQ_BUY_CD_RECYCLE')[0]).toBe(30);
  });
});

describe('Sequential — elective intersection postpones the countdown start', () => {
  // Steep setup on bars 8–16 (closes 113.5 → 101.5, 1.5 steps). Bar 8's high (114.5)… bar 9's high 103.5 never
  // reaches a setup low ≥ 3 bars earlier (bar 6's low 105.5 for bar 9). Bar 17 keeps falling (high 102 < 104).
  // Bar 18 bounces to 106 (high 106.5 ≥ 102.5, the low of setup bar 8 on bar 15) → countdown starts on bar 18.
  // Bar 20 (98 ≤ low of bar 18, 99.5) is the first countdown bar.
  const setup = [13.5, 12, 10.5, 9, 7.5, 6, 4.5, 3, 1.5];
  const bars = barsFromCloses(up([10, 11, 12, 13, 14, 15, 14.5, 14, ...setup, 0, 6, 0, -2]));

  it('off (default): countdown 1 on setup bar 9', () => {
    const r = computeStudy(sequential, SEQ, bars);
    expect(r.lines.setup[16]).toBe(-9);
    expect(r.lines.countdown[16]).toBe(-1);
  });

  it('on: no count until the intersecting bar, then counting resumes normally', () => {
    const r = computeStudy(sequential, resolveConfig(sequential, { requireIntersection: true }), bars);
    for (const i of [16, 17, 18, 19]) expect(r.lines.countdown[i] + 0).toBe(0);
    expect(r.lines.countdown[20]).toBe(-1);
  });

  it('setupBarsOnly: the bounce ends the setup, so the countdown never starts', () => {
    const r = computeStudy(sequential, resolveConfig(sequential, { requireIntersection: true, intersectionScope: 'setupBarsOnly' }), bars);
    expect(r.lines.countdown[20] + 0).toBe(0);
  });
});

describe('Sequential — elective 8-vs-5 deferral', () => {
  // Countdown 1–5 on bars 16–20 (CD5 close 107.5). A rally to 112.5 then a pullback counts 6 and 7 on bars 26–27.
  // Bars 28–31 qualify as countdown bars but their lows (109.5 … 108) stay above 107.5 → "+"; bar 32 (low 107.5) is 8.
  const bars = barsFromCloses(up([...decline(21), 9, 10.5, 12, 12.5, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5]));

  it('off (default): bar 28 is countdown 8', () => {
    expect(computeStudy(sequential, SEQ, bars).lines.countdown[28]).toBe(-8);
  });

  it('on: bars 28–31 show "+", bar 32 becomes 8', () => {
    const r = computeStudy(sequential, resolveConfig(sequential, { cd8Qualifier: true }), bars);
    expect(r.lines.countdown[27]).toBe(-7);
    for (const i of [28, 29, 30, 31]) {
      expect(r.lines.countdown[i]).toBe(-7);
      expect(r.markers.some((m) => m.i === i && m.text === '+')).toBe(true);
    }
    expect(r.lines.countdown[32]).toBe(-8);
  });
});

describe('12-bar reaction window', () => {
  it('keeps the 13 chip up for 12 bars after the 13', () => {
    // Buy 13 on bar 28; bar 40 is the 12th bar after it, bar 41 the 13th.
    const chip = (n: number) => {
      const r = computeStudy(sequential, SEQ, barsFromCloses(up(decline(n))));
      return r.status?.chips.some((c) => c.text.includes('13 ✓')) ?? false;
    };
    expect(chip(41)).toBe(true);
    expect(chip(42)).toBe(false);
  });
});

const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: Date.UTC(2024, 0, 1) + i * 86_400_000, o, h, l, c, v: 1000 });
const mk = (rows: [number, number, number, number][]) => rows.map(([o, h, l, c], i) => bar(i, o, h, l, c));

describe('Anti-Differential — down, down, up, down with the up bar trading below the bar before it', () => {
  const rows: [number, number, number, number][] = [
    [10, 10.5, 9.5, 10],
    [10, 10.2, 9, 9.2], // down
    [9.2, 9.4, 8.4, 8.5], // down
    [8.5, 9, 8.2, 8.8], // up close, low 8.2 < 8.4
    [8.8, 8.9, 8.3, 8.4], // down close → Anti-Differential buy
    [8.4, 9, 8.3, 8.6], // high 9 > 8.9 → follow-through
  ];

  it('fires on bar 4 and confirms on bar 5', () => {
    const r = computeStudy(differential, defaultsOf(differential), mk(rows));
    expect(ids(r, 'ANTIDIFF_UP')).toEqual([4]);
    expect(ids(r, 'ANTIDIFF_UP_CONFIRM')).toEqual([5]);
    expect(ids(r, 'ANTIDIFF_DOWN')).toEqual([]);
  });

  it('needs the up bar’s low below the prior low unless that check is off', () => {
    const flat = rows.map((r) => [...r] as [number, number, number, number]);
    flat[3][2] = 8.5; // up bar's low no longer below bar 2's 8.4
    expect(ids(computeStudy(differential, defaultsOf(differential), mk(flat)), 'ANTIDIFF_UP')).toEqual([]);
    expect(ids(computeStudy(differential, resolveConfig(differential, { antiUpBarLow: false }), mk(flat)), 'ANTIDIFF_UP')).toEqual([4]);
  });

  it('the sell side mirrors it', () => {
    const m = mk(rows.map(([o, h, l, c]) => [100 - o, 100 - l, 100 - h, 100 - c]));
    const r = computeStudy(differential, defaultsOf(differential), m);
    expect(ids(r, 'ANTIDIFF_DOWN')).toEqual([4]);
    expect(ids(r, 'ANTIDIFF_DOWN_CONFIRM')).toEqual([5]);
  });
});

describe('TD Open — opens beyond the prior range, then reverses to the prior close', () => {
  const at = (h: number) => mk([[10, 11, 9, 10.5], [8.5, h, 8.4, 10.2]]);
  it('buy needs the high to reach the prior close (10.5)', () => {
    expect(ids(computeStudy(openPatterns, defaultsOf(openPatterns), at(10.5)), 'TD_OPEN_BUY')).toEqual([1]);
    expect(ids(computeStudy(openPatterns, defaultsOf(openPatterns), at(10.4)), 'TD_OPEN_BUY')).toEqual([]);
  });
  it('the prior-low variant only needs a move back above the prior low (9)', () => {
    expect(ids(computeStudy(openPatterns, resolveConfig(openPatterns, { openRef: 'priorLow' }), at(10.4)), 'TD_OPEN_BUY')).toEqual([1]);
  });
});

describe('TD MA I — breakout confirmed by the next open and a move beyond it', () => {
  // 13 flat bars (H 10.5, L 9.5), then bar 13 gaps up (low 11 > 10.5) → MA I (lows) switches on.
  // Bar 14 closes 9.6, below the line (lows 9.5, 9.5, 9.5, 11, 9.5 → 9.8). Bar 15 opens 9.4 < 9.6 and trades to 9.0.
  const rows: [number, number, number, number][] = Array.from({ length: 13 }, () => [10, 10.5, 9.5, 10] as [number, number, number, number]);
  rows.push([12, 12.5, 11, 12], [11.5, 11.6, 9.5, 9.6], [9.4, 9.5, 9, 9.2]);

  it('fires TDMA1_DN_BREAKOUT on bar 15', () => {
    const r = computeStudy(tdMa1, defaultsOf(tdMa1), mk(rows));
    expect(ids(r, 'TDMA1_UP_ON')).toEqual([13]);
    expect(r.lines.ma_up[14]).toBeCloseTo(9.8, 12);
    expect(ids(r, 'TDMA1_DN_BREAKOUT')).toEqual([15]);
  });

  it('does not confirm when the next bar opens back above the breakout close', () => {
    const r = computeStudy(tdMa1, defaultsOf(tdMa1), mk([...rows.slice(0, 15), [9.7, 9.8, 9, 9.2]]));
    expect(ids(r, 'TDMA1_DN_BREAKOUT')).toEqual([]);
  });
});

describe('TD MA II — two moving averages on the price chart', () => {
  const closes = [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => 139 - 3 * i)];
  const bars = barsFromCloses(closes);
  const r = computeStudy(tdMa2, defaultsOf(tdMa2), bars);

  it('plots the short and long simple averages of the close', () => {
    expect(tdMa2.overlay).toBe(true);
    expect(r.lines.ma_fast[39]).toBeCloseTo((137 + 138 + 139) / 3, 10);
    let s = 0;
    for (let k = 6; k <= 39; k++) s += closes[k];
    expect(r.lines.ma_slow[39]).toBeCloseTo(s / 34, 10);
  });

  it('flags the short crossing below the long, and the offset scales both lines', () => {
    expect(ids(r, 'TDMA2_BEAR').length).toBe(1);
    const off = computeStudy(tdMa2, resolveConfig(tdMa2, { offsetPct: 10 }), bars);
    expect(off.lines.ma_fast[39]).toBeCloseTo(1.1 * r.lines.ma_fast[39], 10);
  });
});

describe('Range Projection — true high/low, and the buffer for opens outside the projection', () => {
  // Bar 1 gaps up (prior close 10): O 12, H 13, L 11.5, C 12.5 → C > O, true high 13, true low 10.
  // X = 2·13 + 10 + 12.5 = 48.5 → projected high 24.25 − 10 = 14.25, low 24.25 − 13 = 11.25 (plain H/L: 13.5 / 12).
  // Bar 2 opens 15, above the projection → buffer O ± 0.15 × TR(3) = 15.45 / 14.55; its high 15.5 exceeds 15.45.
  const bars = mk([
    [10, 10, 10, 10],
    [12, 13, 11.5, 12.5],
    [15, 15.5, 14.8, 15.2],
  ]);

  it('projects from the true high and true low', () => {
    const r = computeStudy(rangeProjection, defaultsOf(rangeProjection), bars);
    expect(r.lines.rp_high[2]).toBeCloseTo(14.25, 12);
    expect(r.lines.rp_low[2]).toBeCloseTo(11.25, 12);
    const plain = computeStudy(rangeProjection, resolveConfig(rangeProjection, { rpPrices: 'plain' }), bars);
    expect(plain.lines.rp_high[2]).toBeCloseTo(13.5, 12);
    expect(plain.lines.rp_low[2]).toBeCloseTo(12, 12);
  });

  it('uses the buffer around an outside open and flags when it is exceeded', () => {
    const r = computeStudy(rangeProjection, defaultsOf(rangeProjection), bars);
    expect(r.lines.up_tol[2]).toBeCloseTo(15.45, 12);
    // (bar 1 also opens above bar 0's flat projection at 10 and clears its zero-width buffer)
    expect(ids(r, 'RP_BUFFER_UP')).toEqual([1, 2]);
    const wide = computeStudy(rangeProjection, resolveConfig(rangeProjection, { bufferK: 0.2 }), bars);
    expect(wide.lines.up_tol[2]).toBeCloseTo(15.6, 12);
    expect(ids(wide, 'RP_BUFFER_UP')).toEqual([1]);
  });
});

describe('REBO — 23.6% / 61.8% levels from a chosen base and range', () => {
  // TR(bar 1) = max(12, 10) − min(9.5, 10) = 2.5; TR(bar 0) = 2. Bar 2 opens 11.6 (prior close 11.5).
  const bars = mk([
    [10, 11, 9, 10],
    [10, 12, 9.5, 11.5],
    [11.6, 12, 11.2, 11.8],
  ]);
  it('defaults: open + 0.236 / 0.618 × prior true range', () => {
    const r = computeStudy(rebo, defaultsOf(rebo), bars);
    expect(r.lines.u1[2]).toBeCloseTo(11.6 + 0.236 * 2.5, 12);
    expect(r.lines.u2[2]).toBeCloseTo(11.6 + 0.618 * 2.5, 12);
  });
  it('prior-close base and a two-bar average range', () => {
    const r = computeStudy(rebo, resolveConfig(rebo, { base: 'priorClose', avgBars: 2 }), bars);
    expect(r.lines.d1[2]).toBeCloseTo(11.5 - 0.236 * 2.25, 12);
  });
});

describe('Trend Factor — auto pivot after a 5.56% swing', () => {
  // Closes 100 → 110 (bars 0–10), then bar 11 makes a higher high (111) but closes down (109.5) → reference = its
  // close. The swing became a rally at bar 5 (high 105.5 ≥ 99.5 × 1.0556). Then a slide: bar 16 (close 104.5,
  // low 104 ≤ 111 × 0.9444 = 104.83) turns it into a decline from a reference low (low 104, closed down); bar 17
  // extends the trough to 103.
  const closes = [...Array.from({ length: 11 }, (_, i) => 100 + i), 109.5, 108.5, 107.5, 106.5, 105.5, 104.5, 103.5];
  const bars = barsFromCloses(closes);
  bars[11] = { ...bars[11], h: 111 };
  const r = computeStudy(trendFactor, defaultsOf(trendFactor), bars);

  it('no pivot before the first one-step move, then the running peak', () => {
    expect(r.lines.pivot[4]).toBeNaN();
    expect(r.lines.pivot[5]).toBeCloseTo(105.5, 12);
    expect(r.lines.pivot[10]).toBeCloseTo(110.5, 12);
  });
  it('a peak bar that closes down uses its close', () => {
    expect(r.lines.pivot[11]).toBeCloseTo(109.5, 12);
    expect(r.lines.dn1[11]).toBeCloseTo(109.5 * (1 - 0.0556), 12);
  });
  it('a 5.56% decline from the peak switches to the trough', () => {
    expect(r.lines.pivot[15]).toBeCloseTo(109.5, 12);
    expect(r.lines.pivot[16]).toBeCloseTo(104, 12);
    expect(r.lines.pivot[17]).toBeCloseTo(103, 12);
  });
});

it('Points and Lines accept levels up to 21', () => {
  expect(resolveConfig(tdPoints, { level: 21 }).level).toBe(21);
  expect(resolveConfig(tdLines, { level: 21 }).level).toBe(21);
});

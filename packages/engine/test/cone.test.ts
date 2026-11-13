import { describe, expect, it } from 'vitest';
import { type Bar, type Fan, CONE_BINS, CONE_BIN_WIDTH, computeStudy, coneKeys, conePhase, defaultsOf, forwardCone, histQuantiles, resolveConfig } from '../src';
import { barsFromCloses, randomWalk } from './helpers';

const cfgOf = (over: Record<string, unknown> = {}) => resolveConfig(forwardCone, over);
const run = (bars: Bar[], over: Record<string, unknown> = {}) => computeStudy(forwardCone, cfgOf(over), bars);
const values = (bars: Bar[], over: Record<string, unknown> = {}) => run(bars, over).status!.values as Record<string, number | string | null>;

/**
 * Closes alternate 100, 102, 100, 102, … (even bars low, odd bars high), pad 0.5. Hand-traceable:
 *  - every log return is ±a with a = ln 1.02, so the volatility estimate is exactly a on every bar;
 *  - over an odd number of bars a low bar always ends a higher, a high bar always ends a lower; over an even number, flat;
 *  - no close is below the close four bars earlier, so no Sequential count ever starts (phase "no count");
 *  - every high is 102.5 and every low 99.5, so DeMarker I has no movement to measure (neutral) and the Ichimoku cloud,
 *    once it exists, is the flat line 101: high bars close above it, low bars below it.
 * The only thing separating the two kinds of bar is therefore the cloud position, which is part of the match.
 */
const A = Math.log(1.02);
const alternating = (n: number) => barsFromCloses(Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 100 : 102)));

describe('histQuantiles — quantiles of a fixed-width histogram', () => {
  const row = (fill: Record<number, number>) => {
    const h = new Uint32Array(CONE_BINS);
    for (const [b, n] of Object.entries(fill)) h[+b] = n;
    return h;
  };
  // bin b covers [−4 + b·w, −4 + (b + 1)·w)
  const edge = (b: number) => -4 + b * CONE_BIN_WIDTH;

  it('returns 0 and NaN for an empty row', () => {
    const out = [0, 0];
    expect(histQuantiles(row({}), 0, [0.1, 0.9], out)).toBe(0);
    expect(out.every(Number.isNaN)).toBe(true);
  });

  it('interpolates linearly inside the bin that holds the quantile', () => {
    // 10 values, all in bin 80 ([0, 0.05)): the p-quantile sits p of the way through the bin
    const out = [0, 0, 0];
    expect(histQuantiles(row({ 80: 10 }), 0, [0.1, 0.5, 0.9], out)).toBe(10);
    expect(out[0]).toBeCloseTo(edge(80) + 0.1 * CONE_BIN_WIDTH, 12);
    expect(out[1]).toBeCloseTo(edge(80) + 0.5 * CONE_BIN_WIDTH, 12);
    expect(out[2]).toBeCloseTo(edge(80) + 0.9 * CONE_BIN_WIDTH, 12);
  });

  it('walks the cumulative counts across bins', () => {
    // 2 values in bin 10, 6 in bin 20, 2 in bin 30 (10 in all): targets 1, 5 and 9
    const out = [0, 0, 0];
    histQuantiles(row({ 10: 2, 20: 6, 30: 2 }), 0, [0.1, 0.5, 0.9], out);
    expect(out[0]).toBeCloseTo(edge(10) + (1 / 2) * CONE_BIN_WIDTH, 12); // 1st of 2 in bin 10
    expect(out[1]).toBeCloseTo(edge(20) + (3 / 6) * CONE_BIN_WIDTH, 12); // 5 − 2 = 3rd of 6 in bin 20
    expect(out[2]).toBeCloseTo(edge(30) + (1 / 2) * CONE_BIN_WIDTH, 12); // 9 − 8 = 1st of 2 in bin 30
  });

  it('reads the row at the given offset', () => {
    const h = new Uint32Array(3 * CONE_BINS);
    h[2 * CONE_BINS + 100] = 4;
    const out = [0];
    expect(histQuantiles(h, 2 * CONE_BINS, [0.5], out)).toBe(4);
    expect(out[0]).toBeCloseTo(edge(100) + 0.5 * CONE_BIN_WIDTH, 12);
  });
});

describe('conePhase / coneKeys — the state a bar is matched on', () => {
  it('no count on either side is phase 0', () => expect(conePhase(0, 0)).toBe(0));
  it('the side further along wins: buy ranks 1–5 map to 1–5, sell ranks to 6–10', () => {
    expect([1, 2, 3, 4, 5].map((r) => conePhase(r, 0))).toEqual([1, 2, 3, 4, 5]);
    expect([1, 2, 3, 4, 5].map((r) => conePhase(0, r))).toEqual([6, 7, 8, 9, 10]);
    expect(conePhase(4, 2)).toBe(4);
    expect(conePhase(1, 3)).toBe(8);
  });
  it('equal non-zero ranks are the mixed phase 11', () => expect(conePhase(3, 3)).toBe(11));

  it('builds four keys from fine to coarse, each in its own range', () => {
    // phase 4, trend 2 (above the cloud), momentum 0 (oversold)
    expect(coneKeys(4, 2, 0)).toEqual([4 * 9 + 2 * 3 + 0, 108 + 4 * 3 + 2, 144 + 4, 156]);
    expect(coneKeys(0, 0, 0)).toEqual([0, 108, 144, 156]);
    expect(coneKeys(11, 2, 2)).toEqual([107, 143, 155, 156]);
  });
});

describe('Forward Cone — warm-up', () => {
  it('writes nothing until volatility is measured and enough outcomes are known', () => {
    const r = run(alternating(200));
    // 21 returns for the volatility estimate, then 21 bars for the first outcome, then 30 outcomes: bar 21 + 21 + 29
    const first = r.lines.p_up.findIndex(Number.isFinite);
    expect(first).toBe(71);
    for (const id of ['med', 'lo80', 'hi80', 'cases', 'match', 'dir']) expect(Number.isNaN(r.lines[id][first - 1])).toBe(true);
    expect(r.lines.cases[first]).toBe(30);
  });

  it('draws no fan before the first forecast', () => {
    const r = run(alternating(60));
    expect(r.geometry.fans ?? []).toEqual([]);
    expect(r.status!.chips).toEqual([]);
  });
});

describe('Forward Cone — learns what the matched state reveals (alternating fixture)', () => {
  const N = 400; // last bar 399 is a high bar; bar 398 a low bar
  const bars = alternating(N);
  // shrink 0: the matched cases alone, so the hand-computed values are exact (blending is tested separately)
  const exact = { shrink: 0 };
  const r = run(bars, exact);

  it('high bars: no similar bar ever closed higher 21 bars on; low bars: all did', () => {
    expect(r.lines.p_up[399]).toBe(0);
    expect(r.lines.p_up[398]).toBe(100);
    expect(r.lines.dir[399]).toBe(-1);
    expect(r.lines.dir[398]).toBe(1);
  });

  it('matches on the finest state (level 0) once it has enough cases', () => {
    expect(r.lines.match[399]).toBe(0);
    expect(r.lines.cases[399]).toBeGreaterThanOrEqual(30);
  });

  it('the median forecast is the one move that always followed, to within one histogram bin', () => {
    const tol = CONE_BIN_WIDTH * Math.sqrt(21) * A * 100; // one bin of z, in % at 1σ = a
    expect(Math.abs(r.lines.med[398] - 2)).toBeLessThan(tol);
    expect(Math.abs(r.lines.med[399] - 100 * (100 / 102 - 1))).toBeLessThan(tol);
    // every case moved the same amount, so the whole 80% range sits inside that one bin
    expect(r.lines.hi80[398] - r.lines.lo80[398]).toBeLessThan(tol);
  });

  it('the status compares with all bars: half of them closed higher', () => {
    const v = values(bars, exact);
    expect(v.horizon).toBe(21);
    expect(v.pUp).toBe(0);
    expect(v.baseUp as number).toBeCloseTo(0.5, 1);
    expect(v.dir).toBe(-1);
    expect(v.level).toBe(0);
    expect(String(v.match)).toContain('above the cloud');
  });

  it('beats the all-bars baseline out of sample', () => {
    const v = values(bars, exact);
    expect(v.scored as number).toBeGreaterThan(100);
    expect(v.skill as number).toBeGreaterThan(0.5);
    expect(v.callHitRate).toBe(1);
  });

  it('counts only cases a full horizon apart as independent', () => {
    const v = values(bars, exact);
    // matched high bars with a known outcome: every second bar; non-overlapping ones are at least 21 bars apart, so
    // every 22nd bar (the next high bar after 21)
    expect(v.cases as number).toBeGreaterThan(100);
    expect(v.independent).toBe(Math.ceil((v.cases as number) / 11));
  });

  it('blends toward the all-bars range while independent cases are few (shrink > 0)', () => {
    const a = values(bars, exact);
    const b = values(bars, { shrink: 10 });
    const n = a.independent as number;
    expect(b.weight as number).toBeCloseTo(n / (n + 10), 12);
    expect(a.weight).toBe(1);
    // the all-bars range spans both outcomes (±2%), so the blended 80% range is wider than the matched one
    expect((b.hi80Pct as number) - (b.lo80Pct as number)).toBeGreaterThan((a.hi80Pct as number) - (a.lo80Pct as number) + 0.5);
    // the lean itself is a statement about the matched cases and does not change
    expect(b.pUp).toBe(a.pUp);
    expect(b.dir).toBe(a.dir);
  });

  it('fires one signal each time the lean changes', () => {
    const lean = r.signals.filter((s) => s.id === 'CONE_BULL' || s.id === 'CONE_BEAR');
    // from the first conditional forecast on, the lean flips every bar
    const from = lean[0].i;
    expect(lean.length).toBe(N - from);
    expect(lean.every((s) => (s.i % 2 === 0 ? s.id === 'CONE_BULL' : s.id === 'CONE_BEAR'))).toBe(true);
  });

  it('the fan starts at the last bar, is 21 steps long and its bands nest around the median', () => {
    const fan = (r.geometry.fans as Fan[])[0];
    expect(fan.i0).toBe(N - 1);
    expect(fan.p0).toBe(102);
    expect(fan.mid.length).toBe(21);
    expect(fan.bands.map((b) => b.level)).toEqual([0.8, 0.5]);
    for (let k = 0; k < 21; k++) {
      expect(fan.bands[0].lo[k]).toBeLessThanOrEqual(fan.bands[1].lo[k]);
      expect(fan.bands[1].lo[k]).toBeLessThanOrEqual(fan.mid[k]);
      expect(fan.mid[k]).toBeLessThanOrEqual(fan.bands[1].hi[k]);
      expect(fan.bands[1].hi[k]).toBeLessThanOrEqual(fan.bands[0].hi[k]);
    }
    // from a high bar: back at 100 after an odd number of bars, at 102 after an even number (within a bin)
    expect(fan.mid[0]).toBeGreaterThan(99.8);
    expect(fan.mid[0]).toBeLessThan(100.2);
    expect(fan.mid[1]).toBeGreaterThan(101.8);
    expect(fan.mid[1]).toBeLessThan(102.2);
    expect(fan.dir).toBe(-1);
  });

  it('trade levels come from the similar cases: target = median best excursion, stop = 80th-percentile worst', () => {
    // ending on low bar 398 (a bullish lean): every case next traded up to 102.5 and down to 99.5
    const v = values(bars.slice(0, 399), exact);
    expect(v.dir).toBe(1);
    expect(v.entry).toBe(100);
    expect(v.target as number).toBeCloseTo(102.5, 6);
    expect(v.stop as number).toBeCloseTo(99.5, 6);
    expect(v.stopSrc).toBe('cases');
    expect(v.rr as number).toBeCloseTo(2.5 / 0.5, 6);
    // the very next bar touches both; a bar that reaches both counts as stopped (the cautious reading)
    expect(v.hitStop).toBe(1);
    expect(v.hitTarget).toBe(0);
  });

  it('ghost candles are off by default and replay one similar case when on', () => {
    expect(r.geometry.ghosts ?? []).toEqual([]);
    const g = run(bars, { ...exact, showGhost: true }).geometry.ghosts!;
    expect(g.length).toBe(21);
    expect(g[0].i).toBe(N);
    expect(g[20].i).toBe(N + 20);
    // the case nearest the median path is any earlier high bar: it alternates down, up, down, …
    expect(g[0].c).toBeCloseTo(100, 6);
    expect(g[1].c).toBeCloseTo(102, 6);
    expect(g[0].h).toBeCloseTo(102.5, 6);
    expect(g[0].l).toBeCloseTo(99.5, 6);
  });
});

describe('Forward Cone — price leaving the range drawn at a signal', () => {
  it('signals a close below the 80% range; ordinary bars inside it stay quiet', () => {
    const bars = alternating(301); // bar 300 is a low bar with a bullish lean
    const quiet = run(bars);
    expect(quiet.signals.filter((s) => s.id.startsWith('CONE_BREAK'))).toEqual([]);
    const crash: Bar = { t: bars[300].t + 86_400_000, o: 100, h: 100.5, l: 79.5, c: 80, v: 1 };
    const r = run([...bars, crash]);
    const br = r.signals.filter((s) => s.id.startsWith('CONE_BREAK'));
    expect(br.map((s) => `${s.i}|${s.id}|${s.dir}`)).toEqual(['301|CONE_BREAK_DOWN|bear']);
  });
});

describe('Forward Cone — a lean needs evidence', () => {
  it('a random walk rarely leans, and no more often when the threshold is the only test', () => {
    const bars = randomWalk(4000, 7);
    const strict = run(bars).lines.dir;
    const loose = run(bars, { confidence: 0 }).lines.dir;
    const count = (a: Float64Array) => a.reduce((s, v) => s + (v === 1 || v === -1 ? 1 : 0), 0);
    expect(count(strict)).toBeLessThan(count(loose) / 2);
    expect(count(strict)).toBeLessThan(0.1 * bars.length);
  });
});

describe('Forward Cone — calibration on a random walk', () => {
  const bars = randomWalk(4000, 7);
  const r = run(bars);
  const v = r.status!.values as Record<string, number | string | null>;

  it('the 80% range held close to 80% of the time, the 50% range close to half', () => {
    expect(v.scored as number).toBeGreaterThan(3000);
    expect(v.cover80 as number).toBeGreaterThan(0.7);
    expect(v.cover80 as number).toBeLessThan(0.9);
    expect(v.cover50 as number).toBeGreaterThan(0.4);
    expect(v.cover50 as number).toBeLessThan(0.6);
  });

  it('is deterministic: the same bars give identical output', () => {
    const again = run(bars);
    expect(again.status).toEqual(r.status);
    expect(again.geometry).toEqual(r.geometry);
    for (const id of Object.keys(r.lines)) expect(Array.from(again.lines[id])).toEqual(Array.from(r.lines[id]));
  });

  it('the horizon is an input: 8 bars ahead draws 8 steps', () => {
    const fan = (run(bars, { horizon: 8 }).geometry.fans as Fan[])[0];
    expect(fan.mid.length).toBe(8);
    expect(forwardCone.presets).toMatchObject({ '8 bars': { horizon: 8 }, '13 bars': { horizon: 13 }, '21 bars': { horizon: 21 }, '34 bars': { horizon: 34 } });
    expect(defaultsOf(forwardCone).horizon).toBe(21);
  });

  it('a cut-off series forecasts exactly what the full run did on that bar', () => {
    const cut = 2500;
    const pre = run(bars.slice(0, cut));
    for (const id of Object.keys(pre.lines)) for (let i = 0; i < cut; i++) expect(Object.is(pre.lines[id][i], r.lines[id][i]) || (Number.isNaN(pre.lines[id][i]) && Number.isNaN(r.lines[id][i]))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { alignEvents, computeStudy, fundingRate, openInterest, resolveConfig, shortInterest, type Bar } from '../src';

const bars = (n: number, start = Date.UTC(2026, 0, 1)): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const t = start + i * 86_400_000;
    return { t, o: 100, h: 101, l: 99, c: 100 + i * 0.1, v: 1000 };
  });

describe('alignEvents', () => {
  it('carries the last known event forward without look-ahead', () => {
    const b = bars(5);
    const ev = [
      { t: b[1].t + 12 * 3600_000, v: 1 }, // midday of bar 1 → visible from bar 1 close onward
      { t: b[3].t + 12 * 3600_000, v: 2 },
    ];
    const a = alignEvents(b, 86_400_000, ev);
    expect([...a]).toEqual([NaN, 1, 1, 2, 2].map((x) => (Number.isNaN(x) ? NaN : x)));
    expect(Number.isNaN(a[0])).toBe(true);
    expect(a[1]).toBe(1);
    expect(a[2]).toBe(1);
    expect(a[3]).toBe(2);
  });
});

describe('funding-rate study', () => {
  it('plots aux funding and fires extreme signals', () => {
    const b = bars(10);
    const funding = Float64Array.from(b, (_, i) => (i === 5 ? 0.1 : i === 6 ? -0.1 : 0.01));
    const r = computeStudy(fundingRate, resolveConfig(fundingRate, { extremePct: 0.05 }), b, { aux: { funding } });
    expect(r.lines.funding[5]).toBe(0.1);
    expect(r.signals.some((s) => s.id === 'FUNDING_LONG_CROWDED' && s.i === 5)).toBe(true);
    expect(r.signals.some((s) => s.id === 'FUNDING_SHORT_CROWDED' && s.i === 6)).toBe(true);
  });

  it('stays empty without aux (no look-ahead / no fabrication)', () => {
    const r = computeStudy(fundingRate, resolveConfig(fundingRate, {}), bars(20));
    expect(r.lines.funding.every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe('open-interest study', () => {
  it('reports surges from the aux series', () => {
    const b = bars(6);
    const openInterestAux = Float64Array.from([1e9, 1e9, 1e9, 1.1e9, 1.2e9, 1.2e9]);
    const r = computeStudy(openInterest, resolveConfig(openInterest, { mode: 'changePct', changeLength: 1 }), b, {
      aux: { openInterest: openInterestAux },
    });
    expect(r.signals.some((s) => s.id === 'OI_SURGE')).toBe(true);
  });
});

describe('short-interest study', () => {
  it('plots days to cover and % change when shares step', () => {
    const b = bars(8);
    const shortInterestAux = Float64Array.from(b, (_, i) => (i < 4 ? 100 : 130));
    const daysToCover = Float64Array.from(b, (_, i) => (i < 4 ? 2 : 3));
    const r = computeStudy(shortInterest, resolveConfig(shortInterest, {}), b, {
      aux: { shortInterest: shortInterestAux, daysToCover },
    });
    expect(r.lines.dtc[0]).toBe(2);
    expect(r.lines.dtc[4]).toBe(3);
    expect(r.signals.some((s) => s.id === 'SHORT_INTEREST_RISE' && s.i === 4)).toBe(true);
  });
});

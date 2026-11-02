import { describe, expect, it } from 'vitest';
import { type OptionsOverlaySpec, bsGreeks, bsPrice, monthlyExpiry, optionsOverlay, realizedVol, strikeForDelta, yearFrac } from '../src';

const D = 86_400_000;
const t0 = Date.UTC(2026, 0, 5); // a Monday
type B = { t: number; o: number; h: number; l: number; c: number };
const path = (closes: number[]): B[] => closes.map((c, i) => ({ t: t0 + i * D, o: c, h: c, l: c, c }));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const spec = (over: Partial<OptionsOverlaySpec> = {}): OptionsOverlaySpec => ({
  dte: 30,
  expiryRule: 'exact',
  strikeBy: 'moneyness',
  moneynessPct: 0,
  delta: 0.5,
  strikeStep: 1,
  sizing: { mode: 'contracts', value: 2 },
  spreadPct: 4,
  minSpread: 0.05,
  feePerContract: 0.65,
  vol: { mode: 'fixed', iv: 0.3 },
  earnings: { dates: [], preBumpPts: 0, preDays: 0 },
  rate: 0.04,
  divYield: 0,
  closeAtDte: 0,
  ...over,
});

describe('option contract selection', () => {
  it('picks the monthly expiration (third Friday) at or after the target date', () => {
    expect(monthlyExpiry('2026-11-01', 45)).toBe('2026-12-18');
    expect(monthlyExpiry('2026-11-01', 10)).toBe('2026-11-20');
    expect(monthlyExpiry('2026-11-20', 0)).toBe('2026-11-20');
    expect(monthlyExpiry('2026-11-21', 0)).toBe('2026-12-18');
  });

  it('solves the strike for a target delta, rounded to the strike step', () => {
    const K = strikeForDelta('call', 250, 0.4, 47 / 365, 0.04, 0, 0.45, 2.5);
    expect(K % 2.5).toBe(0);
    expect(K).toBeGreaterThan(250);
    expect(Math.abs(bsGreeks('call', 250, K, 47 / 365, 0.04, 0, 0.45).delta - 0.4)).toBeLessThan(0.03);
    const P = strikeForDelta('put', 250, 0.3, 47 / 365, 0.04, 0, 0.45, 1);
    expect(P).toBeLessThan(250);
    expect(Math.abs(Math.abs(bsGreeks('put', 250, P, 47 / 365, 0.04, 0, 0.45).delta) - 0.3)).toBeLessThan(0.02);
  });

  it('measures realized volatility from past bars only', () => {
    const b = path(Array.from({ length: 80 }, (_, i) => 100 * Math.exp(0.01 * Math.sin(i))));
    const a = realizedVol(b, 50, 20);
    const later = b.map((x, i) => (i > 50 ? { ...x, c: x.c * 2 } : x));
    expect(realizedVol(later, 50, 20)).toBe(a);
    expect(realizedVol(b, 5, 20)).toBeNaN();
  });
});

describe('theoretical options overlay', () => {
  // stock trade: long at bar 1 (100) → exit at bar 11 (110)
  const b = path([100, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
  const trade = { entryI: 1, exitI: 11, dir: 1 as const, entry: 100, exit: 110 };

  it('buys at the ask and sells at the bid, with fees, by hand', () => {
    const r = optionsOverlay(b, [trade], spec());
    const o = r.trades[0];
    const expiry = iso(t0 + 1 * D + 30 * D);
    expect(o).toMatchObject({ type: 'call', strike: 100, expiry, contracts: 2, exitReason: 'signal' });
    const mid0 = bsPrice('call', 100, 100, yearFrac(iso(b[1].t), expiry), 0.04, 0, 0.3);
    const ask = mid0 + Math.max(0.025, (mid0 * 0.04) / 2);
    expect(o.entryAsk).toBeCloseTo(ask, 10);
    const mid1 = bsPrice('call', 110, 100, yearFrac(iso(b[11].t), expiry), 0.04, 0, 0.3);
    const bid = mid1 - Math.max(0.025, (mid1 * 0.04) / 2);
    expect(o.exitBid).toBeCloseTo(bid, 10);
    expect(o.pnl).toBeCloseTo((bid - ask) * 200 - 4 * 0.65, 8);
    expect(o.returnPct).toBeCloseTo((100 * o.pnl) / (ask * 200 + 2 * 0.65), 8);
    expect(o.stockReturnPct).toBeCloseTo(10, 10);
    expect(r.label).toMatch(/theoretical/i);
  });

  it('puts for short signals and settles at intrinsic value at expiry', () => {
    const down = path([100, 100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89]);
    const r = optionsOverlay(down, [{ entryI: 1, exitI: 12, dir: -1, entry: 100, exit: 89 }], spec({ dte: 5 }));
    const o = r.trades[0];
    expect(o.type).toBe('put');
    expect(o.exitReason).toBe('expiry');
    // expiry 5 days after bar 1 = bar 6's date, close 95: intrinsic 5, no spread on settlement
    expect(o.exitDate).toBe(iso(down[6].t));
    expect(o.exitBid).toBeCloseTo(5, 10);
  });

  it('sizes by premium budget and skips trades it cannot afford', () => {
    const r = optionsOverlay(b, [trade], spec({ sizing: { mode: 'premium', value: 1000 } }));
    const o = r.trades[0];
    expect(o.contracts).toBe(Math.floor(1000 / (o.entryAsk * 100)));
    const none = optionsOverlay(b, [trade], spec({ sizing: { mode: 'premium', value: 10 } }));
    expect(none.trades).toHaveLength(0);
    expect(none.skipped).toBe(1);
  });

  it('adds an event premium before earnings and removes it after', () => {
    const base = optionsOverlay(b, [trade], spec());
    const e = iso(b[4].t);
    const r = optionsOverlay(b, [trade], spec({ earnings: { dates: [e], preBumpPts: 20, preDays: 5 } }));
    expect(r.trades[0].entryIv).toBeCloseTo(0.5, 12); // within 5 days before the report: 30% + 20 pts
    expect(r.trades[0].exitIv).toBeCloseTo(0.3, 12); // after it
    expect(r.trades[0].entryAsk).toBeGreaterThan(base.trades[0].entryAsk);
    expect(r.trades[0].earningsInTrade).toBe(true);
  });

  it('can close early at a minimum days-to-expiry', () => {
    const r = optionsOverlay(b, [trade], spec({ dte: 14, closeAtDte: 7 }));
    expect(r.trades[0].exitReason).toBe('dte');
    expect(r.trades[0].exitDate).toBe(iso(b[8].t)); // 14 − 7 days after entry at bar 1
  });

  it('summarizes option results separately from the stock trades', () => {
    const r = optionsOverlay(b, [trade, { entryI: 2, exitI: 4, dir: 1, entry: 101, exit: 103 }], spec());
    expect(r.stats.trades).toBe(2);
    expect(r.stats.premiumSpent).toBeCloseTo(r.trades.reduce((a, t) => a + t.entryAsk * 100 * t.contracts + t.contracts * 0.65, 0), 8);
    expect(r.stats.totalPnl).toBeCloseTo(r.trades.reduce((a, t) => a + t.pnl, 0), 8);
    expect(r.stats.winRate).toBe(r.trades.filter((t) => t.pnl > 0).length / 2);
    expect(r.stats.stockWinRate).toBe(1);
    expect(optionsOverlay(b, [trade], spec())).toEqual(optionsOverlay(b, [trade], spec()));
  });
});

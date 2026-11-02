import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type OptionPosition, bsGreeks, bsPrice, evaluatePlan, impliedVol, ivOn, priceGrid, scenarioDates, yearFrac } from '../src';

describe('Black-Scholes pricing', () => {
  // textbook case: S 42, K 40, r 10%, vol 20%, six months
  it('prices the classic call/put fixture', () => {
    expect(bsPrice('call', 42, 40, 0.5, 0.1, 0, 0.2)).toBeCloseTo(4.7594, 4);
    expect(bsPrice('put', 42, 40, 0.5, 0.1, 0, 0.2)).toBeCloseTo(0.8086, 4);
  });

  it('collapses to intrinsic value at expiry or zero volatility', () => {
    expect(bsPrice('call', 260, 250, 0, 0.04, 0, 0.5)).toBe(10);
    expect(bsPrice('call', 240, 250, 0, 0.04, 0, 0.5)).toBe(0);
    expect(bsPrice('put', 240, 250, 0, 0.04, 0, 0.5)).toBe(10);
    // zero vol: discounted forward intrinsic
    expect(bsPrice('call', 260, 250, 1, 0, 0, 0)).toBeCloseTo(10, 10);
  });

  it('satisfies put-call parity', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 5, max: 500, noNaN: true }),
        fc.double({ min: 5, max: 500, noNaN: true }),
        fc.double({ min: 0.01, max: 3, noNaN: true }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        fc.double({ min: 0.05, max: 1.5, noNaN: true }),
        (S, K, T, r, q, v) => {
          const lhs = bsPrice('call', S, K, T, r, q, v) - bsPrice('put', S, K, T, r, q, v);
          const rhs = S * Math.exp(-q * T) - K * Math.exp(-r * T);
          return Math.abs(lhs - rhs) < 1e-8 * Math.max(1, S, K);
        },
      ),
    );
  });

  it('greeks match finite differences', () => {
    const [S, K, T, r, q, v] = [250, 250, 47 / 365, 0.04, 0, 0.45];
    const g = bsGreeks('call', S, K, T, r, q, v);
    const h = 0.01;
    expect(g.delta).toBeCloseTo((bsPrice('call', S + h, K, T, r, q, v) - bsPrice('call', S - h, K, T, r, q, v)) / (2 * h), 5);
    expect(g.vega).toBeCloseTo((bsPrice('call', S, K, T, r, q, v + 0.005) - bsPrice('call', S, K, T, r, q, v - 0.005)) / 1, 4);
    expect(g.theta).toBeCloseTo(bsPrice('call', S, K, T - 1 / 365, r, q, v) - bsPrice('call', S, K, T, r, q, v), 3);
  });

  it('recovers implied volatility from a price', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.08, max: 1.5, noNaN: true }), fc.double({ min: 0.8, max: 1.2, noNaN: true }), (v, m) => {
        const S = 250;
        const K = 250 * m;
        const p = bsPrice('call', S, K, 0.25, 0.04, 0, v);
        if (p - Math.max(0, S - K * Math.exp(-0.04 * 0.25)) < 0.01) return true; // too little time value to pin the vol
        return Math.abs(impliedVol(p, 'call', S, K, 0.25, 0.04, 0) - v) < 1e-5;
      }),
    );
    expect(impliedVol(0.5, 'call', 260, 250, 0.1, 0, 0)).toBeNaN(); // below intrinsic
  });
});

describe('calendar helpers', () => {
  it('counts calendar days to expiry over 365', () => {
    expect(yearFrac('2026-11-01', '2026-12-18')).toBeCloseTo(47 / 365, 12);
    expect(yearFrac('2026-12-18', '2026-12-18')).toBe(0);
    expect(yearFrac('2026-12-20', '2026-12-18')).toBe(0);
  });

  it('switches to post-earnings volatility on the earnings date', () => {
    const m = { rate: 0.04, divYield: 0, ivBefore: 0.55, ivAfter: 0.35, earningsDate: '2026-11-20' };
    expect(ivOn(m, '2026-11-19')).toBe(0.55);
    expect(ivOn(m, '2026-11-20')).toBe(0.35);
    expect(ivOn({ ...m, earningsDate: undefined }, '2026-12-01')).toBe(0.55);
  });

  it('builds a date axis around earnings and expiry', () => {
    const d = scenarioDates('2026-11-01', '2026-12-18', '2026-11-20');
    expect(d[0]).toBe('2026-11-01');
    expect(d).toContain('2026-11-19');
    expect(d).toContain('2026-11-20');
    expect(d[d.length - 1]).toBe('2026-12-18');
    expect([...d].sort()).toEqual(d);
    expect(new Set(d).size).toBe(d.length);
  });

  it('builds a price axis that includes the requested levels', () => {
    const g = priceGrid(250, 20, 9, [262.5]);
    expect(g[0]).toBeCloseTo(300, 6);
    expect(g[g.length - 1]).toBeCloseTo(200, 6);
    expect(g).toContain(262.5);
    expect(g).toContain(250);
  });
});

describe('position scenarios', () => {
  // three Dec 18 250 calls bought at 3.15, $0.65/contract each way, $0.05 half-spread
  const pos: OptionPosition = { contract: { type: 'call', strike: 250, expiry: '2026-12-18' }, quantity: 3, entryPrice: 3.15, entryFeePerContract: 0.65 };
  const exec = { halfSpread: 0.05, feePerContract: 0.65 };
  const market = { rate: 0.04, divYield: 0, ivBefore: 0.5, ivAfter: 0.35, earningsDate: '2026-11-20' };
  const at = (plan: Parameters<typeof evaluatePlan>[1], S: number, date = '2026-12-18') => evaluatePlan(pos, plan, exec, market, S, date, 5000);

  it('holds to expiry: hand-computed P/L', () => {
    // sell 3 at 10 − 0.05 = 9.95: 2985 − 1.95 fees; cost 945 + 1.95
    const r = at({ kind: 'hold' }, 260);
    expect(r.pnl).toBeCloseTo(2036.1, 6);
    expect(r.capital).toBeCloseTo(7036.1, 6);
    expect(r.openContracts).toBe(3);
  });

  it('expires worthless without a closing fee', () => {
    const r = at({ kind: 'hold' }, 240);
    expect(r.pnl).toBeCloseTo(-946.95, 6);
    expect(r.openValue).toBe(0);
  });

  it('sells two at a limit when the bid reaches it', () => {
    // 2 × 630 − 1.30 = 1258.70; 1 × 995 − 0.65 = 994.35; minus 946.95
    const r = at({ kind: 'sellAtLimit', quantity: 2, limit: 6.3 }, 260);
    expect(r.filled).toBe(true);
    expect(r.pnl).toBeCloseTo(1306.1, 6);
    expect(r.cash).toBeCloseTo(5000 - 946.95 + 1258.7, 6);
    expect(r.openContracts).toBe(1);
    const miss = at({ kind: 'sellAtLimit', quantity: 2, limit: 6.3 }, 240);
    expect(miss.filled).toBe(false);
    expect(miss.pnl).toBeCloseTo(-946.95, 6);
  });

  it('closes everything now at a fixed price, whatever the scenario', () => {
    // 3 × 400 − 1.95 − 946.95
    expect(at({ kind: 'closeNow', price: 4 }, 260).pnl).toBeCloseTo(251.1, 6);
    expect(at({ kind: 'closeNow', price: 4 }, 200, '2026-11-05').pnl).toBeCloseTo(251.1, 6);
  });

  it('values open contracts with the model before expiry, crushing vol after earnings', () => {
    const before = at({ kind: 'hold' }, 250, '2026-11-19');
    const after = at({ kind: 'hold' }, 250, '2026-11-20');
    const mid = bsPrice('call', 250, 250, yearFrac('2026-11-19', '2026-12-18'), 0.04, 0, 0.5);
    expect(before.mark).toBeCloseTo(mid, 10);
    expect(after.mark).toBeLessThan(before.mark);
  });

  it('is deterministic', () => {
    expect(at({ kind: 'sellAtLimit', quantity: 2, limit: 6.3 }, 255, '2026-11-25')).toEqual(at({ kind: 'sellAtLimit', quantity: 2, limit: 6.3 }, 255, '2026-11-25'));
  });
});

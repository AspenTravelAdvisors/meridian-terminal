import { describe, expect, it } from 'vitest';
import {
  type Account,
  type Transaction,
  buildLedger,
  classifyAction,
  detectPreset,
  equityCurve,
  historicalVaR,
  holdingTerm,
  importRows,
  maxDrawdown,
  moneyWeightedReturn,
  positionSize,
  riskStats,
  valuePositions,
  xirr,
} from '../src';

const acct = (lotMethod: Account['lotMethod'] = 'FIFO'): Account[] => [{ id: 'a', name: 'Main', currency: 'USD', lotMethod }];
const tx = (p: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>, k = Math.random()): Transaction => ({ id: `t${k}`, accountId: 'a', ...p });

const trades = [
  tx({ date: '2023-01-10', type: 'buy', symbol: 'XYZ', qty: 10, price: 100 }, 1),
  tx({ date: '2023-06-10', type: 'buy', symbol: 'XYZ', qty: 10, price: 150 }, 2),
  tx({ date: '2024-03-01', type: 'sell', symbol: 'XYZ', qty: 12, price: 200, fee: 12 }, 3),
];

describe('tax lots', () => {
  it('FIFO consumes the oldest lot first and splits terms', () => {
    const l = buildLedger(acct('FIFO'), trades);
    expect(l.realized.map((r) => [r.lotId, r.qty, r.term])).toEqual([
      ['t1', 10, 'long'],
      ['t2', 2, 'short'],
    ]);
    // proceeds net of the 12 fee allocated pro-rata (10/12 and 2/12)
    expect(l.realized[0].gain).toBeCloseTo(10 * 200 - 10 - 1000, 9);
    expect(l.positions[0]).toMatchObject({ symbol: 'XYZ', qty: 8, avgCost: 150 });
  });
  it('LIFO and HIFO pick the newest / most expensive lot', () => {
    expect(buildLedger(acct('LIFO'), trades).realized[0].lotId).toBe('t2');
    expect(buildLedger(acct('HIFO'), trades).realized[0].lotId).toBe('t2');
  });
  it('specific-ID honours the chosen lot', () => {
    const t = [...trades.slice(0, 2), tx({ date: '2024-03-01', type: 'sell', symbol: 'XYZ', qty: 5, price: 200, lotId: 't2' }, 4)];
    expect(buildLedger(acct('SPECIFIC'), t).realized[0].lotId).toBe('t2');
  });
  it('splits rescale quantity and cost per share; long-term needs more than a year', () => {
    const l = buildLedger(acct(), [trades[0], tx({ date: '2023-02-01', type: 'split', symbol: 'XYZ', ratio: 4 }, 9)]);
    expect(l.positions[0]).toMatchObject({ qty: 40, avgCost: 25 });
    expect(holdingTerm('2023-01-10', '2024-01-10')).toBe('short');
    expect(holdingTerm('2023-01-10', '2024-01-11')).toBe('long');
  });
  it('values positions and weights', () => {
    const l = buildLedger(acct(), trades.slice(0, 2));
    const v = valuePositions(l, { XYZ: { last: 200, prevClose: 190 } });
    expect(v.rows[0]).toMatchObject({ value: 4000, unrealized: 1500, dayChange: 200 });
  });
});

describe('returns', () => {
  it('XIRR of −1000 then +1100 one year later is 10%', () => {
    expect(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1100 }])).toBeCloseTo(0.1, 6);
    expect(xirr([{ date: '2023-01-01', amount: 100 }])).toBeNaN();
  });
  it('TWR ignores the timing of deposits; MWR does not', () => {
    const t: Transaction[] = [
      tx({ date: '2024-01-01', type: 'cash_in', amount: 1000 }, 1),
      tx({ date: '2024-01-01', type: 'buy', symbol: 'A', qty: 10, price: 100 }, 2),
      tx({ date: '2024-01-03', type: 'cash_in', amount: 2200 }, 3),
      tx({ date: '2024-01-03', type: 'buy', symbol: 'A', qty: 20, price: 110 }, 4),
    ];
    const prices = { A: { '2024-01-01': 100, '2024-01-02': 105, '2024-01-03': 110, '2024-01-04': 99 } };
    const { points, mode } = equityCurve(t, prices, '2024-01-04');
    expect(mode).toBe('cash');
    // TWR = 100 → 99 on the security alone (−1%) regardless of the larger second deposit
    expect(points[points.length - 1].twr).toBeCloseTo(0.99, 9);
    expect(moneyWeightedReturn(points)).toBeLessThan(0);
  });
  it('drawdown, VaR and risk stats', () => {
    expect(maxDrawdown([100, 120, 90, 130]).mdd).toBeCloseTo(-0.25, 12);
    const r = Array.from({ length: 100 }, (_, k) => (k % 10 === 0 ? -0.05 : 0.01));
    expect(historicalVaR(r, 0.95)).toBeCloseTo(0.05, 12);
    const s = riskStats(r, { bench: r });
    expect(s.beta).toBeCloseTo(1, 12);
    expect(s.corr).toBeCloseTo(1, 12);
  });
});

describe('imports', () => {
  it('detects presets, classifies actions and dedupes on re-import', () => {
    const header = ['Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Fees & Comm', 'Amount'];
    expect(detectPreset(header)?.id).toBe('schwab');
    const rows = [
      ['03/01/2024 as of 02/29/2024', 'Buy', 'AAPL', 'APPLE INC', '10', '$180.00', '$0.65', '-$1,800.65'],
      ['03/05/2024', 'Qualified Dividend', 'AAPL', 'APPLE INC', '', '', '', '$2.40'],
      ['03/06/2024', 'MoneyLink Transfer', '', 'Tfr', '', '', '', '$5,000.00'],
      ['03/07/2024', 'Mystery', 'X', '', '', '', '', ''],
    ];
    const p = detectPreset(header)!;
    const first = importRows(header, rows, p.map, 'a');
    expect(first.transactions.map((t) => t.type)).toEqual(['buy', 'dividend', 'cash_in']);
    expect(first.transactions[0]).toMatchObject({ date: '2024-03-01', qty: 10, price: 180, fee: 0.65 });
    expect(first.skipped).toHaveLength(1);
    const again = importRows(header, rows, p.map, 'a', first.transactions);
    expect(again.transactions).toHaveLength(0);
    expect(again.duplicates).toBe(3);
    expect(classifyAction('YOU SOLD 10 SHARES', -10, 1000)).toBe('sell');
    expect(classifyAction('REINVESTMENT', 0.5, -20)).toBe('buy');
  });
});

describe('position sizing', () => {
  it('sizes by risk and caps by max position', () => {
    expect(positionSize({ equity: 100_000, riskPct: 1, entry: 50, stop: 48 })).toMatchObject({ shares: 500, dir: 'long', riskAmount: 1000 });
    expect(positionSize({ equity: 100_000, riskPct: 1, entry: 50, stop: 49.9, maxPositionPct: 10 })).toMatchObject({ shares: 200, capped: true });
  });
});

import { describe, expect, it } from 'vitest';
import {
  type Bar,
  ExpressionError,
  combineExpressionBars,
  expressionSymbols,
  fetchBars,
  fetchQuotes,
  isExpression,
  parseExpression,
  periodKey,
  printExpression,
  SYMBOL_RE,
} from '../src';

const bar = (t: number, o: number, h: number, l: number, c: number, v = 100, final?: false): Bar => ({ t, o, h, l, c, v, ...(final === false ? { final } : {}) });
const D = 86_400_000;
const day = (y: number, m: number, d: number, hourUtc = 14.5) => Date.UTC(y, m - 1, d) + hourUtc * 3_600_000;

describe('symbol expressions: parsing', () => {
  it('recognises ratios, products and spaced sums/differences, but not hyphenated tickers', () => {
    expect(isExpression('SPY/RSP')).toBe(true);
    expect(isExpression('ETHUSDT / BTCUSDT')).toBe(true);
    expect(isExpression('(XLY + XLK) / 2')).toBe(true);
    expect(isExpression('GLD*10')).toBe(true);
    expect(isExpression('SPY - RSP')).toBe(true);
    for (const plain of ['SPY', 'BRK-B', 'BTC-USD', '^GSPC', 'EURUSD=X', 'ES=F', 'BINANCE:BTCUSDT', '0700.HK', 'SIM:DEMO']) expect(isExpression(plain)).toBe(false);
  });

  it('canonicalises operands and spacing so equal expressions share one cache key', () => {
    expect(printExpression(parseExpression('spy/rsp'))).toBe('SPY/RSP');
    expect(printExpression(parseExpression(' ethusdt  /  btcusdt '))).toBe('BINANCE:ETHUSDT/BINANCE:BTCUSDT');
    expect(printExpression(parseExpression('(xly+xlk)/2'))).toBe('(XLY + XLK)/2');
    expect(printExpression(parseExpression('A - (B - C)'))).toBe('A - (B - C)');
    expect(printExpression(parseExpression('(A - B) - C'))).toBe('A - B - C');
    expect(printExpression(parseExpression('A/(B*C)'))).toBe('A/(B*C)');
    expect(printExpression(parseExpression('A*B/C'))).toBe('A*B/C');
    expect(printExpression(parseExpression('0700.HK/2800.HK'))).toBe('0700.HK/2800.HK');
  });

  it('applies * and / before + and -', () => {
    const n = parseExpression('A + B*2');
    expect(n).toMatchObject({ k: 'op', op: '+', b: { k: 'op', op: '*' } });
  });

  it('lists each symbol once, in order of first appearance', () => {
    expect(expressionSymbols(parseExpression('(SPY + QQQ)/SPY'))).toEqual(['SPY', 'QQQ']);
  });

  it('rejects malformed input with a readable message', () => {
    for (const bad of ['SPY/', '/RSP', 'SPY//RSP', '(SPY/RSP', 'SPY/RSP)', '2/4', 'A/B/C/D/E/F/G', 'SPY $ RSP', '()'])
      expect(() => parseExpression(bad), bad).toThrow(ExpressionError);
  });

  it('accepts expressions in the shared symbol validator', () => {
    expect(SYMBOL_RE.test('SPY/RSP')).toBe(true);
    expect(SYMBOL_RE.test('(XLY + XLK)/2')).toBe(true);
    expect(SYMBOL_RE.test('SPY;DROP')).toBe(false);
  });
});

describe('symbol expressions: combining bars', () => {
  it('divides open, high, low and close field by field and keeps high ≥ open/close ≥ low', () => {
    const a = [bar(day(2026, 11, 2), 10, 12, 9, 11), bar(day(2026, 11, 3), 11, 13, 10, 12)];
    const b = [bar(day(2026, 11, 2), 5, 4, 6, 5), bar(day(2026, 11, 3), 4, 4, 4, 4)];
    const out = combineExpressionBars(parseExpression('A/B'), { A: { bars: a, timezone: 'America/New_York' }, B: { bars: b, timezone: 'America/New_York' } }, '1D');
    // bar 0: o 2, h 12/4 = 3, l 9/6 = 1.5, c 2.2 → envelope keeps the extremes
    expect(out[0]).toEqual({ t: a[0].t, o: 2, h: 3, l: 1.5, c: 2.2, v: 0 });
    expect(out[1]).toEqual({ t: a[1].t, o: 2.75, h: 3.25, l: 2.5, c: 3, v: 0 });
    for (const x of out) expect(x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c)).toBe(true);
  });

  it('uses the first symbol’s bar times and carries the other symbol’s last close across its missing days', () => {
    // A trades every day (crypto); B skips the weekend (Sat 7, Sun 8 Nov 2026)
    const a = [6, 7, 8, 9].map((d) => bar(Date.UTC(2026, 10, d), 100, 110, 90, 100 + d));
    const b = [6, 9].map((d) => bar(day(2026, 11, d), 50, 55, 45, 50 + d));
    const out = combineExpressionBars(parseExpression('A/B'), { A: { bars: a, timezone: 'UTC' }, B: { bars: b, timezone: 'America/New_York' } }, '1D');
    expect(out.map((x) => x.t)).toEqual(a.map((x) => x.t));
    // weekend bars use B's Friday close for every field
    expect(out[1]).toMatchObject({ o: 100 / 56, c: 107 / 56 });
    expect(out[3]).toMatchObject({ o: 100 / 50, c: 109 / 59 });
  });

  it('drops leading bars until every symbol has history, and skips non-finite results', () => {
    const a = [1, 2, 3].map((d) => bar(day(2026, 6, d), 1, 1, 1, 1));
    const b = [bar(day(2026, 6, 2), 0, 0, 0, 0), bar(day(2026, 6, 3), 2, 2, 2, 2)];
    const out = combineExpressionBars(parseExpression('A/B'), { A: { bars: a, timezone: 'UTC' }, B: { bars: b, timezone: 'UTC' } }, '1D');
    expect(out.map((x) => x.t)).toEqual([a[2].t]);
  });

  it('marks a bar provisional when any symbol’s matching bar is still forming', () => {
    const a = [bar(day(2026, 6, 1), 1, 1, 1, 1), bar(day(2026, 6, 2), 1, 1, 1, 1)];
    const b = [bar(day(2026, 6, 1), 2, 2, 2, 2), bar(day(2026, 6, 2), 2, 2, 2, 2, 1, false)];
    const out = combineExpressionBars(parseExpression('A/B'), { A: { bars: a, timezone: 'UTC' }, B: { bars: b, timezone: 'UTC' } }, '1D');
    expect(out[0].final).toBeUndefined();
    expect(out[1].final).toBe(false);
  });

  it('matches weekly and monthly bars by period even when providers stamp them on different days', () => {
    expect(periodKey(Date.UTC(2026, 10, 1), 'UTC', '1M')).toBe(periodKey(Date.UTC(2026, 10, 2, 14, 30), 'America/New_York', '1M'));
    expect(periodKey(Date.UTC(2026, 10, 9), 'UTC', '1W')).toBe(periodKey(Date.UTC(2026, 10, 9, 14, 30), 'America/New_York', '1W'));
    expect(periodKey(Date.UTC(2026, 10, 9), 'UTC', '1W')).not.toBe(periodKey(Date.UTC(2026, 10, 8), 'UTC', '1W'));
    expect(periodKey(Date.UTC(2026, 0, 2), 'UTC', '3M')).toBe(periodKey(Date.UTC(2026, 2, 30), 'UTC', '3M'));
  });

  it('never looks ahead: appending bars to any symbol leaves earlier output unchanged', () => {
    const mk = (n: number, seed: number) => Array.from({ length: n }, (_, i) => bar(day(2026, 1, 1) + i * D, seed + i, seed + i + 2, seed + i - 1, seed + i + 1));
    const a = mk(40, 50);
    const b = mk(40, 20);
    const full = combineExpressionBars(parseExpression('A/B'), { A: { bars: a, timezone: 'UTC' }, B: { bars: b, timezone: 'UTC' } }, '1D');
    for (const cut of [5, 17, 33]) {
      const part = combineExpressionBars(parseExpression('A/B'), { A: { bars: a.slice(0, cut), timezone: 'UTC' }, B: { bars: b, timezone: 'UTC' } }, '1D');
      expect(part).toEqual(full.slice(0, cut));
    }
  });
});

describe('symbol expressions: fetching', () => {
  const NOW = Date.UTC(2026, 10, 13, 18);

  it('fetches each symbol through the provider chain and returns the combined series', async () => {
    const r = await fetchBars('SIM:AAA/SIM:BBB', '1D', { limit: 50, now: NOW }, fetch);
    const a = await fetchBars('SIM:AAA', '1D', { limit: 50, now: NOW }, fetch);
    const b = await fetchBars('SIM:BBB', '1D', { limit: 50, now: NOW }, fetch);
    expect(r.symbol).toBe('SIM:AAA/SIM:BBB');
    expect(r.info).toMatchObject({ symbol: 'SIM:AAA/SIM:BBB', exchange: 'Expression', calendar: a.info.calendar });
    expect(r.components?.map((c) => c.symbol)).toEqual(['SIM:AAA', 'SIM:BBB']);
    expect(r.simulated).toBe(true);
    expect(r.bars.length).toBe(50);
    expect(r.bars[10].c).toBeCloseTo(a.bars[10].c / b.bars[10].c, 12);
  });

  it('names the symbol that failed', async () => {
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchBars('SIM:AAA/NOPE', '1D', { limit: 10, now: NOW }, failing)).rejects.toThrow(/NOPE/);
  });

  it('rejects a malformed expression as a bad request', async () => {
    await expect(fetchBars('SPY//RSP', '1D', { limit: 10, now: NOW }, fetch)).rejects.toMatchObject({ status: 400 });
  });

  it('computes expression quotes from their components', async () => {
    const [q] = await fetchQuotes(['SIM:AAA/SIM:BBB'], fetch, NOW);
    const parts = await fetchQuotes(['SIM:AAA', 'SIM:BBB'], fetch, NOW);
    expect(q.symbol).toBe('SIM:AAA/SIM:BBB');
    expect(q.last).toBeCloseTo(parts[0].last / parts[1].last, 12);
    expect(q.prevClose).toBeCloseTo(parts[0].prevClose / parts[1].prevClose, 12);
  });
});

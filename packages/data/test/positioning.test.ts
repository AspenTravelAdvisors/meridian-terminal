import { describe, expect, it } from 'vitest';
import {
  cryptoBase,
  equityTicker,
  fetchDaysToCover,
  fetchFundingHistory,
  fetchOpenInterestHistory,
  fetchShortInterest,
  oiPeriodFor,
  toOkxSwap,
} from '../src/positioning';

const mockFetch = (routes: Record<string, unknown | ((url: string) => unknown)>): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(`nope ${url}`, { status: 503 });
    const body = typeof routes[key] === 'function' ? (routes[key] as (u: string, i?: RequestInit) => unknown)(url, init) : routes[key];
    if (body instanceof Response) return body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

describe('positioning symbol helpers', () => {
  it('maps crypto symbols to OKX swaps and detects equity tickers', () => {
    expect(cryptoBase('BINANCE:BTCUSDT')).toBe('BTC');
    expect(cryptoBase('COINBASE:ETH-USD')).toBe('ETH');
    expect(cryptoBase('AAPL')).toBeNull();
    expect(toOkxSwap('BINANCE:BTCUSDT')).toBe('BTC-USDT-SWAP');
    expect(equityTicker('AAPL')).toBe('AAPL');
    expect(equityTicker('BINANCE:BTCUSDT')).toBeNull();
    expect(equityTicker('SIM:DEMO')).toBeNull();
    expect(oiPeriodFor('5m')).toBe('5m');
    expect(oiPeriodFor('1D')).toBe('1D');
  });
});

describe('crypto positioning feeds', () => {
  it('parses OKX funding history into percent points', async () => {
    const fetcher = mockFetch({
      'funding-rate-history': {
        code: '0',
        data: [
          { fundingTime: '1700000000000', fundingRate: '0.0001', realizedRate: '0.0001' },
          { fundingTime: '1699990000000', fundingRate: '-0.0002', realizedRate: '-0.0002' },
        ],
      },
    });
    const s = await fetchFundingHistory('BINANCE:BTCUSDT', {}, fetcher);
    expect(s.source).toBe('okx');
    expect(s.unit).toBe('%');
    expect(s.points).toEqual([
      { t: 1699990000000, v: -0.02 },
      { t: 1700000000000, v: 0.01 },
    ]);
  });

  it('parses OKX open-interest history as USD notional', async () => {
    const fetcher = mockFetch({
      'open-interest-history': {
        code: '0',
        data: [
          ['1700000000000', '100', '1', '5000000'],
          ['1700086400000', '110', '1.1', '5500000'],
        ],
      },
    });
    const s = await fetchOpenInterestHistory('ETHUSDT', { interval: '1D' }, fetcher);
    expect(s.points.map((p) => p.v)).toEqual([5_000_000, 5_500_000]);
  });

  it('returns an empty series with a note for equities on crypto feeds', async () => {
    const s = await fetchFundingHistory('AAPL', {}, mockFetch({}));
    expect(s.points).toEqual([]);
    expect(s.note).toMatch(/crypto/i);
  });
});

describe('FINRA short interest', () => {
  it('maps consolidated short interest rows onto settlement timestamps', async () => {
    const fetcher = mockFetch({
      consolidatedShortInterest: [
        {
          symbolCode: 'AAPL',
          settlementDate: '2026-10-15',
          currentShortPositionQuantity: 100,
          previousShortPositionQuantity: 90,
          daysToCoverQuantity: 2.5,
          changePercent: 11.1,
          averageDailyVolumeQuantity: 40,
        },
        {
          symbolCode: 'AAPL',
          settlementDate: '2026-10-30',
          currentShortPositionQuantity: 120,
          previousShortPositionQuantity: 100,
          daysToCoverQuantity: 3.1,
          changePercent: 20,
          averageDailyVolumeQuantity: 38,
        },
      ],
    });
    const shares = await fetchShortInterest('AAPL', { fromMs: Date.UTC(2026, 0, 1) }, fetcher);
    expect(shares.points).toHaveLength(2);
    expect(shares.points[1].v).toBe(120);
    const dtc = await fetchDaysToCover('AAPL', { fromMs: Date.UTC(2026, 0, 1) }, fetcher);
    expect(dtc.points.map((p) => p.v)).toEqual([2.5, 3.1]);
  });

  it('returns an empty series with a note for crypto on the equity feed', async () => {
    const s = await fetchShortInterest('BINANCE:BTCUSDT', {}, mockFetch({}));
    expect(s.points).toEqual([]);
    expect(s.note).toMatch(/equit/i);
  });
});

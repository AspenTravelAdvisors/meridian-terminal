import { describe, expect, it } from 'vitest';
import {
  type Bar,
  adjustBars,
  barCloseTime,
  csvToBars,
  fetchBars,
  futureBarTimes,
  heikinAshi,
  isOpen,
  nyseHolidays,
  parseDate,
  parseNum,
  parseSymbol,
  parseYahooChart,
  rangeBars,
  renko,
  resample,
  simBars,
  toCoinbaseProduct,
  zonedToEpoch,
  yahoo,
} from '../src';

const mockFetch = (routes: Record<string, unknown | ((url: string) => unknown)>): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('nope', { status: 503 });
    const body = typeof routes[key] === 'function' ? (routes[key] as (u: string) => unknown)(url) : routes[key];
    if (body instanceof Response) return body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

const NOW = Date.UTC(2025, 5, 10, 18); // Tue 10 Jun 2025 14:00 ET

const yahooChart = {
  chart: {
    result: [
      {
        meta: { symbol: 'AAPL', currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS', instrumentType: 'EQUITY', exchangeTimezoneName: 'America/New_York', longName: 'Apple Inc.' },
        timestamp: [1749476400, 1749562800, 1749562800 + 60],
        indicators: {
          quote: [{ open: [200, 201, 202], high: [202, 203, 203], low: [199, 200, 201], close: [201, 202, 202.5], volume: [10, 11, 12] }],
          adjclose: [{ adjclose: [200, 201, 202] }],
        },
        events: { splits: { '1': { date: 1700000000, numerator: 4, denominator: 1 } }, dividends: { '2': { date: 1749476400, amount: 0.26 } } },
      },
    ],
    error: null,
  },
};

describe('symbols', () => {
  it('routes by prefix and detects bare crypto pairs', () => {
    expect(parseSymbol('aapl')).toMatchObject({ provider: 'yahoo', ticker: 'AAPL' });
    expect(parseSymbol('BTCUSDT')).toMatchObject({ provider: 'binance', canonical: 'BINANCE:BTCUSDT' });
    expect(parseSymbol('SIM:DEMO')).toMatchObject({ provider: 'sim', ticker: 'DEMO' });
    expect(toCoinbaseProduct('ETHUSDT')).toBe('ETH-USD');
  });

  it('labels non-US listings with their own venue, hours and currency', async () => {
    const quotes = [
      { symbol: 'SAP.DE', shortname: 'SAP SE', exchange: 'GER', exchDisp: 'XETRA', quoteType: 'EQUITY' },
      { symbol: 'RY.TO', shortname: 'Royal Bank of Canada', exchange: 'TOR', exchDisp: 'Toronto', quoteType: 'EQUITY' },
      { symbol: 'VOD.L', shortname: 'Vodafone', exchange: 'LSE', exchDisp: 'London', quoteType: 'EQUITY' },
      { symbol: 'AAPL', shortname: 'Apple', exchange: 'NMS', exchDisp: 'NASDAQ', quoteType: 'EQUITY' },
    ];
    const fetcher = (async () => new Response(JSON.stringify({ quotes }), { status: 200 })) as unknown as typeof fetch;
    const r = await yahoo.searchSymbols!('x', fetcher);
    expect(r.map((x) => [x.symbol, x.calendar, x.currency, x.timezone])).toEqual([
      ['SAP.DE', 'XETRA', 'EUR', 'Europe/Berlin'],
      ['RY.TO', 'TSX', 'CAD', 'America/Toronto'],
      ['VOD.L', 'LSE', 'GBp', 'Europe/London'],
      ['AAPL', 'NYSE', 'USD', 'America/New_York'],
    ]);
  });

  it('uses the venue session for open hours and bar finalization', () => {
    // 2026-10-27 is a Tuesday. 08:30 UTC = 09:30 Berlin (open) but 04:30 New York (closed).
    const t = Date.UTC(2026, 9, 27, 8, 30);
    expect(isOpen('XETRA', t)).toBe(true);
    expect(isOpen('NYSE', t)).toBe(false);
    // a XETRA daily bar is complete at 17:30 Berlin = 16:30 UTC, not at the 16:00 New York close
    expect(barCloseTime('XETRA', '1D', Date.UTC(2026, 9, 27, 7, 0), 86_400_000)).toBe(Date.UTC(2026, 9, 27, 16, 30));
    expect(barCloseTime('TSX', '1D', Date.UTC(2026, 9, 27, 13, 30), 86_400_000)).toBe(Date.UTC(2026, 9, 27, 20, 0));
  });
});

describe('Yahoo adapter', () => {
  it('parses chart JSON, events and marks the forming bar provisional', () => {
    const p = parseYahooChart(yahooChart as never, '1D', NOW);
    expect(p.bars).toHaveLength(2); // repeated live timestamp collapsed into the last bar
    expect(p.bars[1].c).toBe(202.5);
    expect(p.bars[1].final).toBe(false);
    expect(p.events.splits[0].ratio).toBe(4);
    expect(p.info).toMatchObject({ type: 'stock', calendar: 'NYSE', name: 'Apple Inc.' });
  });
  it('fetches through the router and normalizes the symbol', async () => {
    const r = await fetchBars('AAPL', '1D', { now: NOW }, mockFetch({ '/v8/finance/chart/AAPL': yahooChart }));
    expect(r.provider).toBe('yahoo');
    expect(r.symbol).toBe('AAPL');
    expect(r.simulated).toBe(false);
  });
});

describe('crypto adapters & fallback', () => {
  const kl = [[Date.UTC(2025, 5, 9), '100', '110', '95', '105', '12', Date.UTC(2025, 5, 10) - 1]];
  it('maps Binance klines', async () => {
    const r = await fetchBars('BINANCE:BTCUSDT', '1D', { now: NOW }, mockFetch({ '/api/v3/klines': kl }));
    expect(r.bars[0]).toMatchObject({ o: 100, h: 110, l: 95, c: 105, v: 12 });
    expect(r.info.calendar).toBe('24x7');
  });
  it('falls back to Coinbase when Binance is unreachable, and records why', async () => {
    const cb = [[Date.UTC(2025, 5, 9) / 1000, 95, 110, 100, 105, 12]];
    const r = await fetchBars('BINANCE:BTCUSDT', '1D', { now: NOW }, mockFetch({ 'api.exchange.coinbase.com': cb }));
    expect(r.provider).toBe('coinbase');
    expect(r.fallbacks?.[0]).toMatch(/^binance/);
  });
  it('never substitutes simulated data for a real symbol', async () => {
    await expect(fetchBars('AAPL', '1D', { now: NOW }, mockFetch({}))).rejects.toThrow(/all providers failed/);
  });
});

describe('sessions', () => {
  it('generates NYSE holidays from the rules', () => {
    expect(nyseHolidays(2025)).toEqual(['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25']);
    const h26 = nyseHolidays(2026);
    expect(h26).toContain('2026-04-03'); // Good Friday
    expect(h26).toContain('2026-07-03'); // Independence Day observed (Sat → Fri)
    expect(nyseHolidays(2022)).not.toContain('2021-12-31'); // New Year on Saturday is not observed
  });
  it('knows when NYSE and CME are open', () => {
    expect(isOpen('NYSE', Date.UTC(2025, 5, 10, 14))).toBe(true); // 10:00 ET
    expect(isOpen('NYSE', Date.UTC(2025, 5, 10, 21))).toBe(false); // 17:00 ET
    expect(isOpen('NYSE', Date.UTC(2025, 6, 4, 15))).toBe(false); // July 4th
    expect(isOpen('CME', Date.UTC(2025, 5, 10, 21, 30))).toBe(false); // daily break 16:30 CT
    expect(isOpen('CME', Date.UTC(2025, 5, 11, 2))).toBe(true); // overnight
  });
  it('projects future bar times that skip weekends and holidays', () => {
    const fri = Date.UTC(2025, 6, 3, 13, 30); // Thu 3 Jul 2025 09:30 ET daily bar
    const next = futureBarTimes('NYSE', fri, 86_400_000, 2).map((t) => new Date(t).toISOString().slice(0, 10));
    expect(next).toEqual(['2025-07-07', '2025-07-08']); // skips 4 Jul (holiday) and the weekend
  });
});

describe('resampling & transforms', () => {
  const hourly = (day: number) =>
    // 09:30 … 15:30 ET hourly bars on 10 Jun 2025 (EDT = UTC−4)
    Array.from({ length: 7 }, (_, k): Bar => ({ t: Date.UTC(2025, 5, day, 13, 30) + k * 3_600_000, o: 10 + k, h: 11 + k, l: 9 + k, c: 10.5 + k, v: 1 }));
  it('anchors NYSE 4h bars to the session open (09:30 and 13:30 ET)', () => {
    const r = resample(hourly(10), '4h', 'NYSE');
    expect(r).toHaveLength(2);
    expect(new Date(r[0].t).toISOString()).toBe('2025-06-10T13:30:00.000Z');
    expect(new Date(r[1].t).toISOString()).toBe('2025-06-10T17:30:00.000Z');
    expect(r[0]).toMatchObject({ o: 10, h: 14, l: 9, c: 13.5, v: 4 });
  });
  it('weekly bars start on Monday', () => {
    const days: Bar[] = Array.from({ length: 10 }, (_, k) => ({ t: Date.UTC(2025, 5, 4 + k), o: 1, h: 2, l: 0, c: 1, v: 1 })); // Wed 4 Jun …
    const w = resample(days, '1W', '24x7');
    expect(new Date(w[1].t).getUTCDay()).toBe(1);
  });
  it('Heikin-Ashi, Renko and Range bars are well-formed', () => {
    const bars = simBars('DEMO', '1D', NOW, undefined, 300);
    for (const b of heikinAshi(bars)) expect(b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c)).toBe(true);
    const rk = renko(bars, 2);
    for (let k = 1; k < rk.length; k++) {
      expect(Math.abs(rk[k].c - rk[k].o)).toBeCloseTo(2, 9);
      expect(rk[k].t).toBeGreaterThan(rk[k - 1].t);
    }
    const rb = rangeBars(bars, 3);
    for (const b of rb.slice(0, -1)) expect(b.h - b.l).toBeCloseTo(3, 9);
  });
  it('adjustment modes: none un-applies splits, all back-adjusts dividends', () => {
    const b: Bar[] = [
      { t: 1, o: 10, h: 10, l: 10, c: 10, v: 100 },
      { t: 3, o: 10, h: 10, l: 10, c: 10, v: 100 },
    ];
    expect(adjustBars(b, { splits: [{ t: 2, ratio: 4 }], dividends: [] }, 'none')[0]).toMatchObject({ c: 40, v: 25 });
    expect(adjustBars(b, { splits: [], dividends: [{ t: 2, amount: 1 }] }, 'all')[0].c).toBeCloseTo(9, 12);
  });
});

describe('CSV import', () => {
  it('parses dates, numbers and maps OHLCV columns', () => {
    expect(parseDate('2024-03-05')).toBe(Date.UTC(2024, 2, 5));
    expect(parseDate('03/05/2024')).toBe(Date.UTC(2024, 2, 5));
    expect(parseDate('25/12/2024')).toBe(Date.UTC(2024, 11, 25));
    expect(parseDate('1709596800')).toBe(1709596800000);
    expect(parseNum('$1,234.50')).toBe(1234.5);
    expect(parseNum('(12.5)')).toBe(-12.5);
    const { bars, warnings } = csvToBars('Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-03,10,11,9,10.5,10.4,"1,000"\n2024-01-02,9,10,8,9.5,9.4,900\nbad,1,1,1,1,1,1\n');
    expect(bars.map((b) => b.c)).toEqual([9.5, 10.5]);
    expect(bars[1].v).toBe(1000);
    expect(warnings).toHaveLength(1);
  });
  it('converts exchange-local timestamps (Twelve Data) to epoch', () => {
    expect(zonedToEpoch('2025-06-10 09:30:00', 'America/New_York')).toBe(Date.UTC(2025, 5, 10, 13, 30));
  });
});

describe('simulated feed', () => {
  it('is deterministic, consistent across intervals and flags the forming bar', () => {
    const a = simBars('DEMO', '1h', NOW, undefined, 200);
    const b = simBars('DEMO', '1h', NOW, undefined, 200);
    expect(a).toEqual(b);
    expect(a[a.length - 1].final).toBe(false);
    const daily = simBars('DEMO', '1D', NOW, undefined, 5);
    const lastFullDay = daily[daily.length - 2];
    const hourlyThatDay = a.filter((x) => x.t >= lastFullDay.t && x.t < lastFullDay.t + 86_400_000);
    expect(hourlyThatDay[hourlyThatDay.length - 1].c).toBeCloseTo(lastFullDay.c, 9);
  });
});

describe('bar close times (counts finalize only when the bar has closed)', () => {
  const H = 3_600_000;
  const at = (iso: string) => Date.parse(iso);
  it('an NYSE daily bar closes at 16:00 ET the same day, whatever its timestamp convention', () => {
    const close = at('2026-10-26T20:00:00Z'); // 16:00 EDT
    expect(barCloseTime('NYSE', '1D', at('2026-10-26T13:30:00Z'), 24 * H)).toBe(close); // Yahoo: session open
    expect(barCloseTime('NYSE', '1D', at('2026-10-26T14:30:00Z'), 24 * H)).toBe(close); // Stooq: fixed 14:30 UTC
    expect(barCloseTime('NYSE', '1D', at('2026-01-05T14:30:00Z'), 24 * H)).toBe(at('2026-01-05T21:00:00Z')); // EST
  });
  it('intraday buckets end at the session close, not interval-length later', () => {
    expect(barCloseTime('NYSE', '4h', at('2026-10-26T17:30:00Z'), 4 * H)).toBe(at('2026-10-26T20:00:00Z'));
    expect(barCloseTime('NYSE', '1h', at('2026-10-26T18:30:00Z'), H)).toBe(at('2026-10-26T19:30:00Z'));
  });
  it('weekly bars close Friday 16:00 ET; monthly and quarterly at the next period start', () => {
    expect(barCloseTime('NYSE', '1W', at('2026-10-26T13:30:00Z'), 7 * 24 * H)).toBe(at('2026-10-30T20:00:00Z'));
    expect(barCloseTime('24x7', '1M', at('2026-10-01T00:00:00Z'), 30 * 24 * H)).toBe(at('2026-11-01T00:00:00Z'));
    expect(barCloseTime('24x7', '3M', at('2026-10-01T00:00:00Z'), 91 * 24 * H)).toBe(at('2027-01-01T00:00:00Z'));
    expect(barCloseTime('24x7', '1M', at('2026-01-01T00:00:00Z'), 30 * 24 * H)).toBe(at('2026-02-01T00:00:00Z')); // 31-day month
  });
  it('24x7 intraday bars are a plain interval', () => {
    expect(barCloseTime('24x7', '1h', at('2026-10-27T02:00:00Z'), H)).toBe(at('2026-10-27T03:00:00Z'));
  });
  it('resample keeps a still-open bucket provisional even when every constituent is final', () => {
    const days: Bar[] = ['2026-10-26', '2026-10-27', '2026-10-28'].map((d, k) => ({ t: at(`${d}T00:00:00Z`), o: 10 + k, h: 11 + k, l: 9 + k, c: 10.5 + k, v: 100 }));
    const wed = at('2026-10-28T12:00:00Z');
    expect(resample(days, '1W', '24x7', wed).at(-1)!.final).toBe(false);
    expect(resample(days, '1W', '24x7', at('2026-11-02T00:00:01Z')).at(-1)!.final).toBeUndefined();
  });
});

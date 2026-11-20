import { beforeEach, describe, expect, it } from 'vitest';
import { NEWS_CALENDAR, calendarEventsFor, fetchNews, rateEightK, resetSecCache, secAcceptedAt, sectorsForSic } from '../src/news';

const mockFetch = (routes: Record<string, unknown>, seen: { url: string; ua: string | null }[] = []): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, ua: new Headers(init?.headers).get('User-Agent') });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(`nope ${url}`, { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;

const UA = 'Meridian test contact@example.com';
const NOW = Date.UTC(2026, 10, 20);

const tickers = { '0': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' }, '1': { cik_str: 19617, ticker: 'JPM', title: 'JPMORGAN CHASE & CO' } };
const nvdaSubs = {
  name: 'NVIDIA CORP',
  sic: '3674',
  filings: {
    recent: {
      accessionNumber: ['0001045810-26-000101', '0001045810-26-000090', '0001045810-26-000080', '0001045810-26-000070'],
      filingDate: ['2026-08-27', '2026-06-25', '2026-05-28', '2026-05-28'],
      acceptanceDateTime: ['2026-08-27T16:20:31.000Z', '2026-06-25T16:05:00.000Z', '2026-05-28T16:21:00.000Z', '2026-05-28T17:00:00.000Z'],
      form: ['8-K', '8-K', '10-Q', '8-K/A'],
      items: ['2.02,9.01', '5.07', '', '2.02'],
      primaryDocument: ['nvda-20260827.htm', 'nvda-vote.htm', 'q.htm', 'a.htm'],
    },
    files: [],
  },
};

describe('built-in calendar', () => {
  it('has well-formed entries (dates parse, weights 1–3, scope targets present)', () => {
    for (const e of NEWS_CALENDAR) {
      expect(Number.isFinite(Date.parse(e.d))).toBe(true);
      expect([1, 2, 3]).toContain(e.w);
      if (e.scope === 'industry') expect(e.sectors?.length).toBeGreaterThan(0);
      if (e.scope === 'ticker') expect(e.tickers?.length).toBeGreaterThan(0);
      expect(e.h.length).toBeGreaterThan(5);
    }
  });

  it('gives a stock market-wide events plus its sector, and crypto only crypto-relevant events', () => {
    const jpm = calendarEventsFor('JPM', ['banks']);
    expect(jpm.some((e) => e.scope === 'market' && e.headline.includes('Brexit'))).toBe(true);
    expect(jpm.some((e) => e.scope === 'industry' && e.headline.includes('Silicon Valley Bank'))).toBe(true);
    expect(jpm.some((e) => e.headline.includes('OPEC'))).toBe(false);

    const btc = calendarEventsFor('BINANCE:BTCUSDT', []);
    expect(btc.some((e) => e.headline.includes('Brexit'))).toBe(false); // market event without the crypto flag
    expect(btc.some((e) => e.headline.includes('Russia invades'))).toBe(true);
    expect(btc.some((e) => e.headline.includes('FTX files'))).toBe(true);
    expect(btc.some((e) => e.headline.includes('bitcoin halving'))).toBe(true);
    expect(btc.some((e) => e.headline.includes('Merge'))).toBe(false); // ETH only
  });

  it('anchors day-precision events inside the US session of that day', () => {
    const e = calendarEventsFor('SPY', []).find((x) => x.headline.includes('Brexit'));
    expect(e?.t).toBe(Date.UTC(2016, 5, 24, 15));
    expect(e?.precise).toBe(false);
  });
});

describe('SEC helpers', () => {
  it('rates 8-Ks by their most important item and ignores immaterial ones', () => {
    expect(rateEightK('2.02,9.01')).toEqual({ weight: 2, labels: ['Earnings release'] });
    expect(rateEightK('5.02,1.03')?.weight).toBe(3);
    expect(rateEightK('5.07,9.01')).toBeNull();
  });

  it('reads EDGAR acceptance times as US Eastern', () => {
    // 16:20 EDT = 20:20 UTC in August; 16:20 EST = 21:20 UTC in January
    expect(secAcceptedAt('2026-08-27T16:20:31.000Z', '2026-08-27').t).toBe(Date.UTC(2026, 7, 27, 20, 20, 31));
    expect(secAcceptedAt('2026-01-15T16:20:00.000Z', '2026-01-15').t).toBe(Date.UTC(2026, 0, 15, 21, 20));
    expect(secAcceptedAt(undefined, '2026-01-15')).toEqual({ t: Date.UTC(2026, 0, 15, 15), precise: false });
  });

  it('maps SIC codes to sectors', () => {
    expect(sectorsForSic(3674)).toEqual(['semis', 'tech']);
    expect(sectorsForSic(6021)).toEqual(['banks']);
    expect(sectorsForSic(2911)).toEqual(['energy']);
    expect(sectorsForSic(9999)).toEqual([]);
  });
});

describe('fetchNews', () => {
  beforeEach(() => resetSecCache());

  it('merges rated 8-K filings with calendar events, sending the configured User-Agent to SEC', async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const fetcher = mockFetch({ 'company_tickers.json': tickers, 'CIK0001045810.json': nvdaSubs }, seen);
    const f = await fetchNews('NVDA', { fromMs: Date.UTC(2025, 0, 1), secUserAgent: UA, now: NOW }, fetcher);
    expect(f.sources).toEqual(['meridian', 'sec']);
    expect(f.sectors).toEqual(['semis', 'tech']);
    const sec = f.events.filter((e) => e.source === 'sec');
    // the vote (5.07), the 10-Q and the amendment are dropped
    expect(sec).toHaveLength(1);
    expect(sec[0]).toMatchObject({ scope: 'ticker', weight: 2, headline: '8-K: Earnings release', precise: true });
    expect(sec[0].url).toBe('https://www.sec.gov/Archives/edgar/data/1045810/000104581026000101/nvda-20260827.htm');
    expect(f.events.some((e) => e.headline.includes('DeepSeek'))).toBe(true);
    expect(seen.every((s) => s.ua === UA)).toBe(true);
    // sorted by time
    expect(f.events.map((e) => e.t)).toEqual([...f.events.map((e) => e.t)].sort((a, b) => a - b));
  });

  it('falls back to the SEC industry code when the ticker is not in the built-in sector table', async () => {
    const fetcher = mockFetch({
      'company_tickers.json': { '0': { cik_str: 1, ticker: 'ZZBK', title: 'Z BANK' } },
      'CIK0000000001.json': { sic: '6022', filings: { recent: { accessionNumber: [], filingDate: [], form: [] } } },
    });
    const f = await fetchNews('ZZBK', { fromMs: Date.UTC(2023, 0, 1), toMs: Date.UTC(2023, 11, 31), secUserAgent: UA, now: NOW }, fetcher);
    expect(f.sectors).toEqual(['banks']);
    expect(f.events.some((e) => e.headline.includes('Silicon Valley Bank'))).toBe(true);
  });

  it('skips SEC without a User-Agent and says why, still serving the calendar', async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const f = await fetchNews('JPM', { fromMs: Date.UTC(2023, 0, 1), toMs: Date.UTC(2023, 11, 31), now: NOW }, mockFetch({}, seen));
    expect(seen).toHaveLength(0);
    expect(f.notes[0]).toMatch(/SEC_USER_AGENT/);
    expect(f.events.some((e) => e.headline.includes('First Republic'))).toBe(true);
  });

  it('keeps serving the calendar when SEC is down', async () => {
    const f = await fetchNews('JPM', { fromMs: Date.UTC(2023, 0, 1), toMs: Date.UTC(2023, 11, 31), secUserAgent: UA, now: NOW }, mockFetch({}));
    expect(f.notes[0]).toMatch(/SEC filings unavailable/);
    expect(f.events.length).toBeGreaterThan(0);
  });

  it('gives symbol expressions market-wide events only', async () => {
    const f = await fetchNews('XLF/SPY', { fromMs: Date.UTC(2023, 0, 1), toMs: Date.UTC(2023, 11, 31), secUserAgent: UA, now: NOW }, mockFetch({}));
    expect(f.events.every((e) => e.scope === 'market')).toBe(true);
    expect(f.events.length).toBeGreaterThan(0);
  });
});

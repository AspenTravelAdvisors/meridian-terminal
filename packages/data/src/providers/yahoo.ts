import { calendarFor, timezoneFor } from '../symbols';
import { resample } from '../transform';
import type { AssetType, Bar, CorporateEvents, Interval, MarketDataProvider, Quote, SymbolInfo } from '../types';
import { INTERVAL_MS, isIntraday } from '../types';
import { ProviderError, getJson } from './http';

const DAY = 86_400_000;
const IV: Record<Interval, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '4h': '60m', '1D': '1d', '1W': '1wk', '1M': '1mo', '3M': '3mo' };
/** Yahoo's look-back limits per request for intraday intervals. */
const MAX_WINDOW: Partial<Record<Interval, number>> = { '1m': 7 * DAY, '5m': 59 * DAY, '15m': 59 * DAY, '30m': 59 * DAY, '1h': 720 * DAY, '4h': 720 * DAY };
const MAX_AGE: Partial<Record<Interval, number>> = { '1m': 29 * DAY, '5m': 59 * DAY, '15m': 59 * DAY, '30m': 59 * DAY, '1h': 729 * DAY, '4h': 729 * DAY };

interface YChart {
  chart: {
    result?: {
      meta: {
        symbol: string;
        currency?: string;
        exchangeName?: string;
        fullExchangeName?: string;
        instrumentType?: string;
        exchangeTimezoneName?: string;
        longName?: string;
        shortName?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
      };
      timestamp?: number[];
      indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[]; adjclose?: { adjclose: (number | null)[] }[] };
      events?: { dividends?: Record<string, { amount: number; date: number }>; splits?: Record<string, { date: number; numerator: number; denominator: number }> };
    }[];
    error?: { code: string; description: string } | null;
  };
}

const TYPE: Record<string, AssetType> = { EQUITY: 'stock', ETF: 'etf', INDEX: 'index', CRYPTOCURRENCY: 'crypto', CURRENCY: 'fx', FUTURE: 'future', MUTUALFUND: 'fund' };

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function chart(ticker: string, params: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<YChart> {
  let last: unknown;
  for (const host of HOSTS) {
    try {
      const j = await getJson<YChart>('yahoo', `${host}/v8/finance/chart/${encodeURIComponent(ticker)}?${params}`, fetcher, { signal });
      if (j.chart?.error) throw new ProviderError('yahoo', j.chart.error.description || j.chart.error.code, j.chart.error.code === 'Not Found' ? 404 : 502);
      return j;
    } catch (e) {
      last = e;
      if (e instanceof ProviderError && e.status === 404) throw e;
    }
  }
  throw last;
}

export function parseYahooChart(j: YChart, interval: Interval, now: number) {
  const r = j.chart.result?.[0];
  if (!r) throw new ProviderError('yahoo', 'empty result', 404);
  const ts = r.timestamp ?? [];
  const q = r.indicators.quote[0] ?? { open: [], high: [], low: [], close: [], volume: [] };
  const adj = r.indicators.adjclose?.[0]?.adjclose;
  const bars: Bar[] = [];
  const adjFactor: number[] = [];
  const ivMs = INTERVAL_MS[interval === '4h' ? '1h' : interval];
  for (let k = 0; k < ts.length; k++) {
    const o = q.open[k];
    const h = q.high[k];
    const l = q.low[k];
    const c = q.close[k];
    if (o == null || h == null || l == null || c == null || !(c > 0)) continue;
    const t = ts[k] * 1000;
    const b: Bar = { t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: q.volume[k] ?? 0 };
    if (t + ivMs > now) b.final = false;
    bars.push(b);
    adjFactor.push(adj?.[k] != null && c ? (adj[k] as number) / c : 1);
  }
  // Yahoo appends the live tick with an unaligned timestamp inside the current bar — merge it into that bar
  const clean: Bar[] = [];
  const cleanAdj: number[] = [];
  bars.forEach((b, k) => {
    const prev = clean[clean.length - 1];
    if (prev && b.t - prev.t < ivMs) {
      clean[clean.length - 1] = { t: prev.t, o: prev.o, h: Math.max(prev.h, b.h), l: Math.min(prev.l, b.l), c: b.c, v: Math.max(prev.v, b.v), final: b.final };
      if (b.final !== false) delete clean[clean.length - 1].final;
      cleanAdj[cleanAdj.length - 1] = adjFactor[k];
    } else {
      clean.push(b);
      cleanAdj.push(adjFactor[k]);
    }
  });
  const events: CorporateEvents = {
    splits: Object.values(r.events?.splits ?? {}).map((s) => ({ t: s.date * 1000, ratio: s.numerator / (s.denominator || 1) })),
    dividends: Object.values(r.events?.dividends ?? {}).map((d) => ({ t: d.date * 1000, amount: d.amount })),
  };
  const m = r.meta;
  const type = TYPE[m.instrumentType ?? ''] ?? 'other';
  const exchange = m.fullExchangeName ?? m.exchangeName ?? '';
  const calendar = calendarFor(type, exchange);
  const info: SymbolInfo = {
    symbol: m.symbol,
    name: m.longName ?? m.shortName ?? m.symbol,
    exchange,
    type,
    currency: m.currency ?? 'USD',
    calendar,
    timezone: m.exchangeTimezoneName ?? timezoneFor(calendar),
    provider: 'yahoo',
  };
  return { bars: clean, adjFactor: cleanAdj, events, info, meta: m };
}

export const yahoo: MarketDataProvider & { lastAdjFactor?: number[] } = {
  id: 'yahoo',
  async getBars(ticker, interval, opts, fetcher) {
    const now = opts.now ?? Date.now();
    const to = Math.min(opts.to ?? now + DAY, now + DAY);
    const limit = Math.min(opts.limit ?? 1500, 5000);
    const ivMs = INTERVAL_MS[interval];
    // window wide enough for `limit` bars including weekends/holidays/overnight gaps
    let span = intervalSpan(interval, limit, ivMs);
    if (MAX_WINDOW[interval]) span = Math.min(span, MAX_WINDOW[interval]!);
    let from = to - span;
    const oldest = MAX_AGE[interval] ? now - MAX_AGE[interval]! : -Infinity;
    if (from < oldest) from = oldest;
    if (to <= from) return { provider: 'yahoo', info: placeholder(ticker), bars: [], events: { splits: [], dividends: [] }, simulated: false, hasMore: false };
    const params = new URLSearchParams({
      period1: String(Math.max(0, Math.floor(from / 1000))),
      period2: String(Math.floor(to / 1000)),
      interval: IV[interval],
      includePrePost: 'false',
      events: 'div,splits',
      includeAdjustedClose: 'true',
    });
    const j = await chart(ticker, params.toString(), fetcher, opts.signal);
    const p = parseYahooChart(j, interval, now);
    let bars = p.bars.filter((b) => b.t < to);
    let adj = p.adjFactor.slice(0, bars.length);
    if (interval === '4h') {
      bars = resample(bars, '4h', p.info.calendar);
      adj = bars.map(() => 1);
    }
    if (bars.length > limit) {
      adj = adj.slice(bars.length - limit);
      bars = bars.slice(bars.length - limit);
    }
    const res = { provider: 'yahoo' as const, info: p.info, bars, events: p.events, simulated: false, hasMore: from > oldest && from > 0 && bars.length > 0, adjFactor: adj };
    return res;
  },
  async searchSymbols(q, fetcher) {
    const j = await getJson<{ quotes?: { symbol: string; shortname?: string; longname?: string; exchDisp?: string; exchange?: string; quoteType?: string }[] }>(
      'yahoo',
      `${HOSTS[0]}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0`,
      fetcher,
      { timeoutMs: 5000 },
    );
    return (j.quotes ?? [])
      .filter((x) => x.symbol)
      .map((x) => {
        const type = TYPE[x.quoteType ?? ''] ?? 'other';
        const exchange = x.exchDisp ?? x.exchange ?? '';
        const calendar = calendarFor(type, exchange);
        return { symbol: x.symbol, name: x.longname ?? x.shortname ?? x.symbol, exchange, type, currency: 'USD', calendar, timezone: timezoneFor(calendar), provider: 'yahoo' as const };
      });
  },
  async getQuotes(tickers, fetcher, now) {
    const out = await Promise.allSettled(
      tickers.slice(0, 40).map(async (t): Promise<Quote> => {
        const j = await chart(t, 'range=5d&interval=1d', fetcher);
        const r = j.chart.result?.[0];
        if (!r) throw new Error('empty');
        const closes = (r.indicators.quote[0]?.close ?? []).filter((c): c is number => c != null);
        const last = r.meta.regularMarketPrice ?? closes[closes.length - 1];
        const prev = closes.length >= 2 ? closes[closes.length - 2] : (r.meta.chartPreviousClose ?? last);
        return { symbol: t, last, prevClose: prev, change: last - prev, changePct: prev ? (100 * (last - prev)) / prev : 0, t: (r.meta.regularMarketTime ?? now / 1000) * 1000 };
      }),
    );
    return out.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  },
};

function intervalSpan(interval: Interval, limit: number, ivMs: number): number {
  if (interval === '1M') return limit * 31 * DAY;
  if (interval === '3M') return limit * 92 * DAY;
  if (interval === '1W') return limit * 7 * DAY;
  if (interval === '1D') return Math.ceil(limit * 1.5) * DAY;
  // intraday: ~6.5 trading hours per 24h for equities; be generous
  return isIntraday(interval) ? Math.ceil(limit * ivMs * 4.2) : limit * ivMs;
}

function placeholder(ticker: string): SymbolInfo {
  return { symbol: ticker, name: ticker, exchange: '', type: 'other', currency: 'USD', calendar: 'NYSE', timezone: 'America/New_York', provider: 'yahoo' };
}

import { resample } from '../transform';
import type { Bar, Interval, MarketDataProvider, Quote, SymbolInfo } from '../types';
import { INTERVAL_MS } from '../types';
import { ProviderError, getJson } from './http';

const DAY = 86_400_000;

// ── Binance (public market-data mirror; no key) ────────────────────────────
const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const BIV: Record<Interval, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w', '1M': '1M', '3M': '1M' };

export const cryptoInfo = (ticker: string, provider: 'binance' | 'coinbase'): SymbolInfo => {
  const base = ticker.replace(/(USDT|USDC|FDUSD|USD|BTC|ETH)$/, '').replace(/-$/, '');
  const quote = ticker.slice(base.length).replace(/^-/, '') || 'USD';
  return {
    symbol: provider === 'binance' ? `BINANCE:${ticker}` : `COINBASE:${ticker}`,
    name: `${base} / ${quote}`,
    exchange: provider === 'binance' ? 'Binance' : 'Coinbase',
    type: 'crypto',
    currency: quote,
    calendar: '24x7',
    timezone: 'UTC',
    provider,
  };
};

async function binanceGet<T>(path: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (const h of BINANCE_HOSTS) {
    try {
      return await getJson<T>('binance', `${h}${path}`, fetcher, { signal });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export const binance: MarketDataProvider = {
  id: 'binance',
  async getBars(ticker, interval, opts, fetcher) {
    if (!/^[A-Z0-9]{3,20}$/.test(ticker)) throw new ProviderError('binance', 'invalid pair', 400);
    const now = opts.now ?? Date.now();
    const limit = Math.min(opts.limit ?? 1000, 1000);
    const params = new URLSearchParams({ symbol: ticker, interval: BIV[interval], limit: String(interval === '3M' ? Math.min(1000, limit * 3) : limit) });
    if (opts.to) params.set('endTime', String(opts.to - 1));
    const rows = await binanceGet<(string | number)[][]>(`/api/v3/klines?${params}`, fetcher, opts.signal);
    let bars: Bar[] = rows.map((r) => {
      const b: Bar = { t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] };
      if (Number(r[6]) >= now) b.final = false;
      return b;
    });
    if (interval === '3M') bars = resample(bars, '3M', '24x7', now);
    return { provider: 'binance', info: cryptoInfo(ticker, 'binance'), bars, events: { splits: [], dividends: [] }, simulated: false, hasMore: rows.length >= limit };
  },
  async getQuotes(tickers, fetcher) {
    const list = tickers.filter((t) => /^[A-Z0-9]{3,20}$/.test(t)).slice(0, 50);
    if (!list.length) return [];
    const rows = await binanceGet<{ symbol: string; lastPrice: string; prevClosePrice: string; priceChange: string; priceChangePercent: string; closeTime: number }[]>(
      `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(list))}`,
      fetcher,
    );
    return rows.map(
      (r): Quote => ({ symbol: r.symbol, last: +r.lastPrice, prevClose: +r.lastPrice - +r.priceChange, change: +r.priceChange, changePct: +r.priceChangePercent, t: r.closeTime }),
    );
  },
};

// ── Coinbase Exchange (fallback for crypto when Binance is unreachable) ────
const CB_GRAN: Record<Interval, [number, Interval | null]> = {
  '1m': [60, null],
  '5m': [300, null],
  '15m': [900, null],
  '30m': [900, '30m'],
  '1h': [3600, null],
  '4h': [3600, '4h'],
  '1D': [86400, null],
  '1W': [86400, '1W'],
  '1M': [86400, '1M'],
  '3M': [86400, '3M'],
};

export const toCoinbaseProduct = (ticker: string): string => {
  if (ticker.includes('-')) return ticker;
  const m = /^([A-Z0-9]+?)(USDT|USDC|FDUSD|USD)$/.exec(ticker);
  return m ? `${m[1]}-USD` : ticker;
};

export const coinbase: MarketDataProvider = {
  id: 'coinbase',
  async getBars(ticker, interval, opts, fetcher) {
    const product = toCoinbaseProduct(ticker);
    if (!/^[A-Z0-9]{2,10}-[A-Z]{3,5}$/.test(product)) throw new ProviderError('coinbase', 'invalid product', 400);
    const now = opts.now ?? Date.now();
    const [gran, re] = CB_GRAN[interval];
    const end = Math.min(opts.to ?? now, now);
    const out: Bar[] = [];
    // up to 3 pages of 300 candles
    let pageEnd = end;
    for (let page = 0; page < 3; page++) {
      const start = pageEnd - 300 * gran * 1000;
      const rows = await getJson<number[][]>(
        'coinbase',
        `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}&start=${new Date(start).toISOString()}&end=${new Date(pageEnd).toISOString()}`,
        fetcher,
        { signal: opts.signal },
      );
      if (!rows.length) break;
      for (const r of rows) out.push({ t: r[0] * 1000, o: r[3], h: r[2], l: r[1], c: r[4], v: r[5] });
      pageEnd = start;
      if (interval === '1m' || interval === '5m') break;
    }
    out.sort((a, b) => a.t - b.t);
    const dedup = out.filter((b, k) => k === 0 || b.t !== out[k - 1].t);
    for (const b of dedup) if (b.t + gran * 1000 > now) b.final = false;
    const bars = re ? resample(dedup, re, '24x7', now) : dedup;
    return { provider: 'coinbase', info: cryptoInfo(product.replace('-', ''), 'coinbase'), bars, events: { splits: [], dividends: [] }, simulated: false, hasMore: dedup.length > 0 && INTERVAL_MS[interval] < 30 * DAY };
  },
};

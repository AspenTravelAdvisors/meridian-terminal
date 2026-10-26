import { tzOffsetMs } from '@meridian/engine';
import { calendarFor, timezoneFor } from '../symbols';
import { resample } from '../transform';
import type { Bar, Interval, MarketDataProvider, SymbolInfo } from '../types';
import { INTERVAL_MS } from '../types';
import { ProviderError, getJson, getText } from './http';

const DAY = 86_400_000;
const equityInfo = (ticker: string, provider: SymbolInfo['provider'], exchange = ''): SymbolInfo => {
  const calendar = calendarFor('stock', exchange);
  return { symbol: ticker, name: ticker, exchange, type: 'stock', currency: 'USD', calendar, timezone: timezoneFor(calendar), provider };
};

// ── Stooq (daily/weekly/monthly CSV; last-resort fallback for US listings) ──
export const stooq: MarketDataProvider = {
  id: 'stooq',
  async getBars(ticker, interval, opts, fetcher) {
    const iv = interval === '1D' ? 'd' : interval === '1W' ? 'w' : interval === '1M' || interval === '3M' ? 'm' : null;
    if (!iv) throw new ProviderError('stooq', 'intraday not supported', 400);
    const sym = /[.^=]/.test(ticker) ? ticker.toLowerCase() : `${ticker.toLowerCase()}.us`;
    const csv = await getText('stooq', `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=${iv}`, fetcher);
    if (!/^Date,Open/i.test(csv.trim())) throw new ProviderError('stooq', 'no data', 404);
    const now = opts.now ?? Date.now();
    let bars: Bar[] = csv
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(','))
      .filter((r) => r.length >= 5 && +r[4] > 0)
      .map((r) => {
        const [y, m, d] = r[0].split('-').map(Number);
        const t = Date.UTC(y, m - 1, d, 14, 30);
        return { t, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +(r[5] ?? 0) || 0 };
      });
    if (interval === '3M') bars = resample(bars, '3M', 'NYSE');
    if (opts.to) bars = bars.filter((b) => b.t < opts.to!);
    const limit = opts.limit ?? 1500;
    const hasMore = bars.length > limit;
    bars = bars.slice(-limit);
    const last = bars[bars.length - 1];
    if (last && last.t + INTERVAL_MS[interval] > now) last.final = false;
    return { provider: 'stooq', info: equityInfo(ticker, 'stooq'), bars, events: { splits: [], dividends: [] }, simulated: false, hasMore };
  },
};

// ── Alpaca market data v2 (keys in env) ────────────────────────────────────
const ATF: Record<Interval, [string, Interval | null]> = {
  '1m': ['1Min', null],
  '5m': ['5Min', null],
  '15m': ['15Min', null],
  '30m': ['30Min', null],
  '1h': ['1Hour', null],
  '4h': ['1Hour', '4h'],
  '1D': ['1Day', null],
  '1W': ['1Week', null],
  '1M': ['1Month', null],
  '3M': ['1Month', '3M'],
};

export function alpaca(keyId: string, secret: string, feed = 'iex'): MarketDataProvider {
  return {
    id: 'alpaca',
    async getBars(ticker, interval, opts, fetcher) {
      const now = opts.now ?? Date.now();
      const [tf, re] = ATF[interval];
      const limit = Math.min(opts.limit ?? 1500, 10000);
      const end = new Date(Math.min(opts.to ?? now, now) - 1).toISOString();
      const ivMs = INTERVAL_MS[interval];
      const start = new Date(Date.parse(end) - Math.ceil(limit * ivMs * (ivMs < DAY ? 4.5 : 1.6))).toISOString();
      const adj = opts.adjust === 'all' ? 'all' : opts.adjust === 'none' ? 'raw' : 'split';
      const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars?timeframe=${tf}&start=${start}&end=${end}&limit=10000&adjustment=${adj}&feed=${feed}&sort=asc`;
      const j = await getJson<{ bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] | null }>('alpaca', url, fetcher, {
        headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret },
        signal: opts.signal,
      });
      let bars: Bar[] = (j.bars ?? []).map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
      if (re) bars = resample(bars, re, 'NYSE');
      bars = bars.slice(-limit);
      const last = bars[bars.length - 1];
      if (last && last.t + ivMs > now) last.final = false;
      // Alpaca applies the adjustment server-side; report it as already applied
      return { provider: 'alpaca', info: equityInfo(ticker, 'alpaca'), bars, events: { splits: [], dividends: [] }, simulated: false, hasMore: bars.length >= limit * 0.9, preAdjusted: true };
    },
  };
}

// ── Twelve Data (key in env) ───────────────────────────────────────────────
const TD_IV: Record<Interval, [string, Interval | null]> = {
  '1m': ['1min', null],
  '5m': ['5min', null],
  '15m': ['15min', null],
  '30m': ['30min', null],
  '1h': ['1h', null],
  '4h': ['4h', null],
  '1D': ['1day', null],
  '1W': ['1week', null],
  '1M': ['1month', null],
  '3M': ['1month', '3M'],
};

/** "2024-01-02 09:30:00" in an exchange time zone → epoch ms. */
export function zonedToEpoch(s: string, tz: string): number {
  const [d, tm = '00:00:00'] = s.split(' ');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm, ss] = tm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh || 0, mm || 0, ss || 0);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
}

export function twelveData(apiKey: string): MarketDataProvider {
  return {
    id: 'twelvedata',
    async getBars(ticker, interval, opts, fetcher) {
      const now = opts.now ?? Date.now();
      const [iv, re] = TD_IV[interval];
      const limit = Math.min(opts.limit ?? 1500, 5000);
      const params = new URLSearchParams({ symbol: ticker, interval: iv, outputsize: String(limit), apikey: apiKey, order: 'ASC' });
      if (opts.to) params.set('end_date', new Date(opts.to - 1000).toISOString().slice(0, 19).replace('T', ' '));
      const j = await getJson<{ status: string; message?: string; meta?: { exchange_timezone?: string; exchange?: string; currency?: string; type?: string }; values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[] }>(
        'twelvedata',
        `https://api.twelvedata.com/time_series?${params}`,
        fetcher,
        { signal: opts.signal },
      );
      if (j.status !== 'ok') throw new ProviderError('twelvedata', j.message ?? 'error', 404);
      const tz = j.meta?.exchange_timezone ?? 'America/New_York';
      let bars: Bar[] = (j.values ?? []).map((v) => ({ t: zonedToEpoch(v.datetime, tz), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume ?? 0) || 0 }));
      if (re) bars = resample(bars, re, 'NYSE');
      const last = bars[bars.length - 1];
      if (last && last.t + INTERVAL_MS[interval] > now) last.final = false;
      const info = { ...equityInfo(ticker, 'twelvedata', j.meta?.exchange), currency: j.meta?.currency ?? 'USD', timezone: tz };
      return { provider: 'twelvedata', info, bars, events: { splits: [], dividends: [] }, simulated: false, hasMore: bars.length >= limit };
    },
  };
}

import type { Bar } from '@meridian/engine';

export type { Bar };

export const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M', '3M'] as const;
export type Interval = (typeof INTERVALS)[number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Nominal interval length (months/quarters use average lengths; calendars handle exact boundaries). */
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': MIN,
  '5m': 5 * MIN,
  '15m': 15 * MIN,
  '30m': 30 * MIN,
  '1h': HOUR,
  '4h': 4 * HOUR,
  '1D': DAY,
  '1W': 7 * DAY,
  '1M': 30 * DAY,
  '3M': 91 * DAY,
};

export const INTERVAL_LABEL: Record<Interval, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '15m': '15 minutes',
  '30m': '30 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  '1D': '1 day',
  '1W': '1 week',
  '1M': '1 month',
  '3M': '3 months',
};

export const isIntraday = (iv: Interval): boolean => INTERVAL_MS[iv] < DAY;

export type AssetType = 'stock' | 'etf' | 'index' | 'crypto' | 'fx' | 'future' | 'fund' | 'sim' | 'other';
export type CalendarId =
  | 'NYSE'
  | 'CME'
  | '24x7'
  | 'FX'
  // non-US cash equity venues (regular session only; weekends excluded, local holidays are not modelled)
  | 'TSX'
  | 'LSE'
  | 'XETRA'
  | 'EURONEXT'
  | 'SIX'
  | 'BIT'
  | 'BME'
  | 'TSE'
  | 'HKEX'
  | 'ASX'
  | 'NSE';
export type ProviderId = 'yahoo' | 'binance' | 'coinbase' | 'stooq' | 'alpaca' | 'twelvedata' | 'sim' | 'csv';

/** split = split-adjusted (default), all = split + dividend adjusted, none = raw prints. */
export type AdjustMode = 'split' | 'all' | 'none';

export interface SymbolInfo {
  symbol: string; // canonical, e.g. "AAPL", "BINANCE:BTCUSDT", "SIM:DEMO"
  name: string;
  exchange: string;
  type: AssetType;
  currency: string;
  calendar: CalendarId;
  timezone: string;
  provider: ProviderId;
}

export interface CorporateEvents {
  splits: { t: number; ratio: number }[]; // ratio = new shares per old share (2 = 2-for-1)
  dividends: { t: number; amount: number }[];
}

export interface BarsResponse {
  symbol: string;
  interval: Interval;
  provider: ProviderId;
  info: SymbolInfo;
  bars: Bar[];
  events: CorporateEvents;
  adjust: AdjustMode;
  /** true when bars are deterministic simulated data (never shown without a SIMULATED badge) */
  simulated: boolean;
  /** providers tried before this one succeeded (for the data-status tooltip) */
  fallbacks?: string[];
  /** set when more history exists before the first bar */
  hasMore: boolean;
}

export interface Quote {
  symbol: string;
  last: number;
  prevClose: number;
  change: number;
  changePct: number;
  t: number;
  simulated?: boolean;
}

export interface GetBarsOptions {
  /** epoch ms; fetch bars strictly before this time (for scroll-back backfill) */
  to?: number;
  limit?: number;
  adjust?: AdjustMode;
  /** wall-clock now (injected so providers stay testable) */
  now?: number;
  signal?: AbortSignal;
}

/** What a provider returns before adjustment/normalization by the router. */
export type ProviderBars = Omit<BarsResponse, 'symbol' | 'interval' | 'adjust'> & {
  /** per-bar (adjclose / close) factors when the provider knows dividend adjustments */
  adjFactor?: number[];
  /** the provider already applied the requested adjustment */
  preAdjusted?: boolean;
};

export interface MarketDataProvider {
  id: ProviderId;
  searchSymbols?(q: string, fetcher: typeof fetch): Promise<SymbolInfo[]>;
  getBars(ticker: string, interval: Interval, opts: GetBarsOptions, fetcher: typeof fetch): Promise<ProviderBars>;
  getQuotes?(tickers: string[], fetcher: typeof fetch, now: number): Promise<Quote[]>;
}

/** Compact wire format: [t, o, h, l, c, v, final?0:1] */
export type WireBar = [number, number, number, number, number, number] | [number, number, number, number, number, number, 0];

export const toWire = (b: Bar): WireBar => (b.final === false ? [b.t, b.o, b.h, b.l, b.c, b.v, 0] : [b.t, b.o, b.h, b.l, b.c, b.v]);
export const fromWire = (w: WireBar): Bar => (w.length === 7 ? { t: w[0], o: w[1], h: w[2], l: w[3], c: w[4], v: w[5], final: false } : { t: w[0], o: w[1], h: w[2], l: w[3], c: w[4], v: w[5] });

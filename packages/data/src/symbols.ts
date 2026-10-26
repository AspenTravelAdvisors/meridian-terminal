import type { AssetType, CalendarId, ProviderId, SymbolInfo } from './types';

/** Parse "PROVIDER:TICKER" (provider optional) and route to a provider. */
export function parseSymbol(raw: string): { provider: ProviderId; ticker: string; canonical: string } {
  const s = raw.trim().toUpperCase();
  const m = /^([A-Z0-9]+):(.+)$/.exec(s);
  if (m) {
    const p = m[1];
    const t = m[2];
    const provider: ProviderId | null =
      p === 'BINANCE' ? 'binance' : p === 'COINBASE' ? 'coinbase' : p === 'SIM' ? 'sim' : p === 'YAHOO' ? 'yahoo' : p === 'STOOQ' ? 'stooq' : p === 'ALPACA' ? 'alpaca' : p === 'TWELVEDATA' ? 'twelvedata' : p === 'CSV' ? 'csv' : null;
    if (provider) return { provider, ticker: t, canonical: provider === 'yahoo' ? t : `${p}:${t}` };
  }
  // bare crypto pair like BTCUSDT → Binance
  if (/^[A-Z0-9]{2,10}(USDT|USDC|FDUSD|BTC|ETH)$/.test(s) && !s.includes('-')) return { provider: 'binance', ticker: s, canonical: `BINANCE:${s}` };
  return { provider: 'yahoo', ticker: s, canonical: s };
}

export const SYMBOL_RE = /^[A-Za-z0-9.\-^=:_/]{1,40}$/;

export function calendarFor(type: AssetType, exchange = ''): CalendarId {
  if (type === 'crypto' || type === 'sim') return '24x7';
  if (type === 'fx') return 'FX';
  if (type === 'future' || /CME|CBOT|NYMEX|COMEX|CBT|NYM|CMX/i.test(exchange)) return 'CME';
  return 'NYSE';
}

export function timezoneFor(cal: CalendarId): string {
  return cal === 'CME' ? 'America/Chicago' : cal === '24x7' ? 'UTC' : 'America/New_York';
}

const mk = (symbol: string, name: string, type: AssetType, exchange: string, provider: ProviderId = 'yahoo', currency = 'USD'): SymbolInfo => {
  const calendar = calendarFor(type, exchange);
  return { symbol, name, type, exchange, provider, currency, calendar, timezone: timezoneFor(calendar) };
};

/** Curated, offline symbol list: search fallback and screener universes. */
export const CURATED: SymbolInfo[] = [
  mk('SPY', 'SPDR S&P 500 ETF', 'etf', 'NYSE Arca'),
  mk('QQQ', 'Invesco QQQ Trust', 'etf', 'NASDAQ'),
  mk('IWM', 'iShares Russell 2000 ETF', 'etf', 'NYSE Arca'),
  mk('DIA', 'SPDR Dow Jones Industrial Average ETF', 'etf', 'NYSE Arca'),
  mk('TLT', 'iShares 20+ Year Treasury Bond ETF', 'etf', 'NASDAQ'),
  mk('GLD', 'SPDR Gold Shares', 'etf', 'NYSE Arca'),
  mk('AAPL', 'Apple Inc.', 'stock', 'NASDAQ'),
  mk('MSFT', 'Microsoft Corporation', 'stock', 'NASDAQ'),
  mk('NVDA', 'NVIDIA Corporation', 'stock', 'NASDAQ'),
  mk('AMZN', 'Amazon.com Inc.', 'stock', 'NASDAQ'),
  mk('GOOGL', 'Alphabet Inc. Class A', 'stock', 'NASDAQ'),
  mk('META', 'Meta Platforms Inc.', 'stock', 'NASDAQ'),
  mk('TSLA', 'Tesla Inc.', 'stock', 'NASDAQ'),
  mk('AVGO', 'Broadcom Inc.', 'stock', 'NASDAQ'),
  mk('BRK-B', 'Berkshire Hathaway Inc. Class B', 'stock', 'NYSE'),
  mk('JPM', 'JPMorgan Chase & Co.', 'stock', 'NYSE'),
  mk('V', 'Visa Inc.', 'stock', 'NYSE'),
  mk('UNH', 'UnitedHealth Group Inc.', 'stock', 'NYSE'),
  mk('XOM', 'Exxon Mobil Corporation', 'stock', 'NYSE'),
  mk('LLY', 'Eli Lilly and Company', 'stock', 'NYSE'),
  mk('WMT', 'Walmart Inc.', 'stock', 'NYSE'),
  mk('JNJ', 'Johnson & Johnson', 'stock', 'NYSE'),
  mk('PG', 'Procter & Gamble Co.', 'stock', 'NYSE'),
  mk('MA', 'Mastercard Inc.', 'stock', 'NYSE'),
  mk('HD', 'Home Depot Inc.', 'stock', 'NYSE'),
  mk('COST', 'Costco Wholesale Corporation', 'stock', 'NASDAQ'),
  mk('NFLX', 'Netflix Inc.', 'stock', 'NASDAQ'),
  mk('AMD', 'Advanced Micro Devices Inc.', 'stock', 'NASDAQ'),
  mk('XLK', 'Technology Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLF', 'Financial Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLE', 'Energy Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLV', 'Health Care Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLY', 'Consumer Discretionary Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLP', 'Consumer Staples Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLI', 'Industrial Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLU', 'Utilities Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLB', 'Materials Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLRE', 'Real Estate Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('XLC', 'Communication Services Select Sector SPDR', 'etf', 'NYSE Arca'),
  mk('^GSPC', 'S&P 500 Index', 'index', 'SNP'),
  mk('^NDX', 'Nasdaq-100 Index', 'index', 'NASDAQ'),
  mk('^VIX', 'CBOE Volatility Index', 'index', 'CBOE'),
  mk('ES=F', 'E-mini S&P 500 Futures', 'future', 'CME'),
  mk('NQ=F', 'E-mini Nasdaq-100 Futures', 'future', 'CME'),
  mk('CL=F', 'Crude Oil Futures', 'future', 'NYMEX'),
  mk('GC=F', 'Gold Futures', 'future', 'COMEX'),
  mk('ZN=F', '10-Year T-Note Futures', 'future', 'CBOT'),
  mk('EURUSD=X', 'EUR/USD', 'fx', 'CCY'),
  mk('USDJPY=X', 'USD/JPY', 'fx', 'CCY'),
  mk('GBPUSD=X', 'GBP/USD', 'fx', 'CCY'),
  ...['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'MATIC', 'TRX', 'ATOM', 'NEAR', 'UNI', 'AAVE', 'ARB', 'OP', 'SUI'].map((c) =>
    mk(`BINANCE:${c}USDT`, `${c} / Tether`, 'crypto', 'Binance', 'binance', 'USDT'),
  ),
  mk('SIM:DEMO', 'Simulated demo series (deterministic)', 'sim', 'Meridian', 'sim'),
  mk('SIM:TREND', 'Simulated trending series', 'sim', 'Meridian', 'sim'),
  mk('SIM:CHOP', 'Simulated range-bound series', 'sim', 'Meridian', 'sim'),
];

export const UNIVERSES: Record<string, string[]> = {
  'US mega caps': ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'BRK-B', 'JPM', 'V', 'UNH', 'XOM', 'LLY', 'WMT', 'JNJ', 'PG', 'MA', 'HD', 'COST', 'NFLX', 'AMD'],
  'Sector ETFs': ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB', 'XLRE', 'XLC'],
  'Index ETFs': ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD'],
  'Crypto majors': ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX'].map((c) => `BINANCE:${c}USDT`),
  'Futures & FX': ['ES=F', 'NQ=F', 'CL=F', 'GC=F', 'ZN=F', 'EURUSD=X', 'USDJPY=X', 'GBPUSD=X'],
  Simulated: ['SIM:DEMO', 'SIM:TREND', 'SIM:CHOP'],
};

export function searchCurated(q: string, limit = 20): SymbolInfo[] {
  const s = q.trim().toUpperCase();
  if (!s) return CURATED.slice(0, limit);
  const scored = CURATED.map((x) => {
    const sym = x.symbol.replace(/^[A-Z]+:/, '');
    const score = sym === s ? 0 : sym.startsWith(s) ? 1 : x.name.toUpperCase().includes(s) ? 2 : x.symbol.includes(s) ? 3 : 9;
    return { x, score };
  }).filter((r) => r.score < 9);
  scored.sort((a, b) => a.score - b.score || a.x.symbol.localeCompare(b.x.symbol));
  return scored.slice(0, limit).map((r) => r.x);
}

export function curatedInfo(symbol: string): SymbolInfo | undefined {
  const u = symbol.toUpperCase();
  return CURATED.find((c) => c.symbol === u);
}

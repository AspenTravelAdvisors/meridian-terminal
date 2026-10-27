import { CALENDARS } from './sessions';
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

/** Yahoo-style listing suffixes for non-US venues: calendar, currency and a display name. */
const SUFFIX: Record<string, { calendar: CalendarId; currency: string; exchange: string }> = {
  TO: { calendar: 'TSX', currency: 'CAD', exchange: 'Toronto' },
  V: { calendar: 'TSX', currency: 'CAD', exchange: 'TSX Venture' },
  NE: { calendar: 'TSX', currency: 'CAD', exchange: 'Cboe Canada' },
  CN: { calendar: 'TSX', currency: 'CAD', exchange: 'CSE' },
  L: { calendar: 'LSE', currency: 'GBp', exchange: 'London' },
  IL: { calendar: 'LSE', currency: 'USD', exchange: 'London IOB' },
  DE: { calendar: 'XETRA', currency: 'EUR', exchange: 'XETRA' },
  F: { calendar: 'XETRA', currency: 'EUR', exchange: 'Frankfurt' },
  PA: { calendar: 'EURONEXT', currency: 'EUR', exchange: 'Euronext Paris' },
  AS: { calendar: 'EURONEXT', currency: 'EUR', exchange: 'Euronext Amsterdam' },
  BR: { calendar: 'EURONEXT', currency: 'EUR', exchange: 'Euronext Brussels' },
  LS: { calendar: 'EURONEXT', currency: 'EUR', exchange: 'Euronext Lisbon' },
  IR: { calendar: 'EURONEXT', currency: 'EUR', exchange: 'Euronext Dublin' },
  SW: { calendar: 'SIX', currency: 'CHF', exchange: 'SIX Swiss' },
  MI: { calendar: 'BIT', currency: 'EUR', exchange: 'Milan' },
  MC: { calendar: 'BME', currency: 'EUR', exchange: 'Madrid' },
  T: { calendar: 'TSE', currency: 'JPY', exchange: 'Tokyo' },
  HK: { calendar: 'HKEX', currency: 'HKD', exchange: 'Hong Kong' },
  AX: { calendar: 'ASX', currency: 'AUD', exchange: 'ASX' },
  NS: { calendar: 'NSE', currency: 'INR', exchange: 'NSE India' },
  BO: { calendar: 'NSE', currency: 'INR', exchange: 'BSE India' },
};

/** Exchange names/codes that providers report for those venues (Yahoo `exchange` codes and display names). */
const EXCHANGE: [RegExp, CalendarId][] = [
  [/^(TOR|TSX|TORONTO|VAN|TSXV|CNQ|NEO)$|TORONTO|TSX/i, 'TSX'],
  [/^(LSE|IOB)$|LONDON/i, 'LSE'],
  [/^(GER|FRA|ETR|XETRA|BER|MUN|STU|DUS|HAM)$|XETRA|FRANKFURT/i, 'XETRA'],
  [/^(PAR|AMS|BRU|LIS|ISE)$|EURONEXT|PARIS|AMSTERDAM/i, 'EURONEXT'],
  [/^(EBS|VTX)$|SWISS|ZURICH/i, 'SIX'],
  [/^MIL$|MILAN/i, 'BIT'],
  [/^MCE$|MADRID/i, 'BME'],
  [/^(JPX|TYO)$|TOKYO/i, 'TSE'],
  [/^HKG$|HONG KONG/i, 'HKEX'],
  [/^ASX$|AUSTRALIA/i, 'ASX'],
  [/^(NSI|BSE)$|NSE|BOMBAY/i, 'NSE'],
];

/** Venue facts for a Yahoo-style ticker ("SAP.DE", "RY.TO") — undefined for US listings. */
export function listingFor(ticker: string): { calendar: CalendarId; currency: string; exchange: string } | undefined {
  const m = /\.([A-Z]{1,2})$/.exec(ticker.toUpperCase());
  return m ? SUFFIX[m[1]] : undefined;
}

export function calendarFor(type: AssetType, exchange = '', ticker = ''): CalendarId {
  if (type === 'crypto' || type === 'sim') return '24x7';
  if (type === 'fx') return 'FX';
  if (type === 'future' || /CME|CBOT|NYMEX|COMEX|CBT|NYM|CMX/i.test(exchange)) return 'CME';
  const listed = listingFor(ticker);
  if (listed) return listed.calendar;
  for (const [re, cal] of EXCHANGE) if (re.test(exchange)) return cal;
  return 'NYSE';
}

export function timezoneFor(cal: CalendarId): string {
  return CALENDARS[cal].timezone;
}

/** Trading currency for a listing when the provider does not report one. */
export function currencyFor(type: AssetType, ticker: string, calendar: CalendarId): string {
  if (type === 'crypto') return /USDT$/.test(ticker) ? 'USDT' : /USDC$/.test(ticker) ? 'USDC' : 'USD';
  if (type === 'fx') return ticker.replace(/=X$/, '').slice(3, 6) || 'USD';
  const listed = listingFor(ticker);
  if (listed) return listed.currency;
  return CALENDAR_CURRENCY[calendar] ?? 'USD';
}

const CALENDAR_CURRENCY: Partial<Record<CalendarId, string>> = {
  TSX: 'CAD', LSE: 'GBp', XETRA: 'EUR', EURONEXT: 'EUR', SIX: 'CHF', BIT: 'EUR', BME: 'EUR', TSE: 'JPY', HKEX: 'HKD', ASX: 'AUD', NSE: 'INR',
};

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

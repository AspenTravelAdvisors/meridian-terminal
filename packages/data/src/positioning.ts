import { parseSymbol } from './symbols';
import { ProviderError, getJson, postJson } from './providers/http';

/** A dated scalar used as an auxiliary chart series (funding, OI, short interest, …). */
export interface PositionPoint {
  /** epoch ms when the value became known (settlement / snapshot time) */
  t: number;
  v: number;
}

export type PositioningKind = 'funding' | 'openInterest' | 'longShort' | 'shortInterest';

export interface PositioningSeries {
  kind: PositioningKind;
  symbol: string;
  /** venue / publisher that produced the points */
  source: string;
  unit: string;
  points: PositionPoint[];
  /** human note shown in the UI when the feed only covers one asset class */
  note?: string;
}

const DAY = 86_400_000;

/** Extract the crypto base (BTC, ETH, …) from Meridian symbols, or null for non-crypto. */
export function cryptoBase(symbol: string): string | null {
  const { provider, ticker } = parseSymbol(symbol);
  if (provider === 'binance' || provider === 'coinbase' || /^[A-Z0-9]{2,10}(USDT|USDC|FDUSD|USD)$/i.test(ticker.replace(/-/g, ''))) {
    const raw = ticker.toUpperCase().replace(/-/g, '');
    const m = /^([A-Z0-9]+?)(USDT|USDC|FDUSD|USD)$/.exec(raw);
    return m?.[1] ?? null;
  }
  // bare curated crypto like "BTC" from search
  if (/^(BTC|ETH|SOL|BNB|XRP|ADA|DOGE|AVAX|LINK|DOT|LTC|TRX|SUI|NEAR|APT|ARB|OP|PEPE|WIF|TON|SHIB)$/.test(ticker.toUpperCase())) {
    return ticker.toUpperCase();
  }
  return null;
}

/** OKX USDT-margined swap id for a Meridian crypto symbol. */
export function toOkxSwap(symbol: string): string | null {
  const ccy = cryptoBase(symbol);
  return ccy ? `${ccy}-USDT-SWAP` : null;
}

/** Equity ticker for FINRA (plain US symbols only). */
export function equityTicker(symbol: string): string | null {
  const { provider, ticker } = parseSymbol(symbol);
  if (provider === 'binance' || provider === 'coinbase' || provider === 'sim') return null;
  if (cryptoBase(symbol)) return null;
  // FINRA uses the listing ticker; refuse expressions and exotic prefixes
  if (/[+\-/*()]/.test(symbol) && symbol.includes(' ')) return null;
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(ticker)) return null;
  return ticker;
}

type OkxPeriod = '5m' | '15m' | '30m' | '1H' | '4H' | '1D';

/** Map a Meridian chart interval onto an OKX rubik period. */
export function oiPeriodFor(interval: string): OkxPeriod {
  switch (interval) {
    case '1m':
    case '5m':
      return '5m';
    case '15m':
      return '15m';
    case '30m':
      return '30m';
    case '1h':
      return '1H';
    case '4h':
      return '4H';
    default:
      return '1D';
  }
}

async function okxGet<T>(path: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<T> {
  return getJson<T>('okx', `https://www.okx.com${path}`, fetcher, { signal });
}

/**
 * Settled perpetual funding rates from OKX (free, no key). Rates are the contractual period rate
 * (typically 8h); the study plots them in percent.
 */
export async function fetchFundingHistory(
  symbol: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<PositioningSeries> {
  const swap = toOkxSwap(symbol);
  if (!swap) {
    return { kind: 'funding', symbol, source: 'okx', unit: '%', points: [], note: 'Funding rate is for crypto perpetual futures only.' };
  }
  const want = Math.min(Math.max(opts.limit ?? 300, 1), 1000);
  const points: PositionPoint[] = [];
  let before: string | undefined;
  while (points.length < want) {
    const q = new URLSearchParams({ instId: swap, limit: String(Math.min(100, want - points.length)) });
    if (before) q.set('before', before);
    const j = await okxGet<{ code: string; data?: { fundingTime: string; fundingRate: string; realizedRate?: string }[]; msg?: string }>(
      `/api/v5/public/funding-rate-history?${q}`,
      fetcher,
      opts.signal,
    );
    if (j.code !== '0') throw new ProviderError('okx', j.msg || `code ${j.code}`);
    const rows = j.data ?? [];
    if (!rows.length) break;
    for (const r of rows) {
      const t = Number(r.fundingTime);
      const v = Number(r.realizedRate ?? r.fundingRate) * 100; // → percent
      if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
    }
    const oldest = rows[rows.length - 1]?.fundingTime;
    if (!oldest || oldest === before) break;
    before = oldest;
    if (rows.length < 100) break;
  }
  points.sort((a, b) => a.t - b.t);
  const dedup = points.filter((p, i) => i === 0 || p.t !== points[i - 1].t);
  return { kind: 'funding', symbol, source: 'okx', unit: '%', points: dedup };
}

/**
 * Open interest history from OKX rubik stats (free, no key). Values are notional USD.
 */
export async function fetchOpenInterestHistory(
  symbol: string,
  opts: { interval?: string; limit?: number; signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<PositioningSeries> {
  const swap = toOkxSwap(symbol);
  if (!swap) {
    return { kind: 'openInterest', symbol, source: 'okx', unit: 'USD', points: [], note: 'Open interest is for crypto perpetual futures only.' };
  }
  const period = oiPeriodFor(opts.interval ?? '1D');
  const j = await okxGet<{ code: string; data?: string[][]; msg?: string }>(
    `/api/v5/rubik/stat/contracts/open-interest-history?instId=${encodeURIComponent(swap)}&period=${period}`,
    fetcher,
    opts.signal,
  );
  if (j.code !== '0') throw new ProviderError('okx', j.msg || `code ${j.code}`);
  // [ts, oi (contracts), oiCcy, oiUsd]
  const points = (j.data ?? [])
    .map((r): PositionPoint => ({ t: Number(r[0]), v: Number(r[3] ?? r[1]) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
    .sort((a, b) => a.t - b.t);
  const limit = opts.limit ?? 500;
  return { kind: 'openInterest', symbol, source: 'okx', unit: 'USD', points: points.slice(-limit) };
}

/** Long/short account ratio (accounts long ÷ accounts short) from OKX. */
export async function fetchLongShortRatio(
  symbol: string,
  opts: { interval?: string; signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<PositioningSeries> {
  const ccy = cryptoBase(symbol);
  if (!ccy) {
    return { kind: 'longShort', symbol, source: 'okx', unit: 'ratio', points: [], note: 'Long/short ratio is for crypto perpetual futures only.' };
  }
  const period = oiPeriodFor(opts.interval ?? '1D');
  const j = await okxGet<{ code: string; data?: string[][]; msg?: string }>(
    `/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${encodeURIComponent(ccy)}&period=${period}`,
    fetcher,
    opts.signal,
  );
  if (j.code !== '0') throw new ProviderError('okx', j.msg || `code ${j.code}`);
  const points = (j.data ?? [])
    .map((r): PositionPoint => ({ t: Number(r[0]), v: Number(r[1]) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  return { kind: 'longShort', symbol, source: 'okx', unit: 'ratio', points };
}

interface FinraShortRow {
  symbolCode: string;
  settlementDate: string;
  currentShortPositionQuantity: number;
  previousShortPositionQuantity: number;
  daysToCoverQuantity: number;
  changePercent: number;
  averageDailyVolumeQuantity: number;
}

async function finraShortRows(
  ticker: string,
  fromMs: number,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<FinraShortRow[]> {
  const fromIso = new Date(fromMs).toISOString().slice(0, 10);
  const rows = await postJson<FinraShortRow[]>(
    'finra',
    'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest',
    {
      compareFilters: [
        { compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: ticker },
        { compareType: 'GREATER_THAN_OR_EQUAL', fieldName: 'settlementDate', fieldValue: fromIso },
      ],
      limit: 500,
    },
    fetcher,
    { signal },
  );
  const list = Array.isArray(rows) ? rows : [];
  const byDate = new Map<string, FinraShortRow>();
  for (const r of list) if (r.settlementDate) byDate.set(r.settlementDate, r);
  return [...byDate.values()].sort((a, b) => a.settlementDate.localeCompare(b.settlementDate));
}

/**
 * FINRA consolidated short interest (free public Query API, no key). Twice-monthly settlement
 * snapshots: shares short. Not percent of float (float is not free).
 */
export async function fetchShortInterest(
  symbol: string,
  opts: { fromMs?: number; signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<PositioningSeries> {
  const ticker = equityTicker(symbol);
  const note = 'FINRA short interest is a twice-monthly settlement snapshot, not live leverage.';
  if (!ticker) {
    return {
      kind: 'shortInterest',
      symbol,
      source: 'finra',
      unit: 'shares',
      points: [],
      note: 'Short interest is for US equities (FINRA). Crypto uses Funding Rate / Open Interest instead.',
    };
  }
  const rows = await finraShortRows(ticker, opts.fromMs ?? Date.now() - 3 * 365 * DAY, fetcher, opts.signal);
  const points = rows
    .map((r) => ({ t: Date.parse(`${r.settlementDate}T21:00:00Z`), v: Number(r.currentShortPositionQuantity) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  return { kind: 'shortInterest', symbol, source: 'finra', unit: 'shares', points, note };
}

/** Days-to-cover companion series for the same FINRA rows. */
export async function fetchDaysToCover(
  symbol: string,
  opts: { fromMs?: number; signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<PositioningSeries> {
  const ticker = equityTicker(symbol);
  if (!ticker) {
    return {
      kind: 'shortInterest',
      symbol,
      source: 'finra',
      unit: 'days',
      points: [],
      note: 'Short interest is for US equities (FINRA). Crypto uses Funding Rate / Open Interest instead.',
    };
  }
  const rows = await finraShortRows(ticker, opts.fromMs ?? Date.now() - 3 * 365 * DAY, fetcher, opts.signal);
  const points = rows
    .map((r) => ({ t: Date.parse(`${r.settlementDate}T21:00:00Z`), v: Number(r.daysToCoverQuantity) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  return {
    kind: 'shortInterest',
    symbol,
    source: 'finra',
    unit: 'days',
    points,
    note: 'FINRA short interest is a twice-monthly settlement snapshot, not live leverage.',
  };
}

/** Fetch one positioning series by kind. */
export async function fetchPositioning(
  symbol: string,
  kind: PositioningKind | 'daysToCover',
  opts: { interval?: string; fromMs?: number; signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<PositioningSeries> {
  switch (kind) {
    case 'funding':
      return fetchFundingHistory(symbol, opts, fetcher);
    case 'openInterest':
      return fetchOpenInterestHistory(symbol, opts, fetcher);
    case 'longShort':
      return fetchLongShortRatio(symbol, opts, fetcher);
    case 'shortInterest':
      return fetchShortInterest(symbol, opts, fetcher);
    case 'daysToCover':
      return fetchDaysToCover(symbol, opts, fetcher);
  }
}

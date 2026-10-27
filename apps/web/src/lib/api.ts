import { type AdjustMode, type BarsResponse, type Interval, type Quote, type SymbolInfo, type WireBar, fromWire, parseSymbol, simBars, simInfo } from '@meridian/data';
import type { Bar } from '@meridian/engine';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? `network error: ${e.message}` : 'network error');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. static host without the API) */
  }
  if (!res.ok || body === null) throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? `HTTP ${res.status}${body === null ? ' (API unavailable)' : ''}`);
  return body as T;
}

export interface ClientBars extends Omit<BarsResponse, 'bars'> {
  bars: Bar[];
  serverTime?: number;
  /** generated in the browser because the API was unreachable (SIM:* only) */
  local?: boolean;
}

/**
 * Fetch bars from /api/bars. SIM:* symbols fall back to in-browser generation when the API is unreachable
 * (static hosting / offline). Real symbols never fall back to simulated data.
 */
export async function fetchBarsClient(symbol: string, interval: Interval, opts: { to?: number; limit?: number; adjust?: AdjustMode; signal?: AbortSignal } = {}): Promise<ClientBars> {
  const q = new URLSearchParams({ symbol, interval, limit: String(opts.limit ?? 1500), adjust: opts.adjust ?? 'split' });
  if (opts.to) q.set('to', String(Math.floor(opts.to)));
  try {
    const j = await getJson<Omit<BarsResponse, 'bars'> & { bars: WireBar[]; serverTime: number }>(`/api/bars?${q}`, { signal: opts.signal });
    return { ...j, bars: j.bars.map(fromWire) };
  } catch (e) {
    const p = parseSymbol(symbol);
    if (p.provider === 'sim' && e instanceof ApiError && (e.status === 0 || e.status === 404 || e.status >= 500)) {
      const bars = simBars(p.ticker, interval, Date.now(), opts.to, opts.limit ?? 1500);
      return { symbol: p.canonical, interval, provider: 'sim', info: simInfo(p.ticker), bars, events: { splits: [], dividends: [] }, adjust: 'split', simulated: true, hasMore: bars.length > 0, local: true };
    }
    throw e;
  }
}

export async function searchClient(q: string, signal?: AbortSignal): Promise<SymbolInfo[]> {
  try {
    return (await getJson<{ results: SymbolInfo[] }>(`/api/search?q=${encodeURIComponent(q)}`, { signal })).results;
  } catch {
    const { searchCurated } = await import('@meridian/data');
    return searchCurated(q, 25);
  }
}

export async function quotesClient(symbols: string[]): Promise<Quote[]> {
  if (!symbols.length) return [];
  return (await getJson<{ quotes: Quote[] }>(`/api/quotes?symbols=${encodeURIComponent(symbols.join(','))}`)).quotes;
}

export const postJson = <T>(url: string, body: unknown, signal?: AbortSignal) =>
  getJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

export async function health(): Promise<{ ok: boolean; analyst: string; providers: Record<string, boolean> } | null> {
  try {
    return await getJson('/api/health');
  } catch {
    return null;
  }
}

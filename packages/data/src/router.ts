import { CURATED, curatedInfo, parseSymbol, searchCurated } from './symbols';
import { adjustBars } from './transform';
import { binance, coinbase } from './providers/crypto';
import { alpaca, stooq, twelveData } from './providers/equity';
import { ProviderError } from './providers/http';
import { sim } from './providers/sim';
import { yahoo } from './providers/yahoo';
import type { BarsResponse, GetBarsOptions, Interval, MarketDataProvider, ProviderBars, Quote, SymbolInfo } from './types';

export interface DataEnv {
  ALPACA_KEY_ID?: string;
  ALPACA_SECRET_KEY?: string;
  TWELVE_DATA_API_KEY?: string;
}

/** Provider chain for a symbol, best first. Real symbols NEVER fall back to simulated data. */
export function providerChain(symbol: string, interval: Interval, env: DataEnv = {}): { chain: MarketDataProvider[]; ticker: string; canonical: string } {
  const p = parseSymbol(symbol);
  const daily = interval === '1D' || interval === '1W' || interval === '1M' || interval === '3M';
  const chain: MarketDataProvider[] = [];
  switch (p.provider) {
    case 'sim':
      chain.push(sim);
      break;
    case 'binance':
      chain.push(binance, coinbase);
      break;
    case 'coinbase':
      chain.push(coinbase, binance);
      break;
    case 'stooq':
      chain.push(stooq);
      break;
    case 'alpaca':
      if (env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) chain.push(alpaca(env.ALPACA_KEY_ID, env.ALPACA_SECRET_KEY));
      break;
    case 'twelvedata':
      if (env.TWELVE_DATA_API_KEY) chain.push(twelveData(env.TWELVE_DATA_API_KEY));
      break;
    default: {
      const isPlainEquity = /^[A-Z][A-Z0-9.-]{0,9}$/.test(p.ticker);
      if (isPlainEquity && env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) chain.push(alpaca(env.ALPACA_KEY_ID, env.ALPACA_SECRET_KEY));
      if (env.TWELVE_DATA_API_KEY) chain.push(twelveData(env.TWELVE_DATA_API_KEY));
      chain.push(yahoo);
      if (daily && isPlainEquity) chain.push(stooq);
    }
  }
  return { chain, ticker: p.ticker, canonical: p.canonical };
}

/** Fetch bars through the provider chain, then apply the adjustment mode. */
export async function fetchBars(symbol: string, interval: Interval, opts: GetBarsOptions, fetcher: typeof fetch, env: DataEnv = {}): Promise<BarsResponse> {
  const { chain, ticker, canonical } = providerChain(symbol, interval, env);
  if (!chain.length) throw new ProviderError('router', `no provider configured for ${symbol}`, 400);
  const adjust = opts.adjust ?? 'split';
  const tried: string[] = [];
  let lastErr: unknown;
  for (const p of chain) {
    try {
      const r: ProviderBars = await p.getBars(ticker, interval, opts, fetcher);
      if (!r.bars.length && p !== chain[chain.length - 1]) throw new ProviderError(p.id, 'no bars');
      let bars = r.bars;
      if (!r.preAdjusted) {
        if (adjust === 'all' && r.adjFactor && r.adjFactor.length === bars.length)
          bars = bars.map((b, k) => {
            const f = r.adjFactor![k];
            return f === 1 || !Number.isFinite(f) ? b : { ...b, o: b.o * f, h: b.h * f, l: b.l * f, c: b.c * f };
          });
        else bars = adjustBars(bars, r.events, adjust);
      }
      const info: SymbolInfo = { ...(curatedInfo(canonical) ?? {}), ...r.info, symbol: canonical };
      return { symbol: canonical, interval, adjust, provider: r.provider, info, bars, events: r.events, simulated: r.simulated, hasMore: r.hasMore, fallbacks: tried.length ? tried : undefined };
    } catch (e) {
      lastErr = e;
      tried.push(`${p.id}: ${e instanceof Error ? e.message.replace(/^\w+: /, '') : String(e)}`);
    }
  }
  const err = lastErr instanceof ProviderError ? lastErr : new ProviderError('router', String(lastErr));
  throw new ProviderError('router', `all providers failed for ${symbol} (${tried.join('; ')})`, err.status === 404 ? 404 : 502);
}

export async function searchSymbols(q: string, fetcher: typeof fetch): Promise<SymbolInfo[]> {
  const local = searchCurated(q, 12);
  if (q.trim().length < 1) return CURATED.slice(0, 20);
  let remote: SymbolInfo[] = [];
  try {
    remote = await yahoo.searchSymbols!(q, fetcher);
  } catch {
    /* offline or blocked — curated results still work */
  }
  const seen = new Set<string>();
  const out: SymbolInfo[] = [];
  for (const s of [...local, ...remote]) if (!seen.has(s.symbol)) {
      seen.add(s.symbol);
      out.push(s);
    }
  const pair = /^[A-Z0-9]{2,10}(USDT|USDC)$/i.test(q.trim()) ? `BINANCE:${q.trim().toUpperCase()}` : null;
  if (pair && !seen.has(pair)) out.unshift({ ...CURATED.find((c) => c.provider === 'binance')!, symbol: pair, name: `${q.toUpperCase()} (Binance)` });
  return out.slice(0, 25);
}

export async function fetchQuotes(symbols: string[], fetcher: typeof fetch, now: number): Promise<Quote[]> {
  const groups = { yahoo: [] as string[], binance: [] as string[], sim: [] as string[] };
  const back = new Map<string, string>();
  for (const s of symbols.slice(0, 60)) {
    const p = parseSymbol(s);
    const g = p.provider === 'binance' || p.provider === 'coinbase' ? 'binance' : p.provider === 'sim' ? 'sim' : 'yahoo';
    groups[g].push(p.ticker);
    back.set(`${g}:${p.ticker}`, p.canonical);
  }
  const settled = await Promise.allSettled([
    groups.yahoo.length ? yahoo.getQuotes!(groups.yahoo, fetcher, now) : Promise.resolve([]),
    groups.binance.length ? binance.getQuotes!(groups.binance, fetcher, now) : Promise.resolve([]),
    groups.sim.length ? sim.getQuotes!(groups.sim, fetcher, now) : Promise.resolve([]),
  ]);
  const names = ['yahoo', 'binance', 'sim'];
  return settled.flatMap((r, k) =>
    r.status === 'fulfilled' ? r.value.map((q) => ({ ...q, symbol: back.get(`${names[k]}:${q.symbol.replace(/^SIM:/, '')}`) ?? q.symbol })) : [],
  );
}

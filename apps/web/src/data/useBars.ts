import { type AdjustMode, INTERVAL_MS, type Interval, type SymbolInfo, isOpen, mergeBars, parseSymbol } from '@meridian/data';
import type { Bar } from '@meridian/engine';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fetchBarsClient } from '../lib/api';
import { useSettings } from '../state/store';

export interface BarsState {
  bars: Bar[];
  info: SymbolInfo | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  provider?: string;
  simulated?: boolean;
  fallbacks?: string[];
  hasMore: boolean;
  loadingMore: boolean;
  live: 'off' | 'stream' | 'poll';
  lastUpdate?: number;
}

const CACHE_MAX = 6000;
const cacheKey = (s: string, iv: string, adj: string) => `bars:v1:${s}:${iv}:${adj}`;

/** Replace/append the tail of a bar array with fresh bars (live updates). */
export function mergeTail(bars: Bar[], fresh: Bar[]): Bar[] {
  if (!fresh.length) return bars;
  if (!bars.length) return fresh.slice();
  const out = bars.slice();
  for (const b of fresh) {
    const last = out[out.length - 1];
    if (b.t > last.t) out.push(b);
    else if (b.t === last.t) out[out.length - 1] = b;
    else {
      // replace an earlier bar in place (e.g. the previous bar finalized)
      for (let k = out.length - 2; k >= Math.max(0, out.length - 10); k--)
        if (out[k].t === b.t) {
          out[k] = b;
          break;
        }
    }
  }
  return out;
}

const BINANCE_IV: Partial<Record<Interval, string>> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w', '1M': '1M' };

function pollMs(iv: Interval, sim: boolean): number {
  if (sim) return 5000;
  const ms = INTERVAL_MS[iv];
  return ms <= 300_000 ? 15_000 : ms <= 3_600_000 ? 30_000 : 60_000;
}

export function useBars(symbol: string, interval: Interval, adjust: AdjustMode, enabled = true): BarsState & { loadMore(): void; reload(): void } {
  const [st, setSt] = useState<BarsState>({ bars: [], info: null, status: 'idle', hasMore: false, loadingMore: false, live: 'off' });
  const ref = useRef(st);
  ref.current = st;
  const live = useSettings((s) => s.live);
  const [nonce, setNonce] = useState(0);

  // initial load: IndexedDB snapshot first (instant), then the network
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    let cancelled = false;
    const key = cacheKey(symbol, interval, adjust);
    setSt({ bars: [], info: null, status: 'loading', hasMore: false, loadingMore: false, live: 'off' });
    idbGet<{ bars: Bar[]; info: SymbolInfo; provider: string; simulated: boolean }>(key)
      .then((c) => {
        if (!cancelled && c && ref.current.status === 'loading' && !ref.current.bars.length) setSt((s) => ({ ...s, bars: c.bars, info: c.info, provider: c.provider, simulated: c.simulated }));
      })
      .catch(() => {});
    fetchBarsClient(symbol, interval, { adjust, limit: 1500, signal: ctrl.signal })
      .then((r) => {
        if (cancelled) return;
        setSt({ bars: r.bars, info: r.info, status: 'ready', provider: r.local ? 'sim (in-browser)' : r.provider, simulated: r.simulated, fallbacks: r.fallbacks, hasMore: r.hasMore, loadingMore: false, live: 'off', lastUpdate: Date.now() });
        idbSet(key, { bars: r.bars.slice(-CACHE_MAX), info: r.info, provider: r.provider, simulated: r.simulated }).catch(() => {});
      })
      .catch((e) => {
        if (cancelled || ctrl.signal.aborted) return;
        const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
        setSt((s) => ({ ...s, status: s.bars.length ? 'ready' : 'error', error: s.bars.length ? `offline — showing cached bars (${msg})` : msg }));
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [symbol, interval, adjust, enabled, nonce]);

  // live updates: Binance WebSocket for crypto, polling otherwise (only while the market is open)
  useEffect(() => {
    if (!enabled || !live || st.status !== 'ready') return;
    const p = parseSymbol(symbol);
    const sim = p.provider === 'sim';
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let pending: Bar | null = null;
    let raf = 0;

    const apply = (fresh: Bar[]) => setSt((s) => ({ ...s, bars: mergeTail(s.bars, fresh), lastUpdate: Date.now() }));
    const startPoll = () => {
      if (stopped || timer) return;
      setSt((s) => ({ ...s, live: 'poll' }));
      let lastPoll = 0;
      const tick = async () => {
        const cal = ref.current.info?.calendar ?? '24x7';
        // market closed: poll rarely (still picks up the official close / late prints)
        if (!sim && cal !== '24x7' && !isOpen(cal, Date.now()) && Date.now() - lastPoll < 600_000) return;
        lastPoll = Date.now();
        try {
          const r = await fetchBarsClient(symbol, interval, { adjust, limit: 3 });
          if (!stopped) apply(r.bars);
        } catch {
          /* transient — next tick */
        }
      };
      timer = setInterval(tick, pollMs(interval, sim));
    };
    const biv = BINANCE_IV[interval];
    if (p.provider === 'binance' && biv && typeof WebSocket !== 'undefined') {
      try {
        ws = new WebSocket(`wss://data-stream.binance.vision/ws/${p.ticker.toLowerCase()}@kline_${biv}`);
        ws.onopen = () => setSt((s) => ({ ...s, live: 'stream' }));
        ws.onmessage = (ev) => {
          const k = JSON.parse(String(ev.data))?.k;
          if (!k) return;
          pending = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, ...(k.x ? {} : { final: false }) };
          if (!raf)
            raf = requestAnimationFrame(() => {
              raf = 0;
              if (pending) apply([pending]);
              pending = null;
            });
        };
        ws.onerror = () => {
          ws?.close();
          startPoll();
        };
        ws.onclose = () => {
          if (!stopped) startPoll();
        };
      } catch {
        startPoll();
      }
    } else startPoll();
    return () => {
      stopped = true;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      if (timer) clearInterval(timer);
      if (raf) cancelAnimationFrame(raf);
      setSt((s) => ({ ...s, live: 'off' }));
    };
  }, [symbol, interval, adjust, enabled, live, st.status]);

  const loadMore = useCallback(() => {
    const s = ref.current;
    if (!s.hasMore || s.loadingMore || !s.bars.length) return;
    setSt((x) => ({ ...x, loadingMore: true }));
    fetchBarsClient(symbol, interval, { adjust, limit: 1500, to: s.bars[0].t })
      .then((r) => setSt((x) => ({ ...x, bars: mergeBars(r.bars, x.bars), hasMore: r.hasMore && r.bars.length > 0, loadingMore: false })))
      .catch(() => setSt((x) => ({ ...x, loadingMore: false, hasMore: false })));
  }, [symbol, interval, adjust]);

  return { ...st, loadMore, reload: () => setNonce((n) => n + 1) };
}

/** One-shot fetch with an in-memory cache (panels: TD status D/W/M, tester, portfolio history). */
const memo = new Map<string, { at: number; p: Promise<Bar[]> }>();
export function getBarsCached(symbol: string, interval: Interval, limit = 1500, ttlMs = 120_000): Promise<Bar[]> {
  const k = `${symbol}|${interval}|${limit}`;
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p;
  const p = fetchBarsClient(symbol, interval, { limit }).then((r) => r.bars);
  p.catch(() => memo.delete(k));
  memo.set(k, { at: Date.now(), p });
  return p;
}

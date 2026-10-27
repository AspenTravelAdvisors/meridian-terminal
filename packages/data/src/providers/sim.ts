import type { Bar, Interval, MarketDataProvider, SymbolInfo } from '../types';
import { INTERVAL_MS } from '../types';
import { resample } from '../transform';

/**
 * Deterministic simulated market ("SIM:*"). The same symbol + time always yields the same prices, so
 * charts, tests and demos are reproducible offline. Always flagged `simulated: true` and badged in the UI.
 *
 * Daily path: regime-switching GBM with volatility clustering (GARCH-like) from 2012-01-02.
 * Intraday: a Brownian bridge between each day's open and close, so closes agree across intervals.
 */
const DAY = 86_400_000;
const EPOCH = Date.UTC(2012, 0, 2);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-12, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, gauss };
}

interface Profile {
  start: number;
  drift: number;
  vol: number;
  meanRevert: number;
  cycle: number;
}

function profile(sym: string): Profile {
  if (sym === 'TREND') return { start: 50, drift: 0.0009, vol: 0.016, meanRevert: 0, cycle: 0 };
  if (sym === 'CHOP') return { start: 100, drift: 0, vol: 0.014, meanRevert: 0.04, cycle: 0 };
  const h = hash(sym);
  return { start: 20 + (h % 400), drift: ((h >>> 9) % 7) * 0.0001, vol: 0.012 + ((h >>> 3) % 10) * 0.0012, meanRevert: 0.002, cycle: 60 + ((h >>> 5) % 90) };
}

const dailyCache = new Map<string, Bar[]>();

/** Daily bars from EPOCH through the day containing `now` (the last day is provisional). */
export function simDaily(sym: string, now: number): Bar[] {
  const lastDay = Math.floor((now - EPOCH) / DAY);
  const key = `${sym}|${lastDay}`;
  const hit = dailyCache.get(key);
  if (hit) return hit;
  const p = profile(sym);
  const r = rng(hash(`daily:${sym}`));
  const out: Bar[] = [];
  let c = p.start;
  let vol = p.vol;
  const anchor = p.start;
  for (let d = 0; d <= lastDay; d++) {
    const regime = p.cycle ? Math.sin((2 * Math.PI * d) / p.cycle) * 0.004 + Math.sin((2 * Math.PI * d) / (p.cycle * 4.3)) * 0.002 : 0;
    const shock = r.gauss();
    vol = Math.sqrt(0.9 * vol * vol + 0.1 * p.vol * p.vol * (0.5 + shock * shock * 0.5));
    const mr = p.meanRevert ? p.meanRevert * Math.log(anchor / c) : 0;
    const ret = p.drift + regime + mr + vol * shock;
    const o = c * (1 + vol * 0.15 * r.gauss());
    const nc = Math.max(0.5, o * Math.exp(ret));
    const span = Math.abs(nc - o) + nc * vol * (0.3 + r.next() * 0.9);
    const h = Math.max(o, nc) + span * r.next() * 0.6;
    const l = Math.max(0.01, Math.min(o, nc) - span * r.next() * 0.6);
    out.push({ t: EPOCH + d * DAY, o, h, l, c: nc, v: Math.round(5e5 * (1 + 3 * Math.abs(shock)) * (1 + r.next())) });
    c = nc;
  }
  if (dailyCache.size > 64) dailyCache.clear();
  dailyCache.set(key, out);
  return out;
}

/** Intraday path for one day at `steps` resolution: Brownian bridge o → c clamped inside [l, h]. */
function dayPath(sym: string, day: Bar, steps: number): number[] {
  const r = rng(hash(`intra:${sym}:${day.t}:${steps}`));
  const pts = [day.o];
  let w = 0;
  const raw: number[] = [0];
  for (let k = 1; k <= steps; k++) {
    w += r.gauss();
    raw.push(w);
  }
  const end = raw[steps];
  for (let k = 1; k <= steps; k++) {
    const frac = k / steps;
    const bridge = raw[k] - frac * end; // pinned at 0 on both ends
    const base = day.o + (day.c - day.o) * frac;
    const amp = (day.h - day.l) / Math.max(1, Math.sqrt(steps)) / 1.5;
    pts.push(Math.min(day.h, Math.max(day.l, base + bridge * amp)));
  }
  pts[steps] = day.c;
  return pts;
}

export function simBars(sym: string, interval: Interval, now: number, to: number | undefined, limit: number): Bar[] {
  const daily = simDaily(sym, now);
  const end = Math.min(to ?? Infinity, now + 1);
  if (interval === '1D' || interval === '1W' || interval === '1M' || interval === '3M') {
    let bars = daily.map((b, k) => (k === daily.length - 1 ? { ...b, final: false } : b));
    if (interval !== '1D') bars = resample(bars, interval, '24x7', now);
    bars = bars.filter((b) => b.t < end);
    return bars.slice(-limit);
  }
  const ivMs = INTERVAL_MS[interval];
  const steps = Math.round(DAY / ivMs);
  const out: Bar[] = [];
  // walk back day by day until we have `limit` bars before `end`
  let d = Math.floor((Math.min(end, now) - EPOCH) / DAY);
  const chunks: Bar[][] = [];
  let count = 0;
  while (d >= 0 && count < limit) {
    const day = daily[d];
    const path = dayPath(sym, day, steps);
    const r = rng(hash(`vol:${sym}:${day.t}:${steps}`));
    const chunk: Bar[] = [];
    for (let k = 0; k < steps; k++) {
      const t = day.t + k * ivMs;
      if (t >= end) break;
      const o = path[k];
      let c = path[k + 1];
      const forming = t + ivMs > now;
      if (forming) {
        // deterministic partial bar: interpolate toward the close by elapsed fraction
        const frac = Math.max(0, Math.min(1, (now - t) / ivMs));
        c = o + (c - o) * frac;
      }
      const wig = Math.abs(c - o) * 0.6 + o * 0.0008 * (0.5 + r.next());
      const b: Bar = { t, o, h: Math.max(o, c) + wig * r.next(), l: Math.min(o, c) - wig * r.next(), c, v: Math.round((day.v / steps) * (0.4 + 1.2 * r.next())) };
      if (forming) b.final = false;
      chunk.push(b);
    }
    chunks.push(chunk);
    count += chunk.length;
    d--;
  }
  for (let k = chunks.length - 1; k >= 0; k--) out.push(...chunks[k]);
  return out.slice(-limit);
}

export const simInfo = (sym: string): SymbolInfo => ({
  symbol: `SIM:${sym}`,
  name: sym === 'DEMO' ? 'Simulated demo series' : sym === 'TREND' ? 'Simulated trending series' : sym === 'CHOP' ? 'Simulated range-bound series' : `Simulated ${sym}`,
  exchange: 'Meridian (simulated)',
  type: 'sim',
  currency: 'USD',
  calendar: '24x7',
  timezone: 'UTC',
  provider: 'sim',
});

export const sim: MarketDataProvider = {
  id: 'sim',
  async getBars(ticker, interval, opts) {
    const now = opts.now ?? Date.now();
    const limit = Math.min(opts.limit ?? 1500, 20000);
    const bars = simBars(ticker, interval, now, opts.to, limit);
    return { provider: 'sim', info: simInfo(ticker), bars, events: { splits: [], dividends: [] }, simulated: true, hasMore: bars.length > 0 && bars[0].t > EPOCH };
  },
  async getQuotes(tickers, _f, now) {
    return tickers.map((t) => {
      const d = simDaily(t, now);
      const last = d[d.length - 1];
      const prev = d[d.length - 2] ?? last;
      return { symbol: `SIM:${t}`, last: last.c, prevClose: prev.c, change: last.c - prev.c, changePct: (100 * (last.c - prev.c)) / prev.c, t: now, simulated: true };
    });
  },
};

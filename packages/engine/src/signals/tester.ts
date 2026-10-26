import type { Bar, SignalDir } from '../core/types';

/** Deterministic PRNG (mulberry32) for random-entry baselines — seeded, never Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TestEvent {
  i: number;
  dir: SignalDir;
  symbol?: string;
}

export interface HorizonStats {
  horizon: number;
  n: number;
  mean: number;
  median: number;
  stdev: number;
  hitRate: number;
  /** mean adverse / favourable excursion (%), directional */
  mae: number;
  mfe: number;
  p10: number;
  p90: number;
  /** t-statistic of the mean vs zero */
  t: number;
  baseline: { n: number; mean: number; median: number; hitRate: number } | null;
  /** mean − baseline mean (percentage points) */
  edge: number | null;
  returns: number[];
}

export interface EventStudyResult {
  events: number;
  horizons: HorizonStats[];
}

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return NaN;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
};

function directionalReturns(bars: readonly Bar[], i: number, h: number, sign: number) {
  const entry = bars[i].c;
  let mae = 0;
  let mfe = 0;
  for (let k = i + 1; k <= i + h; k++) {
    const up = (100 * (bars[k].h - entry)) / entry;
    const dn = (100 * (bars[k].l - entry)) / entry;
    const fav = sign > 0 ? up : -dn;
    const adv = sign > 0 ? dn : -up;
    if (fav > mfe) mfe = fav;
    if (adv < mae) mae = adv;
  }
  return { ret: (sign * 100 * (bars[i + h].c - entry)) / entry, mae, mfe };
}

/**
 * Event study: what happened N bars after each signal? Entry = close of the signal bar (the signal is
 * only known at the close). Returns are directional (bear signals are measured short). Compared with a
 * seeded random-entry baseline over the same bars.
 */
export function eventStudy(
  bars: readonly Bar[],
  events: readonly TestEvent[],
  horizons: readonly number[] = [1, 5, 10, 20, 60],
  opts: { baselineSamples?: number; seed?: number } = {},
): EventStudyResult {
  const samples = opts.baselineSamples ?? 500;
  const rnd = mulberry32(opts.seed ?? 1337);
  const out: HorizonStats[] = [];
  for (const h of horizons) {
    const rets: number[] = [];
    let maeSum = 0;
    let mfeSum = 0;
    for (const e of events) {
      if (e.i + h >= bars.length || e.i < 0) continue;
      const sign = e.dir === 'bear' ? -1 : 1;
      const r = directionalReturns(bars, e.i, h, sign);
      rets.push(r.ret);
      maeSum += r.mae;
      mfeSum += r.mfe;
    }
    const n = rets.length;
    const sorted = rets.slice().sort((a, b) => a - b);
    const mean = n ? rets.reduce((a, b) => a + b, 0) / n : NaN;
    const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
    // baseline: random entries, same direction mix as the events
    let baseline: HorizonStats['baseline'] = null;
    const maxI = bars.length - 1 - h;
    if (maxI > 0 && samples > 0) {
      const bearShare = events.length ? events.filter((e) => e.dir === 'bear').length / events.length : 0;
      const br: number[] = [];
      for (let k = 0; k < samples; k++) {
        const i = Math.floor(rnd() * maxI);
        const sign = rnd() < bearShare ? -1 : 1;
        br.push((sign * 100 * (bars[i + h].c - bars[i].c)) / bars[i].c);
      }
      const bs = br.slice().sort((a, b) => a - b);
      baseline = { n: br.length, mean: br.reduce((a, b) => a + b, 0) / br.length, median: quantile(bs, 0.5), hitRate: br.filter((r) => r > 0).length / br.length };
    }
    out.push({
      horizon: h,
      n,
      mean,
      median: quantile(sorted, 0.5),
      stdev: sd,
      hitRate: n ? rets.filter((r) => r > 0).length / n : NaN,
      mae: n ? maeSum / n : NaN,
      mfe: n ? mfeSum / n : NaN,
      p10: quantile(sorted, 0.1),
      p90: quantile(sorted, 0.9),
      t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN,
      baseline,
      edge: baseline && n ? mean - baseline.mean : null,
      returns: rets,
    });
  }
  return { events: events.length, horizons: out };
}

/** Histogram bins for a return distribution. */
export function histogram(values: readonly number[], bins = 20): { x0: number; x1: number; n: number }[] {
  if (!values.length) return [];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const w = (hi - lo) / bins;
  const out = Array.from({ length: bins }, (_, k) => ({ x0: lo + k * w, x1: lo + (k + 1) * w, n: 0 }));
  for (const v of values) out[Math.min(bins - 1, Math.floor((v - lo) / w))].n++;
  return out;
}

// ── Strategy mode ───────────────────────────────────────────────────────────
export interface StrategyConfig {
  entries: readonly TestEvent[];
  /** exits by opposite signal (events of the opposite direction) */
  exitOnOpposite: boolean;
  stop: 'none' | 'pct' | 'atr' | 'level';
  stopPct: number;
  atrMult: number;
  atrLength: number;
  /** per-bar stop levels for long / short entries (e.g. a TD risk level), read at entry */
  stopLevels?: { long?: ArrayLike<number>; short?: ArrayLike<number> };
  timeStopBars: number; // 0 = off
  takeProfitPct: number; // 0 = off
  feesBps: number;
  slippageBps: number;
  entryAt: 'nextOpen' | 'close';
  allowShort: boolean;
}

export interface Trade {
  entryI: number;
  exitI: number;
  dir: 1 | -1;
  entry: number;
  exit: number;
  ret: number; // % net of costs
  reason: 'opposite' | 'stop' | 'target' | 'time' | 'end';
}

export interface StrategyResult {
  trades: Trade[];
  equity: Float64Array; // equity multiple per bar (starts at 1)
  stats: {
    trades: number;
    winRate: number;
    totalReturn: number;
    profitFactor: number;
    avgTrade: number;
    maxDrawdown: number;
    sharpe: number;
    exposure: number;
    buyHold: number;
  };
}

export function runStrategy(bars: readonly Bar[], cfg: StrategyConfig): StrategyResult {
  const n = bars.length;
  const equity = new Float64Array(n).fill(1);
  const trades: Trade[] = [];
  const byBar = new Map<number, TestEvent[]>();
  for (const e of cfg.entries) {
    const arr = byBar.get(e.i) ?? [];
    arr.push(e);
    byBar.set(e.i, arr);
  }
  // Wilder ATR for ATR stops
  const atr = new Float64Array(n).fill(NaN);
  {
    let a = NaN;
    for (let i = 1; i < n; i++) {
      const tr = Math.max(bars[i].h, bars[i - 1].c) - Math.min(bars[i].l, bars[i - 1].c);
      a = Number.isNaN(a) ? tr : a + (tr - a) / cfg.atrLength;
      atr[i] = i >= cfg.atrLength ? a : NaN;
    }
  }
  const cost = (cfg.feesBps + cfg.slippageBps) / 10_000;
  type Pos = { dir: 1 | -1; entryI: number; entry: number; stop: number; target: number };
  const S: { pos: Pos | null } = { pos: null };
  let eq = 1;
  let barsIn = 0;
  let pending: TestEvent | null = null;

  const close = (i: number, price: number, reason: Trade['reason']) => {
    if (!S.pos) return;
    const gross = S.pos.dir * (price - S.pos.entry) / S.pos.entry;
    const net = (1 + gross) * (1 - cost) * (1 - cost) - 1;
    trades.push({ entryI: S.pos.entryI, exitI: i, dir: S.pos.dir, entry: S.pos.entry, exit: price, ret: 100 * net, reason });
    eq *= 1 + net;
    S.pos = null;
  };
  const open = (i: number, ev: TestEvent, price: number) => {
    const dir: 1 | -1 = ev.dir === 'bear' ? -1 : 1;
    if (dir < 0 && !cfg.allowShort) return;
    let stop = NaN;
    if (cfg.stop === 'pct') stop = price * (1 - dir * cfg.stopPct / 100);
    else if (cfg.stop === 'atr' && Number.isFinite(atr[ev.i])) stop = price - dir * cfg.atrMult * atr[ev.i];
    else if (cfg.stop === 'level') {
      const lv = dir > 0 ? cfg.stopLevels?.long?.[ev.i] : cfg.stopLevels?.short?.[ev.i];
      if (lv !== undefined && Number.isFinite(lv) && (dir > 0 ? lv < price : lv > price)) stop = lv;
    }
    const target = cfg.takeProfitPct > 0 ? price * (1 + dir * cfg.takeProfitPct / 100) : NaN;
    S.pos = { dir, entryI: i, entry: price, stop, target };
  };

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    // 1) fill a pending next-open entry
    if (pending && !S.pos) open(i, pending, b.o);
    pending = null;
    // 2) manage the open position intrabar (stops before targets: conservative)
    if (S.pos && i > S.pos.entryI) {
      const p = S.pos;
      if (Number.isFinite(p.stop) && (p.dir > 0 ? b.l <= p.stop : b.h >= p.stop)) close(i, p.dir > 0 ? Math.min(b.o, p.stop) : Math.max(b.o, p.stop), 'stop');
      else if (Number.isFinite(p.target) && (p.dir > 0 ? b.h >= p.target : b.l <= p.target)) close(i, p.dir > 0 ? Math.max(b.o, p.target) : Math.min(b.o, p.target), 'target');
      else if (cfg.timeStopBars > 0 && i - p.entryI >= cfg.timeStopBars) close(i, b.c, 'time');
    }
    // 3) signals at this bar's close
    const evs = byBar.get(i);
    if (evs)
      for (const ev of evs) {
        const dir = ev.dir === 'bear' ? -1 : ev.dir === 'bull' ? 1 : 0;
        if (dir === 0) continue;
        if (S.pos && cfg.exitOnOpposite && S.pos.dir !== dir) close(i, b.c, 'opposite');
        if (!S.pos) {
          if (cfg.entryAt === 'close') open(i, ev, b.c);
          else pending = ev;
        }
      }
    if (S.pos) barsIn++;
    equity[i] = S.pos ? eq * (1 + (S.pos.dir * (b.c - S.pos.entry)) / S.pos.entry) : eq;
  }
  if (S.pos) close(n - 1, bars[n - 1].c, 'end');
  if (n) equity[n - 1] = eq;

  // stats
  const wins = trades.filter((t) => t.ret > 0);
  const grossWin = wins.reduce((a, t) => a + t.ret, 0);
  const grossLoss = -trades.filter((t) => t.ret <= 0).reduce((a, t) => a + t.ret, 0);
  let peak = -Infinity;
  let mdd = 0;
  const rets: number[] = [];
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, equity[i]);
    mdd = Math.min(mdd, equity[i] / peak - 1);
    if (i > 0) rets.push(equity[i] / equity[i - 1] - 1);
  }
  const m = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) : 0;
  return {
    trades,
    equity,
    stats: {
      trades: trades.length,
      winRate: trades.length ? wins.length / trades.length : NaN,
      totalReturn: 100 * (eq - 1),
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
      avgTrade: trades.length ? trades.reduce((a, t) => a + t.ret, 0) / trades.length : NaN,
      maxDrawdown: 100 * mdd,
      sharpe: sd > 0 ? (m / sd) * Math.sqrt(252) : NaN,
      exposure: n ? barsIn / n : 0,
      buyHold: n > 1 ? (100 * (bars[n - 1].c - bars[0].c)) / bars[0].c : 0,
    },
  };
}

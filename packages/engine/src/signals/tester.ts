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

/** An inclusive bar-index window [start, end]. */
export interface BarRange {
  start: number;
  end: number;
}

/**
 * Event study: what happened N bars after each signal? Entry = close of the signal bar (the signal is
 * only known at the close). Returns are directional (bear signals are measured short). Compared with a
 * seeded random-entry baseline over the same bars.
 *
 * With `range`, only signals inside it count, and only when their whole horizon also ends inside it (bar i + h ≤ end):
 * results for a period never read bars after the period. Baseline entries are drawn from the same window.
 */
export function eventStudy(
  bars: readonly Bar[],
  events: readonly TestEvent[],
  horizons: readonly number[] = [1, 5, 10, 20, 60],
  opts: { baselineSamples?: number; seed?: number; range?: BarRange } = {},
): EventStudyResult {
  const samples = opts.baselineSamples ?? 500;
  const rnd = mulberry32(opts.seed ?? 1337);
  const start = Math.max(0, opts.range?.start ?? 0);
  const end = Math.min(bars.length - 1, opts.range?.end ?? bars.length - 1);
  const inRange = events.filter((e) => e.i >= start && e.i <= end);
  const out: HorizonStats[] = [];
  for (const h of horizons) {
    const rets: number[] = [];
    let maeSum = 0;
    let mfeSum = 0;
    for (const e of inRange) {
      if (e.i + h > end || e.i < 0) continue;
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
    const span = end - h - start;
    if (span > 0 && samples > 0) {
      const bearShare = inRange.length ? inRange.filter((e) => e.dir === 'bear').length / inRange.length : 0;
      const br: number[] = [];
      for (let k = 0; k < samples; k++) {
        const i = start + Math.floor(rnd() * span);
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
  return { events: inRange.length, horizons: out };
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
export type SizingMode = 'percentEquity' | 'fixedDollar' | 'riskPercent' | 'fixedShares';

export interface StrategyConfig {
  entries: readonly TestEvent[];
  /** exit events: dir 'bull' closes a long, 'bear' closes a short (combined-rule exits) */
  exits?: readonly TestEvent[];
  /** when signal exits (exit events, opposite signals) fill; default 'close' */
  exitAt?: 'nextOpen' | 'close';
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

  // capital and execution assumptions (defaults reproduce one fully-invested position at a time)
  /** starting capital in dollars (default 100,000) */
  capital?: number;
  /** position size: % of equity (default 100), dollars, % of equity risked to the stop, or a share count */
  sizing?: { mode: SizingMode; value: number };
  /** open positions allowed at once (default 1); signals beyond it are skipped and counted */
  maxPositions?: number;
  /** whole shares only (default false: fractional) */
  wholeShares?: boolean;
  /** fixed commission per order, dollars (default 0) */
  commission?: number;
  /** a bar that opens beyond the stop (or target) fills at the open (default, realistic) or at the level itself */
  gapFill?: 'open' | 'level';
  /** when one bar touches both stop and target: stop first (default, conservative), target first, or whichever is nearer the open */
  sameBar?: 'stopFirst' | 'targetFirst' | 'nearerOpen';
  /** check stops and targets on the entry bar itself when entering at its open (default true) */
  stopOnEntryBar?: boolean;
}

export interface Trade {
  entryI: number;
  exitI: number;
  dir: 1 | -1;
  entry: number;
  exit: number;
  ret: number; // % net of costs, on the position's own notional
  reason: 'opposite' | 'exit' | 'stop' | 'target' | 'time' | 'end';
  shares: number;
  /** dollars committed at entry */
  notional: number;
  /** dollar result net of fees, slippage and commissions */
  pnl: number;
  /** the exit came from a bar that gapped through the level, or touched both stop and target */
  gap?: boolean;
  ambiguous?: boolean;
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
    startCapital: number;
    endCapital: number;
    /** most positions open at once */
    maxConcurrent: number;
    /** average share of equity invested per bar (0 when flat), for exposure-matched benchmarks */
    avgGrossExposure: number;
    /** exits on bars that touched both stop and target (resolved by `sameBar`) */
    ambiguousExits: number;
    /** stop/target exits on bars that opened beyond the level (resolved by `gapFill`) */
    gapExits: number;
    /** entry signals not taken, by reason */
    skipped: { maxPositions: number; noCapital: number; noStop: number; tooSmall: number; shortsOff: number };
  };
}

/**
 * Simulate the strategy with dollar accounting. With `range`, entries are taken only from signals inside it, open
 * positions close at the range's last close, and `equity` / stats cover the range only (equity starts at 1 on its first
 * bar). Indicators such as ATR still warm up on earlier bars; nothing after the range is read.
 *
 * Execution rules (all in `StrategyConfig`): positions are sized from equity at the signal; gross exposure never exceeds
 * equity (no leverage); costs are fees + slippage in bps per side plus a fixed commission per order; stops are checked
 * before targets unless `sameBar` says otherwise; a bar opening beyond a level fills per `gapFill`.
 */
export function runStrategy(allBars: readonly Bar[], cfg: StrategyConfig, range?: BarRange): StrategyResult {
  const start = Math.max(0, range?.start ?? 0);
  const bars = allBars.slice(0, Math.min(allBars.length - 1, range?.end ?? allBars.length - 1) + 1);
  const n = bars.length;
  const capital = cfg.capital && cfg.capital > 0 ? cfg.capital : 100_000;
  const sizing = cfg.sizing ?? { mode: 'percentEquity' as const, value: 100 };
  const maxPos = Math.max(1, Math.round(cfg.maxPositions ?? 1));
  const commission = Math.max(0, cfg.commission ?? 0);
  const gapAtOpen = (cfg.gapFill ?? 'open') === 'open';
  const sameBar = cfg.sameBar ?? 'stopFirst';
  const stopOnEntryBar = cfg.stopOnEntryBar ?? true;
  const equity = new Float64Array(n).fill(1);
  const trades: Trade[] = [];
  const index = (evs: readonly TestEvent[] | undefined) => {
    const m = new Map<number, TestEvent[]>();
    for (const e of evs ?? []) {
      if (e.i < start) continue;
      const arr = m.get(e.i) ?? [];
      arr.push(e);
      m.set(e.i, arr);
    }
    return m;
  };
  const byBar = index(cfg.entries);
  const exitsByBar = index(cfg.exits);
  const exitNextOpen = cfg.exitAt === 'nextOpen';
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
  type Pos = { dir: 1 | -1; entryI: number; entry: number; stop: number; target: number; notional: number; shares: number; atOpen: boolean };
  let open: Pos[] = [];
  let cash = capital;
  let barsIn = 0;
  let maxConcurrent = 0;
  let grossSum = 0;
  let ambiguousExits = 0;
  let gapExits = 0;
  const skipped = { maxPositions: 0, noCapital: 0, noStop: 0, tooSmall: 0, shortsOff: 0 };
  let pending: TestEvent[] = [];
  const pendingExit = new Map<1 | -1, Trade['reason']>();

  const mark = (p: Pos, price: number) => p.notional * (1 + (p.dir * (price - p.entry)) / p.entry);
  const equityAt = (price: number) => cash + open.reduce((a, p) => a + mark(p, price), 0);
  const close = (p: Pos, i: number, price: number, reason: Trade['reason'], flags: { gap?: boolean; ambiguous?: boolean } = {}) => {
    const gross = (p.dir * (price - p.entry)) / p.entry;
    const net = (1 + gross) * (1 - cost) * (1 - cost) - 1;
    const pnl = p.notional * net - 2 * commission;
    cash += p.notional + pnl;
    trades.push({ entryI: p.entryI, exitI: i, dir: p.dir, entry: p.entry, exit: price, ret: 100 * net, reason, shares: p.shares, notional: p.notional, pnl, ...(flags.gap ? { gap: true } : {}), ...(flags.ambiguous ? { ambiguous: true } : {}) });
    open = open.filter((x) => x !== p);
  };
  const closeSide = (dir: 1 | -1, i: number, price: number, reason: Trade['reason']) => {
    for (const p of open.filter((x) => x.dir === dir)) close(p, i, price, reason);
  };
  const tryOpen = (i: number, ev: TestEvent, price: number, atOpen: boolean, eqRef: number) => {
    const dir: 1 | -1 = ev.dir === 'bear' ? -1 : 1;
    if (dir < 0 && !cfg.allowShort) return void skipped.shortsOff++;
    if (open.length >= maxPos) return void skipped.maxPositions++;
    let stop = NaN;
    if (cfg.stop === 'pct') stop = price * (1 - (dir * cfg.stopPct) / 100);
    else if (cfg.stop === 'atr' && Number.isFinite(atr[ev.i])) stop = price - dir * cfg.atrMult * atr[ev.i];
    else if (cfg.stop === 'level') {
      const lv = dir > 0 ? cfg.stopLevels?.long?.[ev.i] : cfg.stopLevels?.short?.[ev.i];
      if (lv !== undefined && Number.isFinite(lv) && (dir > 0 ? lv < price : lv > price)) stop = lv;
    }
    const target = cfg.takeProfitPct > 0 ? price * (1 + (dir * cfg.takeProfitPct) / 100) : NaN;
    // size from equity at the signal, capped so gross exposure stays within equity
    const free = Math.max(0, eqRef - open.reduce((a, p) => a + p.notional, 0));
    let want: number;
    if (sizing.mode === 'percentEquity') want = eqRef * (sizing.value / 100);
    else if (sizing.mode === 'fixedDollar') want = sizing.value;
    else if (sizing.mode === 'fixedShares') want = sizing.value * price;
    else {
      if (!Number.isFinite(stop)) return void skipped.noStop++;
      want = (((eqRef * sizing.value) / 100) / Math.abs(price - stop)) * price;
    }
    let notional = Math.min(want, free);
    if (!(notional > 0)) return void skipped.noCapital++;
    let shares = notional / price;
    if (cfg.wholeShares) {
      shares = Math.floor(shares + 1e-9);
      notional = shares * price;
    }
    if (!(shares > 0)) return void skipped.tooSmall++;
    cash -= notional;
    open.push({ dir, entryI: i, entry: price, stop, target, notional, shares, atOpen });
  };
  /** stop / target / time stop for one position on bar i; true when it closed */
  const manage = (p: Pos, i: number, b: Bar): boolean => {
    if (i === p.entryI && !(p.atOpen && stopOnEntryBar)) return false;
    const hitStop = Number.isFinite(p.stop) && (p.dir > 0 ? b.l <= p.stop : b.h >= p.stop);
    const hitTarget = Number.isFinite(p.target) && (p.dir > 0 ? b.h >= p.target : b.l <= p.target);
    const both = hitStop && hitTarget;
    let first: 'stop' | 'target' | null = hitStop ? 'stop' : hitTarget ? 'target' : null;
    if (both) {
      ambiguousExits++;
      first = sameBar === 'targetFirst' ? 'target' : sameBar === 'nearerOpen' ? (Math.abs(b.o - p.target) < Math.abs(b.o - p.stop) ? 'target' : 'stop') : 'stop';
    }
    if (first) {
      const lvl = first === 'stop' ? p.stop : p.target;
      // gapped through: the open is already beyond the level (only possible on bars after the entry)
      const gapped = i > p.entryI && (first === 'stop' ? (p.dir > 0 ? b.o <= lvl : b.o >= lvl) : p.dir > 0 ? b.o >= lvl : b.o <= lvl);
      if (gapped) gapExits++;
      close(p, i, gapped && gapAtOpen ? b.o : lvl, first, { gap: gapped, ambiguous: both });
      return true;
    }
    if (cfg.timeStopBars > 0 && i - p.entryI >= cfg.timeStopBars) {
      close(p, i, b.c, 'time');
      return true;
    }
    return false;
  };

  for (let i = start; i < n; i++) {
    const b = bars[i];
    const prevC = i > 0 ? bars[i - 1].c : b.o;
    // 0) pending next-open exits, then 1) pending next-open entries (sized from equity at the signal close)
    for (const [dir, reason] of pendingExit) closeSide(dir, i, b.o, reason);
    pendingExit.clear();
    if (pending.length) {
      const eqRef = equityAt(prevC);
      for (const ev of pending) tryOpen(i, ev, b.o, true, eqRef);
      pending = [];
    }
    // 2) intrabar stops, targets and time stops
    for (const p of open.slice()) manage(p, i, b);
    // 3) signals at this bar's close: exits first, then entries
    const exitBy = (dir: 1 | -1, reason: Trade['reason']) => {
      if (!open.some((p) => p.dir === dir) || pendingExit.has(dir)) return;
      if (exitNextOpen) pendingExit.set(dir, reason);
      else closeSide(dir, i, b.c, reason);
    };
    for (const ex of exitsByBar.get(i) ?? []) exitBy(ex.dir === 'bear' ? -1 : 1, 'exit');
    for (const ev of byBar.get(i) ?? []) {
      const dir = ev.dir === 'bear' ? -1 : ev.dir === 'bull' ? 1 : 0;
      if (dir === 0) continue;
      if (cfg.exitOnOpposite) exitBy(dir === 1 ? -1 : 1, 'opposite');
      // positions waiting to exit at the next open free their slot for an entry at that open
      const exitingNext = open.filter((p) => pendingExit.has(p.dir)).length;
      const willHold = open.length - exitingNext + pending.length;
      if (cfg.entryAt === 'close') {
        if (open.length < maxPos || (dir < 0 && !cfg.allowShort)) tryOpen(i, ev, b.c, false, equityAt(b.c));
        else skipped.maxPositions++;
      } else if (willHold < maxPos || (dir < 0 && !cfg.allowShort)) {
        if (dir < 0 && !cfg.allowShort) skipped.shortsOff++;
        else pending.push(ev);
      } else skipped.maxPositions++;
    }
    const eqNow = equityAt(b.c);
    if (open.length) {
      barsIn++;
      grossSum += open.reduce((a, p) => a + mark(p, b.c), 0) / eqNow;
    }
    maxConcurrent = Math.max(maxConcurrent, open.length);
    equity[i] = eqNow / capital;
  }
  for (const p of open.slice()) close(p, n - 1, bars[n - 1].c, 'end');
  if (n) equity[n - 1] = cash / capital;

  const extra = { startCapital: capital, endCapital: cash, maxConcurrent, avgGrossExposure: grossSum / Math.max(1, n - start), ambiguousExits, gapExits, skipped };
  // stats (over the range: rebase indices so callers see equity[0] = the range's first bar)
  if (start > 0) {
    for (const t of trades) {
      t.entryI -= start;
      t.exitI -= start;
    }
    const r = strategyStats(trades, equity.slice(start), bars.slice(start), barsIn, cash / capital);
    return { trades, equity: r.equity, stats: { ...r.stats, ...extra } };
  }
  const r = strategyStats(trades, equity, bars, barsIn, cash / capital);
  return { trades, equity: r.equity, stats: { ...r.stats, ...extra } };
}

function strategyStats(trades: Trade[], equity: Float64Array, bars: readonly Bar[], barsIn: number, eq: number) {
  const n = bars.length;
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

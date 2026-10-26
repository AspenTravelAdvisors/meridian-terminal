import { holdingsOverTime } from './ledger';
import type { Ledger, Transaction } from './types';

const DAY = 86_400_000;
const toT = (d: string) => Date.parse(`${d}T00:00:00Z`);

export interface PriceHistory {
  /** daily closes keyed by YYYY-MM-DD */
  [symbol: string]: Record<string, number>;
}

export interface Valued {
  symbol: string;
  qty: number;
  avgCost: number;
  cost: number;
  last: number;
  prevClose: number;
  value: number;
  unrealized: number;
  unrealizedPct: number;
  dayChange: number;
  dayChangePct: number;
  weight: number;
}

export function valuePositions(ledger: Ledger, quotes: Record<string, { last: number; prevClose: number }>): { rows: Valued[]; total: number; cash: number; invested: number } {
  const cash = Object.values(ledger.cash).reduce((a, b) => a + b, 0);
  const rows = ledger.positions.map((p) => {
    const q = quotes[p.symbol];
    const last = q?.last ?? p.avgCost;
    const prev = q?.prevClose ?? last;
    const value = p.qty * last;
    return {
      symbol: p.symbol,
      qty: p.qty,
      avgCost: p.avgCost,
      cost: p.cost,
      last,
      prevClose: prev,
      value,
      unrealized: value - p.cost,
      unrealizedPct: p.cost ? (100 * (value - p.cost)) / p.cost : 0,
      dayChange: p.qty * (last - prev),
      dayChangePct: prev ? (100 * (last - prev)) / prev : 0,
      weight: 0,
    };
  });
  const invested = rows.reduce((a, r) => a + r.value, 0);
  const total = invested + Math.max(0, cash);
  for (const r of rows) r.weight = total > 0 ? r.value / total : 0;
  return { rows, total, cash, invested };
}

export function realizedSummary(ledger: Ledger, year?: number) {
  const r = year ? ledger.realized.filter((x) => x.closeDate.startsWith(String(year))) : ledger.realized;
  const short = r.filter((x) => x.term === 'short').reduce((a, x) => a + x.gain, 0);
  const long = r.filter((x) => x.term === 'long').reduce((a, x) => a + x.gain, 0);
  return { short, long, total: short + long, count: r.length };
}

/** Allocation buckets, e.g. by asset class / sector / account. */
export function allocation<T extends { value: number }>(rows: T[], key: (r: T) => string): { key: string; value: number; pct: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.value);
  const tot = [...m.values()].reduce((a, b) => a + b, 0);
  return [...m.entries()].map(([k, v]) => ({ key: k, value: v, pct: tot ? v / tot : 0 })).sort((a, b) => b.value - a.value);
}

// ── Equity curve, TWR, XIRR ────────────────────────────────────────────────

export interface EquityPoint {
  date: string;
  value: number;
  flow: number;
  /** daily return excluding flows */
  ret: number;
  /** cumulative time-weighted return (1 = flat) */
  twr: number;
}

/** Calendar days from `from` to `to` inclusive (YYYY-MM-DD). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = toT(from); t <= toT(to); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Daily equity curve from transactions and daily closes (prices are carried forward over non-trading
 * days). When no cash deposits are recorded the curve tracks securities only and treats buys/sells as
 * external flows ("securities-only" mode) so returns are not distorted by a negative cash balance.
 */
export function equityCurve(txs: Transaction[], prices: PriceHistory, to: string): { points: EquityPoint[]; mode: 'cash' | 'securities' } {
  if (!txs.length) return { points: [], mode: 'cash' };
  const from = txs.reduce((m, t) => (t.date < m ? t.date : m), txs[0].date);
  const dates = dateRange(from, to);
  const tracksCash = txs.some((t) => t.type === 'cash_in');
  const held = holdingsOverTime(txs, dates);
  const lastPx: Record<string, number> = {};
  const points: EquityPoint[] = [];
  let twr = 1;
  let prevV = 0;
  const byDate = new Map<string, Transaction[]>();
  for (const t of txs) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
  held.forEach((h, k) => {
    let mv = 0;
    for (const [s, q] of Object.entries(h.qty)) {
      const px = prices[s]?.[h.date];
      if (px !== undefined) lastPx[s] = px;
      if (q && lastPx[s] === undefined) {
        // fall back to the trade price until history is available
        const tx = txs.find((t) => t.symbol?.toUpperCase() === s && t.price);
        if (tx?.price) lastPx[s] = tx.price;
      }
      mv += q * (lastPx[s] ?? 0);
    }
    let flow = h.flow;
    let value = mv + h.cash;
    if (!tracksCash) {
      value = mv;
      flow = 0;
      for (const t of byDate.get(h.date) ?? []) {
        if (t.type === 'buy') flow += (t.qty ?? 0) * (t.price ?? 0) + (t.fee ?? 0);
        if (t.type === 'sell') flow -= (t.qty ?? 0) * (t.price ?? 0) - (t.fee ?? 0);
        if (t.type === 'dividend' || t.type === 'interest') flow -= t.amount ?? 0; // paid out of the securities pool
        if (t.type === 'transfer_in') flow += (t.qty ?? 0) * (t.price ?? 0);
        if (t.type === 'transfer_out') flow -= (t.qty ?? 0) * (t.price ?? 0);
      }
    }
    // flows at the END of the day (trades fill at the day's price, so new money doesn't earn that day's move):
    // r = (V_t − F_t) / V_{t−1} − 1
    const ret = k > 0 && prevV > 0 ? (value - flow) / prevV - 1 : 0;
    twr *= 1 + ret;
    points.push({ date: h.date, value, flow, ret, twr });
    prevV = value;
  });
  return { points, mode: tracksCash ? 'cash' : 'securities' };
}

/** XIRR via Newton–Raphson with a bisection fallback. Flows: negative = invested, positive = returned. */
export function xirr(flows: { date: string; amount: number }[], guess = 0.1): number {
  const f = flows.filter((x) => Number.isFinite(x.amount) && x.amount !== 0).sort((a, b) => a.date.localeCompare(b.date));
  if (f.length < 2 || !f.some((x) => x.amount < 0) || !f.some((x) => x.amount > 0)) return NaN;
  const t0 = toT(f[0].date);
  const yrs = f.map((x) => (toT(x.date) - t0) / (365 * DAY));
  const npv = (r: number) => f.reduce((a, x, k) => a + x.amount / (1 + r) ** yrs[k], 0);
  const d = (r: number) => f.reduce((a, x, k) => a - (yrs[k] * x.amount) / (1 + r) ** (yrs[k] + 1), 0);
  let r = guess;
  for (let k = 0; k < 60; k++) {
    const v = npv(r);
    const dv = d(r);
    if (Math.abs(v) < 1e-9) return r;
    if (!Number.isFinite(dv) || dv === 0) break;
    const next = r - v / dv;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }
  // bisection on (−1, 100]
  let lo = -1 + 1e-10; // very short spans annualize to near −100%
  let hi = 100;
  let flo = npv(lo);
  if (Math.sign(flo) === Math.sign(npv(hi))) return NaN;
  for (let k = 0; k < 300; k++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-12) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Money-weighted return of the portfolio: investor flows plus the terminal value. */
export function moneyWeightedReturn(points: EquityPoint[]): number {
  if (!points.length) return NaN;
  const flows = points.filter((p) => p.flow !== 0).map((p) => ({ date: p.date, amount: -p.flow }));
  const last = points[points.length - 1];
  flows.push({ date: last.date, amount: last.value });
  return xirr(flows);
}

// ── Risk statistics on daily returns ────────────────────────────────────────

export const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
export function stdev(x: number[]): number {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}

export function maxDrawdown(values: number[]): { mdd: number; peakI: number; troughI: number } {
  let peak = -Infinity;
  let peakI = 0;
  let mdd = 0;
  let best = { peakI: 0, troughI: 0 };
  values.forEach((v, i) => {
    if (v > peak) {
      peak = v;
      peakI = i;
    }
    const dd = peak > 0 ? v / peak - 1 : 0;
    if (dd < mdd) {
      mdd = dd;
      best = { peakI, troughI: i };
    }
  });
  return { mdd, ...best };
}

export function riskStats(returns: number[], opts: { rf?: number; periodsPerYear?: number; bench?: number[] } = {}) {
  const P = opts.periodsPerYear ?? 252;
  const rf = (opts.rf ?? 0) / P;
  const ex = returns.map((r) => r - rf);
  const vol = stdev(returns) * Math.sqrt(P);
  const down = returns.filter((r) => r < rf).map((r) => r - rf);
  const dd = down.length > 1 ? Math.sqrt(down.reduce((a, b) => a + b * b, 0) / down.length) * Math.sqrt(P) : NaN;
  const sharpe = (mean(ex) * P) / vol;
  const sortino = (mean(ex) * P) / dd;
  let beta = NaN;
  let corr = NaN;
  if (opts.bench && opts.bench.length === returns.length && returns.length > 2) {
    const mb = mean(opts.bench);
    const mr = mean(returns);
    let cov = 0;
    let vb = 0;
    let vr = 0;
    for (let k = 0; k < returns.length; k++) {
      cov += (returns[k] - mr) * (opts.bench[k] - mb);
      vb += (opts.bench[k] - mb) ** 2;
      vr += (returns[k] - mr) ** 2;
    }
    beta = vb > 0 ? cov / vb : NaN;
    corr = vb > 0 && vr > 0 ? cov / Math.sqrt(vb * vr) : NaN;
  }
  return { vol, sharpe, sortino, beta, corr, var95: historicalVaR(returns, 0.95) };
}

/** One-period historical VaR (as a positive loss fraction) at the given confidence. */
export function historicalVaR(returns: number[], conf = 0.95): number {
  if (returns.length < 10) return NaN;
  const s = returns.slice().sort((a, b) => a - b);
  const idx = Math.floor((1 - conf) * (s.length - 1));
  return -s[idx];
}

export function correlationMatrix(series: Record<string, number[]>): { keys: string[]; m: number[][] } {
  const keys = Object.keys(series);
  const m = keys.map((a) =>
    keys.map((b) => {
      const x = series[a];
      const y = series[b];
      const n = Math.min(x.length, y.length);
      if (n < 3) return NaN;
      const xs = x.slice(-n);
      const ys = y.slice(-n);
      const mx = mean(xs);
      const my = mean(ys);
      let c = 0;
      let vx = 0;
      let vy = 0;
      for (let k = 0; k < n; k++) {
        c += (xs[k] - mx) * (ys[k] - my);
        vx += (xs[k] - mx) ** 2;
        vy += (ys[k] - my) ** 2;
      }
      return vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : NaN;
    }),
  );
  return { keys, m };
}

/** Daily returns from a date→close map, aligned to the given dates (carry forward). */
export function returnsFromCloses(closes: Record<string, number>, dates: string[]): number[] {
  const out: number[] = [];
  let prev = NaN;
  let last = NaN;
  for (const d of dates) {
    if (closes[d] !== undefined) last = closes[d];
    if (Number.isFinite(prev) && Number.isFinite(last)) out.push(last / prev - 1);
    prev = last;
  }
  return out;
}

/** Dividend/interest income by calendar month. */
export function incomeByMonth(ledger: Ledger): { month: string; amount: number; items: { date: string; symbol?: string; amount: number }[] }[] {
  const m = new Map<string, { date: string; symbol?: string; amount: number }[]>();
  for (const i of ledger.income) {
    const k = i.date.slice(0, 7);
    m.set(k, [...(m.get(k) ?? []), { date: i.date, symbol: i.symbol, amount: i.amount }]);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, items]) => ({ month, amount: items.reduce((a, b) => a + b.amount, 0), items }));
}

// ── Position sizing ─────────────────────────────────────────────────────────
export function positionSize(input: { equity: number; riskPct: number; entry: number; stop: number; maxPositionPct?: number; target?: number }) {
  const riskPerShare = Math.abs(input.entry - input.stop);
  const riskAmount = (input.equity * input.riskPct) / 100;
  let shares = riskPerShare > 0 ? Math.floor(riskAmount / riskPerShare) : 0;
  let capped = false;
  if (input.maxPositionPct && input.entry > 0) {
    const maxShares = Math.floor((input.equity * input.maxPositionPct) / 100 / input.entry);
    if (shares > maxShares) {
      shares = maxShares;
      capped = true;
    }
  }
  const dir = input.stop < input.entry ? 'long' : 'short';
  return {
    shares,
    dir,
    riskPerShare,
    riskAmount: shares * riskPerShare,
    positionValue: shares * input.entry,
    pctOfEquity: input.equity ? (100 * shares * input.entry) / input.equity : 0,
    rMultiple: input.target !== undefined && riskPerShare > 0 ? Math.abs(input.target - input.entry) / riskPerShare : null,
    capped,
  };
}

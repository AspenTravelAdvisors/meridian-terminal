import { type OptionType, addDays, bsGreeks, bsPrice, yearFrac } from './options';

// Options overlay for a stock strategy: each stock trade becomes an option trade (calls for longs, puts for shorts),
// priced with Black-Scholes on a MODELLED implied volatility. This is a theoretical simulation, not a backtest on
// historical option quotes: Meridian has no historical options data. Results say so wherever they appear.

export const OPTIONS_OVERLAY_LABEL = 'Theoretical simulation: Black-Scholes on modelled implied volatility, not historical option quotes';

export interface OptionsOverlaySpec {
  /** target days to expiration at entry */
  dte: number;
  /** 'monthly': the third-Friday expiration on or after entry + dte; 'exact': entry + dte calendar days */
  expiryRule: 'monthly' | 'exact';
  strikeBy: 'moneyness' | 'delta';
  /** % out of the money (calls above, puts below the stock); 0 = at the money; negative = in the money */
  moneynessPct: number;
  /** absolute delta to target (0.5 ≈ at the money) */
  delta: number;
  /** strikes are rounded to this increment */
  strikeStep: number;
  /** contracts per trade, or a premium budget in dollars per trade */
  sizing: { mode: 'contracts' | 'premium'; value: number };
  /** bid/ask spread as % of mid, with a minimum width in dollars */
  spreadPct: number;
  minSpread: number;
  feePerContract: number;
  /** implied volatility: a fixed number, or trailing realized volatility × a multiplier, with a floor */
  vol: { mode: 'fixed'; iv: number } | { mode: 'realized'; lookback: number; multiplier: number; floor: number };
  /** report dates (first session that reflects each report): volatility is raised by preBumpPts in the preDays before */
  earnings: { dates: string[]; preBumpPts: number; preDays: number };
  rate: number;
  divYield: number;
  /** close early once days-to-expiration falls to this (0 = hold to the stock exit or expiration) */
  closeAtDte: number;
}

export interface OverlayBar {
  t: number;
  c: number;
}

export interface StockTrade {
  entryI: number;
  exitI: number;
  dir: 1 | -1;
  entry: number;
  exit: number;
}

export interface OptionTrade {
  type: OptionType;
  strike: number;
  expiry: string;
  contracts: number;
  entryDate: string;
  exitDate: string;
  entryStock: number;
  exitStock: number;
  entryIv: number;
  exitIv: number;
  entryAsk: number;
  exitBid: number;
  entryDelta: number;
  /** dollars, net of fees */
  pnl: number;
  /** pnl ÷ (premium + entry fees) */
  returnPct: number;
  stockReturnPct: number;
  exitReason: 'signal' | 'expiry' | 'dte';
  earningsInTrade: boolean;
}

export interface OptionsOverlayResult {
  label: string;
  trades: OptionTrade[];
  /** stock trades with no affordable contract or no usable volatility */
  skipped: number;
  stats: {
    trades: number;
    wins: number;
    winRate: number;
    totalPnl: number;
    premiumSpent: number;
    returnOnPremium: number;
    avgReturnPct: number;
    avgWinUsd: number;
    avgLossUsd: number;
    /** the stock trades' own win rate, for contrast: it is not the options' */
    stockWinRate: number;
    expiredWorthless: number;
  };
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Third Friday of the month containing `iso`. */
function thirdFriday(y: number, m: number): string {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const day = 1 + ((5 - first + 7) % 7) + 14;
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}

/** The monthly (third-Friday) expiration on or after `from` + `dte` days. */
export function monthlyExpiry(from: string, dte: number): string {
  const target = addDays(from, Math.max(0, Math.round(dte)));
  const y = Number(target.slice(0, 4));
  const m = Number(target.slice(5, 7)) - 1;
  const f = thirdFriday(y, m);
  return f >= target ? f : thirdFriday(m === 11 ? y + 1 : y, (m + 1) % 12);
}

/** Strike whose absolute delta is closest to `target`, rounded to `step`. */
export function strikeForDelta(type: OptionType, S: number, target: number, T: number, r: number, q: number, sigma: number, step: number): number {
  let lo = S * 0.2;
  let hi = S * 5;
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    const d = Math.abs(bsGreeks(type, S, mid, T, r, q, sigma).delta);
    // call delta falls as the strike rises; put |delta| rises
    if (type === 'call' ? d > target : d < target) lo = mid;
    else hi = mid;
  }
  return Math.max(step, Math.round((lo + hi) / 2 / step) * step);
}

/** Annualized close-to-close volatility over the `lookback` returns ending at bar i (uses no later bars). */
export function realizedVol(bars: readonly OverlayBar[], i: number, lookback: number): number {
  if (i < lookback || lookback < 2) return NaN;
  const rs: number[] = [];
  for (let k = i - lookback + 1; k <= i; k++) rs.push(Math.log(bars[k].c / bars[k - 1].c));
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt((rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1)) * 252);
}

export function optionsOverlay(bars: readonly OverlayBar[], stockTrades: readonly StockTrade[], spec: OptionsOverlaySpec): OptionsOverlayResult {
  const dates = bars.map((b) => isoDay(b.t));
  const reports = [...spec.earnings.dates].sort();
  const ivAt = (i: number) => {
    const base = spec.vol.mode === 'fixed' ? spec.vol.iv : Math.max(spec.vol.floor, realizedVol(bars, i, spec.vol.lookback) * spec.vol.multiplier);
    const d = dates[i];
    const soon = reports.some((e) => e > d && yearFrac(d, e) * 365 <= spec.earnings.preDays);
    return base + (soon ? spec.earnings.preBumpPts / 100 : 0);
  };
  const half = (mid: number) => Math.max(spec.minSpread / 2, (mid * spec.spreadPct) / 200);
  const out: OptionTrade[] = [];
  let skipped = 0;
  for (const st of stockTrades) {
    const type: OptionType = st.dir > 0 ? 'call' : 'put';
    const d0 = dates[st.entryI];
    const expiry = spec.expiryRule === 'monthly' ? monthlyExpiry(d0, spec.dte) : addDays(d0, Math.round(spec.dte));
    const iv0 = ivAt(st.entryI);
    const T0 = yearFrac(d0, expiry);
    if (!(iv0 > 0) || !(T0 > 0)) {
      skipped++;
      continue;
    }
    const S0 = st.entry;
    const K =
      spec.strikeBy === 'delta'
        ? strikeForDelta(type, S0, spec.delta, T0, spec.rate, spec.divYield, iv0, spec.strikeStep)
        : Math.max(spec.strikeStep, Math.round((S0 * (1 + ((type === 'call' ? 1 : -1) * spec.moneynessPct) / 100)) / spec.strikeStep) * spec.strikeStep);
    const mid0 = bsPrice(type, S0, K, T0, spec.rate, spec.divYield, iv0);
    const ask = mid0 + half(mid0);
    const contracts = spec.sizing.mode === 'contracts' ? Math.max(0, Math.floor(spec.sizing.value)) : Math.floor(spec.sizing.value / (ask * 100));
    if (contracts < 1) {
      skipped++;
      continue;
    }
    // the exit: the stock exit, or earlier at the close-early threshold, or at expiration
    let exitI = st.exitI;
    let reason: OptionTrade['exitReason'] = 'signal';
    for (let i = st.entryI + 1; i <= st.exitI; i++) {
      const dte = yearFrac(dates[i], expiry) * 365;
      if (dates[i] >= expiry || (i < bars.length - 1 && dates[i + 1] > expiry)) {
        exitI = i;
        reason = 'expiry';
        break;
      }
      if (spec.closeAtDte > 0 && dte <= spec.closeAtDte) {
        exitI = i;
        reason = 'dte';
        break;
      }
    }
    const S1 = reason === 'signal' ? st.exit : bars[exitI].c;
    const iv1 = ivAt(exitI);
    let bid: number;
    if (reason === 'expiry') bid = Math.max(0, type === 'call' ? S1 - K : K - S1);
    else {
      const mid1 = bsPrice(type, S1, K, yearFrac(dates[exitI], expiry), spec.rate, spec.divYield, iv1);
      bid = Math.max(0, mid1 - half(mid1));
    }
    const cost = ask * 100 * contracts + spec.feePerContract * contracts;
    const proceeds = bid > 0 ? bid * 100 * contracts - spec.feePerContract * contracts : 0;
    const pnl = proceeds - cost;
    out.push({
      type,
      strike: K,
      expiry,
      contracts,
      entryDate: d0,
      exitDate: dates[exitI],
      entryStock: S0,
      exitStock: S1,
      entryIv: iv0,
      exitIv: iv1,
      entryAsk: ask,
      exitBid: bid,
      entryDelta: bsGreeks(type, S0, K, T0, spec.rate, spec.divYield, iv0).delta,
      pnl,
      returnPct: (100 * pnl) / cost,
      stockReturnPct: (100 * st.dir * (st.exit - st.entry)) / st.entry,
      exitReason: reason,
      earningsInTrade: reports.some((e) => e > d0 && e <= dates[exitI]),
    });
  }
  const wins = out.filter((t) => t.pnl > 0);
  const losses = out.filter((t) => t.pnl <= 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const premiumSpent = out.reduce((a, t) => a + t.entryAsk * 100 * t.contracts + spec.feePerContract * t.contracts, 0);
  const totalPnl = out.reduce((a, t) => a + t.pnl, 0);
  return {
    label: OPTIONS_OVERLAY_LABEL,
    trades: out,
    skipped,
    stats: {
      trades: out.length,
      wins: wins.length,
      winRate: out.length ? wins.length / out.length : NaN,
      totalPnl,
      premiumSpent,
      returnOnPremium: premiumSpent ? (100 * totalPnl) / premiumSpent : NaN,
      avgReturnPct: avg(out.map((t) => t.returnPct)),
      avgWinUsd: avg(wins.map((t) => t.pnl)),
      avgLossUsd: avg(losses.map((t) => t.pnl)),
      stockWinRate: stockTrades.length ? stockTrades.filter((t) => t.dir * (t.exit - t.entry) > 0).length / stockTrades.length : NaN,
      expiredWorthless: out.filter((t) => t.exitReason === 'expiry' && t.exitBid === 0).length,
    },
  };
}

// Option position scenarios: theoretical Black-Scholes values under the user's volatility assumptions.
// Nothing here reads historical option quotes; results are model estimates, and the UI labels them so.
// Pure and deterministic: dates come in as YYYY-MM-DD strings, never from the clock.

export type OptionType = 'call' | 'put';

export interface OptionContract {
  type: OptionType;
  strike: number;
  /** last trading day, YYYY-MM-DD (valued at that day's close) */
  expiry: string;
  /** shares per contract (default 100) */
  multiplier?: number;
}

export interface OptionPosition {
  contract: OptionContract;
  quantity: number;
  /** premium paid per share */
  entryPrice: number;
  entryFeePerContract: number;
}

export interface MarketAssumptions {
  /** risk-free rate, annual, continuous (0.04 = 4%) */
  rate: number;
  /** dividend yield, annual, continuous */
  divYield: number;
  /** implied volatility before the earnings report (0.5 = 50%) */
  ivBefore: number;
  /** implied volatility once the report is out */
  ivAfter: number;
  /** first session that reflects the report, YYYY-MM-DD; omit for no earnings event */
  earningsDate?: string;
}

export interface ExecutionAssumptions {
  /** exits fill at model mid minus this, per share (half the bid/ask spread) */
  halfSpread: number;
  feePerContract: number;
}

export type ScenarioPlan =
  | { kind: 'hold' }
  /** close every contract today at a known price (your bid), whatever happens later */
  | { kind: 'closeNow'; price: number }
  /** a resting limit to sell `quantity` contracts; counts as filled when the modelled bid reaches the limit */
  | { kind: 'sellAtLimit'; quantity: number; limit: number };

export interface ScenarioPoint {
  /** model mid per share */
  mark: number;
  /** modelled exit price per share (mid − half spread, floored at 0) */
  bid: number;
  /** cash after the entry and any sales, net of fees */
  cash: number;
  /** what the contracts still open would fetch if sold at `bid`, net of fees */
  openValue: number;
  openContracts: number;
  /** sellAtLimit only: whether the limit counts as filled in this scenario */
  filled: boolean;
  /** cash + openValue */
  capital: number;
  /** capital − starting cash */
  pnl: number;
}

// ── Normal distribution ─────────────────────────────────────────────────────
/** Cumulative standard normal, double precision (Hart's rational approximation as arranged by G. West). */
export function normCdf(x: number): number {
  const a = Math.abs(x);
  let c: number;
  if (a > 37) c = 0;
  else {
    const e = Math.exp((-a * a) / 2);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-2 * a + 0.700383064443688;
      b = b * a + 6.37396220353165;
      b = b * a + 33.912866078383;
      b = b * a + 112.079291497871;
      b = b * a + 221.213596169931;
      b = b * a + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * a + 1.75566716318264;
      b = b * a + 16.064177579207;
      b = b * a + 86.7807322029461;
      b = b * a + 296.564248779674;
      b = b * a + 637.333633378831;
      b = b * a + 793.826512519948;
      b = b * a + 440.413735824752;
      c /= b;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

const normPdf = (x: number) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);

// ── Black-Scholes (European; for calls on stocks without large dividends this matches American value) ──
/** Theoretical option value per share. T in years; r, q, sigma annual decimals. */
export function bsPrice(type: OptionType, S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0) return Math.max(0, type === 'call' ? S - K : K - S);
  const fwdS = S * Math.exp(-q * T);
  const pvK = K * Math.exp(-r * T);
  if (sigma <= 0) return Math.max(0, type === 'call' ? fwdS - pvK : pvK - fwdS);
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / sd;
  const d2 = d1 - sd;
  return type === 'call' ? fwdS * normCdf(d1) - pvK * normCdf(d2) : pvK * normCdf(-d2) - fwdS * normCdf(-d1);
}

export interface Greeks {
  delta: number;
  gamma: number;
  /** value change per 1 volatility point (0.01) */
  vega: number;
  /** value change from one calendar day passing at the same price and volatility */
  theta: number;
}

export function bsGreeks(type: OptionType, S: number, K: number, T: number, r: number, q: number, sigma: number): Greeks {
  const theta = bsPrice(type, S, K, Math.max(0, T - 1 / 365), r, q, sigma) - bsPrice(type, S, K, T, r, q, sigma);
  if (T <= 0 || sigma <= 0) {
    const itm = type === 'call' ? S > K : S < K;
    return { delta: itm ? (type === 'call' ? 1 : -1) : 0, gamma: 0, vega: 0, theta };
  }
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / sd;
  const dq = Math.exp(-q * T);
  return {
    delta: type === 'call' ? dq * normCdf(d1) : dq * (normCdf(d1) - 1),
    gamma: (dq * normPdf(d1)) / (S * sd),
    vega: (S * dq * normPdf(d1) * Math.sqrt(T)) / 100,
    theta,
  };
}

/** Volatility that reproduces `price` (bisection on 0.01%–500%); NaN when the price is outside no-arbitrage bounds. */
export function impliedVol(price: number, type: OptionType, S: number, K: number, T: number, r: number, q: number): number {
  if (!(T > 0) || !(price > 0)) return NaN;
  let lo = 1e-4;
  let hi = 5;
  if (price <= bsPrice(type, S, K, T, r, q, lo) || price >= bsPrice(type, S, K, T, r, q, hi)) return NaN;
  for (let k = 0; k < 200 && hi - lo > 1e-12; k++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(type, S, K, T, r, q, mid) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Calendar ────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const parseDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const fmtDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => fmtDay(parseDay(iso) + n * DAY);

/** Calendar days from `from` to `to` over 365, floored at 0. */
export function yearFrac(from: string, to: string): number {
  return Math.max(0, Math.round((parseDay(to) - parseDay(from)) / DAY)) / 365;
}

/** The volatility assumption in force on `date`. */
export function ivOn(m: MarketAssumptions, date: string): number {
  return m.earningsDate && date >= m.earningsDate ? m.ivAfter : m.ivBefore;
}

/** Date axis: today, the sessions either side of earnings, two points in between, and expiry. */
export function scenarioDates(today: string, expiry: string, earningsDate?: string): string[] {
  const out = new Set<string>([today, expiry]);
  let from = today;
  if (earningsDate && earningsDate > today && earningsDate <= expiry) {
    if (addDays(earningsDate, -1) > today) out.add(addDays(earningsDate, -1));
    out.add(earningsDate);
    from = earningsDate;
  }
  const span = Math.round((parseDay(expiry) - parseDay(from)) / DAY);
  if (span >= 6) for (const f of [1 / 3, 2 / 3]) out.add(addDays(from, Math.round(span * f)));
  return [...out].filter((d) => d >= today && d <= expiry).sort();
}

/** Price axis from +pct% down to −pct% of `center` in `steps` rows, plus extra levels (strike, target…), highest first. */
export function priceGrid(center: number, pct: number, steps: number, include: readonly number[] = []): number[] {
  const n = Math.max(2, Math.round(steps));
  const lvls = new Set<number>(include.filter((x) => Number.isFinite(x) && x > 0).map((x) => Math.round(x * 100) / 100));
  for (let k = 0; k < n; k++) lvls.add(Math.round(center * (1 + pct / 100 - (2 * pct * k) / (100 * (n - 1))) * 100) / 100);
  return [...lvls].filter((x) => x > 0).sort((a, b) => b - a);
}

// ── Scenarios ───────────────────────────────────────────────────────────────
/**
 * Dollar outcome of a plan if the stock is at `S` on `date`. Contracts still open are valued at what selling them
 * would bring (model mid − half spread − fees); a contract worth nothing is left to expire without a fee.
 * A limit is treated as filled only if the modelled bid reaches it at this price and date — an earlier touch that
 * later reversed is not modelled.
 */
export function evaluatePlan(pos: OptionPosition, plan: ScenarioPlan, exec: ExecutionAssumptions, market: MarketAssumptions, S: number, date: string, startingCash: number): ScenarioPoint {
  const { contract: c, quantity: qty } = pos;
  const mult = c.multiplier ?? 100;
  const sell = (n: number, px: number) => (n > 0 && px > 0 ? Math.max(0, n * px * mult - n * exec.feePerContract) : 0);
  const mark = bsPrice(c.type, S, c.strike, yearFrac(date, c.expiry), market.rate, market.divYield, ivOn(market, date));
  const bid = Math.max(0, mark - exec.halfSpread);
  let cash = startingCash - qty * (pos.entryPrice * mult + pos.entryFeePerContract);
  let open = qty;
  let filled = false;
  if (plan.kind === 'closeNow') {
    cash += sell(qty, plan.price);
    open = 0;
  } else if (plan.kind === 'sellAtLimit' && bid >= plan.limit) {
    const n = Math.min(qty, Math.max(0, Math.round(plan.quantity)));
    cash += sell(n, plan.limit);
    open = qty - n;
    filled = true;
  }
  const openValue = sell(open, bid);
  return { mark, bid, cash, openValue, openContracts: open, filled, capital: cash + openValue, pnl: cash + openValue - startingCash };
}

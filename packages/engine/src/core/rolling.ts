/**
 * Plain-object rolling-window primitives. Every state is structured-cloneable (typed arrays + numbers)
 * so a study's state can be forked cheaply for provisional (live) bars. All updates are O(1) amortized.
 */

// ── Ring buffer ────────────────────────────────────────────────────────────
export interface Ring {
  buf: Float64Array;
  n: number;
  head: number; // next write position
  count: number;
}

export function ringInit(n: number): Ring {
  return { buf: new Float64Array(Math.max(1, n)), n: Math.max(1, n), head: 0, count: 0 };
}

/** Push x; returns the value that fell out of the window (NaN if the window was not full). */
export function ringPush(r: Ring, x: number): number {
  const out = r.count === r.n ? r.buf[r.head] : NaN;
  r.buf[r.head] = x;
  r.head = (r.head + 1) % r.n;
  if (r.count < r.n) r.count++;
  return out;
}

/** k = 0 → most recent value, k = 1 → previous, … */
export function ringAgo(r: Ring, k: number): number {
  if (k >= r.count) return NaN;
  return r.buf[(r.head - 1 - k + r.n * 2) % r.n];
}

export const ringFull = (r: Ring): boolean => r.count === r.n;

// ── Rolling sum (with periodic exact resummation to bound float drift) ─────
export interface RollSum {
  ring: Ring;
  sum: number;
  sinceResum: number;
}

export function sumInit(n: number): RollSum {
  return { ring: ringInit(n), sum: 0, sinceResum: 0 };
}

export function sumPush(s: RollSum, x: number): number {
  const out = ringPush(s.ring, x);
  s.sum += x;
  if (!Number.isNaN(out)) s.sum -= out;
  if (++s.sinceResum >= 4096) {
    let acc = 0;
    for (let k = 0; k < s.ring.count; k++) acc += s.ring.buf[k];
    s.sum = acc;
    s.sinceResum = 0;
  }
  return s.sum;
}

export const sumFull = (s: RollSum): boolean => s.ring.count === s.ring.n;

// ── Rolling mean / variance ───────────────────────────────────────────────
export interface RollStat {
  s1: RollSum;
  s2: RollSum;
}
export const statInit = (n: number): RollStat => ({ s1: sumInit(n), s2: sumInit(n) });
export function statPush(st: RollStat, x: number): void {
  sumPush(st.s1, x);
  sumPush(st.s2, x * x);
}
export const statFull = (st: RollStat): boolean => sumFull(st.s1);
export const statMean = (st: RollStat): number => st.s1.sum / st.s1.ring.count;
export function statStd(st: RollStat, sample = false): number {
  const n = st.s1.ring.count;
  if (n < 2) return 0;
  const m = st.s1.sum / n;
  const v = (st.s2.sum - n * m * m) / (sample ? n - 1 : n);
  return v > 0 ? Math.sqrt(v) : 0;
}

// ── Monotonic deque for rolling max/min over the last n pushes ────────────
export interface Extreme {
  n: number;
  /** ring of (seq, value) pairs */
  seq: Float64Array;
  val: Float64Array;
  head: number;
  size: number;
  cap: number;
  pushed: number;
  isMax: boolean;
}

export function extInit(n: number, isMax: boolean): Extreme {
  const cap = Math.max(1, n) + 1;
  return { n: Math.max(1, n), seq: new Float64Array(cap), val: new Float64Array(cap), head: 0, size: 0, cap, pushed: 0, isMax };
}

export function extPush(e: Extreme, x: number): number {
  const seq = e.pushed++;
  // pop from back while dominated
  while (e.size > 0) {
    const back = (e.head + e.size - 1) % e.cap;
    const bv = e.val[back];
    if (e.isMax ? bv <= x : bv >= x) e.size--;
    else break;
  }
  const pos = (e.head + e.size) % e.cap;
  e.seq[pos] = seq;
  e.val[pos] = x;
  e.size++;
  // drop expired from front
  while (e.size > 0 && e.seq[e.head] <= seq - e.n) {
    e.head = (e.head + 1) % e.cap;
    e.size--;
  }
  return e.val[e.head];
}

export const extValue = (e: Extreme): number => (e.size ? e.val[e.head] : NaN);
export const extFull = (e: Extreme): boolean => e.pushed >= e.n;
/** bars since the extreme value was pushed (0 = current) */
export const extAge = (e: Extreme): number => (e.size ? e.pushed - 1 - e.seq[e.head] : NaN);

// ── Moving averages ───────────────────────────────────────────────────────
export interface Ema {
  n: number;
  alpha: number;
  v: number;
  count: number;
  seed: number;
}

/** EMA seeded with the SMA of the first n values (the common charting convention). */
export function emaInit(n: number, alpha?: number): Ema {
  return { n, alpha: alpha ?? 2 / (n + 1), v: NaN, count: 0, seed: 0 };
}

export function emaPush(e: Ema, x: number): number {
  if (Number.isNaN(x)) return e.v;
  e.count++;
  if (e.count < e.n) {
    e.seed += x;
    return NaN;
  }
  if (e.count === e.n) {
    e.seed += x;
    e.v = e.seed / e.n;
    return e.v;
  }
  e.v = e.v + e.alpha * (x - e.v);
  return e.v;
}

/** Wilder's smoothing (RMA), alpha = 1/n. */
export const rmaInit = (n: number): Ema => emaInit(n, 1 / n);

export interface Sma {
  s: RollSum;
}
export const smaInit = (n: number): Sma => ({ s: sumInit(n) });
export function smaPush(m: Sma, x: number): number {
  sumPush(m.s, x);
  return sumFull(m.s) ? m.s.sum / m.s.ring.n : NaN;
}

/** Linear-weighted MA, O(1) via running sum and weighted sum. */
export interface Wma {
  n: number;
  ring: Ring;
  sum: number;
  wsum: number;
}
export const wmaInit = (n: number): Wma => ({ n, ring: ringInit(n), sum: 0, wsum: 0 });
export function wmaPush(w: Wma, x: number): number {
  if (Number.isNaN(x)) return NaN;
  const full = ringFull(w.ring);
  const out = ringPush(w.ring, x);
  if (full) {
    // shift weights down by one: every element loses its weight by 1, oldest (weight 1) leaves
    w.wsum = w.wsum - w.sum + w.n * x;
    w.sum = w.sum - out + x;
  } else {
    w.sum += x;
    w.wsum += w.ring.count * x;
  }
  if (!ringFull(w.ring)) return NaN;
  return w.wsum / ((w.n * (w.n + 1)) / 2);
}

// ── Misc helpers ──────────────────────────────────────────────────────────
export const isNum = (x: number): boolean => !Number.isNaN(x) && Number.isFinite(x);

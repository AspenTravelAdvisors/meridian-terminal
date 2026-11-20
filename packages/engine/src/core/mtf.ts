import type { Bar, SignalDir, Writer } from './types';

/**
 * Align a higher-timeframe series onto base bars WITHOUT look-ahead: base bar i sees the value of the
 * latest HTF bar that had already CLOSED by the time base bar i closed.
 *   HTF bar k closes at htf[k].t + htfMs;  base bar i closes at base[i].t + baseMs.
 */
export function alignHTF(base: readonly Bar[], baseMs: number, htf: readonly Bar[], htfMs: number, values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(base.length).fill(NaN);
  let k = -1;
  for (let i = 0; i < base.length; i++) {
    const closeT = base[i].t + baseMs;
    while (k + 1 < htf.length && htf[k + 1].t + htfMs <= closeT) k++;
    if (k >= 0) out[i] = values[k];
  }
  return out;
}

/** Align another symbol's closes by timestamp (benchmark / comparison), carrying the last known value forward. */
export function alignByTime(base: readonly Bar[], other: readonly Bar[]): Float64Array {
  const out = new Float64Array(base.length).fill(NaN);
  let k = -1;
  for (let i = 0; i < base.length; i++) {
    while (k + 1 < other.length && other[k + 1].t <= base[i].t) k++;
    if (k >= 0) out[i] = other[k].c;
  }
  return out;
}

/**
 * Align dated scalar events (funding settlements, OI snapshots, short-interest reports) onto base bars
 * WITHOUT look-ahead: bar i only sees events whose timestamp is ≤ the bar's close time, and the last
 * such value is carried forward (step series).
 */
export function alignEvents(base: readonly Bar[], baseMs: number, events: readonly { t: number; v: number }[]): Float64Array {
  const out = new Float64Array(base.length).fill(NaN);
  let k = -1;
  for (let i = 0; i < base.length; i++) {
    const closeT = base[i].t + baseMs;
    while (k + 1 < events.length && events[k + 1].t <= closeT) k++;
    if (k >= 0) out[i] = events[k].v;
  }
  return out;
}

/**
 * Place dated events (news, filings) on the bar they happen in, keeping the largest value per bar. An event that falls
 * between bars (overnight, a weekend) goes to the next bar, the first one that can react to it, never an earlier one.
 * Events before the first bar opens or after the last bar closes are dropped. Unlike `alignEvents` nothing carries forward.
 */
export function bucketEvents(base: readonly Bar[], baseMs: number, events: readonly { t: number; v: number }[]): Float64Array {
  const out = new Float64Array(base.length).fill(NaN);
  if (!base.length) return out;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  let i = 0;
  for (const e of sorted) {
    if (!Number.isFinite(e.v) || e.t < base[0].t) continue;
    while (i < base.length && base[i].t + baseMs <= e.t) i++;
    if (i >= base.length) break;
    if (!(out[i] >= e.v)) out[i] = e.v;
  }
  return out;
}

/** A Writer that discards drawing and only records the signals of the current bar (for composite studies). */
export interface SinkWriter extends Writer {
  fired: { id: string; dir: SignalDir }[];
}

export function sinkWriter(): SinkWriter {
  return {
    i: 0,
    provisional: false,
    inspecting: false,
    fired: [],
    line() {},
    marker() {},
    signal(id, dir) {
      this.fired.push({ id, dir });
    },
    inspect() {},
  };
}

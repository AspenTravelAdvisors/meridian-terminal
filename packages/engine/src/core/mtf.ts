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

import { type CalendarId, futureBarTimes } from '@meridian/data';
import { type Bar, tzOffsetMs } from '@meridian/engine';
import type { UTCTimestamp } from 'lightweight-charts';

/**
 * Lightweight Charts renders times as UTC. To show exchange-local (or browser-local) times we shift each
 * bar's timestamp by its zone offset (DST-aware per bar) and enforce strictly increasing values.
 * The map also converts between real bar times and fractional logical indices for drawings, and supplies
 * future bar times (sessions/holidays aware) for forward-displaced series such as the Ichimoku cloud.
 */
export class TimeMap {
  readonly t: number[]; // real open times (ms)
  readonly disp: UTCTimestamp[]; // display times (s)
  private future: number[] = [];
  private futureDisp: UTCTimestamp[] = [];

  constructor(
    bars: readonly Bar[],
    readonly tz: string,
    readonly intervalMs: number,
    readonly calendar: CalendarId,
  ) {
    this.t = bars.map((b) => b.t);
    this.disp = new Array(bars.length);
    let prev = -Infinity;
    for (let i = 0; i < bars.length; i++) {
      let s = Math.floor((bars[i].t + this.offset(bars[i].t)) / 1000);
      if (s <= prev) s = prev + 1;
      this.disp[i] = s as UTCTimestamp;
      prev = s;
    }
  }

  private offset(t: number): number {
    return this.tz === 'UTC' ? 0 : tzOffsetMs(t, this.tz);
  }

  get length(): number {
    return this.t.length;
  }

  /** display time for logical index i (i ≥ length → future bars) */
  displayAt(i: number): UTCTimestamp | null {
    if (i < 0) return null;
    if (i < this.length) return this.disp[i];
    this.ensureFuture(i - this.length + 1);
    return this.futureDisp[i - this.length] ?? null;
  }

  realAt(i: number): number {
    if (i < this.length && i >= 0) return this.t[i];
    if (i >= this.length) {
      this.ensureFuture(i - this.length + 1);
      return this.future[i - this.length] ?? this.t[this.length - 1] + (i - this.length + 1) * this.intervalMs;
    }
    return this.t[0] + i * this.intervalMs;
  }

  ensureFuture(n: number): void {
    if (this.future.length >= n || !this.length) return;
    const want = Math.max(n, 64);
    this.future = futureBarTimes(this.calendar, this.t[this.length - 1], this.intervalMs || 86_400_000, want);
    let prev = this.disp[this.length - 1];
    this.futureDisp = this.future.map((t) => {
      let s = Math.floor((t + this.offset(t)) / 1000);
      if (s <= prev) s = prev + 1;
      prev = s as UTCTimestamp;
      return s as UTCTimestamp;
    });
  }

  /** real time → fractional logical index (binary search; extrapolates outside the data). */
  toLogical(t: number): number {
    const n = this.length;
    if (!n) return 0;
    if (t <= this.t[0]) return (t - this.t[0]) / (this.intervalMs || 1);
    if (t >= this.t[n - 1]) {
      this.ensureFuture(Math.min(5000, Math.ceil((t - this.t[n - 1]) / (this.intervalMs || 1)) + 2));
      const f = this.future;
      if (f.length && t <= f[f.length - 1]) {
        let prevT = this.t[n - 1];
        for (let k = 0; k < f.length; k++) {
          if (t <= f[k]) return n - 1 + k + (t - prevT) / (f[k] - prevT || 1);
          prevT = f[k];
        }
      }
      return n - 1 + (t - this.t[n - 1]) / (this.intervalMs || 1);
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - this.t[lo]) / (this.t[hi] - this.t[lo] || 1);
  }

  /** fractional logical index → real time */
  fromLogical(l: number): number {
    const i = Math.floor(l);
    const f = l - i;
    const a = this.realAt(i);
    const b = this.realAt(i + 1);
    return a + (b - a) * f;
  }

  /** index of the display time (exact), or -1 */
  indexOfDisplay(s: number): number {
    let lo = 0;
    let hi = this.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.disp[mid] === s) return mid;
      if (this.disp[mid] < s) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

export function displayTz(setting: 'exchange' | 'utc' | 'local', exchangeTz: string): string {
  if (setting === 'utc') return 'UTC';
  if (setting === 'local') return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return exchangeTz || 'UTC';
}

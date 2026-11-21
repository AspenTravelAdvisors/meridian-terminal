import { type CalendarId, futureBarTimes, INTERVAL_MS, type Interval } from '@meridian/data';

/**
 * Window Timeline: turn each timeframe's Exhaustion Window projections ("bars until a 9 / 13") into calendar spans,
 * then find where spans from different timeframes overlap on the same side.
 *
 * A span runs from the open of the earliest bar the count can finish on to the end of the bar it lands on at the
 * pace so far (`est.`). A setup 9 is the single bar it completes on. Two counts on the same timeframe (Sequential and
 * Combo) never make an alignment on their own: that agreement is Count Consensus's job.
 */

export type WindowSide = 'buy' | 'sell';
export type WindowKind = 'setup9' | 'seq13' | 'combo13';

export interface WindowItem {
  tf: Interval;
  side: WindowSide;
  kind: WindowKind;
  /** span start (open of the earliest bar, ms) */
  from: number;
  /** span end (end of the estimated bar, ms, exclusive) */
  to: number;
  /** bars ahead: earliest and estimate (equal for a setup 9, or when every bar so far has counted) */
  minBars: number;
  estBars: number;
  /** current count (setup count for a 9, countdown count for a 13) */
  count: number;
}

export interface Alignment {
  side: WindowSide;
  from: number;
  to: number;
  /** distinct timeframes overlapping here, highest first */
  tfs: Interval[];
  items: WindowItem[];
}

const TF_RANK: Record<string, number> = { '1m': 0, '5m': 1, '15m': 2, '30m': 3, '1h': 4, '4h': 5, '1D': 6, '1W': 7, '1M': 8, '3M': 9 };
export const tfRank = (tf: Interval) => TF_RANK[tf] ?? 0;

const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Exhaustion Window status values → calendar spans.
 * `lastT` is the open time of the last CLOSED bar; bar 1 ahead is the forming bar (or the next session's bar).
 */
export function windowItems(tf: Interval, values: Record<string, number | null | undefined>, lastT: number, calendar: CalendarId): WindowItem[] {
  const specs: { side: WindowSide; kind: WindowKind; min: number | null | undefined; est: number | null | undefined; n: number }[] = [];
  for (const side of ['buy', 'sell'] as const) {
    specs.push({ side, kind: 'setup9', min: values[`${side}9`], est: values[`${side}9`], n: 9 });
    specs.push({ side, kind: 'seq13', min: values[`${side}13Min`], est: values[`${side}13Est`], n: 13 });
    specs.push({ side, kind: 'combo13', min: values[`combo${side}13Min`], est: values[`combo${side}13Est`], n: 13 });
  }
  const live = specs.filter((s) => fin(s.min));
  if (!live.length) return [];
  const ms = INTERVAL_MS[tf];
  const maxBars = Math.max(...live.map((s) => Math.max(s.min as number, fin(s.est) ? s.est : 0)));
  const opens = futureBarTimes(calendar, lastT, ms, Math.min(5000, maxBars + 1));
  const openAt = (k: number) => opens[k - 1] ?? lastT + k * ms;
  const endAt = (k: number) => {
    const o = openAt(k);
    const next = opens[k];
    return o + (next !== undefined ? Math.min(ms, next - o) : ms);
  };
  return live.map((s) => {
    const minBars = s.min as number;
    const estBars = fin(s.est) ? Math.max(minBars, s.est) : minBars;
    return { tf, side: s.side, kind: s.kind, from: openAt(minBars), to: endAt(estBars), minBars, estBars, count: Math.max(0, s.n - minBars) };
  });
}

/**
 * Where spans from two or more timeframes overlap on the same side. Adjacent pieces with the same set of timeframes
 * are merged, so a daily band inside a weekly band gives one alignment the length of the daily band.
 */
export function findAlignments(items: readonly WindowItem[]): Alignment[] {
  const out: Alignment[] = [];
  for (const side of ['buy', 'sell'] as const) {
    const mine = items.filter((x) => x.side === side && x.to > x.from);
    if (mine.length < 2) continue;
    const cuts = [...new Set(mine.flatMap((x) => [x.from, x.to]))].sort((a, b) => a - b);
    let open: Alignment | null = null;
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k];
      const b = cuts[k + 1];
      const here = mine.filter((x) => x.from < b && x.to > a);
      const tfs = [...new Set(here.map((x) => x.tf))].sort((p, q) => tfRank(q) - tfRank(p));
      if (tfs.length < 2) {
        open = null;
        continue;
      }
      if (open && open.to === a && open.tfs.join() === tfs.join()) {
        open.to = b;
        for (const x of here) if (!open.items.includes(x)) open.items.push(x);
      } else {
        open = { side, from: a, to: b, tfs, items: [...here] };
        out.push(open);
      }
    }
  }
  return out.sort((p, q) => p.from - q.from || (p.side === 'buy' ? -1 : 1));
}

export const KIND_LABEL: Record<WindowKind, string> = { setup9: 'Setup 9', seq13: 'Seq 13', combo13: 'Combo 13' };
export const TF_SHORT = (tf: Interval) => (tf === '1D' ? 'D' : tf === '1W' ? 'W' : tf === '1M' ? 'M' : tf === '3M' ? 'Q' : tf.toUpperCase());

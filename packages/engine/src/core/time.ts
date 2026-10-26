/**
 * Deterministic time helpers (no Date.now). Time-zone offsets come from Intl and are cached per
 * 6-hour block, so period detection over 50k bars stays cheap.
 */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
const offCache = new Map<string, number>();
const BLOCK = 6 * 3_600_000;

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of `tz` from UTC at instant t: local = t + offset. */
export function tzOffsetMs(t: number, tz: string): number {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 0;
  const key = `${tz}|${Math.floor(t / BLOCK)}`;
  const hit = offCache.get(key);
  if (hit !== undefined) return hit;
  let off = 0;
  try {
    const parts = formatter(tz).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    off = asUtc - Math.floor(t / 1000) * 1000;
  } catch {
    off = 0;
  }
  if (offCache.size > 50_000) offCache.clear();
  offCache.set(key, off);
  return off;
}

export type PeriodKind = 'day' | 'week' | 'month' | 'quarter' | 'year';
const DAY = 86_400_000;

/** Integer key identifying the calendar period containing t in time zone tz (weeks start Monday). */
export function periodKey(t: number, kind: PeriodKind, tz = 'UTC', dayStartHour = 0): number {
  const local = t + tzOffsetMs(t, tz) - dayStartHour * 3_600_000;
  const d = Math.floor(local / DAY);
  if (kind === 'day') return d;
  if (kind === 'week') return Math.floor((d + 3) / 7); // 1970-01-01 was a Thursday → Monday-based weeks
  const dt = new Date(d * DAY);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth();
  if (kind === 'month') return y * 12 + m;
  if (kind === 'quarter') return y * 4 + Math.floor(m / 3);
  return y;
}

/** Natural "next-higher" period for pivots / session resets given the bar interval. */
export function higherPeriod(intervalMs: number): PeriodKind {
  if (intervalMs <= 0 || intervalMs < DAY) return 'day';
  if (intervalMs < 7 * DAY) return 'week';
  if (intervalMs < 28 * DAY) return 'month';
  return 'year';
}

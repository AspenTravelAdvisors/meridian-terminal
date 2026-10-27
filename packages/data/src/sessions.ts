import { tzOffsetMs } from '@meridian/engine';
import type { CalendarId } from './types';

const DAY = 86_400_000;

export interface CalendarSpec {
  id: CalendarId;
  timezone: string;
  /** regular session open/close in minutes after local midnight (open > close ⇒ overnight session) */
  open: number;
  close: number;
  /** local weekdays the session OPENS on (0 = Sun) */
  days: number[];
  holidays?: (year: number) => string[]; // ISO dates (local)
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** n-th weekday (0=Sun) of a month; n = −1 → last. */
function nthWeekday(y: number, m: number, wd: number, n: number): number {
  if (n > 0) {
    const first = dow(y, m, 1);
    return 1 + ((wd - first + 7) % 7) + 7 * (n - 1);
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ld = dow(y, m, last);
  return last - ((ld - wd + 7) % 7);
}

/** Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
function easter(y: number): [number, number] {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/** Fixed-date holiday observed on Friday if Saturday, Monday if Sunday. */
function observed(y: number, m: number, d: number, saturdayRule = true): string | null {
  const wd = dow(y, m, d);
  const t = Date.UTC(y, m - 1, d);
  if (wd === 6) return saturdayRule ? new Date(t - DAY).toISOString().slice(0, 10) : null;
  if (wd === 0) return new Date(t + DAY).toISOString().slice(0, 10);
  return ymd(y, m, d);
}

/** NYSE full-day closures, generated from the published rules (no early closes). */
export function nyseHolidays(y: number): string[] {
  const [em, ed] = easter(y);
  const goodFriday = new Date(Date.UTC(y, em - 1, ed) - 2 * DAY).toISOString().slice(0, 10);
  const out = [
    observed(y, 1, 1, false), // New Year's Day — not observed on the prior Friday when it falls on Saturday
    ymd(y, 1, nthWeekday(y, 1, 1, 3)), // MLK Day
    ymd(y, 2, nthWeekday(y, 2, 1, 3)), // Washington's Birthday
    goodFriday,
    ymd(y, 5, nthWeekday(y, 5, 1, -1)), // Memorial Day
    y >= 2022 ? observed(y, 6, 19) : null, // Juneteenth
    observed(y, 7, 4),
    ymd(y, 9, nthWeekday(y, 9, 1, 1)), // Labor Day
    ymd(y, 11, nthWeekday(y, 11, 4, 4)), // Thanksgiving
    observed(y, 12, 25),
  ];
  return out.filter((d): d is string => d !== null);
}

export const CALENDARS: Record<CalendarId, CalendarSpec> = {
  NYSE: { id: 'NYSE', timezone: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60, days: [1, 2, 3, 4, 5], holidays: nyseHolidays },
  // CME Globex equity/rates: Sunday–Friday 17:00–16:00 Chicago with a daily one-hour break
  CME: { id: 'CME', timezone: 'America/Chicago', open: 17 * 60, close: 16 * 60, days: [0, 1, 2, 3, 4] },
  FX: { id: 'FX', timezone: 'America/New_York', open: 17 * 60, close: 17 * 60, days: [0, 1, 2, 3, 4] },
  '24x7': { id: '24x7', timezone: 'UTC', open: 0, close: 24 * 60, days: [0, 1, 2, 3, 4, 5, 6] },
};

const holidayCache = new Map<string, Set<string>>();
function holidaySet(cal: CalendarSpec, year: number): Set<string> {
  const k = `${cal.id}${year}`;
  let s = holidayCache.get(k);
  if (!s) {
    s = new Set(cal.holidays ? cal.holidays(year) : []);
    holidayCache.set(k, s);
  }
  return s;
}

function localParts(t: number, tz: string) {
  const local = t + tzOffsetMs(t, tz);
  const d = new Date(local);
  return { local, day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), iso: d.toISOString().slice(0, 10), year: d.getUTCFullYear() };
}

/** Is the market open at instant t? */
export function isOpen(calId: CalendarId, t: number): boolean {
  const cal = CALENDARS[calId];
  if (calId === '24x7') return true;
  const p = localParts(t, cal.timezone);
  if (cal.open < cal.close) {
    if (!cal.days.includes(p.day) || holidaySet(cal, p.year).has(p.iso)) return false;
    return p.minutes >= cal.open && p.minutes < cal.close;
  }
  // overnight session: opens on day D at `open`, runs through D+1 `close`
  if (p.minutes >= cal.open) return cal.days.includes(p.day);
  const prevDay = (p.day + 6) % 7;
  if (calId === 'CME' && p.minutes >= cal.close && p.minutes < cal.open) return false; // daily break
  return cal.days.includes(prevDay) && p.minutes < cal.close;
}

/** Is local date of t a trading day (daily bars)? */
export function isTradingDay(calId: CalendarId, t: number): boolean {
  if (calId === '24x7') return true;
  const cal = CALENDARS[calId];
  const p = localParts(t, cal.timezone);
  if (calId === 'NYSE') return cal.days.includes(p.day) && !holidaySet(cal, p.year).has(p.iso);
  return p.day >= 1 && p.day <= 5;
}

/**
 * Future bar open times after `lastT` (for Ichimoku's forward cloud, time-theory marks and drawings).
 * Respects sessions and holidays for intraday and daily bars; weekly/monthly step by calendar.
 */
export function futureBarTimes(calId: CalendarId, lastT: number, intervalMs: number, count: number): number[] {
  const out: number[] = [];
  if (count <= 0) return out;
  if (intervalMs >= 28 * DAY) {
    const months = Math.round(intervalMs / (30 * DAY)) || 1;
    const d = new Date(lastT);
    for (let k = 1; k <= count; k++) out.push(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months * k, 1));
    return out;
  }
  if (intervalMs >= 7 * DAY) {
    for (let k = 1; k <= count; k++) out.push(lastT + k * 7 * DAY);
    return out;
  }
  let t = lastT;
  let guard = 0;
  while (out.length < count && guard++ < count * 400) {
    t += intervalMs;
    const ok = intervalMs >= DAY ? isTradingDay(calId, t + 12 * 3_600_000) : isOpen(calId, t);
    if (ok) out.push(t);
  }
  return out;
}

/** Local session-open epoch for the session containing t (used to anchor 4h buckets on NYSE). */
export function sessionOpenFor(calId: CalendarId, t: number): number {
  const cal = CALENDARS[calId];
  if (calId === '24x7') return Math.floor(t / DAY) * DAY;
  const off = tzOffsetMs(t, cal.timezone);
  const local = t + off;
  const dayStart = Math.floor(local / DAY) * DAY;
  let open = dayStart + cal.open * 60_000;
  if (cal.open > cal.close && local < open) open -= DAY;
  return open - off;
}

/**
 * When a bar that opens at `t` stops forming. Session-aware for exchange calendars: an NYSE daily bar is complete at the
 * 16:00 ET close (not 24 h after its timestamp) and the last intraday bucket ends at the close. Weekly, monthly and
 * quarterly bars end at the next period start. Errs late, never early, so a bar is never finalized while it can still change.
 */
export function barCloseTime(calId: CalendarId, interval: string, t: number, intervalMs: number): number {
  const cal = CALENDARS[calId];
  const off = calId === '24x7' ? 0 : tzOffsetMs(t, cal.timezone);
  const local = t + off;
  const dayStart = Math.floor(local / DAY) * DAY;
  if (interval === '1M' || interval === '3M') {
    const d = new Date(local);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (interval === '3M' ? 3 - (d.getUTCMonth() % 3) : 1), 1) - off;
  }
  const dayHours = cal.open < cal.close; // single-day session (NYSE)
  if (interval === '1W') {
    const monday = dayStart - ((new Date(local).getUTCDay() + 6) % 7) * DAY;
    return dayHours ? monday + 4 * DAY + cal.close * 60_000 - off : monday + 7 * DAY - off;
  }
  if (calId === '24x7' || !dayHours) return t + intervalMs;
  const sessionClose = dayStart + cal.close * 60_000 - off;
  if (intervalMs >= DAY) return sessionClose;
  return local - dayStart < cal.close * 60_000 ? Math.min(t + intervalMs, sessionClose) : t + intervalMs;
}

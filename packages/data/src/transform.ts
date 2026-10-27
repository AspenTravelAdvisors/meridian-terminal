import { periodKey, tzOffsetMs } from '@meridian/engine';
import { CALENDARS, barCloseTime, sessionOpenFor } from './sessions';
import type { AdjustMode, Bar, CalendarId, CorporateEvents, Interval } from './types';
import { INTERVAL_MS } from './types';

const DAY = 86_400_000;

/**
 * Resample bars to a higher interval. Intraday buckets are anchored to the session open (so NYSE 4h bars
 * are 09:30–13:30 and 13:30–16:00 ET); daily+ buckets follow the exchange-local calendar (Monday weeks,
 * calendar months/quarters). The last bucket is provisional when its source bars are.
 */
/**
 * Aggregate bars into a higher interval. With `now`, a bucket whose period has not ended stays provisional even when
 * every constituent bar is final (e.g. a weekly bar on a Wednesday) — counts must not finalize before the bar closes.
 */
export function resample(bars: readonly Bar[], to: Interval, calendar: CalendarId = '24x7', now?: number): Bar[] {
  const toMs = INTERVAL_MS[to];
  const tz = CALENDARS[calendar].timezone;
  const keyOf = (t: number): number => {
    if (to === '1W') return periodKey(t, 'week', tz);
    if (to === '1M') return periodKey(t, 'month', tz);
    if (to === '3M') return periodKey(t, 'quarter', tz);
    if (to === '1D') return periodKey(t, 'day', tz);
    const open = sessionOpenFor(calendar, t);
    return open * 1000 + Math.floor((t - open) / toMs); // unique per session × bucket
  };
  const startOf = (t: number): number => {
    if (toMs >= DAY) {
      const off = tzOffsetMs(t, tz);
      const local = new Date(t + off);
      const y = local.getUTCFullYear();
      const m = local.getUTCMonth();
      const d = local.getUTCDate();
      let s: number;
      if (to === '1W') {
        const wd = (local.getUTCDay() + 6) % 7; // Monday = 0
        s = Date.UTC(y, m, d - wd);
      } else if (to === '1M') s = Date.UTC(y, m, 1);
      else if (to === '3M') s = Date.UTC(y, m - (m % 3), 1);
      else s = Date.UTC(y, m, d);
      return s - (calendar === '24x7' ? 0 : off);
    }
    const open = sessionOpenFor(calendar, t);
    return open + Math.floor((t - open) / toMs) * toMs;
  };
  const out: Bar[] = [];
  let curKey = NaN;
  for (const b of bars) {
    const k = keyOf(b.t);
    const last = out[out.length - 1];
    if (k !== curKey || !last) {
      out.push({ t: startOf(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, final: b.final });
      curKey = k;
    } else {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
      last.final = b.final === false ? false : last.final;
    }
  }
  const tail = out[out.length - 1];
  if (tail && now !== undefined && barCloseTime(calendar, to, tail.t, toMs) > now) tail.final = false;
  return out;
}

/** Heikin-Ashi candles (each value depends only on the current and previous HA bar — no look-ahead). */
export function heikinAshi(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let po = NaN;
  let pc = NaN;
  for (const b of bars) {
    const c = (b.o + b.h + b.l + b.c) / 4;
    const o = Number.isNaN(po) ? (b.o + b.c) / 2 : (po + pc) / 2;
    out.push({ t: b.t, o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c, v: b.v, final: b.final });
    po = o;
    pc = c;
  }
  return out;
}

/** Average true range over the whole series (used to size Renko/Range boxes in "auto" mode). */
export function autoBox(bars: readonly Bar[], n = 14): number {
  if (bars.length < 2) return 1;
  let a = 0;
  const m = Math.min(bars.length - 1, 500);
  const from = bars.length - m;
  for (let i = from; i < bars.length; i++) a += Math.max(bars[i].h, bars[i - 1].c) - Math.min(bars[i].l, bars[i - 1].c);
  const atr = a / m;
  const mag = 10 ** Math.floor(Math.log10(Math.max(atr, 1e-9)));
  return Math.max(mag, Math.round(atr / mag) * mag) * (n / 14);
}

/**
 * Renko bricks from closes. Bricks get synthetic, strictly increasing timestamps (source bar time plus
 * the brick's ordinal in milliseconds) because several bricks can form inside one source bar.
 */
export function renko(bars: readonly Bar[], box = autoBox(bars)): Bar[] {
  const out: Bar[] = [];
  if (!bars.length || !(box > 0)) return out;
  // last brick spans [bot, top]; a continuation needs one box beyond it, a reversal two boxes from its far end
  let top = Math.floor(bars[0].c / box) * box;
  let bot = top;
  for (const b of bars) {
    let k = 0;
    for (;;) {
      if (b.c >= top + box) {
        out.push({ t: b.t + k++, o: top, h: top + box, l: top, c: top + box, v: b.v });
        bot = top;
        top += box;
      } else if (b.c <= bot - box) {
        out.push({ t: b.t + k++, o: bot, h: bot, l: bot - box, c: bot - box, v: b.v });
        top = bot;
        bot -= box;
      } else break;
    }
  }
  return out;
}

/** Range bars: a new bar starts whenever the current bar's high–low reaches `range`. */
export function rangeBars(bars: readonly Bar[], range = autoBox(bars)): Bar[] {
  const out: Bar[] = [];
  if (!(range > 0)) return out;
  let cur: Bar | null = null;
  let k = 0;
  for (const b of bars) {
    const pts = b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
    for (const p of pts) {
      if (!cur) {
        cur = { t: b.t + k++, o: p, h: p, l: p, c: p, v: 0 };
        continue;
      }
      cur.h = Math.max(cur.h, p);
      cur.l = Math.min(cur.l, p);
      cur.c = p;
      if (cur.h - cur.l >= range) {
        const up: boolean = p >= cur.o;
        const close: number = up ? cur.l + range : cur.h - range;
        cur.c = close;
        if (up) cur.h = close;
        else cur.l = close;
        out.push(cur);
        cur = { t: b.t + k++, o: close, h: close, l: close, c: close, v: 0 };
      }
    }
    if (cur) cur.v += b.v;
  }
  if (cur && cur.h !== cur.l) out.push({ ...cur, final: false });
  return out;
}

/**
 * Corporate-action adjustment. Providers deliver split-adjusted prices (the default mode); `none`
 * un-applies splits after each bar, `all` additionally back-adjusts dividends (multiplicative factor
 * 1 − D / prior close, applied to bars before the ex-date). Volume scales inversely with split factors.
 */
export function adjustBars(bars: readonly Bar[], events: CorporateEvents, mode: AdjustMode): Bar[] {
  if (mode === 'split' || (!events.splits.length && !events.dividends.length)) return bars.slice();
  const n = bars.length;
  const factor = new Float64Array(n).fill(1);
  if (mode === 'none') {
    // undo splits: bars before a split's ex-date get multiplied by its ratio
    for (const s of events.splits) for (let i = 0; i < n && bars[i].t < s.t; i++) factor[i] *= s.ratio;
  } else {
    for (const d of events.dividends) {
      const j = bars.findIndex((b) => b.t >= d.t);
      if (j <= 0) continue;
      const prev = bars[j - 1].c;
      if (!(prev > d.amount)) continue;
      const f = 1 - d.amount / prev;
      for (let i = 0; i < j; i++) factor[i] *= f;
    }
  }
  return bars.map((b, i) => {
    const f = factor[i];
    if (f === 1) return b;
    return { ...b, o: b.o * f, h: b.h * f, l: b.l * f, c: b.c * f, v: mode === 'none' ? b.v / f : b.v };
  });
}

/** Merge an older chunk (backfill) with existing bars, de-duplicating on t. */
export function mergeBars(older: readonly Bar[], newer: readonly Bar[]): Bar[] {
  if (!older.length) return newer.slice();
  if (!newer.length) return older.slice();
  const cut = newer[0].t;
  const head = older.filter((b) => b.t < cut);
  return head.concat(newer);
}

/** Apply a live tick/bar to a bar array (replace the forming bar or append a new one). */
export function applyLiveBar(bars: Bar[], live: Bar): Bar[] {
  const last = bars[bars.length - 1];
  if (!last || live.t > last.t) return [...bars, live];
  if (live.t === last.t) {
    const copy = bars.slice();
    copy[copy.length - 1] = live;
    return copy;
  }
  return bars;
}

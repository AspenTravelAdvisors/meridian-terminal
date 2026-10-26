import { z } from 'zod';
import { smaInit, smaPush, sumFull, sumInit, sumPush } from '../../core/rolling';
import { bool, choice, defineStudy, int, num, text } from '../../core/params';
import { higherPeriod, periodKey, type PeriodKind } from '../../core/time';
import type { Bar, SeriesCtx, VolumeProfile } from '../../core/types';

export const obv = defineStudy(z.object({ maLength: int(0, 0, 500, { title: 'Signal MA (0 = off)' }) }), {
  id: 'obv',
  name: 'On-Balance Volume',
  shortName: 'OBV',
  version: '1.0.0',
  category: 'Volume',
  description: 'Cumulative volume signed by the close-to-close direction.',
  overlay: false,
  outputs: () => [
    { kind: 'line', id: 'obv', title: 'OBV', color: '#26a69a', width: 2 },
    { kind: 'line', id: 'ma', title: 'Signal', color: '#ff9800' },
  ],
  init: (cfg) => ({ v: 0, ma: smaInit(Math.max(1, cfg.maLength)) }),
  update(cfg, s, x, w) {
    const i = w.i;
    if (i > 0) s.v += x.c[i] > x.c[i - 1] ? x.v[i] : x.c[i] < x.c[i - 1] ? -x.v[i] : 0;
    w.line(0, s.v);
    if (cfg.maLength > 0) w.line(1, smaPush(s.ma, s.v));
  },
});

export const cmf = defineStudy(z.object({ length: int(20, 1, 500, { title: 'Length' }) }), {
  id: 'cmf',
  name: 'Chaikin Money Flow',
  shortName: 'CMF',
  version: '1.0.0',
  category: 'Volume',
  description: 'Sum of money-flow volume over n bars divided by total volume.',
  overlay: false,
  outputs: () => [
    { kind: 'histogram', id: 'cmf', title: 'CMF', color: 'bull', negColor: 'bear' },
    { kind: 'hline', id: 'zero', title: 'Zero', value: 0, color: 'muted' },
  ],
  init: (cfg) => ({ mfv: sumInit(cfg.length), vol: sumInit(cfg.length) }),
  update(_cfg, s, x, w) {
    const i = w.i;
    const r = x.h[i] - x.l[i];
    const mfm = r > 0 ? (x.c[i] - x.l[i] - (x.h[i] - x.c[i])) / r : 0;
    sumPush(s.mfv, mfm * x.v[i]);
    sumPush(s.vol, x.v[i]);
    if (!sumFull(s.vol)) return;
    w.line(0, s.vol.sum > 0 ? s.mfv.sum / s.vol.sum : 0);
  },
});

export const adLine = defineStudy(z.object({}), {
  id: 'ad-line',
  name: 'Accumulation/Distribution',
  shortName: 'A/D',
  version: '1.0.0',
  category: 'Volume',
  description: 'Cumulative money-flow volume.',
  overlay: false,
  outputs: () => [{ kind: 'line', id: 'ad', title: 'A/D', color: '#5c6bc0', width: 2 }],
  init: () => ({ v: 0 }),
  update(_cfg, s, x, w) {
    const i = w.i;
    const r = x.h[i] - x.l[i];
    s.v += r > 0 ? ((x.c[i] - x.l[i] - (x.h[i] - x.c[i])) / r) * x.v[i] : 0;
    w.line(0, s.v);
  },
});

export const volume = defineStudy(z.object({ maLength: int(20, 0, 500, { title: 'Volume MA (0 = off)' }) }), {
  id: 'volume',
  name: 'Volume',
  shortName: 'Vol',
  version: '1.0.0',
  category: 'Volume',
  description: 'Volume coloured by bar direction, with a moving average.',
  overlay: false,
  outputs: () => [
    { kind: 'histogram', id: 'vol', title: 'Volume', color: 'bull', negColor: 'bear' },
    { kind: 'line', id: 'ma', title: 'Volume MA', color: '#ff9800' },
  ],
  signals: [{ id: 'VOL_SPIKE', dir: 'neutral', description: 'Volume above 2× its average' }],
  init: (cfg) => ({ ma: smaInit(Math.max(1, cfg.maLength)) }),
  update(cfg, s, x, w) {
    const i = w.i;
    // sign encodes direction for the histogram colour; the renderer plots |value|
    const up = x.c[i] >= x.o[i];
    w.line(0, up ? x.v[i] : -x.v[i]);
    if (cfg.maLength > 0) {
      const m = smaPush(s.ma, x.v[i]);
      w.line(1, m);
      if (Number.isFinite(m) && x.v[i] > 2 * m) w.signal('VOL_SPIKE', 'neutral', x.c[i]);
    }
  },
});

// ── Volume profile ─────────────────────────────────────────────────────────

/** Distribute each bar's volume uniformly across its high–low range into `rows` price bins. */
export function volumeProfileOf(
  get: { h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>; o: ArrayLike<number>; v: ArrayLike<number> },
  i1: number,
  i2: number,
  rows: number,
  valueArea = 0.7,
): VolumeProfile | null {
  if (i2 < i1 || rows < 1) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = i1; i <= i2; i++) {
    if (get.l[i] < lo) lo = get.l[i];
    if (get.h[i] > hi) hi = get.h[i];
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (hi === lo) hi = lo + Math.max(1e-9, Math.abs(lo) * 1e-6);
  const step = (hi - lo) / rows;
  const vol = new Float64Array(rows);
  const up = new Float64Array(rows);
  let total = 0;
  for (let i = i1; i <= i2; i++) {
    const v = get.v[i];
    if (!(v > 0)) continue;
    total += v;
    const a = Math.min(rows - 1, Math.max(0, Math.floor((get.l[i] - lo) / step)));
    const b = Math.min(rows - 1, Math.max(0, Math.floor((get.h[i] - lo) / step)));
    const share = v / (b - a + 1);
    const isUp = get.c[i] >= get.o[i];
    for (let r = a; r <= b; r++) {
      vol[r] += share;
      if (isUp) up[r] += share;
    }
  }
  let poc = 0;
  for (let r = 1; r < rows; r++) if (vol[r] > vol[poc]) poc = r;
  // value area: expand from POC toward the larger neighbour until valueArea of volume is covered
  let a = poc;
  let b = poc;
  let acc = vol[poc];
  while (acc < valueArea * total && (a > 0 || b < rows - 1)) {
    const below = a > 0 ? vol[a - 1] : -1;
    const above = b < rows - 1 ? vol[b + 1] : -1;
    if (above >= below) acc += vol[++b];
    else acc += vol[--a];
  }
  return {
    i1,
    i2,
    rows: Array.from(vol, (v, r) => ({ p1: lo + r * step, p2: lo + (r + 1) * step, vol: v, up: up[r] })),
    poc: lo + (poc + 0.5) * step,
    vah: lo + (b + 1) * step,
    val: lo + a * step,
    total,
  };
}

export const volumeProfileBars = (bars: readonly Bar[], i1: number, i2: number, rows: number, va = 0.7) =>
  volumeProfileOf(
    { h: bars.map((b) => b.h), l: bars.map((b) => b.l), c: bars.map((b) => b.c), o: bars.map((b) => b.o), v: bars.map((b) => b.v) },
    i1,
    i2,
    rows,
    va,
  );

export const sessionVolumeProfile = defineStudy(
  z.object({
    period: choice(['auto', 'day', 'week', 'month'] as const, 'auto', { title: 'Session period' }),
    rows: int(24, 4, 200, { title: 'Rows' }),
    valueArea: num(0.7, 0.1, 1, { title: 'Value area %', step: 0.01 }),
    tz: text('America/New_York', { title: 'Session time zone' }),
    sessions: int(10, 1, 100, { title: 'Sessions shown' }),
    showLevels: bool(false, { title: 'Developing POC line', description: 'O(session length) per bar — off by default.' }),
  }),
  {
    id: 'volume-profile-session',
    name: 'Volume Profile (session)',
    shortName: 'VP',
    version: '1.0.0',
    category: 'Volume',
    description: 'Per-session volume-at-price histograms with point of control and value area. (The visible-range profile is in the chart toolbar.)',
    overlay: true,
    outputs: () => [
      { kind: 'line', id: 'poc', title: 'POC (developing)', color: '#ff9800', render: 'step', style: 'dotted' },
    ],
    init: () => ({ key: NaN, start: 0, starts: [] as number[] }),
    update(cfg, s, x, w) {
      const kind: PeriodKind = cfg.period === 'auto' ? higherPeriod(x.intervalMs) : cfg.period;
      const k = periodKey(x.t[w.i], kind, cfg.tz);
      if (k !== s.key) {
        s.key = k;
        s.start = w.i;
        s.starts.push(w.i);
        if (s.starts.length > cfg.sessions + 1) s.starts.shift();
      }
      if (cfg.showLevels && w.i - s.start < 400) {
        const vp = volumeProfileOf(x, s.start, w.i, cfg.rows, cfg.valueArea);
        if (vp) w.line(0, vp.poc);
      }
    },
    geometry(cfg, s, x: SeriesCtx) {
      const profiles: VolumeProfile[] = [];
      for (let k = 0; k < s.starts.length; k++) {
        const i1 = s.starts[k];
        const i2 = k + 1 < s.starts.length ? s.starts[k + 1] - 1 : x.len - 1;
        const vp = volumeProfileOf(x, i1, i2, cfg.rows, cfg.valueArea);
        if (vp) profiles.push(vp);
      }
      return { profiles };
    },
  },
);

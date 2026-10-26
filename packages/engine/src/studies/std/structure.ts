import { z } from 'zod';
import { ringInit, ringPush, smaInit, smaPush, sumFull, sumInit, sumPush } from '../../core/rolling';
import { bool, choice, defineStudy, int, num, text } from '../../core/params';
import { higherPeriod, periodKey, type PeriodKind } from '../../core/time';
import type { Geometry, Pivot } from '../../core/types';

// ── Pivot Points (classic / Fibonacci / Camarilla / Woodie) ────────────────
type PivotKind = 'classic' | 'fibonacci' | 'camarilla' | 'woodie';

export function pivotLevels(kind: PivotKind, H: number, L: number, C: number, O: number): Record<string, number> {
  const R = H - L;
  switch (kind) {
    case 'classic': {
      const P = (H + L + C) / 3;
      return { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + R, S2: P - R, R3: H + 2 * (P - L), S3: L - 2 * (H - P) };
    }
    case 'fibonacci': {
      const P = (H + L + C) / 3;
      return { P, R1: P + 0.382 * R, S1: P - 0.382 * R, R2: P + 0.618 * R, S2: P - 0.618 * R, R3: P + R, S3: P - R };
    }
    case 'camarilla': {
      const P = (H + L + C) / 3;
      const k = 1.1 * R;
      return { P, R1: C + k / 12, S1: C - k / 12, R2: C + k / 6, S2: C - k / 6, R3: C + k / 4, S3: C - k / 4, R4: C + k / 2, S4: C - k / 2 };
    }
    case 'woodie': {
      // Woodie weights the current period's open
      const P = (H + L + 2 * O) / 4;
      return { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + R, S2: P - R, R3: H + 2 * (P - L), S3: L - 2 * (H - P) };
    }
  }
}

const PIVOT_KEYS = ['P', 'R1', 'S1', 'R2', 'S2', 'R3', 'S3', 'R4', 'S4'] as const;

export const pivotPoints = defineStudy(
  z.object({
    kind: choice(['classic', 'fibonacci', 'camarilla', 'woodie'] as const, 'classic', { title: 'Type' }),
    period: choice(['auto', 'day', 'week', 'month', 'quarter', 'year'] as const, 'auto', { title: 'Pivot period' }),
    tz: text('America/New_York', { title: 'Period time zone' }),
  }),
  {
    id: 'pivot-points',
    name: 'Pivot Points',
    shortName: 'Pivots',
    version: '1.0.0',
    category: 'Trend',
    description: 'Support/resistance levels from the prior period’s high, low and close.',
    overlay: true,
    outputs: () =>
      PIVOT_KEYS.map((k) => ({
        kind: 'line' as const,
        id: k,
        title: k,
        color: k === 'P' ? ('#ff9800' as const) : k.startsWith('R') ? ('bear' as const) : ('bull' as const),
        render: 'level' as const,
        style: k === 'P' ? ('solid' as const) : ('dashed' as const),
        label: k,
      })),
    init: () => ({ key: NaN, h: -Infinity, l: Infinity, c: NaN, lv: {} as Record<string, number> }),
    update(cfg, s, x, w) {
      const i = w.i;
      const kind: PeriodKind = cfg.period === 'auto' ? higherPeriod(x.intervalMs) : cfg.period;
      const k = periodKey(x.t[i], kind, cfg.tz);
      if (k !== s.key) {
        if (Number.isFinite(s.c)) s.lv = pivotLevels(cfg.kind, s.h, s.l, s.c, x.o[i]);
        s.key = k;
        s.h = -Infinity;
        s.l = Infinity;
      }
      s.h = Math.max(s.h, x.h[i]);
      s.l = Math.min(s.l, x.l[i]);
      s.c = x.c[i];
      PIVOT_KEYS.forEach((key, n) => w.line(n, s.lv[key] ?? NaN));
    },
  },
);

// ── ZigZag ─────────────────────────────────────────────────────────────────
export const zigzag = defineStudy(
  z.object({ deviation: num(5, 0.1, 100, { title: 'Deviation %', step: 0.1 }), useHL: bool(true, { title: 'Use highs/lows' }) }),
  {
    id: 'zigzag',
    name: 'ZigZag',
    shortName: 'ZZ',
    version: '1.0.0',
    category: 'Trend',
    description: 'Connects swing highs and lows that reverse by at least the deviation %. A pivot is confirmed only once the reversal happens; the last leg is provisional.',
    overlay: true,
    outputs: () => [],
    signals: [
      { id: 'ZZ_HIGH', dir: 'bear', description: 'Swing high confirmed' },
      { id: 'ZZ_LOW', dir: 'bull', description: 'Swing low confirmed' },
    ],
    init: () => ({ dir: 0, extI: -1, extP: NaN, pivots: [] as Pivot[] }),
    update(cfg, s, x, w) {
      const i = w.i;
      const hi = cfg.useHL ? x.h[i] : x.c[i];
      const lo = cfg.useHL ? x.l[i] : x.c[i];
      const d = cfg.deviation / 100;
      if (s.dir === 0) {
        if (s.extI < 0) {
          s.extI = i;
          s.extP = x.c[i];
          return;
        }
        if (hi >= s.extP * (1 + d)) {
          s.pivots.push({ i: s.extI, price: s.extP, label: 'L', locked: true });
          s.dir = 1;
          s.extI = i;
          s.extP = hi;
        } else if (lo <= s.extP * (1 - d)) {
          s.pivots.push({ i: s.extI, price: s.extP, label: 'H', locked: true });
          s.dir = -1;
          s.extI = i;
          s.extP = lo;
        }
        return;
      }
      if (s.dir > 0) {
        if (hi > s.extP) {
          s.extI = i;
          s.extP = hi;
        } else if (lo <= s.extP * (1 - d)) {
          s.pivots.push({ i: s.extI, price: s.extP, label: 'H', locked: true });
          w.signal('ZZ_HIGH', 'bear', s.extP);
          s.dir = -1;
          s.extI = i;
          s.extP = lo;
        }
      } else if (lo < s.extP) {
        s.extI = i;
        s.extP = lo;
      } else if (hi >= s.extP * (1 + d)) {
        s.pivots.push({ i: s.extI, price: s.extP, label: 'L', locked: true });
        w.signal('ZZ_LOW', 'bull', s.extP);
        s.dir = 1;
        s.extI = i;
        s.extP = hi;
      }
      if (s.pivots.length > 400) s.pivots.shift();
    },
    geometry(_cfg, s): Geometry {
      const pts = s.pivots.slice();
      if (s.extI >= 0 && s.dir !== 0) pts.push({ i: s.extI, price: s.extP, label: s.dir > 0 ? 'H?' : 'L?', locked: false });
      return { pivots: pts, polylineColor: '#ff9800' };
    },
  },
);

// ── Linear Regression channel ──────────────────────────────────────────────
export const linreg = defineStudy(
  z.object({ length: int(100, 2, 2000, { title: 'Length' }), dev: num(2, 0, 10, { title: 'Deviations', step: 0.1 }) }),
  {
    id: 'linreg',
    name: 'Linear Regression Channel',
    shortName: 'LinReg',
    version: '1.0.0',
    category: 'Trend',
    description: 'Least-squares line over the last n closes with ± k standard-error bands. The per-bar line is the regression end-point (no repaint).',
    overlay: true,
    outputs: () => [{ kind: 'line', id: 'end', title: 'Regression end-point', color: '#7e57c2', style: 'dotted', hiddenByDefault: true }],
    init: (cfg) => ({ r: ringInit(cfg.length), sy: sumInit(cfg.length), syy: sumInit(cfg.length), sxy: 0, slope: NaN, icpt: NaN, sd: NaN, last: -1 }),
    update(cfg, s, x, w) {
      const y = x.c[w.i];
      const n = cfg.length;
      const full = s.r.count === n;
      const out = ringPush(s.r, y);
      // Σ(k·y_k) with k = 0 (oldest) … n−1 (newest): on slide every index drops by one
      if (full) s.sxy = s.sxy - (s.sy.sum - out) + (n - 1) * y;
      else s.sxy += s.r.count * y - y;
      sumPush(s.sy, y);
      sumPush(s.syy, y * y);
      if (!sumFull(s.sy)) return;
      const sx = (n * (n - 1)) / 2;
      const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
      const slope = (n * s.sxy - sx * s.sy.sum) / (n * sxx - sx * sx);
      const icpt = (s.sy.sum - slope * sx) / n;
      // residual sum of squares at the least-squares optimum: Σy² − a·Σy − b·Σky  (O(1))
      const ss = Math.max(0, s.syy.sum - icpt * s.sy.sum - slope * s.sxy);
      s.slope = slope;
      s.icpt = icpt;
      s.sd = Math.sqrt(ss / n);
      s.last = w.i;
      w.line(0, icpt + slope * (n - 1));
    },
    geometry(cfg, s): Geometry {
      if (s.last < 0) return {};
      const n = cfg.length;
      const i1 = s.last - n + 1;
      const y1 = s.icpt;
      const y2 = s.icpt + s.slope * (n - 1);
      const off = cfg.dev * s.sd;
      return {
        segments: [
          { i1, p1: y1, i2: s.last, p2: y2, color: '#7e57c2', width: 2 },
          { i1, p1: y1 + off, i2: s.last, p2: y2 + off, color: '#7e57c2', style: 'dashed' },
          { i1, p1: y1 - off, i2: s.last, p2: y2 - off, color: '#7e57c2', style: 'dashed' },
        ],
      };
    },
  },
);

// ── Relative Strength vs benchmark & Correlation ───────────────────────────
export const relativeStrength = defineStudy(
  z.object({ benchmark: text('SPY', { title: 'Benchmark symbol' }), maLength: int(50, 0, 500, { title: 'RS MA (0 = off)' }) }),
  {
    id: 'relative-strength',
    name: 'Relative Strength vs Benchmark',
    shortName: 'RS',
    version: '1.0.0',
    category: 'Momentum',
    description: 'Price ratio to a benchmark, rebased to 100 at the first common bar. The benchmark is aligned without look-ahead.',
    overlay: false,
    needsAux: () => ['benchmark'],
    outputs: () => [
      { kind: 'line', id: 'rs', title: 'RS', color: '#29b6f6', width: 2 },
      { kind: 'line', id: 'ma', title: 'RS MA', color: '#ff9800' },
    ],
    signals: [
      { id: 'RS_NEW_HIGH', dir: 'bull', description: 'RS makes a 52-bar high' },
      { id: 'RS_NEW_LOW', dir: 'bear', description: 'RS makes a 52-bar low' },
    ],
    init: (cfg) => ({ base: NaN, ma: smaInit(Math.max(1, cfg.maLength)), hist: ringInit(52) }),
    update(cfg, s, x, w) {
      const b = x.aux.benchmark?.[w.i];
      if (!(b > 0)) return;
      const ratio = x.c[w.i] / b;
      if (Number.isNaN(s.base)) s.base = ratio;
      const rs = (100 * ratio) / s.base;
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = 0; k < s.hist.count; k++) {
        hi = Math.max(hi, s.hist.buf[k]);
        lo = Math.min(lo, s.hist.buf[k]);
      }
      if (s.hist.count === 52) {
        if (rs > hi) w.signal('RS_NEW_HIGH', 'bull', x.c[w.i]);
        if (rs < lo) w.signal('RS_NEW_LOW', 'bear', x.c[w.i]);
      }
      ringPush(s.hist, rs);
      w.line(0, rs);
      if (cfg.maLength > 0) w.line(1, smaPush(s.ma, rs));
    },
  },
);

export const correlation = defineStudy(
  z.object({
    benchmark: text('SPY', { title: 'Compare with' }),
    length: int(20, 3, 500, { title: 'Length' }),
    basis: choice(['returns', 'price'] as const, 'returns', { title: 'Basis' }),
  }),
  {
    id: 'correlation',
    name: 'Correlation Coefficient',
    shortName: 'Corr',
    version: '1.0.0',
    category: 'Momentum',
    description: 'Rolling Pearson correlation with another symbol (returns or prices).',
    overlay: false,
    needsAux: () => ['benchmark'],
    outputs: () => [
      { kind: 'line', id: 'corr', title: 'Correlation', color: '#ab47bc', width: 2 },
      { kind: 'hline', id: 'zero', title: 'Zero', value: 0, color: 'muted' },
    ],
    init: (cfg) => ({ sx: sumInit(cfg.length), sy: sumInit(cfg.length), sxx: sumInit(cfg.length), syy: sumInit(cfg.length), sxy: sumInit(cfg.length), pa: NaN, pb: NaN }),
    update(cfg, s, x, w) {
      const b = x.aux.benchmark?.[w.i];
      const a = x.c[w.i];
      if (!(b > 0)) return;
      let u = a;
      let v = b;
      if (cfg.basis === 'returns') {
        const ok = Number.isFinite(s.pa) && Number.isFinite(s.pb);
        u = ok ? Math.log(a / s.pa) : NaN;
        v = ok ? Math.log(b / s.pb) : NaN;
        s.pa = a;
        s.pb = b;
        if (!ok) return;
      }
      sumPush(s.sx, u);
      sumPush(s.sy, v);
      sumPush(s.sxx, u * u);
      sumPush(s.syy, v * v);
      sumPush(s.sxy, u * v);
      if (!sumFull(s.sx)) return;
      const n = cfg.length;
      const cov = s.sxy.sum - (s.sx.sum * s.sy.sum) / n;
      const vx = s.sxx.sum - (s.sx.sum * s.sx.sum) / n;
      const vy = s.syy.sum - (s.sy.sum * s.sy.sum) / n;
      w.line(0, vx > 0 && vy > 0 ? Math.max(-1, Math.min(1, cov / Math.sqrt(vx * vy))) : 0);
    },
  },
);

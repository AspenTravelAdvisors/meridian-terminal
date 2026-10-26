import { z } from 'zod';
import { bool, choice, int, num } from '../../core/params';
import type { Geometry, SeriesCtx, StudyDef } from '../../core/types';
import { type Sg, mH } from './common';

/**
 * Level-n TD Point High at bar j (mirrored space): H[j] strictly greater than the highs of the n bars on
 * each side. It can only be CONFIRMED at bar j + n. INDICATORS §6.1
 */
export function isPointHigh(x: SeriesCtx, s: Sg, j: number, n: number, rightAvailable = n): boolean {
  if (j - n < 0 || j + rightAvailable >= x.len) return false;
  const v = mH(x, s, j);
  for (let k = 1; k <= n; k++) if (mH(x, s, j - k) >= v) return false;
  for (let k = 1; k <= rightAvailable; k++) if (mH(x, s, j + k) >= v) return false;
  return true;
}

export interface PointRef {
  i: number;
  p: number;
}

/** Returns the point confirmed at bar i (pivot at i − n), or null. Mirrored space. */
export function confirmedPointAt(x: SeriesCtx, s: Sg, i: number, n: number): PointRef | null {
  const j = i - n;
  if (j < n) return null;
  return isPointHigh(x, s, j, n) ? { i: j, p: mH(x, s, j) } : null;
}

export const pointsSchema = z.object({
  level: int(2, 1, 10, { title: 'Point level (bars each side)' }),
  showLevels: bool(true, { title: 'Show last point levels' }),
  showProvisional: bool(true, { title: 'Show unconfirmed candidates' }),
});
export type PointsCfg = z.infer<typeof pointsSchema>;

export interface PointsState {
  lastHigh: number;
  lastLow: number;
}

export const tdPoints: StudyDef<PointsCfg, PointsState> = {
  id: 'td-points',
  name: 'DeMark-style Points',
  shortName: 'Points',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Level-n swing highs/lows: a high above the n highs on each side (mirror for lows). Confirmed n bars later; candidates are drawn hollow until then.',
  overlay: true,
  schema: pointsSchema,
  outputs: () => [
    { kind: 'line', id: 'last_high', title: 'Last point high', color: 'bear', render: 'level', style: 'dotted', label: 'PH' },
    { kind: 'line', id: 'last_low', title: 'Last point low', color: 'bull', render: 'level', style: 'dotted', label: 'PL' },
  ],
  signals: [
    { id: 'TDP_HIGH', dir: 'bear', description: 'TD Point High confirmed' },
    { id: 'TDP_LOW', dir: 'bull', description: 'TD Point Low confirmed' },
  ],
  init: () => ({ lastHigh: NaN, lastLow: NaN }),
  update(cfg, st, x, w) {
    const i = w.i;
    const ph = confirmedPointAt(x, 1, i, cfg.level);
    const pl = confirmedPointAt(x, -1, i, cfg.level);
    if (ph) {
      st.lastHigh = ph.p;
      w.marker({ i: ph.i, text: '•', pos: 'above', color: 'bear', row: 3, size: 2, tooltip: `Point high L${cfg.level}` });
      w.signal('TDP_HIGH', 'bear', ph.p);
    }
    if (pl) {
      st.lastLow = -pl.p;
      w.marker({ i: pl.i, text: '•', pos: 'below', color: 'bull', row: 3, size: 2, tooltip: `Point low L${cfg.level}` });
      w.signal('TDP_LOW', 'bull', -pl.p);
    }
    if (w.inspecting) {
      w.inspect(`Point high confirmed at bar ${i - cfg.level}`, !!ph);
      w.inspect(`Point low confirmed at bar ${i - cfg.level}`, !!pl);
    }
    if (cfg.showLevels) {
      w.line(0, st.lastHigh);
      w.line(1, st.lastLow);
    }
  },
  geometry(cfg, _st, x) {
    if (!cfg.showProvisional) return {};
    const g: Geometry = { pivots: [] };
    const n = cfg.level;
    for (let j = Math.max(n, x.len - n); j < x.len; j++) {
      const right = x.len - 1 - j;
      if (isPointHigh(x, 1, j, n, right)) g.pivots!.push({ i: j, price: x.h[j], label: '◦', locked: false });
      if (isPointHigh(x, -1, j, n, right)) g.pivots!.push({ i: j, price: x.l[j], label: '◦', locked: false });
    }
    return g;
  },
};

// ── Trend Factor (INDICATORS §6.10) ─────────────────────────────────────────
export const trendFactorSchema = z.object({
  pivotMode: choice(['auto', 'manual'] as const, 'auto', { title: 'Pivot', description: 'auto: most recent level-3 point (high or low).' }),
  manualPivot: num(0, 0, 1e9, { title: 'Manual pivot price', step: 0.01 }),
  pointLevel: int(3, 1, 10, { title: 'Auto pivot point level' }),
  step: num(0.0556, 0.001, 0.5, { title: 'Step (fraction)', step: 0.0001 }),
});
export type TrendFactorCfg = z.infer<typeof trendFactorSchema>;

export const trendFactor: StudyDef<TrendFactorCfg, { pivot: number }> = {
  id: 'td-trend-factor',
  name: 'DeMark-style Trend Factor',
  shortName: 'TF',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Levels at ±5.56% steps from a pivot (11.1% and 22.2% emphasized). Pivot is manual or the latest level-3 point.',
  overlay: true,
  schema: trendFactorSchema,
  outputs: () => [
    ...[1, 2, 3, 4].map((k) => ({ kind: 'line' as const, id: `up${k}`, title: `+${(k * 5.56).toFixed(1)}%`, color: 'bear' as const, render: 'level' as const, width: k % 2 === 0 ? 2 : 1, style: k % 2 === 0 ? ('solid' as const) : ('dotted' as const), label: `+${(k * 5.56).toFixed(1)}%` })),
    ...[1, 2, 3, 4].map((k) => ({ kind: 'line' as const, id: `dn${k}`, title: `−${(k * 5.56).toFixed(1)}%`, color: 'bull' as const, render: 'level' as const, width: k % 2 === 0 ? 2 : 1, style: k % 2 === 0 ? ('solid' as const) : ('dotted' as const), label: `−${(k * 5.56).toFixed(1)}%` })),
    { kind: 'line', id: 'pivot', title: 'Pivot', color: 'muted', render: 'level', style: 'dashed', label: 'TF pivot' },
  ],
  init: () => ({ pivot: NaN }),
  update(cfg, st, x, w) {
    if (cfg.pivotMode === 'manual') st.pivot = cfg.manualPivot > 0 ? cfg.manualPivot : NaN;
    else {
      const ph = confirmedPointAt(x, 1, w.i, cfg.pointLevel);
      const pl = confirmedPointAt(x, -1, w.i, cfg.pointLevel);
      if (ph && pl) st.pivot = ph.i >= pl.i ? ph.p : -pl.p;
      else if (ph) st.pivot = ph.p;
      else if (pl) st.pivot = -pl.p;
    }
    const P = st.pivot;
    for (let k = 1; k <= 4; k++) {
      w.line(k - 1, P * (1 + k * cfg.step));
      w.line(3 + k, P * (1 - k * cfg.step));
    }
    w.line(8, P);
  },
};

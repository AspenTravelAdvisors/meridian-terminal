import { z } from 'zod';
import { bool, choice, num } from '../../core/params';
import type { Geometry, SeriesCtx, StudyDef } from '../../core/types';
import { f, trueRange } from './common';

/** Range Projection for the bar AFTER bar j (INDICATORS §5). */
export function projectFrom(x: SeriesCtx, j: number, basis: 'open' | 'priorClose'): { hi: number; lo: number; branch: string } {
  const H = x.h[j];
  const L = x.l[j];
  const C = x.c[j];
  const ref = basis === 'open' ? x.o[j] : j > 0 ? x.c[j - 1] : x.o[j];
  let X: number;
  let branch: string;
  if (C < ref) {
    X = H + 2 * L + C;
    branch = `C < ${basis === 'open' ? 'O' : 'prior C'}: X = H + 2L + C`;
  } else if (C > ref) {
    X = 2 * H + L + C;
    branch = `C > ${basis === 'open' ? 'O' : 'prior C'}: X = 2H + L + C`;
  } else {
    X = H + L + 2 * C;
    branch = 'C = ref: X = H + L + 2C';
  }
  return { hi: X / 2 - L, lo: X / 2 - H, branch };
}

export const rangeProjectionSchema = z.object({
  rpBasis: choice(['open', 'priorClose'] as const, 'open', { title: 'Compare close with', verify: 'INDICATORS §5 variant toggle' }),
  tolK: num(0.15, 0, 2, { title: 'Tolerance k × prior true range', step: 0.01 }),
  showTolerance: bool(true, { title: 'Show tolerance levels' }),
  showNext: bool(true, { title: 'Project the next bar at the right edge' }),
});
export type RangeProjectionCfg = z.infer<typeof rangeProjectionSchema>;

interface Intra {
  first?: 'PH' | 'DT' | 'PL' | 'UT';
  firstLow?: 'PL' | 'UT';
}

export const rangeProjection: StudyDef<RangeProjectionCfg, { state: number }> = {
  id: 'td-range-projection',
  name: 'DeMark-style Range Projection',
  shortName: 'RP',
  version: '1.0.0',
  category: 'DeMark',
  description:
    'Projects the current bar’s high and low from the prior bar’s OHLC, with tolerance levels around the open. Touching the projected high before the lower tolerance suggests a close above it (mirror for the low).',
  overlay: true,
  intrabar: true,
  schema: rangeProjectionSchema,
  outputs: (cfg) => [
    { kind: 'line', id: 'rp_high', title: 'Projected high', color: 'bear', render: 'level', width: 2 },
    { kind: 'line', id: 'rp_low', title: 'Projected low', color: 'bull', render: 'level', width: 2 },
    ...(cfg.showTolerance
      ? [
          { kind: 'line' as const, id: 'up_tol', title: 'Up tolerance', color: 'muted' as const, render: 'level' as const, style: 'dotted' as const },
          { kind: 'line' as const, id: 'dn_tol', title: 'Down tolerance', color: 'muted' as const, render: 'level' as const, style: 'dotted' as const },
        ]
      : []),
    { kind: 'data', id: 'rp_state', title: 'Expectation (+above / −below)' },
  ],
  signals: [
    { id: 'RP_EXPECT_ABOVE', dir: 'bull', description: 'Projected high touched before the down tolerance' },
    { id: 'RP_EXPECT_BELOW', dir: 'bear', description: 'Projected low touched before the up tolerance' },
    { id: 'RP_BREAK_HIGH', dir: 'bull', description: 'Close above the projected high' },
    { id: 'RP_BREAK_LOW', dir: 'bear', description: 'Close below the projected low' },
  ],
  init: () => ({ state: 0 }),
  update(cfg, _st, x, w, intraRaw) {
    const i = w.i;
    if (i < 1) return;
    const intra = intraRaw as Intra;
    const p = projectFrom(x, i - 1, cfg.rpBasis);
    const tr = trueRange(x, i - 1);
    const O = x.o[i];
    const upTol = O + cfg.tolK * tr;
    const dnTol = O - cfg.tolK * tr;
    const touchPH = x.h[i] >= p.hi;
    const touchDT = x.l[i] <= dnTol;
    const touchPL = x.l[i] <= p.lo;
    const touchUT = x.h[i] >= upTol;

    // Sequence touches. Live ticks record the true order in `intra`; for historical bars (no ticks)
    // both touched on one bar is resolved by proximity to the open (documented heuristic).
    const order = (aTouched: boolean, bTouched: boolean, aLvl: number, bLvl: number, a: string, b: string, cur?: string) => {
      if (cur) return cur;
      if (aTouched && bTouched) return Math.abs(aLvl - O) <= Math.abs(bLvl - O) ? a : b;
      if (aTouched) return a;
      if (bTouched) return b;
      return undefined;
    };
    intra.first = order(touchPH, touchDT, p.hi, dnTol, 'PH', 'DT', intra.first) as Intra['first'];
    intra.firstLow = order(touchPL, touchUT, p.lo, upTol, 'PL', 'UT', intra.firstLow) as Intra['firstLow'];

    let state = 0;
    if (intra.first === 'PH') {
      state = 1;
      w.signal('RP_EXPECT_ABOVE', 'bull', p.hi);
    }
    if (intra.firstLow === 'PL') {
      state = state === 1 ? 0 : -1;
      w.signal('RP_EXPECT_BELOW', 'bear', p.lo);
    }
    if (x.c[i] > p.hi) w.signal('RP_BREAK_HIGH', 'bull', x.c[i]);
    if (x.c[i] < p.lo) w.signal('RP_BREAK_LOW', 'bear', x.c[i]);
    if (w.inspecting) {
      w.inspect(`Formula — ${p.branch}`, true, `PH ${f(p.hi)} · PL ${f(p.lo)}`);
      w.inspect('Tolerance = O ± k·TR(prev)', true, `up ${f(upTol)} · down ${f(dnTol)}`);
      w.inspect('Projected high touched before down tolerance', intra.first === 'PH', intra.first ?? 'no touch');
      w.inspect('Projected low touched before up tolerance', intra.firstLow === 'PL', intra.firstLow ?? 'no touch');
    }
    w.line(0, p.hi);
    w.line(1, p.lo);
    let k = 2;
    if (cfg.showTolerance) {
      w.line(k++, upTol);
      w.line(k++, dnTol);
    }
    w.line(k, state);
  },
  geometry(cfg, _st, x) {
    if (!cfg.showNext || x.len < 1) return {};
    const p = projectFrom(x, x.len - 1, cfg.rpBasis);
    const i = x.len;
    const g: Geometry = {
      segments: [
        { i1: i - 0.45, p1: p.hi, i2: i + 0.45, p2: p.hi, color: 'bear', width: 2, label: 'RP next', style: 'dashed' },
        { i1: i - 0.45, p1: p.lo, i2: i + 0.45, p2: p.lo, color: 'bull', width: 2, style: 'dashed' },
      ],
    };
    return g;
  },
};

// ── REBO — Range Expansion Breakout (INDICATORS §5) ────────────────────────
export const reboSchema = z.object({
  r1: num(0.382, 0.01, 3, { title: 'Ratio 1', step: 0.001 }),
  r2: num(0.618, 0.01, 3, { title: 'Ratio 2', step: 0.001 }),
  r3: num(1.0, 0.01, 3, { title: 'Ratio 3', step: 0.001 }),
});
export type ReboCfg = z.infer<typeof reboSchema>;

export const rebo: StudyDef<ReboCfg, Record<string, never>> = {
  id: 'td-rebo',
  name: 'DeMark-style REBO',
  shortName: 'REBO',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Range-expansion breakout levels at the open ± ratios × prior true range; bias from whether the prior close was up or down.',
  overlay: true,
  schema: reboSchema,
  outputs: (cfg) => [
    { kind: 'line', id: 'u3', title: `+${cfg.r3}`, color: 'bull', render: 'level', width: 2 },
    { kind: 'line', id: 'u2', title: `+${cfg.r2}`, color: 'bull', render: 'level', style: 'dashed' },
    { kind: 'line', id: 'u1', title: `+${cfg.r1}`, color: 'bull', render: 'level', style: 'dotted' },
    { kind: 'line', id: 'd1', title: `−${cfg.r1}`, color: 'bear', render: 'level', style: 'dotted' },
    { kind: 'line', id: 'd2', title: `−${cfg.r2}`, color: 'bear', render: 'level', style: 'dashed' },
    { kind: 'line', id: 'd3', title: `−${cfg.r3}`, color: 'bear', render: 'level', width: 2 },
    { kind: 'data', id: 'bias', title: 'Bias (+1 up / −1 down)' },
  ],
  signals: [
    { id: 'REBO_UP_BREAK', dir: 'bull', description: 'Close beyond the top REBO level' },
    { id: 'REBO_DN_BREAK', dir: 'bear', description: 'Close beyond the bottom REBO level' },
  ],
  init: () => ({}),
  update(cfg, _s, x, w) {
    const i = w.i;
    if (i < 2) return;
    const tr = trueRange(x, i - 1);
    const O = x.o[i];
    const bias = x.c[i - 1] > x.c[i - 2] ? 1 : x.c[i - 1] < x.c[i - 2] ? -1 : 0;
    const lv = [O + cfg.r3 * tr, O + cfg.r2 * tr, O + cfg.r1 * tr, O - cfg.r1 * tr, O - cfg.r2 * tr, O - cfg.r3 * tr];
    lv.forEach((v, k) => w.line(k, v));
    w.line(6, bias);
    if (x.c[i] > lv[0]) w.signal('REBO_UP_BREAK', 'bull', x.c[i], bias > 0 ? 'with bias' : 'against bias');
    if (x.c[i] < lv[5]) w.signal('REBO_DN_BREAK', 'bear', x.c[i], bias < 0 ? 'with bias' : 'against bias');
  },
};

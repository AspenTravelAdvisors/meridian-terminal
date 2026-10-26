import { z } from 'zod';
import { bool, choice, int, num } from '../../core/params';
import type { SeriesCtx, StudyDef, Writer } from '../../core/types';
import { type Sg, SIDES, mC, mH, mL } from './common';
import { confirmedPointAt } from './points';

/**
 * ⚠ VERIFY — lowest-confidence study (INDICATORS §4). Every rule lives in `propulsionRules` so the
 * book-verified definition can be swapped in through configuration alone.
 */
export const propulsionRulesSchema = z
  .object({
    pointLevel: int(2, 1, 10, { title: 'Swing point level', verify: 'INDICATORS §4.1' }),
    propRatio: num(0.236, 0.01, 1, { title: 'Momentum ratio', step: 0.001, verify: 'INDICATORS §4.2 (Bloomberg-style preset 0.25)' }),
    targetMult: num(2, 1, 5, { title: 'Target multiple of M', step: 0.1, verify: 'INDICATORS §4.4' }),
    refPrice: choice(['swingHigh', 'closeOfHighBar'] as const, 'swingHigh', { title: 'Swing reference price', verify: 'INDICATORS §4.5' }),
    pullbackSource: choice(['tdPoint', 'lowestLow'] as const, 'tdPoint', {
      title: 'Pullback low',
      description: 'tdPoint: next confirmed point low after the swing high · lowestLow: running low once the pullback is deep enough and price turns up.',
      verify: 'INDICATORS §4.3',
    }),
    requireAboveA: bool(true, { title: 'Pullback must stay above swing low A', verify: 'INDICATORS §4.3' }),
  })
  .prefault({})
  .meta({ title: 'Propulsion rules', verify: 'INDICATORS §4 — transcribe from the reference before finalizing' });

export const propulsionSchema = z.object({
  propulsionRules: propulsionRulesSchema,
  maxBarsActive: int(60, 5, 500, { title: 'Levels expire after N bars' }),
});
export type PropulsionCfg = z.infer<typeof propulsionSchema>;

interface Pt {
  i: number;
  p: number;
}
interface Side {
  lastLow: Pt | null;
  pending: { a: Pt; b: Pt; m: number; lo: Pt } | null;
  active: { a: Pt; trigger: number; target: number; from: number; triggered: boolean } | null;
}
export interface PropulsionState {
  sides: [Side, Side];
}
const newSide = (): Side => ({ lastLow: null, pending: null, active: null });

function stepSide(cfg: PropulsionCfg, sd: Side, x: SeriesCtx, s: Sg, i: number, w: Writer): void {
  const R = cfg.propulsionRules;
  const n = R.pointLevel;
  const ph = confirmedPointAt(x, s, i, n); // mirrored swing high B
  const pl = confirmedPointAt(x, (-s) as Sg, i, n); // swing low (in real space of the opposite mirror)
  const lowPt = pl ? { i: pl.i, p: -pl.p } : null; // back to this side's mirrored space
  const name = s > 0 ? 'UP' : 'DOWN';

  // a new swing high with a prior swing low defines a construction
  if (ph && sd.lastLow && sd.lastLow.i < ph.i && ph.p > sd.lastLow.p) {
    const ref = R.refPrice === 'swingHigh' ? ph.p : mC(x, s, ph.i);
    const m = (ref - sd.lastLow.p) * R.propRatio;
    sd.pending = { a: sd.lastLow, b: { i: ph.i, p: ref }, m, lo: { i: ph.i, p: Infinity } };
  }
  if (lowPt) sd.lastLow = lowPt;

  const pend = sd.pending;
  if (pend) {
    let P: Pt | null = null;
    if (R.pullbackSource === 'tdPoint') {
      if (lowPt && lowPt.i > pend.b.i) P = lowPt;
    } else {
      if (mL(x, s, i) < pend.lo.p) pend.lo = { i, p: mL(x, s, i) };
      if (pend.lo.p <= pend.b.p - pend.m && i > pend.lo.i && mC(x, s, i) > mC(x, s, i - 1)) P = pend.lo;
    }
    if (mH(x, s, i) > pend.b.p && !P) sd.pending = null; // new high before a pullback: wait for the next swing
    if (P) {
      const deep = P.p <= pend.b.p - pend.m;
      const above = !R.requireAboveA || P.p > pend.a.p;
      if (w.inspecting) {
        w.inspect(`Propulsion ${name}: pullback retraces ≥ M`, deep, `P=${(s * P.p).toFixed(4)} M=${pend.m.toFixed(4)}`);
        w.inspect(`Propulsion ${name}: pullback stays beyond A`, above);
      }
      if (deep && above) sd.active = { a: pend.a, trigger: P.p + pend.m, target: P.p + R.targetMult * pend.m, from: i, triggered: false };
      sd.pending = null;
    }
  }

  const act = sd.active;
  if (act) {
    if (mC(x, s, i) < act.a.p || i - act.from > cfg.maxBarsActive) sd.active = null;
    else {
      if (!act.triggered && mC(x, s, i) > act.trigger) {
        act.triggered = true;
        w.signal(`PROP_${name}_TRIGGER`, s > 0 ? 'bull' : 'bear', s * act.trigger);
        w.marker({ i, text: 'P', pos: s > 0 ? 'below' : 'above', color: s > 0 ? 'bull' : 'bear', row: 4, size: 1, tooltip: 'Propulsion trigger' });
      }
      if (mH(x, s, i) >= act.target) {
        w.signal(`PROP_${name}_TARGET_HIT`, s > 0 ? 'bear' : 'bull', s * act.target);
        w.marker({ i, text: 'T', pos: s > 0 ? 'above' : 'below', color: 'warn', row: 4, size: 1, tooltip: 'Propulsion exhaustion target hit' });
        sd.active = null;
      }
    }
  }
}

export const propulsion: StudyDef<PropulsionCfg, PropulsionState> = {
  id: 'td-propulsion',
  name: 'DeMark-style Propulsion',
  shortName: 'Prop',
  version: '0.9.0',
  category: 'DeMark',
  description:
    'From a swing low→high, momentum M = range × ratio. A pullback retracing at least M projects a momentum trigger (P + M) and an exhaustion target (P + 2M). Provisional rules — see VERIFY_LOG.',
  overlay: true,
  schema: propulsionSchema,
  presets: { Default: {}, 'Bloomberg-style 0.25': { propulsionRules: { propRatio: 0.25 } as PropulsionCfg['propulsionRules'] } },
  verify: [{ key: 'propulsionRules', note: 'INDICATORS §4 — whole construction' }],
  outputs: () => [
    { kind: 'line', id: 'up_trigger', title: 'Propulsion up trigger', color: 'bull', render: 'level', style: 'solid', label: 'Prop ↑' },
    { kind: 'line', id: 'up_target', title: 'Propulsion up target', color: 'bull', render: 'level', style: 'dashed', label: 'Prop tgt' },
    { kind: 'line', id: 'dn_trigger', title: 'Propulsion down trigger', color: 'bear', render: 'level', style: 'solid', label: 'Prop ↓' },
    { kind: 'line', id: 'dn_target', title: 'Propulsion down target', color: 'bear', render: 'level', style: 'dashed', label: 'Prop tgt' },
  ],
  signals: [
    { id: 'PROP_UP_TRIGGER', dir: 'bull', description: 'Close above the propulsion up trigger' },
    { id: 'PROP_UP_TARGET_HIT', dir: 'bear', description: 'Propulsion up exhaustion target reached' },
    { id: 'PROP_DOWN_TRIGGER', dir: 'bear', description: 'Close below the propulsion down trigger' },
    { id: 'PROP_DOWN_TARGET_HIT', dir: 'bull', description: 'Propulsion down exhaustion target reached' },
  ],
  init: () => ({ sides: [newSide(), newSide()] }),
  update(cfg, st, x, w) {
    SIDES.forEach((s, k) => stepSide(cfg, st.sides[k], x, s, w.i, w));
    const [u, d] = st.sides;
    w.line(0, u.active ? u.active.trigger : NaN);
    w.line(1, u.active ? u.active.target : NaN);
    w.line(2, d.active ? -d.active.trigger : NaN);
    w.line(3, d.active ? -d.active.target : NaN);
  },
};

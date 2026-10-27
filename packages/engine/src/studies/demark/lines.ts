import { z } from 'zod';
import { bool, int, num } from '../../core/params';
import type { Geometry, SeriesCtx, StudyDef, Writer } from '../../core/types';
import { type Sg, SIDES, mC, mH, mL, mO, mTL } from './common';
import { confirmedPointAt } from './points';

export const tdLinesSchema = z.object({
  level: int(1, 1, 21, { title: 'Point level', description: 'TD Point level used for the anchors (1–21).' }),
  useQ1: bool(true, { title: 'Q1: prior close below the close two bars before', group: 'Qualifiers', verify: 'INDICATORS §6.2' }),
  useQ2: bool(true, { title: 'Q2: opens beyond the line and trades a tick beyond', group: 'Qualifiers', verify: 'INDICATORS §6.2' }),
  useQ3: bool(true, { title: 'Q3: prior bar pressure projected beyond the line', group: 'Qualifiers', verify: 'INDICATORS §6.2' }),
  tick: num(0, 0, 1e6, { title: 'Tick size', group: 'Qualifiers', step: 0.0001 }),
  showTargets: bool(true, { title: 'Show projection targets' }),
  history: int(60, 5, 500, { title: 'Anchor search depth (points)' }),
});
export type TdLinesCfg = z.infer<typeof tdLinesSchema>;

interface Pt {
  i: number;
  p: number;
}
interface Side {
  pts: Pt[];
  line: { a: Pt; b: Pt; slope: number; from: number } | null;
  target: number;
  broken: { a: Pt; b: Pt; at: number; slope: number } | null;
}
export interface TdLinesState {
  sides: [Side, Side];
}

const newSide = (): Side => ({ pts: [], line: null, target: NaN, broken: null });
const lineAt = (l: { b: Pt; slope: number }, i: number) => l.b.p + l.slope * (i - l.b.i);

function stepSide(cfg: TdLinesCfg, sd: Side, x: SeriesCtx, s: Sg, i: number, w: Writer): void {
  const name = s > 0 ? 'SUPPLY' : 'DEMAND';
  // 1) a newly confirmed point (mirrored high) may define a new line
  const pt = confirmedPointAt(x, s, i, cfg.level);
  if (pt) {
    let prior: Pt | null = null;
    for (let k = sd.pts.length - 1; k >= 0; k--)
      if (sd.pts[k].p > pt.p) {
        prior = sd.pts[k];
        break;
      }
    sd.pts.push(pt);
    if (sd.pts.length > cfg.history) sd.pts.shift();
    if (prior) sd.line = { a: prior, b: pt, slope: (pt.p - prior.p) / (pt.i - prior.i), from: i };
  }
  // 2) breakout test
  const l = sd.line;
  if (l && i > l.from) {
    const v = lineAt(l, i);
    const c = mC(x, s, i);
    if (c > v) {
      const q1 = cfg.useQ1 && i >= 2 && mC(x, s, i - 1) < mC(x, s, i - 2);
      const q2 = cfg.useQ2 && mO(x, s, i) > v && mH(x, s, i) >= v + cfg.tick;
      const q3 = cfg.useQ3 && i >= 1 && mC(x, s, i - 1) + (mC(x, s, i - 1) - mTL(x, s, i - 1)) > v;
      const qualified = q1 || q2 || q3;
      if (w.inspecting) {
        w.inspect(`${name} line break: close beyond line`, true, `line ${(s * v).toFixed(4)}`);
        w.inspect('Q1 prior close < close two bars before', q1);
        w.inspect('Q2 open beyond line & trades a tick beyond', q2);
        w.inspect('Q3 prior bar pressure projected beyond line', q3);
      }
      // projection: distance from the line to the most extreme opposite price between the anchors
      let lo = Infinity;
      let loI = l.a.i;
      for (let k = l.a.i; k <= l.b.i; k++)
        if (mL(x, s, k) < lo) {
          lo = mL(x, s, k);
          loI = k;
        }
      sd.target = v + (lineAt(l, loI) - lo);
      w.signal(qualified ? `TDL_${name}_BREAK` : `TDL_${name}_BREAK_UNQUALIFIED`, s > 0 ? 'bull' : 'bear', x.c[i], qualified ? 'qualified' : 'unqualified');
      w.marker({ i, text: qualified ? '⇡' : '↑', pos: s > 0 ? 'below' : 'above', color: s > 0 ? 'bull' : 'bear', row: 4, size: 2, tooltip: `${name.toLowerCase()} line break (${qualified ? 'qualified' : 'unqualified'})` });
      sd.broken = { a: l.a, b: l.b, at: i, slope: l.slope };
      sd.line = null;
    }
  }
  if (Number.isFinite(sd.target) && mH(x, s, i) >= sd.target) {
    w.signal(`TDL_${name}_TARGET_HIT`, s > 0 ? 'bull' : 'bear', s * sd.target);
    sd.target = NaN;
  }
}

export const tdLines: StudyDef<TdLinesCfg, TdLinesState> = {
  id: 'td-lines',
  name: 'DeMark-style Lines',
  shortName: 'TD Lines',
  version: '1.0.0',
  category: 'DeMark',
  description:
    'Supply line through the two most recent descending point highs, demand line through the two most recent ascending point lows. Breakouts are qualified (Q1–Q3) and projected.',
  overlay: true,
  schema: tdLinesSchema,
  outputs: (cfg) => [
    { kind: 'data', id: 'supply', title: 'Supply line' },
    { kind: 'data', id: 'demand', title: 'Demand line' },
    ...(cfg.showTargets
      ? [
          { kind: 'line' as const, id: 'supply_target', title: 'Upside target', color: 'bull' as const, render: 'level' as const, style: 'dashed' as const, label: 'TDL tgt' },
          { kind: 'line' as const, id: 'demand_target', title: 'Downside target', color: 'bear' as const, render: 'level' as const, style: 'dashed' as const, label: 'TDL tgt' },
        ]
      : []),
  ],
  signals: [
    { id: 'TDL_SUPPLY_BREAK', dir: 'bull', description: 'Qualified upside break of the supply line' },
    { id: 'TDL_DEMAND_BREAK', dir: 'bear', description: 'Qualified downside break of the demand line' },
    { id: 'TDL_SUPPLY_BREAK_UNQUALIFIED', dir: 'neutral', description: 'Unqualified supply-line break' },
    { id: 'TDL_DEMAND_BREAK_UNQUALIFIED', dir: 'neutral', description: 'Unqualified demand-line break' },
    { id: 'TDL_SUPPLY_TARGET_HIT', dir: 'bull', description: 'Upside projection reached' },
    { id: 'TDL_DEMAND_TARGET_HIT', dir: 'bear', description: 'Downside projection reached' },
  ],
  init: () => ({ sides: [newSide(), newSide()] }),
  update(cfg, st, x, w) {
    SIDES.forEach((s, k) => stepSide(cfg, st.sides[k], x, s, w.i, w));
    const [sup, dem] = st.sides;
    w.line(0, sup.line ? lineAt(sup.line, w.i) : NaN);
    w.line(1, dem.line ? -lineAt(dem.line, w.i) : NaN);
    if (cfg.showTargets) {
      w.line(2, sup.target);
      w.line(3, -dem.target);
    }
  },
  geometry(_cfg, st, x) {
    const g: Geometry = { segments: [] };
    st.sides.forEach((sd, k) => {
      const s = k === 0 ? 1 : -1;
      const color = k === 0 ? 'bear' : 'bull';
      if (sd.line) {
        const end = x.len + 5;
        g.segments!.push({ i1: sd.line.a.i, p1: s * sd.line.a.p, i2: end, p2: s * lineAt(sd.line, end), color, width: 2, label: k === 0 ? 'Supply' : 'Demand' });
      }
      if (sd.broken) g.segments!.push({ i1: sd.broken.a.i, p1: s * sd.broken.a.p, i2: sd.broken.at, p2: s * lineAt(sd.broken, sd.broken.at), color: 'muted', style: 'dashed', width: 1 });
    });
    return g;
  },
};

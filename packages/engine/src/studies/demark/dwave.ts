import { z } from 'zod';
import { bool, choice, int, num } from '../../core/params';
import type { Geometry, Pivot, SeriesCtx, StudyDef, StudyStatus, Writer } from '../../core/types';
import { type Sg, mC, mH, mL } from './common';

const ladder = (def: number, title: string) => int(def, 2, 89, { title, group: 'Lookbacks', verify: 'INDICATORS §3 lookback ladder' });

export const dwaveSchema = z.object({
  basis: choice(['highLow', 'close'] as const, 'highLow', {
    title: 'Price basis',
    description: 'highLow: N-bar highs/lows · close: N-bar high/low closes.',
    verify: 'INDICATORS §3',
  }),
  nBarTest: choice(['atLeastPriorN', 'abovePriorNMinus1'] as const, 'atLeastPriorN', {
    title: 'N-bar high test',
    description: 'atLeastPriorN: at or above each of the previous N bars · abovePriorNMinus1: strictly above the previous N − 1 bars.',
    verify: 'INDICATORS §3',
  }),
  lbOrigin: ladder(21, 'Origin (wave 0) low'),
  lbW1: ladder(13, 'Wave 1 high'),
  lbW2: ladder(8, 'Wave 2 low'),
  lbW3: ladder(21, 'Wave 3 high'),
  lbW4: ladder(13, 'Wave 4 low'),
  lbW5: ladder(21, 'Wave 5 high'),
  lbA: ladder(13, 'Wave A low'),
  lbB: ladder(8, 'Wave B high'),
  lbC: ladder(21, 'Wave C low'),
  direction: choice(['auto', 'up', 'down', 'both'] as const, 'auto', {
    title: 'Sequences shown',
    description: 'auto shows whichever sequence is further advanced.',
  }),
  showFib: bool(true, { title: 'Fibonacci guides', group: 'Guides' }),
  fibRetrace: num(0.618, 0.1, 1, { title: 'Wave 2 ideal retrace', group: 'Guides', step: 0.001 }),
  fibW3: num(1.618, 1, 5, { title: 'Wave 3 projection ×W1', group: 'Guides', step: 0.001 }),
  fibW5: num(2.618, 1, 6, { title: 'Wave 5 projection ×W1', group: 'Guides', step: 0.001 }),
  keepCompleted: int(3, 0, 20, { title: 'Completed sequences kept', group: 'Display' }),
});
export type DWaveCfg = z.infer<typeof dwaveSchema>;

/** A wave end (i, p) and where that wave was first recognised (fi, fp) before any shift to the right. */
interface P {
  i: number;
  p: number;
  fi: number;
  fp: number;
}
const NONE: P = { i: -1, p: NaN, fi: -1, fp: NaN };
/** a newly recognised wave end */
const at = (i: number, p: number): P => ({ i, p, fi: i, fp: p });
/** the same wave, its end shifted right to (i, p) */
const mv = (pt: P, i: number, p: number): P => ({ i, p, fi: pt.fi, fp: pt.fp });

interface Seq {
  phase: number; // 0 seek, 1..5 waves, 6=A, 7=B, 8=C
  o: P;
  w1: P;
  w2: P;
  w3: P;
  w4: P;
  w5: P;
  a: P;
  b: P;
  c: P;
  lastEvent: number;
  done: Pivot[][];
}

export interface DWaveState {
  seq: [Seq, Seq];
}

const newSeq = (): Seq => ({ phase: 0, o: NONE, w1: NONE, w2: NONE, w3: NONE, w4: NONE, w5: NONE, a: NONE, b: NONE, c: NONE, lastEvent: -1, done: [] });

const hiOf = (cfg: DWaveCfg, x: SeriesCtx, s: Sg, i: number) => (cfg.basis === 'close' ? mC(x, s, i) : mH(x, s, i));
const loOf = (cfg: DWaveCfg, x: SeriesCtx, s: Sg, i: number) => (cfg.basis === 'close' ? mC(x, s, i) : mL(x, s, i));

/**
 * "N-bar high" (INDICATORS §3): by default at least as high as each of the previous N bars; the alternative test is
 * strictly higher than the previous N − 1 bars.
 */
function nHigh(cfg: DWaveCfg, x: SeriesCtx, s: Sg, i: number, n: number): boolean {
  const atLeast = cfg.nBarTest === 'atLeastPriorN';
  const m = atLeast ? n : n - 1;
  if (i < m) return false;
  const v = hiOf(cfg, x, s, i);
  for (let k = 1; k <= m; k++) {
    const u = hiOf(cfg, x, s, i - k);
    if (atLeast ? u > v : u >= v) return false;
  }
  return true;
}
function nLow(cfg: DWaveCfg, x: SeriesCtx, s: Sg, i: number, n: number): boolean {
  const atLeast = cfg.nBarTest === 'atLeastPriorN';
  const m = atLeast ? n : n - 1;
  if (i < m) return false;
  const v = loOf(cfg, x, s, i);
  for (let k = 1; k <= m; k++) {
    const u = loOf(cfg, x, s, i - k);
    if (atLeast ? u < v : u <= v) return false;
  }
  return true;
}

function pivots(q: Seq, s: Sg): Pivot[] {
  const out: Pivot[] = [];
  const add = (pt: P, label: string, lockedAt: number) => {
    if (pt.i < 0 || q.phase < lockedAt - 1) return;
    const pv: Pivot = { i: pt.i, price: s * pt.p, label, locked: q.phase >= lockedAt };
    // "+" where the wave was first recognised, when its end has since shifted right
    if (pt.fi >= 0 && pt.fi !== pt.i) pv.first = { i: pt.fi, price: s * pt.fp };
    out.push(pv);
  };
  if (q.o.i >= 0) out.push({ i: q.o.i, price: s * q.o.p, label: '0', locked: q.phase >= 1 });
  add(q.w1, '1', 2);
  add(q.w2, '2', 3);
  add(q.w3, '3', 4);
  add(q.w4, '4', 5);
  add(q.w5, '5', 6);
  add(q.a, 'A', 7);
  add(q.b, 'B', 8);
  add(q.c, 'C', 9);
  return out;
}

function emitSig(q: Seq, x: SeriesCtx, w: Writer, i: number, up: boolean, id: string, bull: boolean): void {
  q.lastEvent = i;
  w.signal(`DWAVE_${up ? '' : 'DOWN_'}${id}`, bull === up ? 'bull' : 'bear', x.c[i]);
}

function restartSeq(q: Seq, i: number, lo: number): void {
  q.phase = 0;
  q.o = at(i, lo);
  q.w1 = q.w2 = q.w3 = q.w4 = q.w5 = q.a = q.b = q.c = NONE;
}

function step(cfg: DWaveCfg, q: Seq, x: SeriesCtx, s: Sg, i: number, w: Writer, keep: number): void {
  const hi = hiOf(cfg, x, s, i);
  const lo = loOf(cfg, x, s, i);
  const up = s > 0;

  switch (q.phase) {
    case 0: {
      if (nLow(cfg, x, s, i, cfg.lbOrigin) || (q.o.i >= 0 && lo < q.o.p)) q.o = at(i, lo);
      const t = q.o.i >= 0 && i > q.o.i && nHigh(cfg, x, s, i, cfg.lbW1);
      if (w.inspecting) w.inspect(`${up ? 'Up' : 'Down'} D-Wave: ${cfg.lbW1}-bar high after origin → wave 1`, t);
      if (t) {
        q.phase = 1;
        q.w1 = at(i, hi);
        emitSig(q, x, w, i, up, '1_START', true);
      }
      break;
    }
    case 1:
      if (hi > q.w1.p) q.w1 = mv(q.w1, i, hi); // Wave 1 shifts right to the new high
      else if (lo <= q.o.p) restartSeq(q, i, lo);
      else if (nLow(cfg, x, s, i, cfg.lbW2)) {
        q.phase = 2;
        q.w2 = at(i, lo);
      }
      break;
    case 2:
      if (lo <= q.o.p) restartSeq(q, i, lo);
      else if (lo < q.w2.p) q.w2 = mv(q.w2, i, lo);
      else if (nHigh(cfg, x, s, i, cfg.lbW3) && hi > q.w1.p) {
        q.phase = 3;
        q.w3 = at(i, hi);
        emitSig(q, x, w, i, up, '3_START', true);
      } else if (hi > q.w1.p) {
        // pullback did not hold and price made a new high without a wave-3 trigger → wave 1 extends
        q.phase = 1;
        q.w1 = mv(q.w1, i, hi);
        q.w2 = NONE;
      }
      break;
    case 3:
      if (hi > q.w3.p) q.w3 = mv(q.w3, i, hi);
      else if (lo <= q.o.p) restartSeq(q, i, lo);
      else if (lo < q.w2.p) {
        // Wave 2 shifts right; wave 1 re-evaluates to the highest high since it began, which is wave 3's peak.
        q.phase = 2;
        q.w1 = mv(q.w1, q.w3.i, q.w3.p);
        q.w2 = mv(q.w2, i, lo);
        q.w3 = NONE;
      } else if (nLow(cfg, x, s, i, cfg.lbW4)) {
        const confirmed = q.w3.p > q.w1.p;
        if (w.inspecting) w.inspect(`${up ? 'Up' : 'Down'} D-Wave: wave 3 peak exceeds wave 1 peak`, confirmed);
        if (confirmed) {
          q.phase = 4;
          q.w4 = at(i, lo);
        } else {
          q.phase = 2;
          q.w3 = NONE;
        }
      }
      break;
    case 4:
      if (lo < q.w4.p) q.w4 = mv(q.w4, i, lo);
      if (q.w4.p < q.w2.p) {
        // Wave 4 undercut wave 2 → wave 2 shifts right to wave 4's low and wave 1 to wave 3's peak (the highest high
        // since wave 1 began); re-evaluate from wave 2
        if (q.w4.p <= q.o.p) restartSeq(q, i, lo);
        else {
          q.w1 = mv(q.w1, q.w3.i, q.w3.p);
          q.w2 = mv(q.w2, q.w4.i, q.w4.p);
          q.w3 = q.w4 = NONE;
          q.phase = 2;
        }
      } else if (nHigh(cfg, x, s, i, cfg.lbW5) && hi > q.w3.p) {
        q.phase = 5;
        q.w5 = at(i, hi);
        emitSig(q, x, w, i, up, '5_START', true);
      } else if (hi > q.w3.p) {
        q.phase = 3;
        q.w3 = mv(q.w3, i, hi);
        q.w4 = NONE;
      }
      break;
    case 5:
      if (hi > q.w5.p) q.w5 = mv(q.w5, i, hi);
      else if (nLow(cfg, x, s, i, cfg.lbA)) {
        const confirmed = q.w5.p > q.w3.p;
        if (w.inspecting) w.inspect(`${up ? 'Up' : 'Down'} D-Wave: wave 5 peak exceeds wave 3 peak`, confirmed);
        if (confirmed) {
          q.phase = 6;
          q.a = at(i, lo);
          emitSig(q, x, w, i, up, '5_COMPLETE', false);
        } else {
          q.phase = 4;
          if (lo < q.w4.p) q.w4 = mv(q.w4, i, lo);
          q.w5 = NONE;
        }
      }
      break;
    case 6:
      if (hi > q.w5.p) {
        q.phase = 5;
        q.w5 = mv(q.w5, i, hi);
        q.a = NONE;
      } else if (lo < q.a.p) q.a = mv(q.a, i, lo);
      else if (nHigh(cfg, x, s, i, cfg.lbB)) {
        q.phase = 7;
        q.b = at(i, hi);
      }
      break;
    case 7:
      if (hi > q.w5.p) {
        q.phase = 5;
        q.w5 = mv(q.w5, i, hi);
        q.a = q.b = NONE;
      } else if (hi > q.b.p) q.b = mv(q.b, i, hi);
      else if (nLow(cfg, x, s, i, cfg.lbC) || lo < q.a.p) {
        q.phase = 8;
        q.c = at(i, lo);
      }
      break;
    case 8:
      if (lo < q.c.p) q.c = mv(q.c, i, lo);
      if (q.c.p < q.a.p) {
        // Wave C closes below wave A's low → C locked, wave 5 locked permanently; sequence complete.
        emitSig(q, x, w, i, up, 'C_LOCKED', false);
        q.phase = 9;
        if (keep > 0) {
          q.done.push(pivots(q, s));
          if (q.done.length > keep) q.done.shift();
        }
        restartSeq(q, i, lo);
      } else if (hi > q.w5.p) {
        q.phase = 5;
        q.w5 = mv(q.w5, i, hi);
        q.a = q.b = q.c = NONE;
      }
      break;
  }
}

export const dwave: StudyDef<DWaveCfg, DWaveState> = {
  id: 'td-dwave',
  name: 'DeMark-style D-Wave',
  shortName: 'D-Wave',
  version: '1.0.0',
  category: 'DeMark',
  description:
    'Mechanical Elliott-style wave labels from N-bar highs and lows (21/13/8 ladder), with wave-shift rules, confirmation qualifiers, "+" first-recognition marks and optional Fibonacci guides.',
  overlay: true,
  schema: dwaveSchema,
  presets: {
    'High/low 21/13/8': {},
    'Close-based 21/13/8': { basis: 'close', nBarTest: 'abovePriorNMinus1' },
    'Alt (H/L) 8/5/13': { lbOrigin: 21, lbW1: 8, lbW2: 5, lbW3: 13, lbW4: 8, lbW5: 21, lbA: 13, lbB: 8, lbC: 21 },
  },
  verify: [
    { key: 'lbOrigin', note: 'INDICATORS §3 lookback ladder' },
    { key: 'basis', note: 'INDICATORS §3' },
    { key: 'nBarTest', note: 'INDICATORS §3' },
  ],
  outputs: () => [{ kind: 'data', id: 'wave', title: 'Wave phase (+up / −down)' }],
  signals: [
    { id: 'DWAVE_1_START', dir: 'bull', description: 'Up-sequence wave 1 begins' },
    { id: 'DWAVE_3_START', dir: 'bull', description: 'Up-sequence wave 3 begins' },
    { id: 'DWAVE_5_START', dir: 'bull', description: 'Up-sequence wave 5 begins' },
    { id: 'DWAVE_5_COMPLETE', dir: 'bear', description: 'Up-sequence wave 5 complete (wave A begins)' },
    { id: 'DWAVE_C_LOCKED', dir: 'bear', description: 'Up-sequence wave C locked' },
    { id: 'DWAVE_DOWN_3_START', dir: 'bear', description: 'Down-sequence wave 3 begins' },
    { id: 'DWAVE_DOWN_5_START', dir: 'bear', description: 'Down-sequence wave 5 begins' },
    { id: 'DWAVE_DOWN_5_COMPLETE', dir: 'bull', description: 'Down-sequence wave 5 complete' },
    { id: 'DWAVE_DOWN_C_LOCKED', dir: 'bull', description: 'Down-sequence wave C locked' },
  ],
  init: () => ({ seq: [newSeq(), newSeq()] }),
  update(cfg, st, x, w) {
    step(cfg, st.seq[0], x, 1, w.i, w, cfg.keepCompleted);
    step(cfg, st.seq[1], x, -1, w.i, w, cfg.keepCompleted);
    const [u, d] = st.seq;
    w.line(0, u.phase >= d.phase ? u.phase : -d.phase);
  },
  geometry(cfg, st) {
    const g: Geometry = { pivots: [], segments: [] };
    const [u, d] = st.seq;
    const show: number[] =
      cfg.direction === 'up' ? [0] : cfg.direction === 'down' ? [1] : cfg.direction === 'both' ? [0, 1] : [u.phase > d.phase || (u.phase === d.phase && u.lastEvent >= d.lastEvent) ? 0 : 1];
    for (const k of show) {
      const q = st.seq[k];
      const s: Sg = k === 0 ? 1 : -1;
      for (const done of q.done) g.pivots!.push(...done.map((p) => ({ ...p, locked: true })));
      if (q.phase >= 1) g.pivots!.push(...pivots(q, s));
      if (cfg.showFib && q.phase >= 2 && q.o.i >= 0 && q.w1.i >= 0) {
        const L1 = q.w1.p - q.o.p;
        const end = Math.max(q.w1.i, q.w2.i, q.w3.i, q.w4.i) + 30;
        const color = k === 0 ? 'bull' : 'bear';
        g.segments!.push({ i1: q.w1.i, p1: s * (q.w1.p - cfg.fibRetrace * L1), i2: end, p2: s * (q.w1.p - cfg.fibRetrace * L1), color: 'muted', style: 'dotted', label: `W2 ${cfg.fibRetrace}` });
        if (q.w2.i >= 0) {
          const t3 = q.w2.p + cfg.fibW3 * L1;
          const t5 = q.w2.p + cfg.fibW5 * L1;
          g.segments!.push({ i1: q.w2.i, p1: s * t3, i2: end, p2: s * t3, color, style: 'dotted', label: `W3 ${cfg.fibW3}×` });
          if (q.phase >= 4) g.segments!.push({ i1: q.w4.i >= 0 ? q.w4.i : q.w2.i, p1: s * t5, i2: end, p2: s * t5, color, style: 'dotted', label: `W5 ${cfg.fibW5}×` });
        }
      }
    }
    g.polylineColor = 'accent';
    return g;
  },
  status(_cfg, st): StudyStatus {
    const [u, d] = st.seq;
    const name = (p: number) => (p <= 5 ? String(p) : ['A', 'B', 'C'][p - 6] ?? '');
    const chips: StudyStatus['chips'] = [];
    if (u.phase >= 1 && u.phase >= d.phase) chips.push({ text: `D-Wave ${name(u.phase)}`, dir: u.phase >= 5 ? 'bear' : 'bull', strength: u.phase / 8 });
    else if (d.phase >= 1) chips.push({ text: `D-Wave ↓${name(d.phase)}`, dir: d.phase >= 5 ? 'bull' : 'bear', strength: d.phase / 8 });
    return { chips, values: { upWave: u.phase, downWave: d.phase } };
  },
};

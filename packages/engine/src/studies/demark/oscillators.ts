import { z } from 'zod';
import { type RollSum, sumFull, sumInit, sumPush } from '../../core/rolling';
import { bool, choice, int, num } from '../../core/params';
import type { SeriesCtx, StudyDef, StudyStatus, Writer } from '../../core/types';
import { f, trueHigh, trueLow } from './common';

// ── Zone + duration analysis shared by DeMarker I/II, REI and Pressure ────
export interface Zone {
  ob: number;
  os: number;
  inOB: number; // consecutive bars in overbought (0 = not in zone)
  inOS: number;
  prevOB: number; // duration of the episode that just ended
  prevOS: number;
}
export const zoneInit = (): Zone => ({ ob: 0, os: 0, inOB: 0, inOS: 0, prevOB: 0, prevOS: 0 });

export interface ZoneEvents {
  obExit: boolean;
  osExit: boolean;
  obDuration: number;
  osDuration: number;
}

export function zoneStep(z: Zone, v: number, ob: number, os: number): ZoneEvents {
  const ev: ZoneEvents = { obExit: false, osExit: false, obDuration: 0, osDuration: 0 };
  if (!Number.isFinite(v)) return ev;
  if (v >= ob) z.inOB++;
  else if (z.inOB > 0) {
    ev.obExit = true;
    ev.obDuration = z.inOB;
    z.prevOB = z.inOB;
    z.inOB = 0;
  }
  if (v <= os) z.inOS++;
  else if (z.inOS > 0) {
    ev.osExit = true;
    ev.osDuration = z.inOS;
    z.prevOS = z.inOS;
    z.inOS = 0;
  }
  return ev;
}

const zoneShape = (ob: number, os: number) => ({
  overbought: num(ob, -100, 100, { title: 'Overbought', group: 'Zones', step: 1 }),
  oversold: num(os, -100, 100, { title: 'Oversold', group: 'Zones', step: 1 }),
  maxDuration: int(13, 1, 100, {
    title: 'Max bars in zone',
    group: 'Zones',
    description: 'Longer stays are flagged “extreme / trend” and suppress reversal signals.',
  }),
});

function zoneSignals(
  w: Writer,
  x: SeriesCtx,
  prefix: string,
  ev: ZoneEvents,
  z: Zone,
  maxDur: number,
  qual?: { bars: number; test: 'close' | 'high' },
): void {
  const i = w.i;
  if (ev.osExit) {
    if (ev.osDuration <= maxDur) {
      w.signal(`${prefix}_OS_EXIT`, 'bull', x.c[i]);
      if (qual) {
        let ok = true;
        for (let k = 1; k <= qual.bars; k++) ok = ok && i - k >= 0 && x.c[i] > (qual.test === 'close' ? x.c[i - k] : x.h[i - k]);
        if (ok) w.signal(`${prefix}_OS_EXIT_QUALIFIED`, 'bull', x.c[i]);
      }
    } else w.signal(`${prefix}_OS_EXIT_EXTREME`, 'neutral', x.c[i], `${ev.osDuration} bars in zone`);
  }
  if (ev.obExit) {
    if (ev.obDuration <= maxDur) {
      w.signal(`${prefix}_OB_EXIT`, 'bear', x.c[i]);
      if (qual) {
        let ok = true;
        for (let k = 1; k <= qual.bars; k++) ok = ok && i - k >= 0 && x.c[i] < (qual.test === 'close' ? x.c[i - k] : x.l[i - k]);
        if (ok) w.signal(`${prefix}_OB_EXIT_QUALIFIED`, 'bear', x.c[i]);
      }
    } else w.signal(`${prefix}_OB_EXIT_EXTREME`, 'neutral', x.c[i], `${ev.obDuration} bars in zone`);
  }
  if (z.inOB === maxDur + 1) w.signal(`${prefix}_OB_EXTREME`, 'bull', x.c[i], 'trend: overbought too long');
  if (z.inOS === maxDur + 1) w.signal(`${prefix}_OS_EXTREME`, 'bear', x.c[i], 'trend: oversold too long');
}

const zoneStatus = (name: string, v: number, z: Zone, maxDur: number): StudyStatus => {
  const chips: StudyStatus['chips'] = [];
  if (z.inOS > 0) chips.push({ text: `${name} OS ${z.inOS}${z.inOS > maxDur ? ' ⚠' : ''}`, dir: z.inOS > maxDur ? 'bear' : 'bull', strength: 0.5 });
  if (z.inOB > 0) chips.push({ text: `${name} OB ${z.inOB}${z.inOB > maxDur ? ' ⚠' : ''}`, dir: z.inOB > maxDur ? 'bull' : 'bear', strength: 0.5 });
  return { chips, values: { value: Number.isFinite(v) ? v : null, barsOverbought: z.inOB, barsOversold: z.inOS } };
};

const zoneOutputs = (id: string, title: string, ob: number, os: number) => [
  { kind: 'line' as const, id, title, color: 'accent' as const, width: 2 },
  { kind: 'hline' as const, id: 'ob', title: 'Overbought', value: ob, color: 'bear' as const, style: 'dashed' as const },
  { kind: 'hline' as const, id: 'os', title: 'Oversold', value: os, color: 'bull' as const, style: 'dashed' as const },
];

const zoneSignalSpecs = (p: string, qualified = false) => [
  { id: `${p}_OS_EXIT`, dir: 'bull' as const, description: 'Exit from oversold (duration within limit)' },
  { id: `${p}_OB_EXIT`, dir: 'bear' as const, description: 'Exit from overbought (duration within limit)' },
  ...(qualified
    ? [
        { id: `${p}_OS_EXIT_QUALIFIED`, dir: 'bull' as const, description: 'Qualified oversold exit (close above prior close/high)' },
        { id: `${p}_OB_EXIT_QUALIFIED`, dir: 'bear' as const, description: 'Qualified overbought exit' },
      ]
    : []),
  { id: `${p}_OS_EXTREME`, dir: 'bear' as const, description: 'Oversold longer than max duration (trend)' },
  { id: `${p}_OB_EXTREME`, dir: 'bull' as const, description: 'Overbought longer than max duration (trend)' },
];

// ── DeMarker I (INDICATORS §6.3) ───────────────────────────────────────────
export const demarker1Schema = z.object({
  length: int(13, 2, 100, { title: 'Length' }),
  ...zoneShape(60, 40),
  qualifiedBars: int(1, 1, 2, { title: 'Qualified entry: beat prior N bars', group: 'Signals' }),
  qualifiedTest: choice(['close', 'high'] as const, 'close', { title: 'Qualified entry compares with prior', group: 'Signals' }),
});
export type DeMarker1Cfg = z.infer<typeof demarker1Schema>;
interface Dem1State {
  smax: RollSum;
  smin: RollSum;
  zone: Zone;
  v: number;
}

export const demarker1: StudyDef<DeMarker1Cfg, Dem1State> = {
  id: 'td-demarker-1',
  name: 'DeMark-style DeMarker I',
  shortName: 'DeM I',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Ratio of summed upside high-to-high moves to total high/low movement over n bars (0–100), with zone duration analysis.',
  overlay: false,
  schema: demarker1Schema,
  presets: { '60/40': { overbought: 60, oversold: 40 }, '70/30': { overbought: 70, oversold: 30 } },
  outputs: (cfg) => zoneOutputs('dem1', 'DeMarker I', cfg.overbought, cfg.oversold),
  signals: zoneSignalSpecs('DEM1', true),
  init: (cfg) => ({ smax: sumInit(cfg.length), smin: sumInit(cfg.length), zone: zoneInit(), v: NaN }),
  update(cfg, st, x, w) {
    const i = w.i;
    if (i < 1) return;
    const deMax = x.h[i] > x.h[i - 1] ? x.h[i] - x.h[i - 1] : 0;
    const deMin = x.l[i] < x.l[i - 1] ? x.l[i - 1] - x.l[i] : 0;
    sumPush(st.smax, deMax);
    sumPush(st.smin, deMin);
    if (!sumFull(st.smax)) return;
    const den = st.smax.sum + st.smin.sum;
    st.v = den > 0 ? (100 * st.smax.sum) / den : 50;
    const ev = zoneStep(st.zone, st.v, cfg.overbought, cfg.oversold);
    if (w.inspecting) {
      w.inspect(`DeMax=${f(deMax)} DeMin=${f(deMin)}`, true, `DeM I = ${st.v.toFixed(2)}`);
      w.inspect(`In oversold (≤ ${cfg.oversold})`, st.zone.inOS > 0, `${st.zone.inOS} bars`);
      w.inspect(`In overbought (≥ ${cfg.overbought})`, st.zone.inOB > 0, `${st.zone.inOB} bars`);
    }
    zoneSignals(w, x, 'DEM1', ev, st.zone, cfg.maxDuration, { bars: cfg.qualifiedBars, test: cfg.qualifiedTest });
    w.line(0, st.v);
  },
  status: (cfg, st) => zoneStatus('DeM I', st.v, st.zone, cfg.maxDuration),
  golden: (r, i) => ({ dem1: r.lines.dem1[i] }),
};

// ── DeMarker II (INDICATORS §6.4, ⚠ VERIFY components) ─────────────────────
export const demarker2Schema = z.object({
  length: int(8, 2, 100, { title: 'Length' }),
  bpHighVsPriorClose: bool(true, { title: 'BP: max(0, H − prior C)', group: 'Components', verify: 'INDICATORS §6.4' }),
  bpCloseVsTrueLow: bool(true, { title: 'BP: C − true low', group: 'Components', verify: 'INDICATORS §6.4' }),
  spPriorCloseVsLow: bool(true, { title: 'SP: max(0, prior C − L)', group: 'Components', verify: 'INDICATORS §6.4' }),
  spTrueHighVsClose: bool(true, { title: 'SP: true high − C', group: 'Components', verify: 'INDICATORS §6.4' }),
  ...zoneShape(60, 40),
});
export type DeMarker2Cfg = z.infer<typeof demarker2Schema>;
interface Dem2State {
  sbp: RollSum;
  ssp: RollSum;
  zone: Zone;
  v: number;
}

export const demarker2: StudyDef<DeMarker2Cfg, Dem2State> = {
  id: 'td-demarker-2',
  name: 'DeMark-style DeMarker II',
  shortName: 'DeM II',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Buying pressure vs selling pressure built from prior-close and true-range components, summed over n bars (0–100). Components are individually switchable pending verification.',
  overlay: false,
  schema: demarker2Schema,
  verify: [{ key: 'bpHighVsPriorClose', note: 'INDICATORS §6.4 component definitions' }],
  outputs: (cfg) => zoneOutputs('dem2', 'DeMarker II', cfg.overbought, cfg.oversold),
  signals: zoneSignalSpecs('DEM2'),
  init: (cfg) => ({ sbp: sumInit(cfg.length), ssp: sumInit(cfg.length), zone: zoneInit(), v: NaN }),
  update(cfg, st, x, w) {
    const i = w.i;
    if (i < 1) return;
    const C = x.c[i];
    const C1 = x.c[i - 1];
    const bp = (cfg.bpHighVsPriorClose ? Math.max(0, x.h[i] - C1) : 0) + (cfg.bpCloseVsTrueLow ? C - trueLow(x, i) : 0);
    const sp = (cfg.spPriorCloseVsLow ? Math.max(0, C1 - x.l[i]) : 0) + (cfg.spTrueHighVsClose ? trueHigh(x, i) - C : 0);
    sumPush(st.sbp, bp);
    sumPush(st.ssp, sp);
    if (!sumFull(st.sbp)) return;
    const den = st.sbp.sum + st.ssp.sum;
    st.v = den > 0 ? (100 * st.sbp.sum) / den : 50;
    const ev = zoneStep(st.zone, st.v, cfg.overbought, cfg.oversold);
    if (w.inspecting) w.inspect(`BP=${f(bp)} SP=${f(sp)}`, true, `DeM II = ${st.v.toFixed(2)}`);
    zoneSignals(w, x, 'DEM2', ev, st.zone, cfg.maxDuration);
    w.line(0, st.v);
  },
  status: (cfg, st) => zoneStatus('DeM II', st.v, st.zone, cfg.maxDuration),
  golden: (r, i) => ({ dem2: r.lines.dem2[i] }),
};

// ── REI + POQ (INDICATORS §6.5) ─────────────────────────────────────────────
export const reiSchema = z.object({
  length: int(5, 2, 50, { title: 'Length' }),
  lagA1: int(5, 1, 20, { title: 'Overlap: H vs L[i−a1]', group: 'Overlap', verify: 'INDICATORS §6.5 lags' }),
  lagA2: int(6, 1, 20, { title: 'Overlap: H vs L[i−a2]', group: 'Overlap', verify: 'INDICATORS §6.5 lags' }),
  lagB1: int(7, 1, 20, { title: 'Overlap: L vs H[i−b1]', group: 'Overlap', verify: 'INDICATORS §6.5 lags' }),
  lagB2: int(8, 1, 20, { title: 'Overlap: L vs H[i−b2]', group: 'Overlap', verify: 'INDICATORS §6.5 lags' }),
  ...zoneShape(40, -40),
  poq: bool(true, { title: 'POQ entries', group: 'POQ' }),
  poqMinBars: int(6, 1, 50, { title: 'POQ: min bars in zone', group: 'POQ' }),
  poqWindow: int(3, 0, 20, { title: 'POQ: bars after zone exit still eligible', group: 'POQ' }),
});
export type ReiCfg = z.infer<typeof reiSchema>;
interface ReiState {
  sx: RollSum;
  sd: RollSum;
  zone: Zone;
  v: number;
  osEnd: number; // bar where the last long-enough oversold episode ended (or is ongoing)
  obEnd: number;
  armBuy: number; // bar k where C > C[k−1] while eligible
  armSell: number;
}

export const rei: StudyDef<ReiCfg, ReiState> = {
  id: 'td-rei',
  name: 'DeMark-style REI + POQ',
  shortName: 'REI',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Range Expansion Index (±100) counting only bars that overlap earlier price, plus POQ entries after sustained oversold/overbought readings.',
  overlay: false,
  schema: reiSchema,
  verify: [{ key: 'lagA1', note: 'INDICATORS §6.5 overlap lags 5/6 and 7/8' }],
  outputs: (cfg) => zoneOutputs('rei', 'REI', cfg.overbought, cfg.oversold),
  signals: [...zoneSignalSpecs('REI'), { id: 'POQ_BUY', dir: 'bull', description: 'POQ buy' }, { id: 'POQ_SELL', dir: 'bear', description: 'POQ sell' }],
  init: (cfg) => ({ sx: sumInit(cfg.length), sd: sumInit(cfg.length), zone: zoneInit(), v: NaN, osEnd: -1e9, obEnd: -1e9, armBuy: -1, armSell: -1 }),
  update(cfg, st, x, w) {
    const i = w.i;
    const maxLag = Math.max(cfg.lagA1, cfg.lagA2, cfg.lagB1, cfg.lagB2, 2);
    if (i < maxLag) return;
    const H = x.h[i];
    const L = x.l[i];
    const dh = H - x.h[i - 2];
    const dl = L - x.l[i - 2];
    const overlap = (H >= x.l[i - cfg.lagA1] || H >= x.l[i - cfg.lagA2]) && (L <= x.h[i - cfg.lagB1] || L <= x.h[i - cfg.lagB2]);
    sumPush(st.sx, overlap ? dh + dl : 0);
    sumPush(st.sd, Math.abs(dh) + Math.abs(dl));
    if (!sumFull(st.sx)) return;
    st.v = st.sd.sum > 0 ? (100 * st.sx.sum) / st.sd.sum : 0;
    const ev = zoneStep(st.zone, st.v, cfg.overbought, cfg.oversold);
    if (w.inspecting) w.inspect('Price overlap condition', overlap, `REI = ${st.v.toFixed(2)}`);
    zoneSignals(w, x, 'REI', ev, st.zone, cfg.maxDuration);
    w.line(0, st.v);

    if (!cfg.poq) return;
    if (st.zone.inOS >= cfg.poqMinBars) st.osEnd = i;
    if (st.zone.inOB >= cfg.poqMinBars) st.obEnd = i;
    const hi2 = Math.max(x.h[i - 1], x.h[i - 2]);
    const lo2 = Math.min(x.l[i - 1], x.l[i - 2]);
    // step 2: bar after the arming bar opens at/below the prior two highs, then trades above the higher of them
    if (st.armBuy === i - 1) {
      const ok = x.o[i] <= hi2 && H > hi2;
      if (w.inspecting) w.inspect('POQ buy: open ≤ prior two highs, then trades above them', ok);
      if (ok) {
        w.signal('POQ_BUY', 'bull', hi2);
        w.marker({ i, text: 'Q', pos: 'below', color: 'bull', row: 4, size: 1, tooltip: 'POQ buy' });
      }
    }
    if (st.armSell === i - 1) {
      const ok = x.o[i] >= lo2 && L < lo2;
      if (ok) {
        w.signal('POQ_SELL', 'bear', lo2);
        w.marker({ i, text: 'Q', pos: 'above', color: 'bear', row: 4, size: 1, tooltip: 'POQ sell' });
      }
    }
    // step 1: arming bar — close above the prior close while (recently) oversold long enough
    if (i - st.osEnd <= cfg.poqWindow && x.c[i] > x.c[i - 1]) st.armBuy = i;
    if (i - st.obEnd <= cfg.poqWindow && x.c[i] < x.c[i - 1]) st.armSell = i;
  },
  status: (cfg, st) => zoneStatus('REI', st.v, st.zone, cfg.maxDuration),
  golden: (r, i) => ({ rei: r.lines.rei[i] }),
};

// ── TD Pressure (INDICATORS §6.6, ⚠ VERIFY) ────────────────────────────────
export const pressureSchema = z.object({
  length: int(5, 2, 100, { title: 'Length', verify: 'INDICATORS §6.6' }),
  useVolume: bool(true, { title: 'Weight by volume', verify: 'INDICATORS §6.6' }),
  ...zoneShape(60, 40),
});
export type PressureCfg = z.infer<typeof pressureSchema>;
interface PressureState {
  sb: RollSum;
  ss: RollSum;
  zone: Zone;
  v: number;
}

export const pressure: StudyDef<PressureCfg, PressureState> = {
  id: 'td-pressure',
  name: 'DeMark-style Pressure',
  shortName: 'Pressure',
  version: '0.9.0',
  category: 'DeMark',
  description: 'Volume-weighted (C − O)/true range, split into buying and selling pressure over n bars and normalized to 0–100.',
  overlay: false,
  schema: pressureSchema,
  verify: [{ key: 'length', note: 'INDICATORS §6.6 — whole formula' }],
  outputs: (cfg) => zoneOutputs('pressure', 'Pressure', cfg.overbought, cfg.oversold),
  signals: zoneSignalSpecs('PRESS'),
  init: (cfg) => ({ sb: sumInit(cfg.length), ss: sumInit(cfg.length), zone: zoneInit(), v: NaN }),
  update(cfg, st, x, w) {
    const i = w.i;
    const tr = trueHigh(x, i) - trueLow(x, i);
    const xv = tr > 0 ? ((x.c[i] - x.o[i]) / tr) * (cfg.useVolume ? x.v[i] : 1) : 0;
    sumPush(st.sb, Math.max(0, xv));
    sumPush(st.ss, Math.max(0, -xv));
    if (!sumFull(st.sb)) return;
    const den = st.sb.sum + st.ss.sum;
    st.v = den > 0 ? (100 * st.sb.sum) / den : 50;
    const ev = zoneStep(st.zone, st.v, cfg.overbought, cfg.oversold);
    zoneSignals(w, x, 'PRESS', ev, st.zone, cfg.maxDuration);
    w.line(0, st.v);
  },
  status: (cfg, st) => zoneStatus('Press', st.v, st.zone, cfg.maxDuration),
};

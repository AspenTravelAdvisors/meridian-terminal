import { z } from 'zod';
import { bool, choice, int } from '../../core/params';
import type { SeriesCtx, StudyDef, StudyStatus, Writer } from '../../core/types';
import {
  type Countdown,
  type SetupInfo,
  type SetupSide,
  type Sg,
  SIDE_UP,
  SIDES,
  countdownMgmtShape,
  f,
  markerPos,
  mC,
  mL,
  mO,
  newCountdown,
  newSetupSide,
  intersectsSetup,
  longSetupRecycle,
  newSetupStep,
  setupShape,
  setupStep,
  shouldRecycle,
  startCountdown,
  tdstCancelled,
  trackCountdownRisk,
} from './common';

export const sequentialSchema = z.object({
  ...setupShape,
  showSetup: bool(true, { title: 'Show setup counts', group: 'Display' }),
  showSetupExtension: bool(true, { title: 'Show setup extension (10+)', group: 'Display' }),
  showCountdown: bool(true, { title: 'Show countdown', group: 'Display' }),
  showTdst: bool(true, { title: 'Show TDST levels', group: 'Display' }),
  showRisk: bool(true, { title: 'Show risk levels', group: 'Display' }),
  countdownMode: choice(['standard', 'aggressive'] as const, 'standard', {
    title: 'Countdown mode',
    group: 'Countdown',
    description: 'standard: close ≤ low two bars earlier · aggressive: low ≤ low two bars earlier.',
  }),
  countdownLength: z.number().int().min(5).max(30).default(13).meta({ title: 'Countdown length', group: 'Countdown', step: 1 }),
  cd13Qualifier: choice(['low_vs_cd8_close', 'close_vs_cd8_close', 'none'] as const, 'low_vs_cd8_close', {
    title: 'Bar-13 qualifier',
    group: 'Countdown',
    verify: 'INDICATORS §1.5 — some sources compare the close instead of the low.',
  }),
  cd8Qualifier: bool(false, {
    title: 'Bar-8 qualifier (8 vs 5)',
    group: 'Countdown',
    description: 'Elective: countdown bar 8 needs its low ≤ the close of countdown bar 5 (sell: high ≥), else "+" and the count waits.',
    verify: 'INDICATORS §1.5',
  }),
  ...countdownMgmtShape,
  requireIntersection: bool(false, {
    title: 'Intersection',
    group: 'Countdown',
    description: 'Elective: postpone the countdown start until a bar’s high reaches the low of a setup bar three or more bars earlier (sell: mirror).',
    verify: 'INDICATORS §1.5',
  }),
  intersectionScope: choice(['anyLaterBar', 'setupBarsOnly'] as const, 'anyLaterBar', {
    title: 'Intersection: bars that may confirm',
    group: 'Countdown',
    description: 'anyLaterBar: any bar after setup bar 9 · setupBarsOnly: only bars that extend the same setup (10, 11, …).',
    verify: 'INDICATORS §1.5',
  }),
  reactionBars: int(12, 1, 50, {
    title: 'Reaction window after 13 (bars)',
    group: 'Countdown',
    description: '12-bar rule: a reversal should follow a 13 within this many bars; the status chip stays up for the window.',
  }),
  riskCloseBeyond: bool(true, { title: 'Risk breach: close beyond level', group: 'Risk' }),
  riskPriorCloseNotBeyond: bool(true, { title: 'Risk breach: prior close not beyond', group: 'Risk' }),
  riskNextOpenBeyond: bool(false, { title: 'Risk breach: next open beyond', group: 'Risk' }),
});
export type SequentialCfg = z.infer<typeof sequentialSchema>;

interface Side {
  su: SetupSide;
  last: SetupInfo | null;
  cd: Countdown;
  /** TDST from the latest completed setup on this side (mirrored), persists until replaced */
  tdst: number;
  tdstAbove: boolean;
  /** setup risk level (mirrored) */
  risk: number;
  /** countdown risk level (mirrored) */
  cdRisk: number;
  pendBreach: number[]; // levels awaiting next-open confirmation
  /** completed setup whose countdown waits for intersection (INDICATORS §1.5) */
  pendIx: SetupInfo | null;
  /** last bar of the pending setup's run (bar 9, then any extension bars 10, 11, …) */
  pendIxEnd: number;
  lastCd13: number;
  lastSetup9: number;
}

export interface SequentialState {
  sides: [Side, Side];
}

const newSide = (): Side => ({
  su: newSetupSide(),
  last: null,
  cd: newCountdown(),
  tdst: NaN,
  tdstAbove: false,
  risk: NaN,
  cdRisk: NaN,
  pendBreach: [],
  pendIx: null,
  pendIxEnd: -1,
  lastCd13: -1,
  lastSetup9: -1,
});

const L_TDST_RES = 0;
const L_TDST_SUP = 1;
const L_RISK_BUY = 2;
const L_RISK_SELL = 3;
const L_CDRISK_BUY = 4;
const L_CDRISK_SELL = 5;
const D_SETUP = 6;
const D_COUNTDOWN = 7;
const LBL_SETUP = 8;
const LBL_CD = 9;

/** Countdown bar predicate in mirrored space (INDICATORS §1.5). */
/** Scratch step results reused every bar (single-threaded; never stored in state). */
const STEPS = [newSetupStep(), newSetupStep()];
const RISK_KEYS = ['risk', 'cdRisk'] as const;
const DEFAULT_EMIT = { markers: true, prefix: 'SEQ', row: 0 };

const cdCond = (cfg: SequentialCfg, x: SeriesCtx, s: Sg, i: number): boolean =>
  i >= 2 && (cfg.countdownMode === 'standard' ? mC(x, s, i) <= mL(x, s, i - 2) : mL(x, s, i) <= mL(x, s, i - 2));

function riskBreach(cfg: SequentialCfg, x: SeriesCtx, s: Sg, i: number, lvl: number): boolean {
  if (!Number.isFinite(lvl) || i < 1) return false;
  const beyond = cfg.riskCloseBeyond ? mC(x, s, i) < lvl : mL(x, s, i) < lvl;
  const priorOk = !cfg.riskPriorCloseNotBeyond || mC(x, s, i - 1) >= lvl;
  return beyond && priorOk;
}

export function sequentialStep(
  cfg: SequentialCfg,
  st: SequentialState,
  x: SeriesCtx,
  w: Writer,
  i: number,
  emit: { markers: boolean; prefix: string; row: number } = DEFAULT_EMIT,
): void {
  const steps = STEPS;
  setupStep(cfg, st.sides[0].su, x, 1, i, steps[0]);
  setupStep(cfg, st.sides[1].su, x, -1, i, steps[1]);
  const anyFlip = steps[0].flip || steps[1].flip;
  const anyCompleted = steps[0].completed !== null || steps[1].completed !== null;
  const P = emit.prefix;

  for (let k = 0; k < 2; k++) {
    const s = SIDES[k];
    const side = st.sides[k];
    const step = steps[k];
    const name = s > 0 ? 'BUY' : 'SELL';
    const dir = s > 0 ? 'bull' : 'bear';
    const pos = markerPos(s);

    if (w.inspecting) {
      w.inspect(`${name} flip: C[i-1] ${s > 0 ? '>' : '<'} C[i-5] and C ${s > 0 ? '<' : '>'} C[i-4]`, step.flip);
      w.inspect(
        `${name} setup bar: C ${s > 0 ? '<' : '>'} C[i-${cfg.setupLookback}]`,
        step.cond,
        i >= cfg.setupLookback ? `C=${f(x.c[i])} vs ${f(x.c[i - cfg.setupLookback])} · count ${side.su.count}` : 'insufficient history',
      );
    }

    // ── Setup counts & completion ─────────────────────────────────────────
    const cnt = side.su.count;
    // dense count numbers go to a label column (sell → +, buy → −); the 9 itself is a styled marker below
    if (emit.markers && cfg.showSetup && cnt > 0 && cnt !== cfg.setupLength && (cnt < cfg.setupLength || cfg.showSetupExtension)) w.line(LBL_SETUP, -s * cnt);
    if (step.flip && cfg.emitFlips) w.signal(`${P}_${s > 0 ? 'BEARISH' : 'BULLISH'}_FLIP`, 'neutral', x.c[i]);

    // Deferred perfection: cancelled by any intervening flip or new setup completion (INDICATORS §1.3).
    if (Number.isFinite(side.su.perfThr) && (anyFlip || anyCompleted)) side.su.perfThr = NaN;
    if (Number.isFinite(side.su.perfThr) && mL(x, s, i) <= side.su.perfThr) {
      side.su.perfThr = NaN;
      w.signal(`${P}_${name}_SETUP_PERFECTED`, dir, x.c[i], 'deferred');
      if (emit.markers && cfg.showSetup) w.marker({ i, text: 'P', pos, color: s > 0 ? 'bull' : 'bear', row: emit.row + 2, size: 1, tooltip: 'Deferred perfection' });
    }

    const done = step.completed;
    if (done) {
      side.last = done;
      side.lastSetup9 = i;
      w.signal(`${P}_${name}_SETUP_9`, dir, x.c[i]);
      if (done.perfected) w.signal(`${P}_${name}_SETUP_PERFECTED`, dir, x.c[i]);
      else side.su.perfThr = (done as SetupInfo & { perfThr: number }).perfThr;
      if (emit.markers && cfg.showSetup)
        w.marker({
          i,
          text: String(cfg.setupLength),
          pos,
          color: s > 0 ? 'bull' : 'bear',
          row: emit.row,
          size: 2,
          style: done.perfected ? 'solid' : 'hollow',
          tooltip: `${s > 0 ? 'Buy' : 'Sell'} setup ${done.perfected ? 'perfected' : 'not yet perfected'} · TDST ${f(s * done.tdst)}`,
        });
      side.tdst = done.tdst;
      side.tdstAbove = mC(x, s, i) > done.tdst;
      side.risk = done.risk;
      if (w.inspecting) {
        w.inspect(`${name} setup perfected`, done.perfected);
        w.inspect(`${name} setup intersection: bar 8 or 9 high reaches a setup low ≥ 3 bars earlier`, done.intersect);
      }
    }

    // ── Countdown cancellation (INDICATORS §1.6) ──────────────────────────
    if (side.cd.active) {
      let reason = '';
      if (cfg.cancelOnOppositeSetup && steps[1 - k].completed) reason = 'opposite setup';
      else if (tdstCancelled(cfg, side.cd, x, s, i)) reason = 'TDST break';
      if (w.inspecting) w.inspect(`${name} countdown cancel (opp. setup / TDST)`, reason !== '', reason || undefined);
      if (reason) {
        side.cd.active = false;
        w.signal(`${P}_${name}_CD_CANCEL`, 'neutral', x.c[i], reason);
        if (emit.markers && cfg.showCountdown)
          w.marker({ i, text: '×', pos, color: 'muted', row: emit.row + 1, size: 1, tooltip: `Countdown cancelled: ${reason}` });
      }
    }

    // ── Countdown start / recycle (INDICATORS §1.5, §1.7) ─────────────────
    // A pending (not yet intersected) countdown is dropped by an opposite setup and replaced by a newer setup.
    if (side.pendIx && (done || (cfg.cancelOnOppositeSetup && steps[1 - k].completed))) side.pendIx = null;
    if (done) {
      if (!side.cd.active) {
        if (cfg.requireIntersection && !done.intersect) {
          side.pendIx = done;
          side.pendIxEnd = i;
        }
        else startCountdown(side.cd, done, i);
      } else if (shouldRecycle(cfg, side.cd, done)) {
        startCountdown(side.cd, done, i);
        w.signal(`${P}_${name}_CD_RECYCLE`, 'neutral', x.c[i]);
        if (emit.markers && cfg.showCountdown) w.marker({ i, text: 'R', pos, color: 'warn', row: emit.row + 1, size: 1, tooltip: 'Countdown recycled' });
      }
    } else if (side.pendIx) {
      const ix = side.pendIx;
      // Extension bars of the same setup run also count as setup bars to intersect with (reference chart, VERIFY_LOG note 6).
      if (side.su.count > 0 && side.su.i1 === ix.i1) side.pendIxEnd = i;
      const inScope = cfg.intersectionScope === 'anyLaterBar' || (side.su.count > cfg.setupLength && side.su.i1 === ix.i1);
      const hit = inScope && intersectsSetup(x, s, ix.i1, side.pendIxEnd, i);
      if (w.inspecting) w.inspect(`${name} intersection pending: high reaches a setup low ≥ 3 bars earlier`, hit);
      if (hit) {
        side.pendIx = null;
        startCountdown(side.cd, ix, i);
      }
    } else if (longSetupRecycle(cfg, side.cd, side.su, side.last)) {
      startCountdown(side.cd, side.last, i);
      w.signal(`${P}_${name}_CD_RECYCLE`, 'neutral', x.c[i], `setup reached ${cfg.recycleSetupCount}`);
      if (emit.markers && cfg.showCountdown) w.marker({ i, text: 'R', pos, color: 'warn', row: emit.row + 1, size: 1, tooltip: `Countdown recycled: setup reached ${cfg.recycleSetupCount}` });
    }

    // ── Countdown counting ───────────────────────────────────────────────
    if (side.cd.active) {
      const cd = side.cd;
      trackCountdownRisk(cd, x, s, i);
      const ok = cdCond(cfg, x, s, i);
      if (w.inspecting)
        w.inspect(
          `${name} countdown bar: ${cfg.countdownMode === 'standard' ? 'C' : 'L'} ${s > 0 ? '≤ L' : '≥ H'}[i-2]`,
          ok,
          i >= 2 ? `${f(cfg.countdownMode === 'standard' ? x.c[i] : s > 0 ? x.l[i] : x.h[i])} vs ${f(s > 0 ? x.l[i - 2] : x.h[i - 2])} · count ${cd.count}` : '',
        );
      if (ok) {
        const N = cfg.countdownLength;
        // Elective 8-vs-5 deferral (INDICATORS §1.5): the would-be 8 must reach the close of countdown bar 5.
        const defer8 = cfg.cd8Qualifier && cd.count === 7 && N > 8 && !(mL(x, s, i) <= cd.cd5);
        if (cfg.cd8Qualifier && cd.count === 7 && N > 8 && w.inspecting) w.inspect(`${name} bar-8 qualifier (low vs CD5 close)`, !defer8, `CD5 close ${f(s * cd.cd5)}`);
        if (defer8) {
          if (emit.markers && cfg.showCountdown)
            w.marker({ i, text: '+', pos, color: s > 0 ? 'bullAlt' : 'bearAlt', row: emit.row + 1, size: 1, tooltip: 'Bar 8 deferred: 8-vs-5 qualifier failed' });
        } else if (cd.count < N - 1) {
          cd.count++;
          if (cd.count === 5) cd.cd5 = mC(x, s, i);
          if (cd.count === 8) cd.cd8 = mC(x, s, i);
          if (emit.markers && cfg.showCountdown) w.line(LBL_CD, -s * cd.count);
        } else {
          let q = true;
          if (cfg.cd13Qualifier === 'low_vs_cd8_close') q = mL(x, s, i) <= cd.cd8;
          else if (cfg.cd13Qualifier === 'close_vs_cd8_close') q = mC(x, s, i) <= cd.cd8;
          if (w.inspecting) w.inspect(`${name} bar-${N} qualifier (${cfg.cd13Qualifier})`, q, `CD8 close ${f(s * cd.cd8)}`);
          if (q) {
            cd.count = N;
            cd.active = false;
            side.cdRisk = cd.minTL - cd.minTLtr;
            side.lastCd13 = i;
            w.signal(`${P}_${name}_CD_13`, dir, x.c[i]);
            if (emit.markers && cfg.showCountdown)
              w.marker({
                i,
                text: String(N),
                pos,
                color: s > 0 ? 'bullAlt' : 'bearAlt',
                row: emit.row + 1,
                size: 3,
                style: 'boxed',
                tooltip: `${s > 0 ? 'Buy' : 'Sell'} countdown ${N} · risk ${f(s * side.cdRisk)}`,
              });
          } else if (emit.markers && cfg.showCountdown)
            w.marker({ i, text: '+', pos, color: s > 0 ? 'bullAlt' : 'bearAlt', row: emit.row + 1, size: 1, tooltip: `Bar ${N} deferred: qualifier failed` });
        }
      }
    }

    // ── TDST breaks (INDICATORS §1.4) ────────────────────────────────────
    if (Number.isFinite(side.tdst) && !done) {
      const above = mC(x, s, i) > side.tdst;
      const qual = !cfg.tdstBreakQualifier || mO(x, s, i) > side.tdst || (i > 0 && mC(x, s, i - 1) > side.tdst);
      if (above && !side.tdstAbove && qual) {
        side.tdstAbove = true;
        w.signal(s > 0 ? 'TDST_RES_BREAK' : 'TDST_SUP_BREAK', s > 0 ? 'bull' : 'bear', x.c[i]);
      } else if (!above) side.tdstAbove = false;
    }

    // ── Risk-level breaches (INDICATORS §1.8) ────────────────────────────
    if (side.pendBreach.length) {
      for (const lvl of side.pendBreach) if (mO(x, s, i) < lvl) w.signal(`${P}_RISK_BREACH`, s > 0 ? 'bear' : 'bull', s * lvl, `${name} risk (next open)`);
      side.pendBreach = [];
    }
    for (const which of RISK_KEYS) {
      const lvl = side[which];
      if (riskBreach(cfg, x, s, i, lvl) && !(done && which === 'risk')) {
        if (cfg.riskNextOpenBeyond) side.pendBreach.push(lvl);
        else w.signal(`${P}_RISK_BREACH`, s > 0 ? 'bear' : 'bull', s * lvl, `${name} ${which === 'risk' ? 'setup' : 'countdown'} risk`);
        side[which] = NaN; // a breached level is retired
      }
    }
  }

  // ── Line outputs (un-mirror) ─────────────────────────────────────────────
  const [b, s] = st.sides;
  if (cfg.showTdst) {
    w.line(L_TDST_RES, b.tdst);
    w.line(L_TDST_SUP, -s.tdst);
  }
  if (cfg.showRisk) {
    w.line(L_RISK_BUY, b.risk);
    w.line(L_RISK_SELL, -s.risk);
    w.line(L_CDRISK_BUY, b.cdRisk);
    w.line(L_CDRISK_SELL, -s.cdRisk);
  }
  w.line(D_SETUP, s.su.count > 0 ? s.su.count : b.su.count > 0 ? -b.su.count : 0);
  const N = cfg.countdownLength;
  w.line(D_COUNTDOWN, s.cd.active ? s.cd.count : s.lastCd13 === i ? N : b.cd.active ? -b.cd.count : b.lastCd13 === i ? -N : 0);
}

export function sequentialStatus(cfg: SequentialCfg, st: SequentialState, x: SeriesCtx): StudyStatus {
  const chips: StudyStatus['chips'] = [];
  const last = x.len - 1;
  st.sides.forEach((side, k) => {
    const s: Sg = k === 0 ? 1 : -1;
    const dir = s > 0 ? 'bull' : 'bear';
    if (side.su.count > 0) chips.push({ text: `${SIDE_UP(s)}-Setup ${side.su.count}`, dir, strength: Math.min(1, side.su.count / cfg.setupLength) });
    if (side.cd.active) chips.push({ text: `${SIDE_UP(s)}-CD ${side.cd.count}`, dir, strength: side.cd.count / cfg.countdownLength });
    if (side.lastCd13 >= 0 && last - side.lastCd13 <= cfg.reactionBars) chips.push({ text: `${SIDE_UP(s)}-CD ${cfg.countdownLength} ✓`, dir, strength: 1 });
  });
  const c = x.c[last];
  const [b, s] = st.sides;
  if (Number.isFinite(b.tdst) && c > b.tdst) chips.push({ text: 'TDST ↑ broken', dir: 'bull', strength: 0.6 });
  if (Number.isFinite(s.tdst) && c < -s.tdst) chips.push({ text: 'TDST ↓ broken', dir: 'bear', strength: 0.6 });
  return {
    chips,
    values: {
      buySetup: b.su.count,
      sellSetup: s.su.count,
      buyCountdown: b.cd.active ? b.cd.count : null,
      sellCountdown: s.cd.active ? s.cd.count : null,
      tdstResistance: Number.isFinite(b.tdst) ? b.tdst : null,
      tdstSupport: Number.isFinite(s.tdst) ? -s.tdst : null,
      buyRisk: Number.isFinite(b.risk) ? b.risk : null,
      sellRisk: Number.isFinite(s.risk) ? -s.risk : null,
      barsSinceBuy9: b.lastSetup9 >= 0 ? last - b.lastSetup9 : null,
      barsSinceSell9: s.lastSetup9 >= 0 ? last - s.lastSetup9 : null,
      barsSinceBuy13: b.lastCd13 >= 0 ? last - b.lastCd13 : null,
      barsSinceSell13: s.lastCd13 >= 0 ? last - s.lastCd13 : null,
    },
  };
}

export const newSequentialState = (): SequentialState => ({ sides: [newSide(), newSide()] });

export const sequential: StudyDef<SequentialCfg, SequentialState> = {
  id: 'td-sequential',
  name: 'DeMark-style Sequential',
  shortName: 'Seq',
  version: '1.0.0',
  category: 'DeMark',
  description:
    'Price flip → 9-bar setup (with perfection, extension and TDST levels) → 13-bar non-consecutive countdown with the bar-13 qualifier, cancellation, recycling and risk levels.',
  overlay: true,
  schema: sequentialSchema,
  presets: {
    Standard: {},
    Aggressive: { countdownMode: 'aggressive' },
    'TDST bar-1 only': { tdstMode: 'bar1TrueExtreme' },
    'Close-based 13 qualifier': { cd13Qualifier: 'close_vs_cd8_close' },
    'Intersection + 8 vs 5': { requireIntersection: true, cd8Qualifier: true },
    'Minimal (9s & 13s)': { showSetupExtension: false, showRisk: false },
  },
  verify: [
    { key: 'tdstMode', note: 'INDICATORS §1.4' },
    { key: 'cd13Qualifier', note: 'INDICATORS §1.5' },
    { key: 'recycleFactor', note: 'INDICATORS §1.7' },
    { key: 'tdstCancelTest', note: 'INDICATORS §1.6' },
    { key: 'recycleSetupCount', note: 'INDICATORS §1.7' },
    { key: 'requireIntersection', note: 'INDICATORS §1.5' },
    { key: 'intersectionScope', note: 'INDICATORS §1.5' },
    { key: 'cd8Qualifier', note: 'INDICATORS §1.5' },
  ],
  outputs: () => [
    { kind: 'line', id: 'tdst_res', title: 'TDST resistance', color: 'bear', render: 'level', width: 1, style: 'solid', label: 'TDST' },
    { kind: 'line', id: 'tdst_sup', title: 'TDST support', color: 'bull', render: 'level', width: 1, style: 'solid', label: 'TDST' },
    { kind: 'line', id: 'risk_buy', title: 'Buy setup risk', color: 'bull', render: 'level', width: 1, style: 'dashed', label: 'Risk' },
    { kind: 'line', id: 'risk_sell', title: 'Sell setup risk', color: 'bear', render: 'level', width: 1, style: 'dashed', label: 'Risk' },
    { kind: 'line', id: 'cdrisk_buy', title: 'Buy countdown risk', color: 'bullAlt', render: 'level', width: 1, style: 'dotted', label: 'CD risk' },
    { kind: 'line', id: 'cdrisk_sell', title: 'Sell countdown risk', color: 'bearAlt', render: 'level', width: 1, style: 'dotted', label: 'CD risk' },
    { kind: 'data', id: 'setup', title: 'Setup (+sell / −buy)' },
    { kind: 'data', id: 'countdown', title: 'Countdown (+sell / −buy)' },
    { kind: 'labels', id: 'setup_lbl', title: 'Setup counts', row: 0, posColor: 'bear', negColor: 'bull', mutedAbove: 9 },
    { kind: 'labels', id: 'cd_lbl', title: 'Countdown counts', row: 1, posColor: 'bearAlt', negColor: 'bullAlt' },
  ],
  signals: [
    { id: 'SEQ_BUY_SETUP_9', dir: 'bull', description: 'Buy setup completed (bar 9 close)' },
    { id: 'SEQ_SELL_SETUP_9', dir: 'bear', description: 'Sell setup completed (bar 9 close)' },
    { id: 'SEQ_BUY_SETUP_PERFECTED', dir: 'bull', description: 'Buy setup perfected (at 9 or deferred)' },
    { id: 'SEQ_SELL_SETUP_PERFECTED', dir: 'bear', description: 'Sell setup perfected (at 9 or deferred)' },
    { id: 'SEQ_BUY_CD_13', dir: 'bull', description: 'Buy countdown 13' },
    { id: 'SEQ_SELL_CD_13', dir: 'bear', description: 'Sell countdown 13' },
    { id: 'SEQ_BUY_CD_CANCEL', dir: 'neutral', description: 'Buy countdown cancelled' },
    { id: 'SEQ_SELL_CD_CANCEL', dir: 'neutral', description: 'Sell countdown cancelled' },
    { id: 'SEQ_BUY_CD_RECYCLE', dir: 'neutral', description: 'Buy countdown recycled' },
    { id: 'SEQ_SELL_CD_RECYCLE', dir: 'neutral', description: 'Sell countdown recycled' },
    { id: 'TDST_RES_BREAK', dir: 'bull', description: 'Close above TDST resistance' },
    { id: 'TDST_SUP_BREAK', dir: 'bear', description: 'Close below TDST support' },
    { id: 'SEQ_RISK_BREACH', dir: 'neutral', description: 'Setup or countdown risk level breached' },
    { id: 'SEQ_BEARISH_FLIP', dir: 'neutral', description: 'Bearish price flip (arms a buy setup)' },
    { id: 'SEQ_BULLISH_FLIP', dir: 'neutral', description: 'Bullish price flip (arms a sell setup)' },
  ],
  init: () => newSequentialState(),
  update(cfg, st, x, w) {
    sequentialStep(cfg, st, x, w, w.i);
  },
  status: (cfg, st, x) => sequentialStatus(cfg, st, x),
  golden: (r, i) => ({
    setup: r.lines.setup[i],
    countdown: r.lines.countdown[i],
    tdst_res: r.lines.tdst_res[i],
    tdst_sup: r.lines.tdst_sup[i],
  }),
};


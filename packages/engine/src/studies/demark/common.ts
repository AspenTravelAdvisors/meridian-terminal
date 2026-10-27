import { z } from 'zod';
import { bool, choice, int, num } from '../../core/params';
import type { SeriesCtx } from '../../core/types';

/**
 * Mirrored price space. Every DeMark-style rule is written once for the BUY side; the SELL side runs the
 * same code on the mirrored series (h' = −l, l' = −h, o' = −o, c' = −c). This guarantees the sell rules are
 * exact mirrors (INDICATORS.md conventions) and halves the surface for bugs. Values leaving this space are
 * multiplied by the side sign again.
 */
export type Sg = 1 | -1;
export const SIDES: readonly Sg[] = [1, -1];

export const mH = (x: SeriesCtx, s: Sg, i: number): number => (s > 0 ? x.h[i] : -x.l[i]);
export const mL = (x: SeriesCtx, s: Sg, i: number): number => (s > 0 ? x.l[i] : -x.h[i]);
export const mC = (x: SeriesCtx, s: Sg, i: number): number => s * x.c[i];
export const mO = (x: SeriesCtx, s: Sg, i: number): number => s * x.o[i];
/** True High = max(H, prior close) */
export const mTH = (x: SeriesCtx, s: Sg, i: number): number => (i > 0 ? Math.max(mH(x, s, i), mC(x, s, i - 1)) : mH(x, s, i));
/** True Low = min(L, prior close) */
export const mTL = (x: SeriesCtx, s: Sg, i: number): number => (i > 0 ? Math.min(mL(x, s, i), mC(x, s, i - 1)) : mL(x, s, i));

export const trueHigh = (x: SeriesCtx, i: number): number => mTH(x, 1, i);
export const trueLow = (x: SeriesCtx, i: number): number => mTL(x, 1, i);
export const trueRange = (x: SeriesCtx, i: number): number => trueHigh(x, i) - trueLow(x, i);

export const sideName = (s: Sg): 'buy' | 'sell' => (s > 0 ? 'buy' : 'sell');
export const SIDE_UP = (s: Sg): 'B' | 'S' => (s > 0 ? 'B' : 'S');
export const markerPos = (s: Sg): 'below' | 'above' => (s > 0 ? 'below' : 'above');

const fmt = (v: number): string => (Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(5));
export const f = (v: number): string => (Number.isFinite(v) ? fmt(v) : '—');

// ── Shared config fragments ───────────────────────────────────────────────

export const setupShape = {
  setupLength: int(9, 2, 30, { title: 'Setup length', group: 'Setup', description: 'Consecutive bars required (9 by definition).' }),
  setupLookback: int(4, 1, 10, { title: 'Setup close lookback', group: 'Setup', description: 'Compare each close with the close N bars earlier.' }),
  tdstMode: choice(['allSetupBars', 'bar1TrueExtreme'] as const, 'allSetupBars', {
    title: 'TDST mode',
    group: 'TDST',
    verify: 'INDICATORS §1.4 — some sources use only setup bar 1’s true extreme.',
  }),
  emitFlips: bool(false, { title: 'Emit price-flip signals', group: 'Setup', description: 'Flips are frequent; enable to alert on them.' }),
  tdstBreakQualifier: bool(false, {
    title: 'TDST break needs open/prior close beyond',
    group: 'TDST',
    verify: 'INDICATORS §1.4 optional qualifier.',
  }),
};

export const countdownMgmtShape = {
  cancelOnOppositeSetup: bool(true, { title: 'Cancel on opposite setup', group: 'Cancellation', verify: 'INDICATORS §1.6(a)' }),
  cancelOnTdstBreak: bool(true, { title: 'Cancel on TDST break', group: 'Cancellation', verify: 'INDICATORS §1.6(b)' }),
  tdstCancelTest: choice(['trueExtreme', 'close'] as const, 'trueExtreme', {
    title: 'TDST cancel test',
    group: 'Cancellation',
    description: 'trueExtreme: whole bar beyond the level (buy: true low above TDST resistance) · close: close beyond it.',
    verify: 'INDICATORS §1.6(b)',
  }),
  recycleMode: choice(['size', 'never', 'always'] as const, 'size', { title: 'Recycle mode', group: 'Recycling', verify: 'INDICATORS §1.7' }),
  recycleFactor: num(2, 1, 5, {
    title: 'Recycle factor',
    group: 'Recycling',
    step: 0.001,
    description: 'Recycle when the new setup is 100% to factor × 100% the size of the prior one.',
    verify: 'INDICATORS §1.7',
  }),
  recycleOnLongSetup: bool(true, { title: 'Recycle when a later setup runs long', group: 'Recycling', verify: 'INDICATORS §1.7' }),
  recycleSetupCount: int(22, 10, 60, { title: 'Long-setup recycle count', group: 'Recycling', verify: 'INDICATORS §1.7' }),
};

export const setupSchemaPart = z.object(setupShape);
export type SetupCfg = z.infer<typeof setupSchemaPart>;
export const countdownMgmtPart = z.object(countdownMgmtShape);
export type CdMgmtCfg = z.infer<typeof countdownMgmtPart>;

// ── Setup tracking (mirrored space) ───────────────────────────────────────

export interface SetupInfo {
  i1: number;
  i9: number;
  /** max TH − min TL over setup bars (mirrored space; always ≥ 0) */
  size: number;
  /** TDST level in mirrored space (for a buy setup: TDST resistance) */
  tdst: number;
  /** setup risk level in mirrored space (lowest TL − its TR) */
  risk: number;
  perfected: boolean;
  intersect: boolean;
}

export interface SetupSide {
  count: number;
  i1: number;
  /** deferred-perfection threshold (mirrored), NaN when nothing pending */
  perfThr: number;
}

export const newSetupSide = (): SetupSide => ({ count: 0, i1: -1, perfThr: NaN });

export interface SetupStep {
  flip: boolean;
  /** the bar condition held this bar */
  cond: boolean;
  completed: SetupInfo | null;
}

/** Price flip in mirrored space (bearish flip for the buy side). INDICATORS §1.1 */
export function isFlip(x: SeriesCtx, s: Sg, i: number, lb: number): boolean {
  if (i < lb + 1) return false;
  return mC(x, s, i - 1) > mC(x, s, i - 1 - lb) && mC(x, s, i) < mC(x, s, i - lb);
}

/** Setup bar condition in mirrored space: close below the close `lb` bars earlier. INDICATORS §1.2 */
export const setupCond = (x: SeriesCtx, s: Sg, i: number, lb: number): boolean => i >= lb && mC(x, s, i) < mC(x, s, i - lb);

export const newSetupStep = (): SetupStep => ({ flip: false, cond: false, completed: null });

/** Advance one side's setup count. Writes into `out` (reused across bars to avoid per-bar allocation). */
export function setupStep(cfg: SetupCfg, su: SetupSide, x: SeriesCtx, s: Sg, i: number, out: SetupStep = newSetupStep()): SetupStep {
  const lb = cfg.setupLookback;
  const cond = setupCond(x, s, i, lb);
  const flip = cond && isFlip(x, s, i, lb);
  let completed: SetupInfo | null = null;
  if (cond) {
    if (su.count > 0) su.count++;
    else if (flip) {
      su.count = 1;
      su.i1 = i;
    }
  } else su.count = 0;
  if (su.count === cfg.setupLength) completed = describeSetup(cfg, x, s, su.i1, i);
  out.flip = flip;
  out.cond = cond;
  out.completed = completed;
  return out;
}

export function describeSetup(cfg: SetupCfg, x: SeriesCtx, s: Sg, i1: number, i9: number): SetupInfo {
  let maxTH = -Infinity;
  let minTL = Infinity;
  let minTLi = i1;
  for (let k = i1; k <= i9; k++) {
    const th = mTH(x, s, k);
    const tl = mTL(x, s, k);
    if (th > maxTH) maxTH = th;
    if (tl < minTL) {
      minTL = tl;
      minTLi = k;
    }
  }
  const tdst = cfg.tdstMode === 'allSetupBars' ? maxTH : mTH(x, s, i1);
  const tr = mTH(x, s, minTLi) - mTL(x, s, minTLi);
  const n = cfg.setupLength;
  // Perfection uses setup-bar numbering relative to the final bar (bars n-3, n-2 vs n-1, n). INDICATORS §1.3
  const b = (k: number) => i9 - n + k; // index of setup bar k
  let perfected = false;
  let thr = NaN;
  if (n >= 4) {
    thr = Math.min(mL(x, s, b(n - 3)), mL(x, s, b(n - 2)));
    perfected = mL(x, s, b(n - 1)) < thr || mL(x, s, b(n)) < thr;
  }
  // Intersection (INDICATORS §1.5): the high of bar n-1 or n reaches the low of a setup bar three or more bars earlier.
  const intersect = n < 4 || intersectsSetup(x, s, i1, i9, b(n - 1)) || intersectsSetup(x, s, i1, i9, i9);
  const info: SetupInfo = { i1, i9, size: maxTH - minTL, tdst, risk: minTL - tr, perfected, intersect };
  (info as SetupInfo & { perfThr?: number }).perfThr = thr;
  return info;
}

/**
 * Intersection test in mirrored space: bar j's high reaches the low of any setup bar (i1…iEnd) at least three bars
 * before j. `iEnd` is bar 9 at completion and the end of the setup run (extension bars) while a countdown waits.
 * Loops over at most one setup run.
 */
export function intersectsSetup(x: SeriesCtx, s: Sg, i1: number, i9: number, j: number): boolean {
  const last = Math.min(i9, j - 3);
  const h = mH(x, s, j);
  for (let k = i1; k <= last; k++) if (h >= mL(x, s, k)) return true;
  return false;
}

// ── Countdown bookkeeping shared by Sequential and Combo ──────────────────

export interface Countdown {
  active: boolean;
  count: number;
  startI: number;
  /** setup that started (or last recycled) this countdown */
  setupI1: number;
  tdst: number;
  size: number;
  /** close of countdown bars 5 and 8 (mirrored) */
  cd5: number;
  cd8: number;
  /** close of the previous countdown bar (mirrored) — Combo rule 4 */
  lastClose: number;
  /** lowest TL since countdown bar 1 and that bar's TR (risk level) */
  minTL: number;
  minTLtr: number;
}

export const newCountdown = (): Countdown => ({
  active: false,
  count: 0,
  startI: -1,
  setupI1: -1,
  tdst: NaN,
  size: NaN,
  cd5: NaN,
  cd8: NaN,
  lastClose: NaN,
  minTL: Infinity,
  minTLtr: 0,
});

export function startCountdown(cd: Countdown, setup: SetupInfo, startI: number): void {
  cd.active = true;
  cd.count = 0;
  cd.startI = startI;
  cd.setupI1 = setup.i1;
  cd.tdst = setup.tdst;
  cd.size = setup.size;
  cd.cd5 = NaN;
  cd.cd8 = NaN;
  cd.lastClose = NaN;
  cd.minTL = Infinity;
  cd.minTLtr = 0;
}

/** Recycling decision (INDICATORS §1.7). Returns true when the countdown should restart from `setup`. */
export function shouldRecycle(cfg: CdMgmtCfg, cd: Countdown, setup: SetupInfo): boolean {
  if (!cd.active) return false;
  switch (cfg.recycleMode) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'size':
      return setup.size >= cd.size && setup.size <= cfg.recycleFactor * cd.size;
  }
}

/**
 * Long-setup recycle (INDICATORS §1.7): a LATER same-direction setup — not the one that started the countdown — has
 * just reached `recycleSetupCount` while the countdown is still running.
 */
export function longSetupRecycle(cfg: CdMgmtCfg, cd: Countdown, su: SetupSide, last: SetupInfo | null): last is SetupInfo {
  return cfg.recycleOnLongSetup && cfg.recycleMode !== 'never' && cd.active && last !== null && su.count === cfg.recycleSetupCount && last.i1 === su.i1 && last.i1 !== cd.setupI1;
}

/** TDST-break cancellation test (INDICATORS §1.6(b)) in mirrored space: price moved ABOVE the setup's TDST. */
export function tdstCancelled(cfg: CdMgmtCfg, cd: Countdown, x: SeriesCtx, s: Sg, i: number): boolean {
  if (!cfg.cancelOnTdstBreak || !Number.isFinite(cd.tdst)) return false;
  return cfg.tdstCancelTest === 'close' ? mC(x, s, i) > cd.tdst : mTL(x, s, i) > cd.tdst;
}

/** Track lowest TL (with its TR) over all bars since countdown bar 1 — for the countdown risk level. */
export function trackCountdownRisk(cd: Countdown, x: SeriesCtx, s: Sg, i: number): void {
  const tl = mTL(x, s, i);
  if (tl < cd.minTL) {
    cd.minTL = tl;
    cd.minTLtr = mTH(x, s, i) - tl;
  }
}

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
  tdstCancelTest: choice(['close', 'trueExtreme'] as const, 'trueExtreme', {
    title: 'TDST cancel test',
    group: 'Cancellation',
    description: 'trueExtreme: whole bar (true low / true high) beyond the level · close: close beyond it.',
    verify: 'INDICATORS §1.6(b) — trueExtreme per reference charts (VERIFY_LOG note 4A).',
  }),
  recycleMode: choice(['size', 'never', 'always'] as const, 'size', { title: 'Recycle mode', group: 'Recycling', verify: 'INDICATORS §1.7' }),
  recycleFactor: num(2, 1, 5, {
    title: 'Recycle factor',
    group: 'Recycling',
    step: 0.001,
    description: 'Recycle when the new setup is 1×–factor× the size of the one that started the countdown.',
    verify: 'INDICATORS §1.7 — 2.0 per reference (VERIFY_LOG note 4B).',
  }),
  recycleOnLongSetup: bool(true, {
    title: 'Recycle when setup runs long',
    group: 'Recycling',
    description: 'A same-direction setup that keeps counting to the recycle count restarts the countdown.',
    verify: 'INDICATORS §1.7',
  }),
  recycleSetupCount: int(22, 10, 50, { title: 'Recycle setup count', group: 'Recycling', verify: 'INDICATORS §1.7 — 22 per reference (VERIFY_LOG note 4B).' }),
};

export const intersectionShape = {
  intersectionMode: choice(['off', 'postpone', 'cancel'] as const, 'off', {
    title: 'Intersection',
    group: 'Countdown',
    description:
      'Setup bar 8 or 9 (or, when postponing, any later bar) must overlap a setup bar three or more bars earlier. postpone: start the countdown on the first bar that does · cancel: no countdown when bar 9 has not.',
    verify: 'INDICATORS §1.6(c) — postpone per reference (VERIFY_LOG note 4C).',
  }),
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

/** Long-setup recycle trigger (INDICATORS §1.7): the setup count reached the recycle count on this bar. */
export const reachedRecycleCount = (cfg: CdMgmtCfg, su: SetupSide): boolean => cfg.recycleOnLongSetup && su.count === cfg.recycleSetupCount;

/**
 * Intersection (INDICATORS §1.6(c), ⚠ VERIFY): bar `j`'s range overlaps the range of any setup bar from `i1` to `kMax`.
 * Callers pass `kMax ≤ j − 3` (three or more bars earlier). Scans at most one setup run, so the cost stays bounded.
 */
export function overlapsEarlier(x: SeriesCtx, s: Sg, j: number, i1: number, kMax: number): boolean {
  const hj = mH(x, s, j);
  const lj = mL(x, s, j);
  for (let k = i1; k <= kMax; k++) if (hj >= mL(x, s, k) && lj <= mH(x, s, k)) return true;
  return false;
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
    perfected = mL(x, s, b(n - 1)) <= thr || mL(x, s, b(n)) <= thr;
  }
  // Intersection (⚠ VERIFY): bar n-1 or n overlaps a setup bar three or more bars earlier.
  const intersect = n < 5 || overlapsEarlier(x, s, i9, i1, i9 - 3) || overlapsEarlier(x, s, i9 - 1, i1, i9 - 4);
  const info: SetupInfo = { i1, i9, size: maxTH - minTL, tdst, risk: minTL - tr, perfected, intersect };
  (info as SetupInfo & { perfThr?: number }).perfThr = thr;
  return info;
}

// ── Countdown bookkeeping shared by Sequential and Combo ──────────────────

export interface Countdown {
  active: boolean;
  count: number;
  startI: number;
  /** setup that started (or last recycled) this countdown */
  tdst: number;
  size: number;
  /** close of countdown bar 8 (mirrored) */
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
  tdst: NaN,
  size: NaN,
  cd8: NaN,
  lastClose: NaN,
  minTL: Infinity,
  minTLtr: 0,
});

export function startCountdown(cd: Countdown, setup: SetupInfo, startI: number): void {
  cd.active = true;
  cd.count = 0;
  cd.startI = startI;
  cd.tdst = setup.tdst;
  cd.size = setup.size;
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

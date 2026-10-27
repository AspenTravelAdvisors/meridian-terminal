import { z } from 'zod';
import { type Extreme, type Sma, extFull, extInit, extPush, extValue, smaInit, smaPush } from '../../core/rolling';
import { bool, choice, int, num, text } from '../../core/params';
import type { SeriesCtx, StudyDef, Writer } from '../../core/types';
import { type Sg, SIDES, mC, mH, mL, mO, mTH, mTL } from './common';

// ── Differential family (INDICATORS §6.7) ───────────────────────────────────
export const differentialSchema = z.object({
  differential: bool(true, { title: 'Differential (reversal)' }),
  reverse: bool(false, {
    title: 'Reverse Differential (continuation)',
    description: 'Off by default: as written its conditions coincide with Differential Down; the exact rule is unresolved.',
    verify: 'INDICATORS §6.7 — Reverse Up ≡ Differential Down as written; see VERIFY_LOG.',
  }),
  anti: bool(true, { title: 'Anti-Differential', verify: 'INDICATORS §6.7' }),
  antiPattern: text('D,D,U,D', {
    title: 'Anti-Differential buy close pattern',
    description: 'Directions of the last four close-to-close changes (oldest first), U/D. Sell mirrors.',
    verify: 'INDICATORS §6.7',
  }),
  antiUpBarLow: bool(true, {
    title: 'Anti-Differential: up-close bar trades below the bar before it',
    description: 'Buy: the low of the last up-close bar in the pattern is below the prior bar’s low (sell: high above).',
    verify: 'INDICATORS §6.7',
  }),
});
export type DifferentialCfg = z.infer<typeof differentialSchema>;

/** Buying pressure C − TL, selling pressure TH − C (mirrored space). */
const bp = (x: SeriesCtx, s: Sg, i: number) => mC(x, s, i) - mTL(x, s, i);
const sp = (x: SeriesCtx, s: Sg, i: number) => mTH(x, s, i) - mC(x, s, i);

interface DiffState {
  /** per side: bar index of an Anti-Differential awaiting next-bar follow-through, or −1 */
  antiAt: [number, number];
}

export const differential: StudyDef<DifferentialCfg, DiffState> = {
  id: 'td-differential',
  name: 'DeMark-style Differential',
  shortName: 'Diff',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Two-bar close patterns where buying/selling pressure diverge from price (Differential, Reverse Differential, optional Anti-Differential).',
  overlay: true,
  schema: differentialSchema,
  verify: [
    { key: 'reverse', note: 'INDICATORS §6.7 — Reverse Up ≡ Differential Down as written' },
    { key: 'antiPattern', note: 'INDICATORS §6.7' },
  ],
  outputs: () => [],
  signals: [
    { id: 'DIFF_UP', dir: 'bull', description: 'Differential buy' },
    { id: 'DIFF_DOWN', dir: 'bear', description: 'Differential sell' },
    { id: 'REVDIFF_UP', dir: 'bull', description: 'Reverse Differential up (continuation)' },
    { id: 'REVDIFF_DOWN', dir: 'bear', description: 'Reverse Differential down (continuation)' },
    { id: 'ANTIDIFF_UP', dir: 'bull', description: 'Anti-Differential buy' },
    { id: 'ANTIDIFF_DOWN', dir: 'bear', description: 'Anti-Differential sell' },
    { id: 'ANTIDIFF_UP_CONFIRM', dir: 'bull', description: 'Anti-Differential buy followed through (next bar above its high or close)' },
    { id: 'ANTIDIFF_DOWN_CONFIRM', dir: 'bear', description: 'Anti-Differential sell followed through (next bar below its low or close)' },
  ],
  init: () => ({ antiAt: [-1, -1] }),
  update(cfg, st, x, w) {
    const i = w.i;
    if (i < 2) return;
    for (let side = 0; side < 2; side++) {
      const s = SIDES[side];
      const up = s > 0;
      // Anti-Differential follow-through: the next bar trades above the signal bar's high or closes above its close.
      const a = st.antiAt[side];
      if (a >= 0 && i === a + 1 && (mH(x, s, i) > mH(x, s, a) || mC(x, s, i) > mC(x, s, a))) w.signal(up ? 'ANTIDIFF_UP_CONFIRM' : 'ANTIDIFF_DOWN_CONFIRM', up ? 'bull' : 'bear', x.c[i]);
      if (a >= 0 && i > a) st.antiAt[side] = -1;
      const lowerCloses = mC(x, s, i) < mC(x, s, i - 1) && mC(x, s, i - 1) < mC(x, s, i - 2);
      const bpUp = bp(x, s, i) > bp(x, s, i - 1);
      const spDn = sp(x, s, i) < sp(x, s, i - 1);
      if (cfg.differential && lowerCloses && bpUp && spDn) {
        w.signal(up ? 'DIFF_UP' : 'DIFF_DOWN', up ? 'bull' : 'bear', x.c[i]);
        w.marker({ i, text: 'D', pos: up ? 'below' : 'above', color: up ? 'bull' : 'bear', row: 5, size: 1, tooltip: `Differential ${up ? 'buy' : 'sell'}` });
      }
      // Reverse Differential, written for the UP case per INDICATORS: two higher closes, BP falling, SP rising.
      const higherCloses = mC(x, s, i) > mC(x, s, i - 1) && mC(x, s, i - 1) > mC(x, s, i - 2);
      if (cfg.reverse && higherCloses && bp(x, s, i) < bp(x, s, i - 1) && sp(x, s, i) > sp(x, s, i - 1)) {
        w.signal(up ? 'REVDIFF_UP' : 'REVDIFF_DOWN', up ? 'bull' : 'bear', x.c[i]);
        w.marker({ i, text: 'RD', pos: up ? 'below' : 'above', color: up ? 'bullAlt' : 'bearAlt', row: 5, size: 1, tooltip: 'Reverse Differential' });
      }
      if (cfg.anti && i >= 4) {
        const pat = cfg.antiPattern.split(',').map((t) => t.trim().toUpperCase());
        let ok = pat.length > 0 && pat.length <= i;
        for (let k = 0; ok && k < pat.length; k++) {
          const j = i - pat.length + 1 + k;
          const d = mC(x, s, j) - mC(x, s, j - 1);
          ok = pat[k] === 'U' ? d > 0 : pat[k] === 'D' ? d < 0 : false;
        }
        if (ok && cfg.antiUpBarLow && pat.includes('U')) {
          const j = i - pat.length + 1 + pat.lastIndexOf('U');
          ok = mL(x, s, j) < mL(x, s, j - 1);
        }
        if (ok) {
          st.antiAt[side] = i;
          w.signal(up ? 'ANTIDIFF_UP' : 'ANTIDIFF_DOWN', up ? 'bull' : 'bear', x.c[i]);
          w.marker({ i, text: 'AD', pos: up ? 'below' : 'above', color: 'warn', row: 5, size: 1, tooltip: 'Anti-Differential' });
        }
      }
    }
  },
};

// ── Open-based patterns + Camouflage (INDICATORS §6.8) ──────────────────────
export const openPatternsSchema = z.object({
  open: bool(true, { title: 'TD Open' }),
  openRef: choice(['priorClose', 'priorLow'] as const, 'priorClose', {
    title: 'TD Open: reversal reaches',
    description: 'Buy: opens below the prior low, then trades back up to the prior close (or only the prior low). Sell mirrors.',
    verify: 'INDICATORS §6.8',
  }),
  trap: bool(true, { title: 'TD Trap' }),
  clop: bool(true, { title: 'TD Clop' }),
  clopwin: bool(true, { title: 'TD Clopwin' }),
  camouflage: bool(true, { title: 'TD Camouflage' }),
});
export type OpenPatternsCfg = z.infer<typeof openPatternsSchema>;

function patterns(cfg: OpenPatternsCfg, x: SeriesCtx, s: Sg, i: number): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const O = mO(x, s, i);
  const H = mH(x, s, i);
  const C = mC(x, s, i);
  const L = mL(x, s, i);
  const O1 = mO(x, s, i - 1);
  const C1 = mC(x, s, i - 1);
  const H1 = mH(x, s, i - 1);
  const L1 = mL(x, s, i - 1);
  if (cfg.open && O < L1 && (cfg.openRef === 'priorClose' ? H >= C1 : H > L1)) out.push({ id: 'OPEN', label: 'Op' });
  if (cfg.trap && O >= L1 && O <= H1 && H > H1) out.push({ id: 'TRAP', label: 'Tr' });
  if (cfg.clop && O < Math.min(O1, C1) && H > Math.max(O1, C1)) out.push({ id: 'CLOP', label: 'Cl' });
  const lo = Math.min(O1, C1);
  const hi = Math.max(O1, C1);
  if (cfg.clopwin && O >= lo && O <= hi && C >= lo && C <= hi && C > C1) out.push({ id: 'CLOPWIN', label: 'Cw' });
  if (cfg.camouflage && i >= 2 && C < C1 && C > O && L < mTL(x, s, i - 2)) out.push({ id: 'CAMOUFLAGE', label: 'Cm' });
  return out;
}

export const openPatterns: StudyDef<OpenPatternsCfg, Record<string, never>> = {
  id: 'td-open-patterns',
  name: 'DeMark-style Open Patterns',
  shortName: 'Opens',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Open, Trap, Clop, Clopwin and Camouflage: one-bar patterns based on where the bar opens relative to the prior bar. Intrabar-provisional, final on close.',
  overlay: true,
  schema: openPatternsSchema,
  verify: [{ key: 'openRef', note: 'INDICATORS §6.8' }],
  outputs: () => [],
  signals: ['OPEN', 'TRAP', 'CLOP', 'CLOPWIN', 'CAMOUFLAGE'].flatMap((p) => [
    { id: `TD_${p}_BUY`, dir: 'bull' as const, description: `${p.toLowerCase()} buy` },
    { id: `TD_${p}_SELL`, dir: 'bear' as const, description: `${p.toLowerCase()} sell` },
  ]),
  init: () => ({}),
  update(cfg, _s, x, w: Writer) {
    const i = w.i;
    if (i < 1) return;
    for (const s of SIDES) {
      const hits = patterns(cfg, x, s, i);
      hits.forEach((h, k) => {
        w.signal(`TD_${h.id}_${s > 0 ? 'BUY' : 'SELL'}`, s > 0 ? 'bull' : 'bear', x.c[i]);
        w.marker({ i, text: h.label, pos: s > 0 ? 'below' : 'above', color: s > 0 ? 'bull' : 'bear', row: 6 + k, size: 1, style: 'muted', tooltip: `TD ${h.id.toLowerCase()} ${s > 0 ? 'buy' : 'sell'}` });
      });
      if (w.inspecting) w.inspect(`${s > 0 ? 'Buy' : 'Sell'} open patterns`, hits.length > 0, hits.map((h) => h.id).join(', ') || 'none');
    }
  },
};

// ── TD Moving Averages (INDICATORS §6.9, ⚠ VERIFY) ──────────────────────────
export const tdMaSchema = z.object({
  maLength: int(5, 2, 50, { title: 'MA I length', verify: 'INDICATORS §6.9' }),
  lookback: int(12, 2, 100, { title: 'MA I trigger lookback', verify: 'INDICATORS §6.9' }),
  activeBars: int(4, 1, 50, { title: 'MA I active bars', verify: 'INDICATORS §6.9' }),
});
export type TdMaCfg = z.infer<typeof tdMaSchema>;
interface TdMaState {
  smaL: Sma;
  smaH: Sma;
  maxH: Extreme;
  minL: Extreme;
  activeUp: number;
  activeDn: number;
  /** close of a bar that closed beyond an active MA I line, awaiting confirmation on the next bar (NaN = none) */
  pendUp: number;
  pendDn: number;
}

export const tdMa1: StudyDef<TdMaCfg, TdMaState> = {
  id: 'td-ma-1',
  name: 'DeMark-style Moving Average I',
  shortName: 'TD MA I',
  version: '0.9.0',
  category: 'DeMark',
  description: 'A 5-bar average of lows that switches on only after a low clears the highest high of the prior 12 bars, staying active for 4 bars (re-triggers extend it). Mirror with highs.',
  overlay: true,
  schema: tdMaSchema,
  verify: [{ key: 'lookback', note: 'INDICATORS §6.9' }],
  outputs: () => [
    { kind: 'line', id: 'ma_up', title: 'TD MA I (lows)', color: 'bull', width: 2 },
    { kind: 'line', id: 'ma_dn', title: 'TD MA I (highs)', color: 'bear', width: 2 },
  ],
  signals: [
    { id: 'TDMA1_UP_ON', dir: 'bull', description: 'TD MA I (lows) activated' },
    { id: 'TDMA1_DN_ON', dir: 'bear', description: 'TD MA I (highs) activated' },
    { id: 'TDMA1_UP_BREAKOUT', dir: 'bull', description: 'Close above the active MA I (highs), confirmed: next bar opens above that close and trades above its own open' },
    { id: 'TDMA1_DN_BREAKOUT', dir: 'bear', description: 'Close below the active MA I (lows), confirmed: next bar opens below that close and trades below its own open' },
  ],
  init: (cfg) => ({
    smaL: smaInit(cfg.maLength),
    smaH: smaInit(cfg.maLength),
    maxH: extInit(cfg.lookback, true),
    minL: extInit(cfg.lookback, false),
    activeUp: 0,
    activeDn: 0,
    pendUp: NaN,
    pendDn: NaN,
  }),
  update(cfg, st, x, w) {
    const i = w.i;
    const mL5 = smaPush(st.smaL, x.l[i]);
    const mH5 = smaPush(st.smaH, x.h[i]);
    // compare with the prior `lookback` bars (exclude current): read extremes BEFORE pushing bar i
    const priorMax = extFull(st.maxH) ? extValue(st.maxH) : NaN;
    const priorMin = extFull(st.minL) ? extValue(st.minL) : NaN;
    extPush(st.maxH, x.h[i]);
    extPush(st.minL, x.l[i]);
    if (st.activeUp > 0) st.activeUp--;
    if (st.activeDn > 0) st.activeDn--;
    if (x.l[i] > priorMax) {
      if (st.activeUp === 0) w.signal('TDMA1_UP_ON', 'bull', x.c[i]);
      st.activeUp = cfg.activeBars;
    }
    if (x.h[i] < priorMin) {
      if (st.activeDn === 0) w.signal('TDMA1_DN_ON', 'bear', x.c[i]);
      st.activeDn = cfg.activeBars;
    }
    // Breakout confirmation (INDICATORS §6.9): next bar opens beyond the breakout close, then trades beyond its own open.
    const o = x.o[i];
    if (Number.isFinite(st.pendUp) && o > st.pendUp && x.h[i] > o) w.signal('TDMA1_UP_BREAKOUT', 'bull', x.c[i]);
    if (Number.isFinite(st.pendDn) && o < st.pendDn && x.l[i] < o) w.signal('TDMA1_DN_BREAKOUT', 'bear', x.c[i]);
    const upLine = st.activeUp > 0 ? mL5 : NaN;
    const dnLine = st.activeDn > 0 ? mH5 : NaN;
    st.pendUp = Number.isFinite(dnLine) && x.c[i] > dnLine ? x.c[i] : NaN;
    st.pendDn = Number.isFinite(upLine) && x.c[i] < upLine ? x.c[i] : NaN;
    w.line(0, upLine);
    w.line(1, dnLine);
  },
};

export const tdMa2Schema = z.object({
  fast: int(3, 1, 50, { title: 'Short moving average', verify: 'INDICATORS §6.9' }),
  slow: int(34, 2, 200, { title: 'Long moving average', verify: 'INDICATORS §6.9' }),
  offsetPct: num(0, -20, 20, { title: 'Percent offset', step: 0.1, description: 'Displace both averages by this percentage (0 = off).' }),
});
export type TdMa2Cfg = z.infer<typeof tdMa2Schema>;
interface TdMa2State {
  fast: Sma;
  slow: Sma;
  regime: number;
  prevFast: number;
}

export const tdMa2: StudyDef<TdMa2Cfg, TdMa2State> = {
  id: 'td-ma-2',
  name: 'DeMark-style Moving Average II',
  shortName: 'TD MA II',
  version: '1.0.0',
  category: 'DeMark',
  description: 'Short (3) and long (34) moving averages of the close on the price chart: bullish while the short is above the long. Optional percent offset.',
  overlay: true,
  schema: tdMa2Schema,
  verify: [{ key: 'fast', note: 'INDICATORS §6.9' }],
  outputs: () => [
    { kind: 'line', id: 'ma_fast', title: 'Short MA', color: 'accent', width: 2 },
    { kind: 'line', id: 'ma_slow', title: 'Long MA', color: 'warn', width: 1 },
    { kind: 'data', id: 'regime', title: 'Regime (+1 short above long / −1 below)' },
    { kind: 'data', id: 'slope', title: 'Short MA direction (+1 rising / −1 falling)' },
  ],
  signals: [
    { id: 'TDMA2_BULL', dir: 'bull', description: 'Short MA crosses above the long MA' },
    { id: 'TDMA2_BEAR', dir: 'bear', description: 'Short MA crosses below the long MA' },
  ],
  init: (cfg) => ({ fast: smaInit(cfg.fast), slow: smaInit(cfg.slow), regime: 0, prevFast: NaN }),
  update(cfg, st, x, w) {
    const i = w.i;
    const k = 1 + cfg.offsetPct / 100;
    const f = smaPush(st.fast, x.c[i]) * k;
    const sl = smaPush(st.slow, x.c[i]) * k;
    if (!Number.isFinite(sl)) return;
    const reg = f > sl ? 1 : f < sl ? -1 : st.regime;
    if (st.regime !== 0 && reg !== st.regime) w.signal(reg > 0 ? 'TDMA2_BULL' : 'TDMA2_BEAR', reg > 0 ? 'bull' : 'bear', x.c[i]);
    st.regime = reg;
    w.line(0, f);
    w.line(1, sl);
    w.line(2, reg);
    w.line(3, Number.isFinite(st.prevFast) ? Math.sign(f - st.prevFast) : 0);
    st.prevFast = f;
  },
};

import { z } from 'zod';
import { type Extreme, type Sma, extFull, extInit, extPush, extValue, smaInit, smaPush } from '../../core/rolling';
import { bool, int, text } from '../../core/params';
import type { SeriesCtx, StudyDef, Writer } from '../../core/types';
import { type Sg, SIDES, mC, mH, mL, mO, mTH, mTL } from './common';

// ── Differential family (INDICATORS §6.7) ───────────────────────────────────
export const differentialSchema = z.object({
  differential: bool(true, { title: 'Differential (reversal)' }),
  reverse: bool(true, {
    title: 'Reverse Differential (continuation)',
    verify: 'INDICATORS §6.7 — as written, Reverse Up has the same conditions as Differential Down; see VERIFY_LOG.',
  }),
  anti: bool(false, { title: 'Anti-Differential', verify: 'INDICATORS §6.7 — sequence unverified; disabled by default' }),
  antiPattern: text('D,U,D,U', {
    title: 'Anti-Differential buy close pattern',
    description: 'Directions of the last four close-to-close changes (oldest first), U/D. Sell mirrors.',
    verify: 'INDICATORS §6.7',
  }),
});
export type DifferentialCfg = z.infer<typeof differentialSchema>;

/** Buying pressure C − TL, selling pressure TH − C (mirrored space). */
const bp = (x: SeriesCtx, s: Sg, i: number) => mC(x, s, i) - mTL(x, s, i);
const sp = (x: SeriesCtx, s: Sg, i: number) => mTH(x, s, i) - mC(x, s, i);

export const differential: StudyDef<DifferentialCfg, Record<string, never>> = {
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
  ],
  init: () => ({}),
  update(cfg, _s, x, w) {
    const i = w.i;
    if (i < 2) return;
    for (const s of SIDES) {
      const up = s > 0;
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
        if (ok) {
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
  if (cfg.open && O < L1 && H > L1) out.push({ id: 'OPEN', label: 'Op' });
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
  ],
  init: (cfg) => ({ smaL: smaInit(cfg.maLength), smaH: smaInit(cfg.maLength), maxH: extInit(cfg.lookback, true), minL: extInit(cfg.lookback, false), activeUp: 0, activeDn: 0 }),
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
    w.line(0, st.activeUp > 0 ? mL5 : NaN);
    w.line(1, st.activeDn > 0 ? mH5 : NaN);
  },
};

export const tdMa2Schema = z.object({
  fast: int(3, 1, 50, { title: 'Fast ROC length', verify: 'INDICATORS §6.9' }),
  slow: int(34, 2, 200, { title: 'Slow ROC length', verify: 'INDICATORS §6.9' }),
});
export type TdMa2Cfg = z.infer<typeof tdMa2Schema>;

export const tdMa2: StudyDef<TdMa2Cfg, { regime: number }> = {
  id: 'td-ma-2',
  name: 'DeMark-style Moving Average II',
  shortName: 'TD MA II',
  version: '0.9.0',
  category: 'DeMark',
  description: 'Regime filter comparing a 3-bar rate of change with a 34-bar rate of change.',
  overlay: false,
  schema: tdMa2Schema,
  verify: [{ key: 'fast', note: 'INDICATORS §6.9' }],
  outputs: () => [
    { kind: 'line', id: 'roc_fast', title: 'Fast ROC %', color: 'accent', width: 2 },
    { kind: 'line', id: 'roc_slow', title: 'Slow ROC %', color: 'warn', width: 1 },
    { kind: 'histogram', id: 'regime', title: 'Regime', color: 'bull', negColor: 'bear' },
  ],
  signals: [
    { id: 'TDMA2_BULL', dir: 'bull', description: 'Fast ROC crosses above slow ROC' },
    { id: 'TDMA2_BEAR', dir: 'bear', description: 'Fast ROC crosses below slow ROC' },
  ],
  init: () => ({ regime: 0 }),
  update(cfg, st, x, w) {
    const i = w.i;
    if (i < cfg.slow) return;
    const rf = (100 * (x.c[i] - x.c[i - cfg.fast])) / x.c[i - cfg.fast];
    const rs = (100 * (x.c[i] - x.c[i - cfg.slow])) / x.c[i - cfg.slow];
    const reg = rf > rs ? 1 : rf < rs ? -1 : st.regime;
    if (st.regime !== 0 && reg !== st.regime) w.signal(reg > 0 ? 'TDMA2_BULL' : 'TDMA2_BEAR', reg > 0 ? 'bull' : 'bear', x.c[i]);
    st.regime = reg;
    w.line(0, rf);
    w.line(1, rs);
    w.line(2, rf - rs);
  },
};

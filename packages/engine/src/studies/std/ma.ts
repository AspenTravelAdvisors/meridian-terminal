import { z } from 'zod';
import { type Ema, type Wma, emaInit, emaPush, smaInit, smaPush, type Sma, wmaInit, wmaPush } from '../../core/rolling';
import { bool, choice, int, num, text } from '../../core/params';
import { periodKey, type PeriodKind } from '../../core/time';
import type { Color, StudyDef } from '../../core/types';
import { type Source, crossDown, crossUp, sourceParam, src } from './common';

type MaKind = 'sma' | 'ema' | 'wma' | 'hma' | 'dema' | 'tema';

const maSchema = (def: number) =>
  z.object({
    length: int(def, 1, 1000, { title: 'Length' }),
    source: sourceParam(),
    offset: int(0, -500, 500, { title: 'Offset' }),
    crossSignals: bool(true, { title: 'Price-cross signals' }),
  });
type MaCfg = z.infer<ReturnType<typeof maSchema>>;

interface MaState {
  a: Ema | Sma | Wma;
  b?: Ema | Wma;
  c?: Ema | Wma;
  prevDiff: number;
}

const NAMES: Record<MaKind, [string, string, Color]> = {
  sma: ['Simple Moving Average', 'SMA', '#f5a623'],
  ema: ['Exponential Moving Average', 'EMA', '#29b6f6'],
  wma: ['Weighted Moving Average', 'WMA', '#ab47bc'],
  hma: ['Hull Moving Average', 'HMA', '#26a69a'],
  dema: ['Double EMA', 'DEMA', '#ef5350'],
  tema: ['Triple EMA', 'TEMA', '#8d6e63'],
};

function maInit(kind: MaKind, n: number): MaState {
  switch (kind) {
    case 'sma':
      return { a: smaInit(n), prevDiff: NaN };
    case 'ema':
      return { a: emaInit(n), prevDiff: NaN };
    case 'wma':
      return { a: wmaInit(n), prevDiff: NaN };
    case 'hma':
      return { a: wmaInit(Math.max(1, Math.round(n / 2))), b: wmaInit(n), c: wmaInit(Math.max(1, Math.round(Math.sqrt(n)))), prevDiff: NaN };
    case 'dema':
      return { a: emaInit(n), b: emaInit(n), prevDiff: NaN };
    case 'tema':
      return { a: emaInit(n), b: emaInit(n), c: emaInit(n), prevDiff: NaN };
  }
}

export function maPush(kind: MaKind, s: MaState, v: number): number {
  switch (kind) {
    case 'sma':
      return smaPush(s.a as Sma, v);
    case 'ema':
      return emaPush(s.a as Ema, v);
    case 'wma':
      return wmaPush(s.a as Wma, v);
    case 'hma': {
      const half = wmaPush(s.a as Wma, v);
      const full = wmaPush(s.b as Wma, v);
      if (Number.isNaN(half) || Number.isNaN(full)) return NaN;
      return wmaPush(s.c as Wma, 2 * half - full);
    }
    case 'dema': {
      const e1 = emaPush(s.a as Ema, v);
      if (Number.isNaN(e1)) return NaN;
      const e2 = emaPush(s.b as Ema, e1);
      return Number.isNaN(e2) ? NaN : 2 * e1 - e2;
    }
    case 'tema': {
      const e1 = emaPush(s.a as Ema, v);
      if (Number.isNaN(e1)) return NaN;
      const e2 = emaPush(s.b as Ema, e1);
      if (Number.isNaN(e2)) return NaN;
      const e3 = emaPush(s.c as Ema, e2);
      return Number.isNaN(e3) ? NaN : 3 * e1 - 3 * e2 + e3;
    }
  }
}

function makeMa(kind: MaKind, defLen: number): StudyDef<MaCfg, MaState> {
  const [name, short, color] = NAMES[kind];
  const SIG = short.toUpperCase();
  return {
    id: kind,
    name,
    shortName: short,
    version: '1.0.0',
    category: 'Trend',
    description: `${name} of the selected source.`,
    overlay: true,
    schema: maSchema(defLen),
    outputs: (cfg) => [{ kind: 'line', id: 'ma', title: `${short} ${cfg.length}`, color, width: 2, offset: cfg.offset || undefined }],
    signals: [
      { id: `${SIG}_CROSS_UP`, dir: 'bull', description: `Close crosses above the ${short}` },
      { id: `${SIG}_CROSS_DOWN`, dir: 'bear', description: `Close crosses below the ${short}` },
    ],
    init: (cfg) => maInit(kind, cfg.length),
    update(cfg, st, x, w) {
      const i = w.i;
      const v = maPush(kind, st, src(x, i, cfg.source as Source));
      w.line(0, v);
      if (cfg.crossSignals && Number.isFinite(v)) {
        const d = x.c[i] - v;
        if (Number.isFinite(st.prevDiff)) {
          if (st.prevDiff <= 0 && d > 0) w.signal(`${SIG}_CROSS_UP`, 'bull', x.c[i]);
          if (st.prevDiff >= 0 && d < 0) w.signal(`${SIG}_CROSS_DOWN`, 'bear', x.c[i]);
        }
        st.prevDiff = d;
      }
    },
  };
}

export const sma = makeMa('sma', 20);
export const ema = makeMa('ema', 20);
export const wma = makeMa('wma', 20);
export const hma = makeMa('hma', 21);
export const dema = makeMa('dema', 20);
export const tema = makeMa('tema', 20);

// ── VWAP (session / week / month / anchored) with σ bands ──────────────────
export const vwapSchema = z.object({
  anchor: choice(['session', 'week', 'month', 'quarter', 'year', 'anchored'] as const, 'session', { title: 'Anchor period' }),
  anchorTime: num(0, 0, 9e15, { title: 'Anchored start (epoch ms)', description: 'Used when anchor = anchored. Set by clicking “Anchor VWAP here” on the chart.' }),
  tz: text('America/New_York', { title: 'Session time zone' }),
  source: sourceParam('hlc3'),
  bands: bool(true, { title: 'Show ±σ bands' }),
  mult1: num(1, 0.1, 5, { title: 'Band 1 ×σ' }),
  mult2: num(2, 0.1, 5, { title: 'Band 2 ×σ' }),
});
export type VwapCfg = z.infer<typeof vwapSchema>;
interface VwapState {
  key: number;
  pv: number;
  v: number;
  p2v: number;
  started: boolean;
  prev: number;
}

export const vwap: StudyDef<VwapCfg, VwapState> = {
  id: 'vwap',
  name: 'VWAP',
  shortName: 'VWAP',
  version: '1.0.0',
  category: 'Volume',
  description: 'Volume-weighted average price, reset each session/period or anchored at a chosen bar, with standard-deviation bands.',
  overlay: true,
  schema: vwapSchema,
  outputs: (cfg) => [
    { kind: 'line', id: 'vwap', title: 'VWAP', color: '#ff9800', width: 2, render: 'line' },
    ...(cfg.bands
      ? (['u1', 'l1', 'u2', 'l2'] as const).map((id) => ({ kind: 'line' as const, id, title: id, color: 'muted' as const, style: id.endsWith('2') ? ('dotted' as const) : ('dashed' as const) }))
      : []),
  ],
  signals: [
    { id: 'VWAP_CROSS_UP', dir: 'bull', description: 'Close crosses above VWAP' },
    { id: 'VWAP_CROSS_DOWN', dir: 'bear', description: 'Close crosses below VWAP' },
  ],
  init: () => ({ key: NaN, pv: 0, v: 0, p2v: 0, started: false, prev: NaN }),
  update(cfg, st, x, w) {
    const i = w.i;
    const t = x.t[i];
    if (cfg.anchor === 'anchored') {
      if (!st.started && t >= cfg.anchorTime) {
        st.started = true;
        st.pv = st.v = st.p2v = 0;
      }
      if (!st.started) return;
    } else {
      const kind: PeriodKind = cfg.anchor === 'session' ? 'day' : cfg.anchor;
      const k = periodKey(t, kind, cfg.tz);
      if (k !== st.key) {
        st.key = k;
        st.pv = st.v = st.p2v = 0;
        st.prev = NaN;
      }
    }
    const p = src(x, i, cfg.source);
    const vol = x.v[i] > 0 ? x.v[i] : 1e-9; // zero-volume feeds degrade gracefully to a TWAP
    st.pv += p * vol;
    st.v += vol;
    st.p2v += p * p * vol;
    const vw = st.pv / st.v;
    w.line(0, vw);
    if (cfg.bands) {
      const sd = Math.sqrt(Math.max(0, st.p2v / st.v - vw * vw));
      w.line(1, vw + cfg.mult1 * sd);
      w.line(2, vw - cfg.mult1 * sd);
      w.line(3, vw + cfg.mult2 * sd);
      w.line(4, vw - cfg.mult2 * sd);
    }
    const d = x.c[i] - vw;
    if (Number.isFinite(st.prev)) {
      if (crossUp(st.prev, d, 0, 0)) w.signal('VWAP_CROSS_UP', 'bull', x.c[i]);
      if (crossDown(st.prev, d, 0, 0)) w.signal('VWAP_CROSS_DOWN', 'bear', x.c[i]);
    }
    st.prev = d;
  },
};

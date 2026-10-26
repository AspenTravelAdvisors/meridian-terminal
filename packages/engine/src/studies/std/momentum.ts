import { z } from 'zod';
import {
  emaInit,
  emaPush,
  extFull,
  extInit,
  extPush,
  ringInit,
  ringPush,
  rmaInit,
  smaInit,
  smaPush,
  sumFull,
  sumInit,
  sumPush,
} from '../../core/rolling';
import { defineStudy, int, num } from '../../core/params';
import { crossDown, crossUp, sourceParam, src } from './common';

const zones = (ob: number, os: number) => [
  { kind: 'hline' as const, id: 'ob', title: 'Overbought', value: ob, color: 'bear' as const, style: 'dashed' as const },
  { kind: 'hline' as const, id: 'os', title: 'Oversold', value: os, color: 'bull' as const, style: 'dashed' as const },
];

// ── RSI (Wilder) ───────────────────────────────────────────────────────────
export const rsi = defineStudy(
  z.object({
    length: int(14, 1, 500, { title: 'Length' }),
    source: sourceParam(),
    overbought: num(70, 50, 100, { title: 'Overbought', step: 1 }),
    oversold: num(30, 0, 50, { title: 'Oversold', step: 1 }),
  }),
  {
    id: 'rsi',
    name: 'Relative Strength Index',
    shortName: 'RSI',
    version: '1.0.0',
    category: 'Momentum',
    description: 'Wilder-smoothed ratio of average gains to average losses (0–100).',
    overlay: false,
    outputs: (cfg) => [{ kind: 'line', id: 'rsi', title: 'RSI', color: '#7e57c2', width: 2 }, ...zones(cfg.overbought, cfg.oversold)],
    signals: [
      { id: 'RSI_OS_EXIT', dir: 'bull', description: 'RSI crosses back above oversold' },
      { id: 'RSI_OB_EXIT', dir: 'bear', description: 'RSI crosses back below overbought' },
    ],
    init: (cfg) => ({ up: rmaInit(cfg.length), dn: rmaInit(cfg.length), prev: NaN, prevSrc: NaN }),
    update(cfg, s, x, w) {
      const v = src(x, w.i, cfg.source);
      if (Number.isNaN(s.prevSrc)) {
        s.prevSrc = v;
        return;
      }
      const ch = v - s.prevSrc;
      s.prevSrc = v;
      const u = emaPush(s.up, Math.max(0, ch));
      const d = emaPush(s.dn, Math.max(0, -ch));
      if (!Number.isFinite(u)) return;
      const r = d === 0 ? (u === 0 ? 50 : 100) : 100 - 100 / (1 + u / d);
      w.line(0, r);
      if (Number.isFinite(s.prev)) {
        if (crossUp(s.prev, r, cfg.oversold, cfg.oversold)) w.signal('RSI_OS_EXIT', 'bull', x.c[w.i]);
        if (crossDown(s.prev, r, cfg.overbought, cfg.overbought)) w.signal('RSI_OB_EXIT', 'bear', x.c[w.i]);
      }
      s.prev = r;
    },
  },
);

// ── Stochastic ─────────────────────────────────────────────────────────────
export const stochastic = defineStudy(
  z.object({ k: int(14, 1, 500, { title: '%K length' }), smoothK: int(3, 1, 50, { title: '%K smoothing' }), d: int(3, 1, 50, { title: '%D smoothing' }) }),
  {
    id: 'stochastic',
    name: 'Stochastic',
    shortName: 'Stoch',
    version: '1.0.0',
    category: 'Momentum',
    description: 'Close relative to the n-bar range, smoothed (%K) with a signal line (%D).',
    overlay: false,
    outputs: () => [{ kind: 'line', id: 'k', title: '%K', color: '#2962ff', width: 2 }, { kind: 'line', id: 'd', title: '%D', color: '#ff6d00' }, ...zones(80, 20)],
    signals: [
      { id: 'STOCH_CROSS_UP', dir: 'bull', description: '%K crosses above %D in oversold' },
      { id: 'STOCH_CROSS_DOWN', dir: 'bear', description: '%K crosses below %D in overbought' },
    ],
    init: (cfg) => ({ hi: extInit(cfg.k, true), lo: extInit(cfg.k, false), sk: smaInit(cfg.smoothK), sd: smaInit(cfg.d), pk: NaN, pd: NaN }),
    update(_cfg, s, x, w) {
      const i = w.i;
      const h = extPush(s.hi, x.h[i]);
      const l = extPush(s.lo, x.l[i]);
      if (!extFull(s.hi)) return;
      const raw = h > l ? (100 * (x.c[i] - l)) / (h - l) : 50;
      const k = smaPush(s.sk, raw);
      if (!Number.isFinite(k)) return;
      const d = smaPush(s.sd, k);
      w.line(0, k);
      w.line(1, d);
      if (Number.isFinite(s.pk) && Number.isFinite(s.pd) && Number.isFinite(d)) {
        if (crossUp(s.pk, k, s.pd, d) && k < 20) w.signal('STOCH_CROSS_UP', 'bull', x.c[i]);
        if (crossDown(s.pk, k, s.pd, d) && k > 80) w.signal('STOCH_CROSS_DOWN', 'bear', x.c[i]);
      }
      s.pk = k;
      s.pd = d;
    },
  },
);

// ── Stochastic RSI ─────────────────────────────────────────────────────────
export const stochRsi = defineStudy(
  z.object({
    rsiLength: int(14, 1, 500, { title: 'RSI length' }),
    stochLength: int(14, 1, 500, { title: 'Stochastic length' }),
    smoothK: int(3, 1, 50, { title: '%K smoothing' }),
    d: int(3, 1, 50, { title: '%D smoothing' }),
  }),
  {
    id: 'stoch-rsi',
    name: 'Stochastic RSI',
    shortName: 'StochRSI',
    version: '1.0.0',
    category: 'Momentum',
    description: 'Stochastic oscillator applied to RSI.',
    overlay: false,
    outputs: () => [{ kind: 'line', id: 'k', title: '%K', color: '#2962ff', width: 2 }, { kind: 'line', id: 'd', title: '%D', color: '#ff6d00' }, ...zones(80, 20)],
    init: (cfg) => ({
      up: rmaInit(cfg.rsiLength),
      dn: rmaInit(cfg.rsiLength),
      prev: NaN,
      hi: extInit(cfg.stochLength, true),
      lo: extInit(cfg.stochLength, false),
      sk: smaInit(cfg.smoothK),
      sd: smaInit(cfg.d),
    }),
    update(_cfg, s, x, w) {
      const c = x.c[w.i];
      if (Number.isNaN(s.prev)) {
        s.prev = c;
        return;
      }
      const ch = c - s.prev;
      s.prev = c;
      const u = emaPush(s.up, Math.max(0, ch));
      const d0 = emaPush(s.dn, Math.max(0, -ch));
      if (!Number.isFinite(u)) return;
      const r = d0 === 0 ? 100 : 100 - 100 / (1 + u / d0);
      const h = extPush(s.hi, r);
      const l = extPush(s.lo, r);
      if (!extFull(s.hi)) return;
      const k = smaPush(s.sk, h > l ? (100 * (r - l)) / (h - l) : 50);
      if (!Number.isFinite(k)) return;
      w.line(0, k);
      w.line(1, smaPush(s.sd, k));
    },
  },
);

// ── MACD ───────────────────────────────────────────────────────────────────
export const macd = defineStudy(
  z.object({ fast: int(12, 1, 500, { title: 'Fast' }), slow: int(26, 1, 500, { title: 'Slow' }), signal: int(9, 1, 200, { title: 'Signal' }), source: sourceParam() }),
  {
    id: 'macd',
    name: 'MACD',
    shortName: 'MACD',
    version: '1.0.0',
    category: 'Momentum',
    description: 'Difference of two EMAs, its signal EMA and the histogram.',
    overlay: false,
    outputs: () => [
      { kind: 'histogram', id: 'hist', title: 'Histogram', color: 'bull', negColor: 'bear' },
      { kind: 'line', id: 'macd', title: 'MACD', color: '#2962ff', width: 2 },
      { kind: 'line', id: 'signal', title: 'Signal', color: '#ff6d00' },
    ],
    signals: [
      { id: 'MACD_CROSS_UP', dir: 'bull', description: 'MACD crosses above signal' },
      { id: 'MACD_CROSS_DOWN', dir: 'bear', description: 'MACD crosses below signal' },
      { id: 'MACD_ZERO_UP', dir: 'bull', description: 'MACD crosses above zero' },
      { id: 'MACD_ZERO_DOWN', dir: 'bear', description: 'MACD crosses below zero' },
    ],
    init: (cfg) => ({ f: emaInit(cfg.fast), s: emaInit(cfg.slow), g: emaInit(cfg.signal), ph: NaN, pm: NaN }),
    update(cfg, s, x, w) {
      const v = src(x, w.i, cfg.source);
      const f = emaPush(s.f, v);
      const sl = emaPush(s.s, v);
      if (!Number.isFinite(f) || !Number.isFinite(sl)) return;
      const m = f - sl;
      const g = emaPush(s.g, m);
      w.line(1, m);
      if (!Number.isFinite(g)) return;
      const h = m - g;
      w.line(0, h);
      w.line(2, g);
      if (Number.isFinite(s.ph)) {
        if (s.ph <= 0 && h > 0) w.signal('MACD_CROSS_UP', 'bull', x.c[w.i]);
        if (s.ph >= 0 && h < 0) w.signal('MACD_CROSS_DOWN', 'bear', x.c[w.i]);
      }
      if (Number.isFinite(s.pm)) {
        if (s.pm <= 0 && m > 0) w.signal('MACD_ZERO_UP', 'bull', x.c[w.i]);
        if (s.pm >= 0 && m < 0) w.signal('MACD_ZERO_DOWN', 'bear', x.c[w.i]);
      }
      s.ph = h;
      s.pm = m;
    },
  },
);

// ── CCI ────────────────────────────────────────────────────────────────────
export const cci = defineStudy(z.object({ length: int(20, 2, 500, { title: 'Length' }) }), {
  id: 'cci',
  name: 'Commodity Channel Index',
  shortName: 'CCI',
  version: '1.0.0',
  category: 'Momentum',
  description: 'Typical price deviation from its SMA, scaled by mean absolute deviation.',
  overlay: false,
  outputs: () => [{ kind: 'line', id: 'cci', title: 'CCI', color: '#26a69a', width: 2 }, ...zones(100, -100)],
  init: (cfg) => ({ r: ringInit(cfg.length), sum: sumInit(cfg.length) }),
  update(cfg, s, x, w) {
    const i = w.i;
    const tp = (x.h[i] + x.l[i] + x.c[i]) / 3;
    ringPush(s.r, tp);
    sumPush(s.sum, tp);
    if (!sumFull(s.sum)) return;
    const m = s.sum.sum / cfg.length;
    let md = 0;
    for (let k = 0; k < cfg.length; k++) md += Math.abs(s.r.buf[k] - m);
    md /= cfg.length;
    w.line(0, md > 0 ? (tp - m) / (0.015 * md) : 0);
  },
});

// ── Williams %R ────────────────────────────────────────────────────────────
export const williamsR = defineStudy(z.object({ length: int(14, 1, 500, { title: 'Length' }) }), {
  id: 'williams-r',
  name: 'Williams %R',
  shortName: '%R',
  version: '1.0.0',
  category: 'Momentum',
  description: 'Close relative to the n-bar high (0 to −100).',
  overlay: false,
  outputs: () => [{ kind: 'line', id: 'wr', title: '%R', color: '#ab47bc', width: 2 }, ...zones(-20, -80)],
  init: (cfg) => ({ hi: extInit(cfg.length, true), lo: extInit(cfg.length, false) }),
  update(_cfg, s, x, w) {
    const i = w.i;
    const h = extPush(s.hi, x.h[i]);
    const l = extPush(s.lo, x.l[i]);
    if (!extFull(s.hi)) return;
    w.line(0, h > l ? (-100 * (h - x.c[i])) / (h - l) : -50);
  },
});

// ── ROC ────────────────────────────────────────────────────────────────────
export const roc = defineStudy(z.object({ length: int(9, 1, 500, { title: 'Length' }), source: sourceParam() }), {
  id: 'roc',
  name: 'Rate of Change',
  shortName: 'ROC',
  version: '1.0.0',
  category: 'Momentum',
  description: 'Percent change over n bars.',
  overlay: false,
  outputs: () => [{ kind: 'line', id: 'roc', title: 'ROC %', color: '#29b6f6', width: 2 }, { kind: 'hline', id: 'zero', title: 'Zero', value: 0, color: 'muted' }],
  init: () => ({}),
  update(cfg, _s, x, w) {
    const i = w.i;
    if (i < cfg.length) return;
    const b = src(x, i - cfg.length, cfg.source);
    w.line(0, b !== 0 ? (100 * (src(x, i, cfg.source) - b)) / b : 0);
  },
});

// ── MFI ────────────────────────────────────────────────────────────────────
export const mfi = defineStudy(z.object({ length: int(14, 1, 500, { title: 'Length' }) }), {
  id: 'mfi',
  name: 'Money Flow Index',
  shortName: 'MFI',
  version: '1.0.0',
  category: 'Volume',
  description: 'Volume-weighted RSI of typical price.',
  overlay: false,
  outputs: () => [{ kind: 'line', id: 'mfi', title: 'MFI', color: '#ef6c00', width: 2 }, ...zones(80, 20)],
  init: (cfg) => ({ pos: sumInit(cfg.length), neg: sumInit(cfg.length), prev: NaN }),
  update(_cfg, s, x, w) {
    const i = w.i;
    const tp = (x.h[i] + x.l[i] + x.c[i]) / 3;
    if (Number.isNaN(s.prev)) {
      s.prev = tp;
      return;
    }
    const flow = tp * x.v[i];
    sumPush(s.pos, tp > s.prev ? flow : 0);
    sumPush(s.neg, tp < s.prev ? flow : 0);
    s.prev = tp;
    if (!sumFull(s.pos)) return;
    const den = s.pos.sum + s.neg.sum;
    w.line(0, den > 0 ? (100 * s.pos.sum) / den : 50);
  },
});


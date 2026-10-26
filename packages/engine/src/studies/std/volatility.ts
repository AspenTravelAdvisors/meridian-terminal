import { z } from 'zod';
import {
  type Sma,
  emaInit,
  emaPush,
  extFull,
  extInit,
  extPush,
  rmaInit,
  smaInit,
  smaPush,
  statFull,
  statInit,
  statMean,
  statPush,
  statStd,
} from '../../core/rolling';
import { choice, defineStudy, int, num } from '../../core/params';

import { sourceParam, src, tr } from './common';

// ── Bollinger Bands ────────────────────────────────────────────────────────
export const bollinger = defineStudy(z.object({ length: int(20, 2, 500, { title: 'Length' }), mult: num(2, 0.1, 10, { title: 'StdDev ×' }), source: sourceParam() }), {
  id: 'bollinger',
  name: 'Bollinger Bands',
  shortName: 'BB',
  version: '1.0.0',
  category: 'Volatility',
  description: 'SMA basis with bands at ± k population standard deviations.',
  overlay: true,
  outputs: () => [
    { kind: 'line', id: 'basis', title: 'Basis', color: '#f5a623' },
    { kind: 'line', id: 'upper', title: 'Upper', color: '#29b6f6' },
    { kind: 'line', id: 'lower', title: 'Lower', color: '#29b6f6' },
    { kind: 'cloud', id: 'fill', title: 'Band fill', a: 'upper', b: 'lower', upColor: 'rgba(41,182,246,0.06)', downColor: 'rgba(41,182,246,0.06)' },
    { kind: 'data', id: 'pctb', title: '%B' },
    { kind: 'data', id: 'width', title: 'Bandwidth %' },
  ],
  signals: [
    { id: 'BB_CLOSE_ABOVE', dir: 'bear', description: 'Close above the upper band' },
    { id: 'BB_CLOSE_BELOW', dir: 'bull', description: 'Close below the lower band' },
    { id: 'BB_REENTER_FROM_BELOW', dir: 'bull', description: 'Close back inside from below' },
    { id: 'BB_REENTER_FROM_ABOVE', dir: 'bear', description: 'Close back inside from above' },
  ],
  init: (cfg) => ({ st: statInit(cfg.length), prevPos: 0 }),
  update(cfg, s, x, w) {
    const i = w.i;
    statPush(s.st, src(x, i, cfg.source));
    if (!statFull(s.st)) return;
    const m = statMean(s.st);
    const sd = statStd(s.st);
    const up = m + cfg.mult * sd;
    const lo = m - cfg.mult * sd;
    w.line(0, m);
    w.line(1, up);
    w.line(2, lo);
    w.line(3, up > lo ? (x.c[i] - lo) / (up - lo) : 0.5);
    w.line(4, m !== 0 ? (100 * (up - lo)) / m : 0);
    const pos = x.c[i] > up ? 1 : x.c[i] < lo ? -1 : 0;
    if (pos === 1 && s.prevPos !== 1) w.signal('BB_CLOSE_ABOVE', 'bear', x.c[i]);
    if (pos === -1 && s.prevPos !== -1) w.signal('BB_CLOSE_BELOW', 'bull', x.c[i]);
    if (pos === 0 && s.prevPos === -1) w.signal('BB_REENTER_FROM_BELOW', 'bull', x.c[i]);
    if (pos === 0 && s.prevPos === 1) w.signal('BB_REENTER_FROM_ABOVE', 'bear', x.c[i]);
    s.prevPos = pos;
  },
});

// ── ATR ────────────────────────────────────────────────────────────────────
const smoothing = choice(['rma', 'ema', 'sma'] as const, 'rma', { title: 'Smoothing' });
export const atr = defineStudy(z.object({ length: int(14, 1, 500, { title: 'Length' }), smoothing }), {
  id: 'atr',
  name: 'Average True Range',
  shortName: 'ATR',
  version: '1.0.0',
  category: 'Volatility',
  description: 'Smoothed true range.',
  overlay: false,
  outputs: () => [{ kind: 'line', id: 'atr', title: 'ATR', color: '#ef5350', width: 2 }],
  init: (cfg) => ({ e: cfg.smoothing === 'rma' ? rmaInit(cfg.length) : emaInit(cfg.length), m: smaInit(cfg.length) as Sma }),
  update(cfg, s, x, w) {
    const v = tr(x, w.i);
    w.line(0, cfg.smoothing === 'sma' ? smaPush(s.m, v) : emaPush(s.e, v));
  },
});

// ── Keltner Channels ───────────────────────────────────────────────────────
export const keltner = defineStudy(z.object({ length: int(20, 1, 500, { title: 'EMA length' }), atrLength: int(10, 1, 500, { title: 'ATR length' }), mult: num(2, 0.1, 10, { title: 'ATR ×' }) }), {
  id: 'keltner',
  name: 'Keltner Channels',
  shortName: 'KC',
  version: '1.0.0',
  category: 'Volatility',
  description: 'EMA basis with bands at ± k × ATR.',
  overlay: true,
  outputs: () => [
    { kind: 'line', id: 'mid', title: 'Basis', color: '#26a69a' },
    { kind: 'line', id: 'upper', title: 'Upper', color: '#26a69a', style: 'dashed' },
    { kind: 'line', id: 'lower', title: 'Lower', color: '#26a69a', style: 'dashed' },
  ],
  init: (cfg) => ({ mid: emaInit(cfg.length), atr: rmaInit(cfg.atrLength) }),
  update(cfg, s, x, w) {
    const m = emaPush(s.mid, x.c[w.i]);
    const a = emaPush(s.atr, tr(x, w.i));
    w.line(0, m);
    w.line(1, m + cfg.mult * a);
    w.line(2, m - cfg.mult * a);
  },
});

// ── Donchian Channels ──────────────────────────────────────────────────────
export const donchian = defineStudy(z.object({ length: int(20, 1, 1000, { title: 'Length' }) }), {
  id: 'donchian',
  name: 'Donchian Channels',
  shortName: 'DC',
  version: '1.0.0',
  category: 'Volatility',
  description: 'Highest high and lowest low over n bars, with midline.',
  overlay: true,
  outputs: () => [
    { kind: 'line', id: 'upper', title: 'Upper', color: '#2962ff' },
    { kind: 'line', id: 'lower', title: 'Lower', color: '#2962ff' },
    { kind: 'line', id: 'mid', title: 'Basis', color: '#ff6d00', style: 'dotted' },
  ],
  signals: [
    { id: 'DC_BREAK_UP', dir: 'bull', description: 'New n-bar high' },
    { id: 'DC_BREAK_DOWN', dir: 'bear', description: 'New n-bar low' },
  ],
  init: (cfg) => ({ hi: extInit(cfg.length, true), lo: extInit(cfg.length, false) }),
  update(_cfg, s, x, w) {
    const i = w.i;
    const prevHi = extFull(s.hi) ? s.hi.val[s.hi.head] : NaN;
    const prevLo = extFull(s.lo) ? s.lo.val[s.lo.head] : NaN;
    const h = extPush(s.hi, x.h[i]);
    const l = extPush(s.lo, x.l[i]);
    if (!extFull(s.hi)) return;
    w.line(0, h);
    w.line(1, l);
    w.line(2, (h + l) / 2);
    if (x.h[i] > prevHi) w.signal('DC_BREAK_UP', 'bull', x.h[i]);
    if (x.l[i] < prevLo) w.signal('DC_BREAK_DOWN', 'bear', x.l[i]);
  },
});

// ── Supertrend ─────────────────────────────────────────────────────────────
export const supertrend = defineStudy(z.object({ atrLength: int(10, 1, 500, { title: 'ATR length' }), mult: num(3, 0.1, 20, { title: 'Factor' }) }), {
  id: 'supertrend',
  name: 'Supertrend',
  shortName: 'ST',
  version: '1.0.0',
  category: 'Trend',
  description: 'ATR trailing stop that flips with the trend.',
  overlay: true,
  outputs: () => [
    { kind: 'line', id: 'up', title: 'Up trend', color: 'bull', width: 2 },
    { kind: 'line', id: 'down', title: 'Down trend', color: 'bear', width: 2 },
  ],
  signals: [
    { id: 'ST_FLIP_UP', dir: 'bull', description: 'Supertrend flips up' },
    { id: 'ST_FLIP_DOWN', dir: 'bear', description: 'Supertrend flips down' },
  ],
  init: (cfg) => ({ atr: rmaInit(cfg.atrLength), up: NaN, dn: NaN, dir: 1 }),
  update(cfg, s, x, w) {
    const i = w.i;
    const a = emaPush(s.atr, tr(x, i));
    if (!Number.isFinite(a)) return;
    const hl2 = (x.h[i] + x.l[i]) / 2;
    let up = hl2 - cfg.mult * a;
    let dn = hl2 + cfg.mult * a;
    const c1 = i > 0 ? x.c[i - 1] : x.c[i];
    if (Number.isFinite(s.up) && c1 > s.up) up = Math.max(up, s.up);
    if (Number.isFinite(s.dn) && c1 < s.dn) dn = Math.min(dn, s.dn);
    let dir = s.dir;
    if (dir < 0 && Number.isFinite(s.dn) && x.c[i] > s.dn) dir = 1;
    else if (dir > 0 && Number.isFinite(s.up) && x.c[i] < s.up) dir = -1;
    if (dir !== s.dir) w.signal(dir > 0 ? 'ST_FLIP_UP' : 'ST_FLIP_DOWN', dir > 0 ? 'bull' : 'bear', x.c[i]);
    s.up = up;
    s.dn = dn;
    s.dir = dir;
    w.line(0, dir > 0 ? up : NaN);
    w.line(1, dir < 0 ? dn : NaN);
  },
});

// ── Parabolic SAR ──────────────────────────────────────────────────────────
export const psar = defineStudy(z.object({ start: num(0.02, 0.001, 1, { title: 'Start', step: 0.001 }), step: num(0.02, 0.001, 1, { title: 'Increment', step: 0.001 }), max: num(0.2, 0.01, 1, { title: 'Max', step: 0.01 }) }), {
  id: 'psar',
  name: 'Parabolic SAR',
  shortName: 'SAR',
  version: '1.0.0',
  category: 'Trend',
  description: 'Stop-and-reverse points that accelerate with the trend.',
  overlay: true,
  outputs: () => [{ kind: 'line', id: 'sar', title: 'SAR', color: '#26c6da', render: 'dots', width: 2 }],
  signals: [
    { id: 'SAR_FLIP_UP', dir: 'bull', description: 'SAR flips below price' },
    { id: 'SAR_FLIP_DOWN', dir: 'bear', description: 'SAR flips above price' },
  ],
  init: () => ({ sar: NaN, ep: NaN, af: 0, long: true, init: false }),
  update(cfg, s, x, w) {
    const i = w.i;
    if (i === 0) return;
    if (!s.init) {
      s.long = x.c[i] >= x.c[i - 1];
      s.sar = s.long ? Math.min(x.l[i - 1], x.l[i]) : Math.max(x.h[i - 1], x.h[i]);
      s.ep = s.long ? x.h[i] : x.l[i];
      s.af = cfg.start;
      s.init = true;
      w.line(0, s.sar);
      return;
    }
    let sar = s.sar + s.af * (s.ep - s.sar);
    if (s.long) {
      sar = Math.min(sar, x.l[i - 1], i > 1 ? x.l[i - 2] : x.l[i - 1]);
      if (x.l[i] < sar) {
        s.long = false;
        sar = s.ep;
        s.ep = x.l[i];
        s.af = cfg.start;
        w.signal('SAR_FLIP_DOWN', 'bear', x.c[i]);
      } else if (x.h[i] > s.ep) {
        s.ep = x.h[i];
        s.af = Math.min(cfg.max, s.af + cfg.step);
      }
    } else {
      sar = Math.max(sar, x.h[i - 1], i > 1 ? x.h[i - 2] : x.h[i - 1]);
      if (x.h[i] > sar) {
        s.long = true;
        sar = s.ep;
        s.ep = x.h[i];
        s.af = cfg.start;
        w.signal('SAR_FLIP_UP', 'bull', x.c[i]);
      } else if (x.l[i] < s.ep) {
        s.ep = x.l[i];
        s.af = Math.min(cfg.max, s.af + cfg.step);
      }
    }
    s.sar = sar;
    w.line(0, sar);
  },
});

// ── ADX / DMI ──────────────────────────────────────────────────────────────
export const adx = defineStudy(z.object({ length: int(14, 1, 200, { title: 'DI length' }), smoothing: int(14, 1, 200, { title: 'ADX smoothing' }) }), {
  id: 'adx',
  name: 'ADX / DMI',
  shortName: 'ADX',
  version: '1.0.0',
  category: 'Trend',
  description: 'Directional movement (+DI/−DI) and the average directional index.',
  overlay: false,
  outputs: () => [
    { kind: 'line', id: 'adx', title: 'ADX', color: '#ff9800', width: 2 },
    { kind: 'line', id: 'pdi', title: '+DI', color: 'bull' },
    { kind: 'line', id: 'ndi', title: '−DI', color: 'bear' },
    { kind: 'hline', id: 'trend', title: 'Trend threshold', value: 25, color: 'muted', style: 'dashed' },
  ],
  signals: [
    { id: 'DMI_CROSS_UP', dir: 'bull', description: '+DI crosses above −DI' },
    { id: 'DMI_CROSS_DOWN', dir: 'bear', description: '−DI crosses above +DI' },
  ],
  init: (cfg) => ({ tr: rmaInit(cfg.length), pdm: rmaInit(cfg.length), ndm: rmaInit(cfg.length), adx: rmaInit(cfg.smoothing), pd: NaN }),
  update(_cfg, s, x, w) {
    const i = w.i;
    if (i === 0) return;
    const up = x.h[i] - x.h[i - 1];
    const dn = x.l[i - 1] - x.l[i];
    const pdm = up > dn && up > 0 ? up : 0;
    const ndm = dn > up && dn > 0 ? dn : 0;
    const t = emaPush(s.tr, tr(x, i));
    const p = emaPush(s.pdm, pdm);
    const n = emaPush(s.ndm, ndm);
    if (!Number.isFinite(t) || t === 0) return;
    const pdi = (100 * p) / t;
    const ndi = (100 * n) / t;
    const dx = pdi + ndi > 0 ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0;
    const a = emaPush(s.adx, dx);
    w.line(0, a);
    w.line(1, pdi);
    w.line(2, ndi);
    if (Number.isFinite(s.pd)) {
      if (s.pd <= 0 && pdi - ndi > 0) w.signal('DMI_CROSS_UP', 'bull', x.c[i]);
      if (s.pd >= 0 && pdi - ndi < 0) w.signal('DMI_CROSS_DOWN', 'bear', x.c[i]);
    }
    s.pd = pdi - ndi;
  },
});

// ── Historical Volatility ──────────────────────────────────────────────────
export const historicalVolatility = defineStudy(z.object({ length: int(20, 2, 500, { title: 'Length' }), calendar: choice(['equity', '24x7'] as const, 'equity', { title: 'Annualization calendar' }) }), {
  id: 'hv',
  name: 'Historical Volatility',
  shortName: 'HV',
  version: '1.0.0',
  category: 'Volatility',
  description: 'Annualized standard deviation of log returns (%).',
  overlay: false,
  outputs: () => [{ kind: 'line', id: 'hv', title: 'HV %', color: '#7e57c2', width: 2 }],
  init: (cfg) => ({ st: statInit(cfg.length) }),
  update(cfg, s, x, w) {
    const i = w.i;
    if (i === 0) return;
    statPush(s.st, Math.log(x.c[i] / x.c[i - 1]));
    if (!statFull(s.st)) return;
    const DAY = 86_400_000;
    const iv = x.intervalMs > 0 ? x.intervalMs : DAY;
    const perYear = cfg.calendar === '24x7' ? (365 * DAY) / iv : iv >= DAY ? (252 * DAY) / iv : (252 * 6.5 * 3_600_000) / iv;
    w.line(0, 100 * statStd(s.st, true) * Math.sqrt(perYear));
  },
});

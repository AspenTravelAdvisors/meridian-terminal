import { z } from 'zod';
import { type Extreme, type Ring, extFull, extInit, extPush, ringAgo, ringInit, ringPush } from '../core/rolling';
import { bool, int } from '../core/params';
import type { Geometry, StudyDef, StudyStatus } from '../core/types';

export const ichimokuSchema = z.object({
  tenkan: int(9, 1, 200, { title: 'Tenkan (conversion)' }),
  kijun: int(26, 1, 300, { title: 'Kijun (base)' }),
  senkouB: int(52, 1, 500, { title: 'Senkou B' }),
  displacement: int(26, 1, 300, { title: 'Displacement' }),
  flatKijunBars: int(5, 2, 100, { title: 'Flat Kijun “magnet” after N bars', group: 'Signals' }),
  timeTheory: bool(false, { title: 'Time-theory markers from the latest swing', group: 'Time theory' }),
  timePivotLookback: int(52, 5, 500, { title: 'Time-theory pivot lookback', group: 'Time theory' }),
});
export type IchimokuCfg = z.infer<typeof ichimokuSchema>;

interface IchiState {
  hT: Extreme;
  lT: Extreme;
  hK: Extreme;
  lK: Extreme;
  hB: Extreme;
  lB: Extreme;
  /** senkou A/B values computed at past bars (index offset by displacement gives the cloud at "now") */
  spanA: Ring;
  spanB: Ring;
  prevTK: number;
  prevKumoSign: number;
  prevAbove: number;
  kijunFlat: number;
  prevKijun: number;
  tenkan: number;
  kijun: number;
  cloudTop: number;
  cloudBot: number;
}

const mid = (h: Extreme, l: Extreme) => (extFull(h) ? (h.val[h.head] + l.val[l.head]) / 2 : NaN);

export const ichimoku: StudyDef<IchimokuCfg, IchiState> = {
  id: 'ichimoku',
  name: 'Ichimoku Kinko Hyo',
  shortName: 'Ichimoku',
  version: '1.0.0',
  category: 'Ichimoku',
  description:
    'Tenkan, Kijun, Senkou A/B cloud projected forward and the Chikou span plotted back, with TK-cross strength by cloud position, cloud breakouts, Kumo twists and flat-Kijun detection.',
  overlay: true,
  schema: ichimokuSchema,
  presets: {
    'Classic 9/26/52': { tenkan: 9, kijun: 26, senkouB: 52, displacement: 26 },
    'Crypto 20/60/120': { tenkan: 20, kijun: 60, senkouB: 120, displacement: 30 },
  },
  outputs: (cfg) => [
    { kind: 'line', id: 'tenkan', title: 'Tenkan', color: '#2196f3', width: 1 },
    { kind: 'line', id: 'kijun', title: 'Kijun', color: '#b71c1c', width: 2 },
    { kind: 'line', id: 'senkouA', title: 'Senkou A', color: 'bull', width: 1, offset: cfg.displacement },
    { kind: 'line', id: 'senkouB', title: 'Senkou B', color: 'bear', width: 1, offset: cfg.displacement },
    { kind: 'cloud', id: 'kumo', title: 'Kumo', a: 'senkouA', b: 'senkouB', upColor: 'bull', downColor: 'bear', offset: cfg.displacement },
    { kind: 'line', id: 'chikou', title: 'Chikou', color: '#7e57c2', width: 1, offset: -cfg.displacement },
  ],
  signals: [
    { id: 'ICHI_TK_CROSS_BULL_STRONG', dir: 'bull', description: 'Bullish TK cross above the cloud' },
    { id: 'ICHI_TK_CROSS_BULL_NEUTRAL', dir: 'bull', description: 'Bullish TK cross inside the cloud' },
    { id: 'ICHI_TK_CROSS_BULL_WEAK', dir: 'bull', description: 'Bullish TK cross below the cloud' },
    { id: 'ICHI_TK_CROSS_BEAR_STRONG', dir: 'bear', description: 'Bearish TK cross below the cloud' },
    { id: 'ICHI_TK_CROSS_BEAR_NEUTRAL', dir: 'bear', description: 'Bearish TK cross inside the cloud' },
    { id: 'ICHI_TK_CROSS_BEAR_WEAK', dir: 'bear', description: 'Bearish TK cross above the cloud' },
    { id: 'ICHI_CLOUD_BREAK_UP', dir: 'bull', description: 'Close breaks above the cloud' },
    { id: 'ICHI_CLOUD_BREAK_DOWN', dir: 'bear', description: 'Close breaks below the cloud' },
    { id: 'ICHI_KUMO_TWIST_BULL', dir: 'bull', description: 'Future cloud turns bullish' },
    { id: 'ICHI_KUMO_TWIST_BEAR', dir: 'bear', description: 'Future cloud turns bearish' },
    { id: 'ICHI_CHIKOU_CROSS_UP', dir: 'bull', description: 'Chikou crosses above price' },
    { id: 'ICHI_CHIKOU_CROSS_DOWN', dir: 'bear', description: 'Chikou crosses below price' },
    { id: 'ICHI_KIJUN_FLAT', dir: 'neutral', description: 'Kijun flat (price magnet)' },
  ],
  init: (cfg) => ({
    hT: extInit(cfg.tenkan, true),
    lT: extInit(cfg.tenkan, false),
    hK: extInit(cfg.kijun, true),
    lK: extInit(cfg.kijun, false),
    hB: extInit(cfg.senkouB, true),
    lB: extInit(cfg.senkouB, false),
    spanA: ringInit(cfg.displacement + 1),
    spanB: ringInit(cfg.displacement + 1),
    prevTK: 0,
    prevKumoSign: 0,
    prevAbove: 0,
    kijunFlat: 0,
    prevKijun: NaN,
    tenkan: NaN,
    kijun: NaN,
    cloudTop: NaN,
    cloudBot: NaN,
  }),
  update(cfg, st, x, w) {
    const i = w.i;
    extPush(st.hT, x.h[i]);
    extPush(st.lT, x.l[i]);
    extPush(st.hK, x.h[i]);
    extPush(st.lK, x.l[i]);
    extPush(st.hB, x.h[i]);
    extPush(st.lB, x.l[i]);
    const ten = mid(st.hT, st.lT);
    const kij = mid(st.hK, st.lK);
    const sa = (ten + kij) / 2;
    const sb = mid(st.hB, st.lB);
    ringPush(st.spanA, sa);
    ringPush(st.spanB, sb);
    st.tenkan = ten;
    st.kijun = kij;
    w.line(0, ten);
    w.line(1, kij);
    w.line(2, sa);
    w.line(3, sb);
    w.line(4, x.c[i]); // chikou: today's close, drawn displacement bars back by the renderer

    // the cloud *at bar i* was computed `displacement` bars ago
    const ca = ringAgo(st.spanA, cfg.displacement);
    const cb = ringAgo(st.spanB, cfg.displacement);
    const top = Math.max(ca, cb);
    const bot = Math.min(ca, cb);
    st.cloudTop = top;
    st.cloudBot = bot;
    const c = x.c[i];
    const pos = !Number.isFinite(top) ? 0 : c > top ? 1 : c < bot ? -1 : 0; // vs cloud

    // TK cross, classified by where it happens relative to the cloud
    const tk = Number.isFinite(ten) && Number.isFinite(kij) ? Math.sign(ten - kij) : 0;
    if (st.prevTK !== 0 && tk !== 0 && tk !== st.prevTK && Number.isFinite(top)) {
      const where = Math.max(ten, kij) > top && Math.min(ten, kij) > top ? 1 : Math.max(ten, kij) < bot ? -1 : 0;
      const bull = tk > 0;
      const strength = bull ? (where > 0 ? 'STRONG' : where < 0 ? 'WEAK' : 'NEUTRAL') : where < 0 ? 'STRONG' : where > 0 ? 'WEAK' : 'NEUTRAL';
      w.signal(`ICHI_TK_CROSS_${bull ? 'BULL' : 'BEAR'}_${strength}`, bull ? 'bull' : 'bear', c, strength.toLowerCase());
      w.marker({ i, text: bull ? 'TK↑' : 'TK↓', pos: bull ? 'below' : 'above', color: bull ? 'bull' : 'bear', row: 5, size: 1, style: strength === 'STRONG' ? 'solid' : 'muted', tooltip: `TK cross (${strength.toLowerCase()})` });
      if (w.inspecting) w.inspect('TK cross', true, `${bull ? 'bullish' : 'bearish'} · ${strength.toLowerCase()}`);
    }
    if (tk !== 0) st.prevTK = tk;

    // price/cloud breakouts
    if (pos !== 0 && pos !== st.prevAbove) {
      if (pos > 0 && st.prevAbove <= 0) w.signal('ICHI_CLOUD_BREAK_UP', 'bull', c);
      if (pos < 0 && st.prevAbove >= 0) w.signal('ICHI_CLOUD_BREAK_DOWN', 'bear', c);
    }
    st.prevAbove = pos;

    // Kumo twist in the FUTURE cloud (A vs B computed now)
    const ks = Number.isFinite(sa) && Number.isFinite(sb) ? Math.sign(sa - sb) : 0;
    if (st.prevKumoSign !== 0 && ks !== 0 && ks !== st.prevKumoSign) w.signal(ks > 0 ? 'ICHI_KUMO_TWIST_BULL' : 'ICHI_KUMO_TWIST_BEAR', ks > 0 ? 'bull' : 'bear', c);
    if (ks !== 0) st.prevKumoSign = ks;

    // Chikou vs price `displacement` bars ago (uses only past data)
    const d = cfg.displacement;
    if (i > d) {
      const now = c - x.c[i - d];
      const prev = x.c[i - 1] - x.c[i - 1 - d];
      if (now > 0 && prev <= 0) w.signal('ICHI_CHIKOU_CROSS_UP', 'bull', c);
      if (now < 0 && prev >= 0) w.signal('ICHI_CHIKOU_CROSS_DOWN', 'bear', c);
    }

    // flat Kijun
    if (Number.isFinite(kij) && kij === st.prevKijun) {
      st.kijunFlat++;
      if (st.kijunFlat === cfg.flatKijunBars - 1) w.signal('ICHI_KIJUN_FLAT', 'neutral', kij, `${cfg.flatKijunBars} bars`);
    } else st.kijunFlat = 0;
    st.prevKijun = kij;
  },
  geometry(cfg, _st, x) {
    if (!cfg.timeTheory || x.len < 3) return {};
    // pivot: most extreme high or low within the lookback window
    const from = Math.max(0, x.len - cfg.timePivotLookback);
    let hi = from;
    let lo = from;
    for (let k = from; k < x.len; k++) {
      if (x.h[k] > x.h[hi]) hi = k;
      if (x.l[k] < x.l[lo]) lo = k;
    }
    const p = Math.max(hi, lo);
    const g: Geometry = { timeMarks: [9, 17, 26, 33, 42, 65, 76].map((n) => ({ i: p + n, label: String(n) })) };
    return g;
  },
  status(_cfg, st, x): StudyStatus {
    const c = x.c[x.len - 1];
    const chips: StudyStatus['chips'] = [];
    if (Number.isFinite(st.cloudTop)) {
      if (c > st.cloudTop) chips.push({ text: 'Above cloud', dir: 'bull', strength: 0.5 });
      else if (c < st.cloudBot) chips.push({ text: 'Below cloud', dir: 'bear', strength: 0.5 });
      else chips.push({ text: 'In cloud', dir: 'neutral', strength: 0.3 });
    }
    if (Number.isFinite(st.tenkan) && Number.isFinite(st.kijun)) chips.push({ text: st.tenkan > st.kijun ? 'TK bull' : 'TK bear', dir: st.tenkan > st.kijun ? 'bull' : 'bear', strength: 0.3 });
    return { chips, values: { tenkan: st.tenkan, kijun: st.kijun, cloudTop: st.cloudTop, cloudBottom: st.cloudBot } };
  },
};

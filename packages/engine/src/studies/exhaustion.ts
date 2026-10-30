import { z } from 'zod';
import { sinkWriter } from '../core/mtf';
import { defineStudy, int, num } from '../core/params';
import { emaPush, rmaInit } from '../core/rolling';
import type { Geometry, StudyStatus, Writer } from '../core/types';
import { combo, comboSchema, newComboState } from './demark/combo';
import { tdLines } from './demark/lines';
import { propulsion } from './demark/propulsion';
import { newSequentialState, sequential, sequentialSchema } from './demark/sequential';
import { ichimoku } from './ichimoku';
import { tr } from './std/common';

const sink = sinkWriter();
function sub(i: number, provisional: boolean): typeof sink {
  sink.i = i;
  sink.provisional = provisional;
  sink.fired.length = 0;
  return sink;
}

const SEQ_DEFAULTS = sequentialSchema.parse({ showSetup: false, showCountdown: false, showTdst: false, showRisk: false });
const COMBO_DEFAULTS = comboSchema.parse({ showCountdown: false });
const ICHI_DEFAULTS = ichimoku.schema.parse({ timeTheory: false });
const TDL_DEFAULTS = tdLines.schema.parse({});
const PROP_DEFAULTS = propulsion.schema.parse({});

// ── Exhaustion Zone: WHERE a move is likely to exhaust ──────────────────────

export interface ZoneLevel {
  src: string;
  p: number;
  w: number;
}

/**
 * Densest band of height `width` among the levels at or below `ref` (and within `maxDist` of it), by total weight, among
 * bands holding at least `minCount` levels. Ties go to the band nearest `ref`. The sell side calls this in mirrored
 * (negated) prices.
 */
export function bestBand(levels: readonly ZoneLevel[], ref: number, width: number, maxDist: number, minCount = 1): { lo: number; hi: number; score: number; srcs: string[] } | null {
  const cand = levels.filter((l) => Number.isFinite(l.p) && l.w > 0 && l.p <= ref && ref - l.p <= maxDist).sort((a, b) => b.p - a.p || (a.src < b.src ? -1 : 1));
  let best: { lo: number; hi: number; score: number; srcs: string[] } | null = null;
  for (let j = 0; j < cand.length; j++) {
    const top = cand[j].p;
    let score = 0;
    let lo = top;
    const srcs: string[] = [];
    for (let k = j; k < cand.length && cand[k].p >= top - width; k++) {
      score += cand[k].w;
      lo = cand[k].p;
      srcs.push(cand[k].src);
    }
    if (srcs.length >= minCount && (!best || score > best.score)) best = { lo, hi: top, score, srcs };
  }
  return best;
}

const SOURCES = ['tdst', 'setupRisk', 'cdRisk', 'cloud', 'kijun', 'tdLines', 'propulsion'] as const;
type Source = (typeof SOURCES)[number];
const weight = (def: number, title: string) => num(def, 0, 10, { title, group: 'Level weights', step: 0.1 });

export const zoneSchema = z.object({
  wTdst: weight(2, 'TDST level (opposite setup)'),
  wSetupRisk: weight(1, 'Sequential setup risk level'),
  wCdRisk: weight(1.5, 'Sequential countdown risk level'),
  wCloud: weight(1, 'Ichimoku cloud edge'),
  wKijun: weight(0.5, 'Ichimoku Kijun'),
  wTdLines: weight(1, 'TD Lines breakout target'),
  wPropulsion: weight(1, 'Propulsion exhaustion target'),
  zoneAtr: num(1, 0.1, 10, { title: 'Zone height (×ATR)', step: 0.1, description: 'Levels within this distance of each other form one zone.' }),
  padAtr: num(0.25, 0, 5, { title: 'Zone padding (×ATR)', step: 0.05 }),
  maxDistAtr: num(15, 1, 100, { title: 'Ignore levels farther than (×ATR)', step: 1 }),
  minLevels: int(2, 1, 7, { title: 'Levels required for a zone' }),
});
export type ZoneCfg = z.infer<typeof zoneSchema>;

const W_KEY: Record<Source, keyof ZoneCfg> = { tdst: 'wTdst', setupRisk: 'wSetupRisk', cdRisk: 'wCdRisk', cloud: 'wCloud', kijun: 'wKijun', tdLines: 'wTdLines', propulsion: 'wPropulsion' };

interface ZoneSide {
  /** candidate level per source (SOURCES order), real prices; NaN = none on this side of the close */
  levels: number[];
  hi: number;
  lo: number;
  score: number;
  /** sources in the zone, one bit per SOURCES index */
  mask: number;
  testing: boolean;
  /** first bar of the current zone (it restarts when the zone appears or its set of levels changes) */
  since: number;
}
const newZoneSide = (): ZoneSide => ({ levels: SOURCES.map(() => NaN), hi: NaN, lo: NaN, score: 0, mask: 0, testing: false, since: -1 });

/** Bars the current zone is drawn past the last bar. */
const ZONE_AHEAD = 8;

interface ZoneState {
  seq: ReturnType<typeof newSequentialState>;
  ichi: ReturnType<typeof ichimoku.init>;
  tdl: ReturnType<typeof tdLines.init>;
  prop: ReturnType<typeof propulsion.init>;
  atr: ReturnType<typeof rmaInit>;
  atrNow: number;
  /** level weights in SOURCES order */
  wts: number[];
  sides: [ZoneSide, ZoneSide];
}

/** Fill side k's candidate levels (0 = buy: supports at or below the close; 1 = sell: resistances at or above it). */
function fillLevels(st: ZoneState, c: number, k: 0 | 1): void {
  const s = k === 0 ? 1 : -1;
  const own = st.seq.sides[k];
  const top = st.ichi.cloudTop;
  const bot = st.ichi.cloudBot;
  const lv = st.sides[k].levels;
  lv[0] = -s * st.seq.sides[1 - k].tdst;
  lv[1] = s * own.risk;
  lv[2] = s * own.cdRisk;
  // the cloud edge price would meet first: the top from above, the bottom from inside (mirrored for the sell side)
  lv[3] = k === 0 ? (c > top ? top : c >= bot ? bot : NaN) : c < bot ? bot : c <= top ? top : NaN;
  lv[4] = st.ichi.kijun;
  // TD Lines / Propulsion keep the downside objective on their mirrored side 1, the upside one on side 0
  lv[5] = -s * st.tdl.sides[1 - k].target;
  const prop = st.prop.sides[1 - k].active;
  lv[6] = prop ? -s * prop.target : NaN;
  for (let j = 0; j < lv.length; j++) if (!(s * lv[j] <= s * c)) lv[j] = NaN;
}

// alphabetical rank of each source: bestBand's tie-break for levels at the same price
const NAME_RANK = SOURCES.map((n) => [...SOURCES].sort().indexOf(n));
const ORDER = new Int32Array(SOURCES.length);
const BAND = { lo: NaN, hi: NaN, score: 0, mask: 0 };

/**
 * `bestBand` without allocation, for the per-bar update (at most 7 levels): same candidates, order and choice, in mirrored
 * prices `s × level`. The result is left in BAND (mask 0 = no band).
 */
function bandOf(levels: number[], wts: number[], s: number, ref: number, width: number, maxDist: number, minCount: number): void {
  let n = 0;
  for (let j = 0; j < levels.length; j++) {
    const p = s * levels[j];
    if (!Number.isFinite(p) || !(wts[j] > 0) || p > ref || ref - p > maxDist) continue;
    // insertion sort: price descending, then name
    let at = n++;
    while (at > 0) {
      const q = ORDER[at - 1];
      const pq = s * levels[q];
      if (pq > p || (pq === p && NAME_RANK[q] < NAME_RANK[j])) break;
      ORDER[at] = q;
      at--;
    }
    ORDER[at] = j;
  }
  BAND.mask = 0;
  BAND.score = 0;
  for (let a = 0; a < n; a++) {
    const top = s * levels[ORDER[a]];
    let score = 0;
    let lo = top;
    let mask = 0;
    let count = 0;
    for (let b = a; b < n; b++) {
      const p = s * levels[ORDER[b]];
      if (p < top - width) break;
      score += wts[ORDER[b]];
      lo = p;
      mask |= 1 << ORDER[b];
      count++;
    }
    if (count >= minCount && (BAND.mask === 0 || score > BAND.score)) {
      BAND.lo = lo;
      BAND.hi = top;
      BAND.score = score;
      BAND.mask = mask;
    }
  }
}

/** The zone's sources in bestBand order (price toward the close first, then name). */
function zoneSources(side: ZoneSide, s: number): string[] {
  return SOURCES.filter((_, j) => side.mask & (1 << j))
    .map((src) => ({ src, p: s * side.levels[SOURCES.indexOf(src)] }))
    .sort((a, b) => b.p - a.p || (a.src < b.src ? -1 : 1))
    .map((x) => x.src);
}

const bits = (m: number) => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};

export const exhaustionZone = defineStudy(zoneSchema, {
  id: 'meridian-zone',
  name: 'Exhaustion Zone',
  shortName: 'Zone',
  version: '1.0.0',
  category: 'Meridian',
  description:
    'WHERE a move is likely to exhaust: the densest band of support below price (buy zone) and resistance above it (sell zone), built from TDST, Sequential risk levels, the Ichimoku cloud and Kijun, and TD Lines / Propulsion targets. A map of levels, not a forecast.',
  overlay: true,
  outputs: () => [
    // the zone on every past bar: off by default (the current zones are drawn as geometry); turn on under Style
    { kind: 'line', id: 'buy_hi', title: 'Buy zone top (history)', color: 'bull', render: 'step', style: 'dotted', width: 1, hiddenByDefault: true },
    { kind: 'line', id: 'buy_lo', title: 'Buy zone bottom (history)', color: 'bull', render: 'step', style: 'dotted', width: 1, hiddenByDefault: true },
    { kind: 'cloud', id: 'buy_zone', title: 'Buy zone (history)', a: 'buy_hi', b: 'buy_lo', upColor: 'bull', downColor: 'bull', hiddenByDefault: true },
    { kind: 'line', id: 'sell_hi', title: 'Sell zone top (history)', color: 'bear', render: 'step', style: 'dotted', width: 1, hiddenByDefault: true },
    { kind: 'line', id: 'sell_lo', title: 'Sell zone bottom (history)', color: 'bear', render: 'step', style: 'dotted', width: 1, hiddenByDefault: true },
    { kind: 'cloud', id: 'sell_zone', title: 'Sell zone (history)', a: 'sell_hi', b: 'sell_lo', upColor: 'bear', downColor: 'bear', hiddenByDefault: true },
    { kind: 'data', id: 'buy_score', title: 'Buy zone weight' },
    { kind: 'data', id: 'sell_score', title: 'Sell zone weight' },
  ],
  signals: [
    { id: 'ZONE_BUY_TEST', dir: 'bull', description: 'Price traded down into the buy exhaustion zone' },
    { id: 'ZONE_SELL_TEST', dir: 'bear', description: 'Price traded up into the sell exhaustion zone' },
  ],
  init: (cfg): ZoneState => ({
    seq: newSequentialState(),
    ichi: ichimoku.init(ICHI_DEFAULTS),
    tdl: tdLines.init(TDL_DEFAULTS),
    prop: propulsion.init(PROP_DEFAULTS),
    atr: rmaInit(14),
    atrNow: NaN,
    wts: SOURCES.map((src) => cfg[W_KEY[src]] as number),
    sides: [newZoneSide(), newZoneSide()],
  }),
  update(cfg, st, x, w: Writer, intra) {
    const i = w.i;
    sequential.update(SEQ_DEFAULTS, st.seq, x, sub(i, w.provisional), intra);
    ichimoku.update(ICHI_DEFAULTS, st.ichi, x, sub(i, w.provisional), intra);
    tdLines.update(TDL_DEFAULTS, st.tdl, x, sub(i, w.provisional), intra);
    propulsion.update(PROP_DEFAULTS, st.prop, x, sub(i, w.provisional), intra);
    const atr = emaPush(st.atr, tr(x, i));
    st.atrNow = atr;
    const c = x.c[i];
    const ok = Number.isFinite(atr) && atr > 0;
    const pad = cfg.padAtr * atr;
    for (let k: 0 | 1 = 0; k < 2; k = (k + 1) as 0 | 1) {
      const side = st.sides[k];
      const s = k === 0 ? 1 : -1;
      // a test is the bar trading into the zone the PREVIOUS bar drew
      const into = Number.isFinite(side.hi) && (k === 0 ? x.l[i] <= side.hi : x.h[i] >= side.lo);
      if (into && !side.testing) w.signal(k === 0 ? 'ZONE_BUY_TEST' : 'ZONE_SELL_TEST', k === 0 ? 'bull' : 'bear', k === 0 ? side.hi : side.lo, `${bits(side.mask)} levels`);
      side.testing = into;
      fillLevels(st, c, k);
      if (ok) bandOf(side.levels, st.wts, s, s * c, cfg.zoneAtr * atr, cfg.maxDistAtr * atr, cfg.minLevels);
      if (ok && BAND.mask) {
        if (!Number.isFinite(side.hi) || BAND.mask !== side.mask) side.since = i;
        // mirrored band → real prices: the buy side keeps hi/lo, the sell side swaps them
        side.hi = k === 0 ? BAND.hi + pad : -(BAND.lo - pad);
        side.lo = k === 0 ? BAND.lo - pad : -(BAND.hi + pad);
        side.score = BAND.score;
        side.mask = BAND.mask;
      } else {
        side.hi = NaN;
        side.lo = NaN;
        side.score = 0;
        side.mask = 0;
        side.since = -1;
      }
      w.line(k * 2, side.hi);
      w.line(k * 2 + 1, side.lo);
      if (w.inspecting)
        SOURCES.forEach((src, j) => w.inspect(`${k === 0 ? 'Buy' : 'Sell'} · ${src}`, (side.mask & (1 << j)) !== 0, Number.isFinite(side.levels[j]) ? side.levels[j].toPrecision(6) : '—'));
    }
    w.line(4, st.sides[0].score);
    w.line(5, st.sides[1].score);
  },
  geometry(_cfg, st, x): Geometry {
    const last = x.len - 1;
    const segments: NonNullable<Geometry['segments']> = [];
    st.sides.forEach((side, k) => {
      if (!Number.isFinite(side.hi)) return;
      const color = k === 0 ? 'bull' : 'bear';
      const name = `${k === 0 ? 'Buy' : 'Sell'} zone (${bits(side.mask)})`;
      // the label goes on the edge price meets first: the top of a buy zone, the bottom of a sell zone
      segments.push(
        { i1: side.since, p1: side.hi, i2: last + ZONE_AHEAD, p2: side.hi, color, style: 'dashed', width: 2, label: k === 0 ? name : undefined },
        { i1: side.since, p1: side.lo, i2: last + ZONE_AHEAD, p2: side.lo, color, style: 'dashed', width: 2, label: k === 1 ? name : undefined },
      );
    });
    return { segments };
  },
  status(_cfg, st): StudyStatus {
    const chips: StudyStatus['chips'] = [];
    const values: Record<string, number | string | null> = { atr: st.atrNow };
    const f = (v: number) => (Number.isFinite(v) ? v : null);
    st.sides.forEach((side, k) => {
      const name = k === 0 ? 'buy' : 'sell';
      const n = bits(side.mask);
      if (Number.isFinite(side.hi)) chips.push({ text: `${k === 0 ? 'Buy' : 'Sell'} zone ${side.lo.toPrecision(5)}–${side.hi.toPrecision(5)} (${n})`, dir: k === 0 ? 'bull' : 'bear', strength: Math.min(1, n / 4) });
      values[`${name}Hi`] = f(side.hi);
      values[`${name}Lo`] = f(side.lo);
      values[`${name}Score`] = side.score;
      values[`${name}Levels`] = n;
      values[`${name}Sources`] = zoneSources(side, k === 0 ? 1 : -1).join(',');
      SOURCES.forEach((src, j) => (values[`${name}.${src}`] = f(side.levels[j])));
    });
    SOURCES.forEach((src, j) => (values[`w.${src}`] = st.wts[j]));
    return { chips, values };
  },
});

// ── Exhaustion Window: WHEN a setup 9 or countdown 13 can complete ──────────

/**
 * Bars until a countdown can reach `n`: the earliest (every bar qualifies) and an estimate at the rate seen so far
 * (`count` qualifying bars since `startI`, floored at `minRate`). A pending final bar is always at least one bar away.
 */
export function countdownEta(count: number, startI: number, i: number, n: number, minRate: number): [number, number] {
  const left = Math.max(1, n - count);
  const rate = Math.max(minRate, count / (i - startI + 1));
  return [left, Math.max(left, Math.ceil(left / rate - 1e-9))];
}

export const windowSchema = z.object({
  minRate: num(0.25, 0.05, 1, { title: 'Slowest assumed countdown rate (bars counted per bar)', step: 0.05 }),
  nearBars: int(3, 0, 20, { title: 'Signal when a 13 is this many bars away' }),
});
export type WindowCfg = z.infer<typeof windowSchema>;

interface WindowSide {
  /** bars ahead: setup 9, Sequential 13 earliest / estimate, Combo 13 earliest / estimate (NaN = not in progress) */
  eta: [number, number, number, number, number];
  near: boolean;
}

interface WindowState {
  seq: ReturnType<typeof newSequentialState>;
  combo: ReturnType<typeof newComboState>;
  sides: [WindowSide, WindowSide];
  last: number;
}

export const exhaustionWindow = defineStudy(windowSchema, {
  id: 'meridian-window',
  name: 'Exhaustion Window',
  shortName: 'Window',
  version: '1.0.0',
  category: 'Meridian',
  description:
    'WHEN a setup 9 or countdown 13 can complete: the earliest bar (every bar counts) and an estimate at the countdown’s own pace so far, drawn as time marks past the last bar for Sequential and Combo, both sides.',
  overlay: true,
  outputs: () =>
    (['buy', 'sell'] as const).flatMap((n) => [
      { kind: 'data' as const, id: `${n}9`, title: `Bars to ${n} setup 9` },
      { kind: 'data' as const, id: `${n}13_min`, title: `Bars to ${n} 13 (earliest)` },
      { kind: 'data' as const, id: `${n}13_est`, title: `Bars to ${n} 13 (estimate)` },
      { kind: 'data' as const, id: `c${n}13_min`, title: `Bars to Combo ${n} 13 (earliest)` },
      { kind: 'data' as const, id: `c${n}13_est`, title: `Bars to Combo ${n} 13 (estimate)` },
    ]),
  signals: [
    { id: 'WINDOW_BUY_NEAR', dir: 'bull', description: 'A buy countdown 13 (Sequential or Combo) is within reach' },
    { id: 'WINDOW_SELL_NEAR', dir: 'bear', description: 'A sell countdown 13 (Sequential or Combo) is within reach' },
  ],
  init: (): WindowState => ({
    seq: newSequentialState(),
    combo: newComboState(),
    sides: [
      { eta: [NaN, NaN, NaN, NaN, NaN], near: false },
      { eta: [NaN, NaN, NaN, NaN, NaN], near: false },
    ],
    last: -1,
  }),
  update(cfg, st, x, w, intra) {
    const i = w.i;
    sequential.update(SEQ_DEFAULTS, st.seq, x, sub(i, w.provisional), intra);
    combo.update(COMBO_DEFAULTS, st.combo, x, sub(i, w.provisional), intra);
    st.last = i;
    for (const k of [0, 1] as const) {
      const sq = st.seq.sides[k];
      const cb = st.combo.sides[k].cd;
      const side = st.sides[k];
      const L = SEQ_DEFAULTS.setupLength;
      const s9 = sq.su.count > 0 && sq.su.count < L ? L - sq.su.count : NaN;
      const [q1, q2] = sq.cd.active ? countdownEta(sq.cd.count, sq.cd.startI, i, SEQ_DEFAULTS.countdownLength, cfg.minRate) : [NaN, NaN];
      const [c1, c2] = cb.active ? countdownEta(cb.count, cb.startI, i, COMBO_DEFAULTS.countdownLength, cfg.minRate) : [NaN, NaN];
      side.eta = [s9, q1, q2, c1, c2];
      side.eta.forEach((v, j) => w.line(k * 5 + j, v));
      // edge-triggered: one signal per approach, naming the count that is nearest
      const seqNear = q1 <= cfg.nearBars;
      const comboNear = c1 <= cfg.nearBars;
      const near = seqNear || comboNear;
      if (near && !side.near) {
        const useCombo = comboNear && !(seqNear && q1 <= c1);
        w.signal(k === 0 ? 'WINDOW_BUY_NEAR' : 'WINDOW_SELL_NEAR', k === 0 ? 'bull' : 'bear', x.c[i], `${useCombo ? 'Combo' : 'Seq'} 13 in ≥${useCombo ? c1 : q1} bars`);
      }
      side.near = near;
      if (w.inspecting) w.inspect(`${k === 0 ? 'Buy' : 'Sell'} · bars to 9 / Seq 13 / Combo 13`, near, side.eta.map((v) => (Number.isFinite(v) ? v : '—')).join(' / '));
    }
  },
  geometry(_cfg, st): Geometry {
    const marks: NonNullable<Geometry['timeMarks']> = [];
    st.sides.forEach((side, k) => {
      const B = k === 0 ? 'B' : 'S';
      const main = k === 0 ? 'bull' : 'bear';
      const alt = k === 0 ? 'bullAlt' : 'bearAlt';
      const [s9, q1, q2, c1, c2] = side.eta;
      if (Number.isFinite(s9)) marks.push({ i: st.last + s9, label: `${B}9`, color: main });
      const pair = (a: number, b: number, name: string, color: typeof main | typeof alt) => {
        if (!Number.isFinite(a)) return;
        if (a === b) marks.push({ i: st.last + a, label: name, color });
        else marks.push({ i: st.last + a, label: `${name} earliest`, color }, { i: st.last + b, label: `${name} est.`, color });
      };
      pair(q1, q2, `${B}13`, main);
      pair(c1, c2, `Combo ${B}13`, alt);
    });
    return { timeMarks: marks };
  },
  status(_cfg, st): StudyStatus {
    const chips: StudyStatus['chips'] = [];
    const values: Record<string, number | null> = {};
    const f = (v: number) => (Number.isFinite(v) ? v : null);
    st.sides.forEach((side, k) => {
      const n = k === 0 ? 'buy' : 'sell';
      const [s9, q1, q2, c1, c2] = side.eta;
      Object.assign(values, { [`${n}9`]: f(s9), [`${n}13Min`]: f(q1), [`${n}13Est`]: f(q2), [`combo${n}13Min`]: f(c1), [`combo${n}13Est`]: f(c2) });
      const soonest = Math.min(...[q1, c1].filter(Number.isFinite));
      if (Number.isFinite(soonest)) chips.push({ text: `${k === 0 ? 'Buy' : 'Sell'} 13 in ≥${soonest}`, dir: k === 0 ? 'bull' : 'bear', strength: 1 / (1 + soonest / 4) });
      else if (Number.isFinite(s9)) chips.push({ text: `${k === 0 ? 'Buy' : 'Sell'} 9 in ${s9}`, dir: k === 0 ? 'bull' : 'bear', strength: 0.3 });
    });
    return { chips, values };
  },
});

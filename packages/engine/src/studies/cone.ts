import { z } from 'zod';
import { sinkWriter } from '../core/mtf';
import { bool, defineStudy, int, num } from '../core/params';
import type { Fan, Geometry, GhostBar, SeriesCtx, StudyStatus } from '../core/types';
import { f } from './demark/common';
import { demarker1 } from './demark/oscillators';
import { newSequentialState, sequential, sequentialSchema } from './demark/sequential';
import { ichimoku } from './ichimoku';

// ── Forward Cone: the range of outcomes that followed bars like this one ────
//
// Every closed bar is filed under the state it was in (count phase, cloud position, DeM I zone). Once a bar's next
// `horizon` bars are known, its moves over 1…horizon bars, measured in units of the volatility at that bar, are added to
// that state's histograms. A forecast for the newest bar reads the quantiles of the histograms of ITS state and scales
// them by ITS volatility. Nothing is fitted and nothing is extrapolated: the cone is what happened after similar bars.
//
// No look-ahead: an outcome enters a histogram on the bar that completes it, so the forecast on bar i only ever holds
// moves that had ended by bar i. Per bar the work is `horizon` histogram increments plus one quantile read: O(1).

const sink = sinkWriter();
function sub(i: number, provisional: boolean): typeof sink {
  sink.i = i;
  sink.provisional = provisional;
  sink.fired.length = 0;
  return sink;
}

const SEQ = sequentialSchema.parse({ showSetup: false, showCountdown: false, showTdst: false, showRisk: false });
const ICHI = ichimoku.schema.parse({ timeTheory: false });
const DEM = demarker1.schema.parse({});

/** Histogram of z ÷ √h over [−4, 4): 160 bins of 0.05. Moves beyond ±4σ√h land in the end bins. */
export const CONE_BINS = 160;
export const CONE_BIN_WIDTH = 0.05;
const ZMAX = 4;
const QS = [0.1, 0.25, 0.5, 0.75, 0.9] as const;
const Q_LO80 = 0;
const Q_LO50 = 1;
const Q_MID = 2;
const Q_HI50 = 3;
const Q_HI80 = 4;

const MAX_H = 55;
const SQRT = Float64Array.from({ length: MAX_H + 1 }, (_, h) => Math.sqrt(h));
const INV_SQRT = Float64Array.from({ length: MAX_H + 1 }, (_, h) => (h ? 1 / Math.sqrt(h) : 0));

/** Keys: 108 (phase × cloud × DeM I) + 36 (phase × cloud) + 12 (phase) + 1 (all bars). */
const LEVEL_OFFSET = [0, 108, 144, 156] as const;
const KEYS = 157;
const BASE = 156;
/** Most recent matched bars kept per key, for the path statistics (trade levels, ghost candles). */
const RING = 150;
/** Fewest similar bars the trade levels are computed from. */
const MIN_PATHS = 5;

const PHASE_NAMES = [
  'no count in progress',
  'buy setup 5–8',
  'buy countdown 1–7',
  'buy setup 9 just completed',
  'buy countdown 8–12',
  'buy 13 just completed',
  'sell setup 5–8',
  'sell countdown 1–7',
  'sell setup 9 just completed',
  'sell countdown 8–12',
  'sell 13 just completed',
  'buy and sell counts overlapping',
];
const TREND_NAMES = ['below the cloud', 'inside the cloud', 'above the cloud'];
const MOM_NAMES = ['DeM I oversold', 'DeM I neutral', 'DeM I overbought'];

/**
 * Quantiles `ps` (ascending, 0–1) of one histogram row starting at `off`, written to `out` in units of z ÷ √h.
 * A quantile sits in the bin where the cumulative count reaches p × total, that fraction of the way through the bin.
 * Returns the row total (0 → every quantile is NaN); pass `known` when the caller already has it.
 */
export function histQuantiles(h: Uint32Array, off: number, ps: readonly number[], out: number[], known = -1): number {
  let total = known;
  if (total < 0) {
    total = 0;
    for (let b = 0; b < CONE_BINS; b++) total += h[off + b];
  }
  if (!total) {
    for (let q = 0; q < ps.length; q++) out[q] = NaN;
    return 0;
  }
  let cum = 0;
  let b = 0;
  for (let q = 0; q < ps.length; q++) {
    const target = ps[q] * total;
    while (b < CONE_BINS - 1 && cum + h[off + b] < target) cum += h[off + b++];
    const n = h[off + b];
    out[q] = -ZMAX + (b + (n > 0 ? Math.min(1, (target - cum) / n) : 0)) * CONE_BIN_WIDTH;
  }
  return total;
}

/**
 * One phase from the two sides' ranks (0 none, 1 setup 5–8, 2 countdown 1–7, 3 setup 9 just completed, 4 countdown 8–12,
 * 5 countdown 13 just completed): the side further along wins (buy 1–5, sell 6–10); equal non-zero ranks are 11.
 */
export function conePhase(buyRank: number, sellRank: number): number {
  if (buyRank === sellRank) return buyRank === 0 ? 0 : 11;
  return buyRank > sellRank ? buyRank : 5 + sellRank;
}

/** The four keys a bar is filed under, finest first: full state, phase × cloud, phase, all bars. */
export function coneKeys(phase: number, trend: number, mom: number): [number, number, number, number] {
  return [phase * 9 + trend * 3 + mom, LEVEL_OFFSET[1] + phase * 3 + trend, LEVEL_OFFSET[2] + phase, BASE];
}

type SeqSide = ReturnType<typeof newSequentialState>['sides'][number];
function sideRank(side: SeqSide, i: number, recentBars: number): number {
  if (side.lastCd13 >= 0 && i - side.lastCd13 <= SEQ.reactionBars) return 5;
  if (side.cd.active && side.cd.count >= 8) return 4;
  if (side.lastSetup9 >= 0 && i - side.lastSetup9 <= recentBars) return 3;
  if (side.cd.active && side.cd.count >= 1) return 2;
  if (side.su.count >= 5 && side.su.count < SEQ.setupLength) return 1;
  return 0;
}

export const coneSchema = z.object({
  horizon: int(21, 5, MAX_H, {
    title: 'Bars ahead',
    description: 'How far the cone reaches. 8, 13, 21 and 34 are presets; shorter horizons are narrower and are scored more often.',
  }),
  minSamples: int(30, 10, 1000, {
    title: 'Similar bars required',
    group: 'Matching',
    description: 'A state needs this many past bars with a known outcome; otherwise the match is loosened one step at a time, down to all bars.',
  }),
  minIndependent: int(5, 1, 100, {
    title: 'Non-overlapping cases required',
    group: 'Matching',
    description: 'Neighbouring bars share most of their next bars, so they are nearly one case. This counts only cases at least a full horizon apart.',
  }),
  shrink: num(10, 0, 200, {
    title: 'Caution (blend toward all bars)',
    group: 'Matching',
    step: 1,
    description: 'The matched range is blended with the all-bars range: weight = n ÷ (n + this), n = non-overlapping cases. 0 uses the matched cases alone.',
  }),
  recentBars: int(4, 1, 20, { title: 'A setup 9 counts as “just completed” for (bars)', group: 'Matching' }),
  volLength: int(21, 5, 200, { title: 'Volatility length', group: 'Matching', description: 'Moves are compared in units of recent volatility (average squared log return).' }),
  edge: num(0.1, 0.01, 0.5, {
    title: 'Lean threshold',
    group: 'Signals',
    step: 0.01,
    description: 'The share of similar bars that closed higher must differ from the all-bars share by at least this much (0.10 = 10 points) to call a lean.',
  }),
  confidence: num(2, 0, 5, {
    title: 'Lean must also clear (standard errors)',
    group: 'Signals',
    step: 0.1,
    description: 'The difference must exceed this many standard errors of a share measured on the non-overlapping cases, so a handful of cases cannot call a lean.',
  }),
  showLevels: bool(true, { title: 'Show target and stop when the cases lean', group: 'Display' }),
  showGhost: bool(false, { title: 'Show ghost candles (one similar past case, replayed)', group: 'Display' }),
  showSignalCone: bool(false, { title: 'Show the range drawn at the last lean signal', group: 'Display' }),
});
export type ConeCfg = z.infer<typeof coneSchema>;

interface ConeNow {
  ok: boolean;
  key: number;
  level: number;
  n: number;
  /** cases at least a horizon apart */
  independent: number;
  /** weight of the matched cases against all bars (1 = matched cases alone) */
  weight: number;
  pUp: number;
  baseUp: number;
  /** quantiles (QS order) of the horizon move, in units of volatility */
  z: number[];
  dir: number;
  sigma: number;
  phase: number;
  trend: number;
  mom: number;
}

interface ConeState {
  seq: ReturnType<typeof newSequentialState>;
  ichi: ReturnType<typeof ichimoku.init>;
  dem: ReturnType<typeof demarker1.init>;
  // volatility: mean squared log return (simple mean while warming up, exponential after)
  ewVar: number;
  nRet: number;
  prevLn: number;
  /** the last horizon + 1 bars (slot = i mod (horizon + 1)): four keys, volatility (NaN = unusable) and log close */
  rKeys: Int32Array;
  rSig: Float64Array;
  rLn: Float64Array;
  /** per key, allocated on first use: `horizon` rows of CONE_BINS counts (row h − 1 = moves over h bars) */
  hist: (Uint32Array | null)[];
  /** per key: bars with a known horizon outcome, how many closed higher, how many lie a horizon apart, and the last of those */
  cnt: Uint32Array;
  up: Uint32Array;
  ind: Uint32Array;
  lastInd: Int32Array;
  /** per key: ring of the most recent matched bars (index and volatility) */
  aIdx: Int32Array;
  aSig: Float64Array;
  aHead: Int32Array;
  aCnt: Int32Array;
  /** forecasts awaiting their outcome (slot = i mod horizon): 5 matched + 5 all-bars quantiles, match level + 1 (0 = none), lean */
  pQ: Float64Array;
  pOk: Int8Array;
  pDir: Int8Array;
  /** scored forecasts: n, inside 80%, inside 50%, matched n, matched loss, all-bars loss, lean calls, lean calls right */
  score: Float64Array;
  now: ConeNow;
  prevDir: number;
  /** the 80% range drawn at the last lean signal, as log prices per step (i = −1: none) */
  anchor: { i: number; dir: number; sigma: number; lo: Float64Array; hi: Float64Array };
  last: number;
}

const S_N = 0;
const S_IN80 = 1;
const S_IN50 = 2;
const S_NCOND = 3;
const S_LOSS = 4;
const S_LOSS_BASE = 5;
const S_CALLS = 6;
const S_HITS = 7;

/** Quantile (pinball) loss: the proper score for a quantile forecast. Lower is better. */
const pinball = (y: number, q: number, p: number) => (y >= q ? p * (y - q) : (1 - p) * (q - y));

// scratch (single-threaded; never stored in state)
const Q: number[] = [0, 0, 0, 0, 0];
const QB: number[] = [0, 0, 0, 0, 0];
const Q2: number[] = [0, 0];
const P_80 = [0.1, 0.9] as const;

const L_FWD_HI = 0;
const L_FWD_LO = 1;
const L_FWD_MID = 2;
const L_P_UP = 3;
const L_MED = 4;
const L_LO80 = 5;
const L_HI80 = 6;
const L_CASES = 7;
const L_MATCH = 8;
const L_DIR = 9;
const L_COVER = 10;
const L_SKILL = 11;

const pct = (v: number) => `${Math.round(100 * v)}%`;
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
const ret = (z: number, sigma: number) => 100 * (Math.exp(z * sigma) - 1);

function matchText(now: ConeNow): string {
  const p = PHASE_NAMES[now.phase];
  if (now.level === 0) return `${p} · ${TREND_NAMES[now.trend]} · ${MOM_NAMES[now.mom]}`;
  if (now.level === 1) return `${p} · ${TREND_NAMES[now.trend]}`;
  if (now.level === 2) return p;
  return 'all bars';
}

interface Trade {
  entry: number;
  target: number;
  stop: number;
  stopSrc: 'Seq risk' | 'cases';
  rr: number;
  hitTarget: number;
  hitStop: number;
  paths: number;
}

interface Projection {
  fan: Fan;
  ghosts: GhostBar[];
  trade: Trade | null;
}

/** nearest-rank quantile of an ascending array */
const rank = (sorted: Float64Array, p: number) => sorted[Math.round(p * (sorted.length - 1))];

/**
 * Everything drawn past the last bar: the fan from the matched state's histograms, and, from that state's most recent
 * matched bars (all of whose next `horizon` bars are already in the series), the trade levels and the ghost candles.
 */
function project(cfg: ConeCfg, st: ConeState, x: SeriesCtx): Projection | null {
  const now = st.now;
  if (!now.ok) return null;
  const H = cfg.horizon;
  const i0 = st.last;
  const c = x.c[i0];
  const sg = now.sigma;
  const hk = st.hist[now.key];
  const hb = st.hist[BASE];
  if (!hk || !hb) return null;
  const wt = now.weight;
  const lo80: number[] = [];
  const lo50: number[] = [];
  const mid: number[] = [];
  const hi50: number[] = [];
  const hi80: number[] = [];
  const midZ = new Float64Array(H);
  for (let k = 1; k <= H; k++) {
    histQuantiles(hk, (k - 1) * CONE_BINS, QS, Q);
    if (wt < 1) {
      histQuantiles(hb, (k - 1) * CONE_BINS, QS, QB);
      for (let q = 0; q < 5; q++) Q[q] = wt * Q[q] + (1 - wt) * QB[q];
    }
    const s = SQRT[k] * sg;
    lo80.push(c * Math.exp(Q[Q_LO80] * s));
    lo50.push(c * Math.exp(Q[Q_LO50] * s));
    mid.push(c * Math.exp(Q[Q_MID] * s));
    hi50.push(c * Math.exp(Q[Q_HI50] * s));
    hi80.push(c * Math.exp(Q[Q_HI80] * s));
    midZ[k - 1] = Q[Q_MID] * SQRT[k];
  }
  const dir = now.dir as -1 | 0 | 1;
  const label = `${H} bars: ${pct(now.pUp)} up · median ${signed(ret(now.z[Q_MID], sg))} · 80%: ${signed(ret(now.z[Q_LO80], sg))} to ${signed(ret(now.z[Q_HI80], sg))} · n=${now.n}`;
  const fan: Fan = {
    i0,
    p0: c,
    mid,
    bands: [
      { level: 0.8, lo: lo80, hi: hi80 },
      { level: 0.5, lo: lo50, hi: hi50 },
    ],
    dir,
    color: dir > 0 ? 'bull' : dir < 0 ? 'bear' : 'info',
    label,
  };

  const n = st.aCnt[now.key];
  const base = now.key * RING;
  let trade: Trade | null = null;
  if (dir !== 0 && n >= MIN_PATHS) {
    // best and worst excursion of each similar bar over its next H bars, in units of its own volatility
    const mfe = new Float64Array(n);
    const mae = new Float64Array(n);
    for (let a = 0; a < n; a++) {
      const j = st.aIdx[base + a];
      const lc = Math.log(x.c[j]);
      const sj = st.aSig[base + a];
      let best = -Infinity;
      let worst = -Infinity;
      for (let k = 1; k <= H; k++) {
        const up = (Math.log(x.h[j + k]) - lc) / sj;
        const dn = (lc - Math.log(x.l[j + k])) / sj;
        best = Math.max(best, dir > 0 ? up : dn);
        worst = Math.max(worst, dir > 0 ? dn : up);
      }
      mfe[a] = best;
      mae[a] = worst;
    }
    const zT = rank(mfe.slice().sort(), 0.5);
    // stop: the nearest Sequential risk level on the losing side of price, else the excursion 80% of cases stayed inside
    const side = st.seq.sides[dir > 0 ? 0 : 1];
    let stop = NaN;
    for (const lvl of [dir * side.risk, dir * side.cdRisk]) if (Number.isFinite(lvl) && lvl > 0 && dir * (c - lvl) > 0 && !(Math.abs(c - lvl) >= Math.abs(c - stop))) stop = lvl;
    let stopSrc: Trade['stopSrc'] = 'Seq risk';
    let zS = Number.isFinite(stop) ? Math.abs(Math.log(stop / c)) / sg : NaN;
    if (!Number.isFinite(stop)) {
      zS = rank(mae.slice().sort(), 0.8);
      stop = c * Math.exp(-dir * zS * sg);
      stopSrc = 'cases';
    }
    if (zT > 0 && zS > 0) {
      let targets = 0;
      let stops = 0;
      for (let a = 0; a < n; a++) {
        const j = st.aIdx[base + a];
        const lc = Math.log(x.c[j]);
        const sj = st.aSig[base + a];
        for (let k = 1; k <= H; k++) {
          const up = (Math.log(x.h[j + k]) - lc) / sj;
          const dn = (lc - Math.log(x.l[j + k])) / sj;
          // a bar that reaches both counts as stopped: bars do not say which came first
          if ((dir > 0 ? dn : up) >= zS) {
            stops++;
            break;
          }
          if ((dir > 0 ? up : dn) >= zT) {
            targets++;
            break;
          }
        }
      }
      const target = c * Math.exp(dir * zT * sg);
      trade = { entry: c, target, stop, stopSrc, rr: Math.abs(target - c) / Math.abs(c - stop), hitTarget: targets / n, hitStop: stops / n, paths: n };
    }
  }

  const ghosts: GhostBar[] = [];
  if (cfg.showGhost && n > 0) {
    // the similar bar whose close-to-close path lies nearest the median path (ties: the most recent)
    let bestJ = -1;
    let bestS = NaN;
    let bestD = Infinity;
    for (let a = 0; a < n; a++) {
      const j = st.aIdx[base + a];
      const lc = Math.log(x.c[j]);
      const sj = st.aSig[base + a];
      let d = 0;
      for (let k = 1; k <= H; k++) {
        const e = (Math.log(x.c[j + k]) - lc) / sj - midZ[k - 1];
        d += (e * e) / k;
      }
      if (d < bestD || (d === bestD && j > bestJ)) {
        bestD = d;
        bestJ = j;
        bestS = sj;
      }
    }
    if (bestJ >= 0) {
      const lc = Math.log(x.c[bestJ]);
      const scale = sg / bestS;
      const at = (p: number) => c * Math.exp((Math.log(p) - lc) * scale);
      for (let k = 1; k <= H; k++) ghosts.push({ i: i0 + k, o: at(x.o[bestJ + k]), h: at(x.h[bestJ + k]), l: at(x.l[bestJ + k]), c: at(x.c[bestJ + k]) });
    }
  }
  return { fan, ghosts, trade };
}

export const forwardCone = defineStudy(coneSchema, {
  id: 'meridian-cone',
  name: 'Forward Cone',
  shortName: 'Cone',
  version: '1.0.0',
  category: 'Meridian',
  description:
    'The range of outcomes over the next N bars, taken from what followed past bars in the same state (Sequential count phase, Ichimoku cloud position, DeM I zone) and scaled by current volatility. Shows the median path with 50% and 80% bands, how the cases lean against all bars, and a running out-of-sample score of its own forecasts. A range of past outcomes, not a prediction of individual candles.',
  overlay: true,
  presets: { '8 bars': { horizon: 8 }, '13 bars': { horizon: 13 }, '21 bars': { horizon: 21 }, '34 bars': { horizon: 34 } },
  outputs: (cfg) => [
    // where the forecast made `horizon` bars earlier put price now: off by default; turn on under Style to see the track record
    { kind: 'line', id: 'fwd_hi', title: '80% range top (as forecast)', color: 'info', style: 'dotted', width: 1, offset: cfg.horizon, hiddenByDefault: true },
    { kind: 'line', id: 'fwd_lo', title: '80% range bottom (as forecast)', color: 'info', style: 'dotted', width: 1, offset: cfg.horizon, hiddenByDefault: true },
    { kind: 'line', id: 'fwd_mid', title: 'Median (as forecast)', color: 'info', style: 'dashed', width: 1, offset: cfg.horizon, hiddenByDefault: true },
    { kind: 'cloud', id: 'fwd_band', title: '80% range (as forecast)', a: 'fwd_hi', b: 'fwd_lo', upColor: 'info', downColor: 'info', offset: cfg.horizon, hiddenByDefault: true },
    { kind: 'data', id: 'p_up', title: 'Similar bars that closed higher (%)' },
    { kind: 'data', id: 'med', title: 'Median move (%)' },
    { kind: 'data', id: 'lo80', title: '80% range low (%)' },
    { kind: 'data', id: 'hi80', title: '80% range high (%)' },
    { kind: 'data', id: 'cases', title: 'Similar bars' },
    { kind: 'data', id: 'match', title: 'Match level (0 full state … 3 all bars)' },
    { kind: 'data', id: 'dir', title: 'Lean (+1 up, −1 down, 0 none)' },
    { kind: 'data', id: 'cover80', title: 'Scorecard: closes inside the 80% range (%)' },
    { kind: 'data', id: 'skill', title: 'Scorecard: gain over the all-bars forecast (%)' },
  ],
  signals: [
    { id: 'CONE_BULL', dir: 'bull', description: 'Similar bars closed higher clearly more often than all bars' },
    { id: 'CONE_BEAR', dir: 'bear', description: 'Similar bars closed lower clearly more often than all bars' },
    { id: 'CONE_BREAK_UP', dir: 'bull', description: 'Close above the 80% range drawn at the last lean signal' },
    { id: 'CONE_BREAK_DOWN', dir: 'bear', description: 'Close below the 80% range drawn at the last lean signal' },
  ],
  init: (cfg): ConeState => {
    const H = cfg.horizon;
    return {
      seq: newSequentialState(),
      ichi: ichimoku.init(ICHI),
      dem: demarker1.init(DEM),
      ewVar: 0,
      nRet: 0,
      prevLn: NaN,
      rKeys: new Int32Array(4 * (H + 1)),
      rSig: new Float64Array(H + 1).fill(NaN),
      rLn: new Float64Array(H + 1),
      hist: Array.from({ length: KEYS }, () => null),
      cnt: new Uint32Array(KEYS),
      up: new Uint32Array(KEYS),
      ind: new Uint32Array(KEYS),
      lastInd: new Int32Array(KEYS).fill(-1_000_000),
      aIdx: new Int32Array(KEYS * RING),
      aSig: new Float64Array(KEYS * RING),
      aHead: new Int32Array(KEYS),
      aCnt: new Int32Array(KEYS),
      pQ: new Float64Array(10 * H),
      pOk: new Int8Array(H),
      pDir: new Int8Array(H),
      score: new Float64Array(8),
      now: { ok: false, key: BASE, level: 3, n: 0, independent: 0, weight: 1, pUp: NaN, baseUp: NaN, z: [NaN, NaN, NaN, NaN, NaN], dir: 0, sigma: NaN, phase: 0, trend: 1, mom: 1 },
      prevDir: 0,
      anchor: { i: -1, dir: 0, sigma: NaN, lo: new Float64Array(H), hi: new Float64Array(H) },
      last: -1,
    };
  },
  update(cfg, st, x, w, intra) {
    const i = w.i;
    const H = cfg.horizon;
    const M = H + 1;
    sequential.update(SEQ, st.seq, x, sub(i, w.provisional), intra);
    ichimoku.update(ICHI, st.ichi, x, sub(i, w.provisional), intra);
    demarker1.update(DEM, st.dem, x, sub(i, w.provisional), intra);
    st.last = i;
    const c = x.c[i];
    const ln = Math.log(c);
    const usable = Number.isFinite(ln);

    // volatility of this bar: mean squared log return (simple mean for the first volLength returns, exponential after)
    if (usable && Number.isFinite(st.prevLn)) {
      const r = ln - st.prevLn;
      st.ewVar += (r * r - st.ewVar) * (st.nRet < cfg.volLength ? 1 / (st.nRet + 1) : 2 / (cfg.volLength + 1));
      st.nRet++;
    }
    if (usable) st.prevLn = ln;
    const sigma = usable && st.nRet >= cfg.volLength && st.ewVar > 0 ? Math.sqrt(st.ewVar) : NaN;

    // the state this bar is in
    const phase = conePhase(sideRank(st.seq.sides[0], i, cfg.recentBars), sideRank(st.seq.sides[1], i, cfg.recentBars));
    const trend = c > st.ichi.cloudTop ? 2 : c < st.ichi.cloudBot ? 0 : 1;
    const mom = st.dem.v <= DEM.oversold ? 0 : st.dem.v >= DEM.overbought ? 2 : 1;
    const k0 = phase * 9 + trend * 3 + mom;
    const k1 = LEVEL_OFFSET[1] + phase * 3 + trend;
    const k2 = LEVEL_OFFSET[2] + phase;
    const slot = i % M;

    // this close completes the h-bar move of bar i − h, for h = 1 … H: file each under that bar's keys
    if (usable) {
      const maxH = i < H ? i : H;
      let js = slot;
      for (let h = 1; h <= maxH; h++) {
        js = js === 0 ? M - 1 : js - 1;
        const sg = st.rSig[js];
        if (!(sg > 0)) continue;
        const zv = (ln - st.rLn[js]) / sg;
        let bin = Math.floor((zv * INV_SQRT[h] + ZMAX) / CONE_BIN_WIDTH);
        bin = bin < 0 ? 0 : bin >= CONE_BINS ? CONE_BINS - 1 : bin;
        const at = (h - 1) * CONE_BINS + bin;
        const kk = 4 * js;
        const j = i - h;
        for (let l = 0; l < 4; l++) {
          const key = st.rKeys[kk + l];
          let hk = st.hist[key];
          if (!hk) hk = st.hist[key] = new Uint32Array(H * CONE_BINS);
          hk[at]++;
          if (h !== H) continue;
          // the bar's full horizon is now known: it becomes a case
          st.cnt[key]++;
          if (zv > 0) st.up[key]++;
          if (j - st.lastInd[key] >= H) {
            st.ind[key]++;
            st.lastInd[key] = j;
          }
          const pos = st.aHead[key];
          st.aIdx[key * RING + pos] = j;
          st.aSig[key * RING + pos] = sg;
          st.aHead[key] = pos + 1 === RING ? 0 : pos + 1;
          if (st.aCnt[key] < RING) st.aCnt[key]++;
        }
      }
    }

    // score the forecast made H bars ago against this close (always out of sample: it was made before this bar existed)
    const ps = i % H;
    const sc = st.score;
    if (usable && i >= H && st.pOk[ps] > 0) {
      const jsH = slot + 1 === M ? 0 : slot + 1;
      const zr = (ln - st.rLn[jsH]) / st.rSig[jsH];
      const o = 10 * ps;
      sc[S_N]++;
      if (zr >= st.pQ[o + Q_LO80] && zr <= st.pQ[o + Q_HI80]) sc[S_IN80]++;
      if (zr >= st.pQ[o + Q_LO50] && zr <= st.pQ[o + Q_HI50]) sc[S_IN50]++;
      if (st.pOk[ps] <= 3) {
        sc[S_NCOND]++;
        for (let q = 0; q < 5; q++) {
          sc[S_LOSS] += pinball(zr, st.pQ[o + q], QS[q]);
          sc[S_LOSS_BASE] += pinball(zr, st.pQ[o + 5 + q], QS[q]);
        }
      }
      const d = st.pDir[ps];
      if (d !== 0) {
        sc[S_CALLS]++;
        if (zr * d > 0) sc[S_HITS]++;
      }
    }

    // file this bar
    st.rLn[slot] = ln;
    st.rSig[slot] = sigma;
    st.rKeys[4 * slot] = k0;
    st.rKeys[4 * slot + 1] = k1;
    st.rKeys[4 * slot + 2] = k2;
    st.rKeys[4 * slot + 3] = BASE;

    // forecast: the finest state with enough cases from enough separate runs, else all bars
    const now = st.now;
    now.ok = false;
    now.dir = 0;
    now.phase = phase;
    now.trend = trend;
    now.mom = mom;
    now.sigma = sigma;
    st.pOk[ps] = 0;
    st.pDir[ps] = 0;
    if (sigma > 0) {
      const { cnt, ind } = st;
      const enough = (k: number) => cnt[k] >= cfg.minSamples && ind[k] >= cfg.minIndependent;
      const level = enough(k0) ? 0 : enough(k1) ? 1 : enough(k2) ? 2 : cnt[BASE] >= cfg.minSamples ? 3 : -1;
      if (level >= 0) {
        const key = level === 0 ? k0 : level === 1 ? k1 : level === 2 ? k2 : BASE;
        const row = (H - 1) * CONE_BINS;
        const sH = SQRT[H];
        histQuantiles(st.hist[key]!, row, QS, Q, cnt[key]);
        if (level < 3) histQuantiles(st.hist[BASE]!, row, QS, QB, cnt[BASE]);
        // few independent cases say little: blend the matched range with the all-bars range in proportion to the evidence
        const wt = level < 3 ? ind[key] / (ind[key] + cfg.shrink) : 1;
        const o = 10 * ps;
        for (let q = 0; q < 5; q++) {
          const base = level < 3 ? QB[q] : Q[q];
          now.z[q] = (wt * Q[q] + (1 - wt) * base) * sH;
          st.pQ[o + q] = now.z[q];
          st.pQ[o + 5 + q] = base * sH;
        }
        const pUp = st.up[key] / cnt[key];
        const baseUp = st.up[BASE] / cnt[BASE];
        // a lean must be both large (edge) and unlikely to be chance for this many independent cases
        const need = Math.max(cfg.edge, cfg.confidence * Math.sqrt((baseUp * (1 - baseUp)) / ind[key]));
        const dir = level < 3 && pUp - baseUp >= need && pUp > 0.5 ? 1 : level < 3 && baseUp - pUp >= need && pUp < 0.5 ? -1 : 0;
        now.ok = true;
        now.key = key;
        now.level = level;
        now.n = cnt[key];
        now.independent = ind[key];
        now.weight = wt;
        now.pUp = pUp;
        now.baseUp = baseUp;
        now.dir = dir;
        st.pOk[ps] = level + 1;
        st.pDir[ps] = dir;
        w.line(L_FWD_HI, c * Math.exp(now.z[Q_HI80] * sigma));
        w.line(L_FWD_LO, c * Math.exp(now.z[Q_LO80] * sigma));
        w.line(L_FWD_MID, c * Math.exp(now.z[Q_MID] * sigma));
        w.line(L_P_UP, 100 * pUp);
        w.line(L_MED, ret(now.z[Q_MID], sigma));
        w.line(L_LO80, ret(now.z[Q_LO80], sigma));
        w.line(L_HI80, ret(now.z[Q_HI80], sigma));
        w.line(L_CASES, now.n);
        w.line(L_MATCH, level);
        w.line(L_DIR, dir);
      }
    }
    if (sc[S_N] > 0) w.line(L_COVER, (100 * sc[S_IN80]) / sc[S_N]);
    if (sc[S_LOSS_BASE] > 0) w.line(L_SKILL, 100 * (1 - sc[S_LOSS] / sc[S_LOSS_BASE]));

    // a close outside the 80% range drawn at the last lean signal (by more than one histogram bin): once per range
    const an = st.anchor;
    if (an.i >= 0) {
      const k = i - an.i;
      if (usable && k >= 1 && k <= H) {
        const tol = CONE_BIN_WIDTH * SQRT[k] * an.sigma;
        const ago = `${an.dir > 0 ? 'Bullish' : 'Bearish'} range from ${k} bar${k === 1 ? '' : 's'} ago`;
        if (ln > an.hi[k - 1] + tol) {
          w.signal('CONE_BREAK_UP', 'bull', c, ago);
          an.i = -1;
        } else if (ln < an.lo[k - 1] - tol) {
          w.signal('CONE_BREAK_DOWN', 'bear', c, ago);
          an.i = -1;
        }
      }
      if (k >= H) an.i = -1;
    }
    // a new lean: signal it once and keep its 80% range
    if (now.dir !== 0 && now.dir !== st.prevDir) {
      const share = now.dir > 0 ? now.pUp : 1 - now.pUp;
      w.signal(now.dir > 0 ? 'CONE_BULL' : 'CONE_BEAR', now.dir > 0 ? 'bull' : 'bear', c, `${pct(share)} of ${now.n} similar bars closed ${now.dir > 0 ? 'higher' : 'lower'} after ${H} bars`);
      const hk = st.hist[now.key]!;
      const hb = st.hist[BASE]!;
      for (let k = 1; k <= H; k++) {
        histQuantiles(hk, (k - 1) * CONE_BINS, P_80, Q2);
        histQuantiles(hb, (k - 1) * CONE_BINS, P_80, QB);
        an.lo[k - 1] = ln + (now.weight * Q2[0] + (1 - now.weight) * QB[0]) * SQRT[k] * sigma;
        an.hi[k - 1] = ln + (now.weight * Q2[1] + (1 - now.weight) * QB[1]) * SQRT[k] * sigma;
      }
      an.i = i;
      an.dir = now.dir;
      an.sigma = sigma;
    }
    st.prevDir = now.dir;

    if (w.inspecting) {
      w.inspect(`State: ${PHASE_NAMES[phase]} · ${TREND_NAMES[trend]} · ${MOM_NAMES[mom]}`, true, `volatility ${Number.isFinite(sigma) ? `${(100 * sigma).toFixed(2)}% per bar` : '—'}`);
      const lv = ['Full state', 'Phase + cloud', 'Phase only', 'All bars'];
      [k0, k1, k2, BASE].forEach((k, l) => w.inspect(`${lv[l]}: ≥ ${cfg.minSamples} bars${l < 3 ? `, ≥ ${cfg.minIndependent} non-overlapping` : ''}`, now.ok && now.level === l, `${st.cnt[k]} bars, ${st.ind[k]} non-overlapping`));
      w.inspect(`Lean: share closing higher differs from all bars by ≥ ${pct(cfg.edge)} and ≥ ${cfg.confidence} standard errors`, now.dir !== 0, now.ok ? `${pct(now.pUp)} vs ${pct(now.baseUp)}` : '—');
    }
  },
  geometry(cfg, st, x): Geometry {
    const p = project(cfg, st, x);
    if (!p) return {};
    const H = cfg.horizon;
    const i0 = st.last;
    const segments: NonNullable<Geometry['segments']> = [];
    if (cfg.showLevels && p.trade) {
      const t = p.trade;
      segments.push(
        { i1: i0, p1: t.target, i2: i0 + H, p2: t.target, color: p.fan.dir > 0 ? 'bull' : 'bear', style: 'dashed', width: 1, label: `Target ${f(t.target)} · first in ${pct(t.hitTarget)}` },
        { i1: i0, p1: t.stop, i2: i0 + H, p2: t.stop, color: 'warn', style: 'dashed', width: 1, label: `Stop ${f(t.stop)} (${t.stopSrc}) · first in ${pct(t.hitStop)}` },
      );
    }
    const an = st.anchor;
    if (cfg.showSignalCone && an.i >= 0 && an.i < i0) {
      let pl = x.c[an.i];
      let ph = pl;
      for (let k = 1; k <= H; k++) {
        const lo = Math.exp(an.lo[k - 1]);
        const hi = Math.exp(an.hi[k - 1]);
        segments.push({ i1: an.i + k - 1, p1: pl, i2: an.i + k, p2: lo, color: 'muted', style: 'dotted', width: 1 }, { i1: an.i + k - 1, p1: ph, i2: an.i + k, p2: hi, color: 'muted', style: 'dotted', width: 1 });
        pl = lo;
        ph = hi;
      }
    }
    return { fans: [p.fan], ghosts: p.ghosts.length ? p.ghosts : undefined, segments: segments.length ? segments : undefined };
  },
  status(cfg, st, x): StudyStatus {
    const now = st.now;
    const sc = st.score;
    const H = cfg.horizon;
    const scoreValues = {
      scored: sc[S_N],
      cover80: sc[S_N] > 0 ? sc[S_IN80] / sc[S_N] : null,
      cover50: sc[S_N] > 0 ? sc[S_IN50] / sc[S_N] : null,
      scoredMatched: sc[S_NCOND],
      skill: sc[S_LOSS_BASE] > 0 ? 1 - sc[S_LOSS] / sc[S_LOSS_BASE] : null,
      calls: sc[S_CALLS],
      callHitRate: sc[S_CALLS] > 0 ? sc[S_HITS] / sc[S_CALLS] : null,
    };
    if (!now.ok) return { chips: [], values: { horizon: H, ...scoreValues } };
    const sg = now.sigma;
    const med = ret(now.z[Q_MID], sg);
    const lo = ret(now.z[Q_LO80], sg);
    const hi = ret(now.z[Q_HI80], sg);
    const cases = now.level === 3 ? `no similar state with enough history: all ${now.n} bars` : `${now.n} similar bars (${now.independent} non-overlapping)`;
    const summary = `Next ${H} bars: ${pct(now.pUp)} closed higher (all bars ${pct(now.baseUp)}) · median ${signed(med)} · 80% range ${signed(lo)} to ${signed(hi)} · ${cases}`;
    const t = project(cfg, st, x)?.trade ?? null;
    const chip =
      now.dir === 0
        ? { text: `Cone: no lean (${pct(now.pUp)} up / ${H} bars)`, dir: 'neutral' as const, strength: 0.2 }
        : { text: `Cone ${now.dir > 0 ? '▲' : '▼'} ${pct(now.dir > 0 ? now.pUp : 1 - now.pUp)} ${now.dir > 0 ? 'up' : 'down'} / ${H} bars`, dir: now.dir > 0 ? ('bull' as const) : ('bear' as const), strength: Math.min(1, 2 * Math.abs(now.pUp - now.baseUp) + 0.3) };
    return {
      chips: [chip],
      values: {
        horizon: H,
        summary,
        pUp: now.pUp,
        baseUp: now.baseUp,
        medPct: med,
        lo80Pct: lo,
        hi80Pct: hi,
        lo50Pct: ret(now.z[Q_LO50], sg),
        hi50Pct: ret(now.z[Q_HI50], sg),
        cases: now.n,
        independent: now.independent,
        weight: now.weight,
        level: now.level,
        match: matchText(now),
        dir: now.dir,
        volPct: 100 * sg,
        entry: t ? t.entry : null,
        target: t ? t.target : null,
        stop: t ? t.stop : null,
        stopSrc: t ? t.stopSrc : null,
        rr: t ? t.rr : null,
        hitTarget: t ? t.hitTarget : null,
        hitStop: t ? t.hitStop : null,
        paths: t ? t.paths : null,
        ...scoreValues,
      },
    };
  },
});

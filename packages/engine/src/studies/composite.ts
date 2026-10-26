import { z } from 'zod';
import { sinkWriter } from '../core/mtf';
import { bool, defineStudy, int, num } from '../core/params';
import { emaInit, emaPush, rmaInit } from '../core/rolling';
import type { SeriesCtx, StudyStatus, Writer } from '../core/types';
import { combo, comboSchema, newComboState } from './demark/combo';
import { demarker1, demarker1Schema } from './demark/oscillators';
import { rei, reiSchema } from './demark/oscillators';
import { newSequentialState, sequential, sequentialSchema } from './demark/sequential';
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
const DEM_DEFAULTS = demarker1Schema.parse({});
const REI_DEFAULTS = reiSchema.parse({ poq: false });

// ── Exhaustion Confluence (SPEC §8 / INDICATORS §8) ─────────────────────────
const weight = (def: number, title: string) => num(def, 0, 10, { title, group: 'Weights', step: 0.1 });

export const confluenceSchema = z.object({
  wSetup: weight(1, 'Sequential setup progress'),
  wCountdown: weight(2, 'Sequential countdown progress'),
  wCombo: weight(1.5, 'Combo countdown progress'),
  wDeMarker: weight(1, 'DeMarker I zone (duration-aware)'),
  wRei: weight(1, 'REI zone'),
  wTdst: weight(1, 'Proximity to TDST level'),
  wHtf: weight(1.5, 'Higher-timeframe alignment'),
  tdstAtr: num(1.5, 0.1, 10, { title: 'TDST proximity window (×ATR)', step: 0.1 }),
  recentBars: int(5, 1, 50, { title: 'A completed 9/13 counts as full for N bars' }),
  threshold: num(60, 1, 100, { title: 'Signal threshold (score)', step: 1 }),
  useHtf: bool(false, { title: 'Use higher timeframe (needs HTF data)', description: 'The chart supplies HTF Sequential counts aligned without look-ahead.' }),
});
export type ConfluenceCfg = z.infer<typeof confluenceSchema>;

type Parts = Record<string, number>;

function sideScore(cfg: ConfluenceCfg, st: ConfluenceState, x: SeriesCtx, i: number, k: 0 | 1, atr: number): { score: number; parts: Parts } {
  const s = k === 0 ? 1 : -1;
  const seq = st.seq.sides[k];
  const cmb = st.combo.sides[k];
  const recent = (j: number) => j >= 0 && i - j < cfg.recentBars;
  const parts: Parts = {};
  parts.setup = recent(seq.lastSetup9) ? 1 : Math.min(1, seq.su.count / 9);
  parts.countdown = recent(seq.lastCd13) ? 1 : seq.cd.active ? seq.cd.count / 13 : 0;
  parts.combo = recent(cmb.last13) ? 1 : cmb.cd.active ? cmb.cd.count / 13 : 0;
  const z = st.dem.zone;
  const inZone = k === 0 ? z.inOS : z.inOB;
  parts.demarker = inZone > 0 && inZone <= DEM_DEFAULTS.maxDuration ? Math.min(1, inZone / 5) : 0;
  const rz = st.rei.zone;
  parts.rei = (k === 0 ? rz.inOS : rz.inOB) > 0 ? 1 : 0;
  // TDST from the OPPOSITE side's setup is the support/resistance a reversal would lean on
  const lvl = -s * st.seq.sides[1 - k].tdst; // buy side → TDST support (from sell setup), un-mirrored
  const dist = Number.isFinite(lvl) && atr > 0 ? Math.abs(x.c[i] - lvl) / atr : Infinity;
  parts.tdst = dist <= cfg.tdstAtr ? 1 - dist / cfg.tdstAtr : 0;
  const hs = x.aux.htfSetup?.[i];
  const hc = x.aux.htfCountdown?.[i];
  // HTF columns follow the Sequential convention: negative = buy side, positive = sell side
  parts.htf = cfg.useHtf && Number.isFinite(hs) ? Math.max(Math.min(1, Math.max(0, -s * hs) / 9), Math.max(0, -s * (hc ?? 0)) / 13) : 0;
  const W: Parts = { setup: cfg.wSetup, countdown: cfg.wCountdown, combo: cfg.wCombo, demarker: cfg.wDeMarker, rei: cfg.wRei, tdst: cfg.wTdst, htf: cfg.useHtf ? cfg.wHtf : 0 };
  let tot = 0;
  let acc = 0;
  for (const key of Object.keys(W)) {
    tot += W[key];
    acc += W[key] * parts[key];
  }
  return { score: tot > 0 ? (100 * acc) / tot : 0, parts };
}

interface ConfluenceState {
  seq: ReturnType<typeof newSequentialState>;
  combo: ReturnType<typeof newComboState>;
  dem: ReturnType<typeof demarker1.init>;
  rei: ReturnType<typeof rei.init>;
  atr: ReturnType<typeof emaInit>;
  prevBuy: number;
  prevSell: number;
  lastParts: { buy: Parts; sell: Parts; buyScore: number; sellScore: number };
}

export const confluence = defineStudy(confluenceSchema, {
  id: 'meridian-confluence',
  name: 'Exhaustion Confluence',
  shortName: 'Confluence',
  version: '1.0.0',
  category: 'Meridian',
  description:
    'Weighted 0–100 score combining Sequential/Combo progress, DeMarker zone duration, REI, TDST proximity and higher-timeframe alignment. Buy score up, sell score down; hover for the breakdown.',
  overlay: false,
  outputs: (cfg) => [
    { kind: 'histogram', id: 'buy', title: 'Buy exhaustion', color: 'bull' },
    { kind: 'histogram', id: 'sell', title: 'Sell exhaustion', color: 'bear' },
    { kind: 'hline', id: 'thr_up', title: 'Threshold', value: cfg.threshold, color: 'muted', style: 'dashed' },
    { kind: 'hline', id: 'thr_dn', title: 'Threshold', value: -cfg.threshold, color: 'muted', style: 'dashed' },
  ],
  needsAux: (cfg) => (cfg.useHtf ? ['htfSetup', 'htfCountdown'] : []),
  signals: [
    { id: 'CONFLUENCE_BUY', dir: 'bull', description: 'Buy exhaustion score crosses above the threshold' },
    { id: 'CONFLUENCE_SELL', dir: 'bear', description: 'Sell exhaustion score crosses above the threshold' },
  ],
  init: (): ConfluenceState => ({
    seq: newSequentialState(),
    combo: newComboState(),
    dem: demarker1.init(DEM_DEFAULTS),
    rei: rei.init(REI_DEFAULTS),
    atr: rmaInit(14),
    prevBuy: 0,
    prevSell: 0,
    lastParts: { buy: {}, sell: {}, buyScore: 0, sellScore: 0 },
  }),
  update(cfg, st, x, w: Writer, intra) {
    const i = w.i;
    sequential.update(SEQ_DEFAULTS, st.seq, x, sub(i, w.provisional), intra);
    combo.update(COMBO_DEFAULTS, st.combo, x, sub(i, w.provisional), intra);
    demarker1.update(DEM_DEFAULTS, st.dem, x, sub(i, w.provisional), intra);
    rei.update(REI_DEFAULTS, st.rei, x, sub(i, w.provisional), intra);
    const atr = emaPush(st.atr, tr(x, i));
    const b = sideScore(cfg, st, x, i, 0, atr);
    const s = sideScore(cfg, st, x, i, 1, atr);
    st.lastParts = { buy: b.parts, sell: s.parts, buyScore: b.score, sellScore: s.score };
    w.line(0, b.score);
    w.line(1, -s.score);
    if (st.prevBuy < cfg.threshold && b.score >= cfg.threshold) w.signal('CONFLUENCE_BUY', 'bull', x.c[i], b.score.toFixed(0));
    if (st.prevSell < cfg.threshold && s.score >= cfg.threshold) w.signal('CONFLUENCE_SELL', 'bear', x.c[i], s.score.toFixed(0));
    st.prevBuy = b.score;
    st.prevSell = s.score;
    if (w.inspecting)
      for (const [side, r] of [
        ['Buy', b],
        ['Sell', s],
      ] as const)
        for (const [k, v] of Object.entries(r.parts)) w.inspect(`${side} · ${k}`, v > 0, `${(v * 100).toFixed(0)}%`);
  },
  status(_cfg, st): StudyStatus {
    const { buyScore, sellScore, buy, sell } = st.lastParts;
    const chips: StudyStatus['chips'] = [];
    if (buyScore >= 25) chips.push({ text: `Buy exh. ${buyScore.toFixed(0)}`, dir: 'bull', strength: buyScore / 100 });
    if (sellScore >= 25) chips.push({ text: `Sell exh. ${sellScore.toFixed(0)}`, dir: 'bear', strength: sellScore / 100 });
    const values: Record<string, number> = { buyScore, sellScore };
    for (const [k, v] of Object.entries(buy)) values[`buy.${k}`] = v;
    for (const [k, v] of Object.entries(sell)) values[`sell.${k}`] = v;
    return { chips, values };
  },
});

// ── Count Consensus (SPEC §8.2 variant diff) ────────────────────────────────
const VARIANTS = [
  { key: 'seqStd', title: 'Seq standard', kind: 'seq' as const, cfg: { ...SEQ_DEFAULTS, countdownMode: 'standard' as const } },
  { key: 'seqAgg', title: 'Seq aggressive', kind: 'seq' as const, cfg: { ...SEQ_DEFAULTS, countdownMode: 'aggressive' as const } },
  { key: 'comboStrict', title: 'Combo strict', kind: 'combo' as const, cfg: { ...COMBO_DEFAULTS, comboVersion: 'strict' as const } },
  { key: 'comboV2', title: 'Combo v2', kind: 'combo' as const, cfg: { ...COMBO_DEFAULTS, comboVersion: 'v2' as const } },
];

export const consensusSchema = z.object({
  window: int(5, 0, 50, { title: 'Agreement window (bars)' }),
  minAgree: int(3, 2, 4, { title: 'Variants required for a consensus signal' }),
});

export const consensus = defineStudy(consensusSchema, {
  id: 'meridian-consensus',
  name: 'Count Consensus',
  shortName: 'Consensus',
  version: '1.0.0',
  category: 'Meridian',
  description: 'Runs Sequential (standard & aggressive) and Combo (strict & v2) side by side to show where rule variants agree — a direct view of rule sensitivity.',
  overlay: false,
  outputs: () => [
    ...VARIANTS.map((v, k) => ({ kind: 'line' as const, id: v.key, title: v.title, color: (['#29b6f6', '#ab47bc', '#ff9800', '#26a69a'] as const)[k], render: 'step' as const })),
    { kind: 'histogram', id: 'agree', title: 'Variants at 13 (window)', color: 'bull', negColor: 'bear' },
    { kind: 'hline', id: 'p13', title: '+13', value: 13, color: 'muted', style: 'dotted' },
    { kind: 'hline', id: 'm13', title: '−13', value: -13, color: 'muted', style: 'dotted' },
  ],
  signals: [
    { id: 'CONSENSUS_BUY_13', dir: 'bull', description: 'Enough variants completed a buy 13 within the window' },
    { id: 'CONSENSUS_SELL_13', dir: 'bear', description: 'Enough variants completed a sell 13 within the window' },
  ],
  init: () => ({
    states: VARIANTS.map((v) => (v.kind === 'seq' ? newSequentialState() : newComboState())) as unknown[],
    last13: VARIANTS.map(() => [-1e9, -1e9]),
    fired: [-1e9, -1e9],
  }),
  update(cfg, st, x, w, intra) {
    const i = w.i;
    VARIANTS.forEach((v, k) => {
      const sw = sub(i, w.provisional);
      if (v.kind === 'seq') {
        const s = st.states[k] as ReturnType<typeof newSequentialState>;
        sequential.update(v.cfg, s, x, sw, intra);
        const [b, sl] = s.sides;
        w.line(k, sl.cd.active ? sl.cd.count : sl.lastCd13 === i ? 13 : b.cd.active ? -b.cd.count : b.lastCd13 === i ? -13 : 0);
      } else {
        const s = st.states[k] as ReturnType<typeof newComboState>;
        combo.update(v.cfg, s, x, sw, intra);
        const [b, sl] = s.sides;
        w.line(k, sl.cd.active ? sl.cd.count : sl.last13 === i ? 13 : b.cd.active ? -b.cd.count : b.last13 === i ? -13 : 0);
      }
      for (const f of sw.fired) {
        if (f.id.endsWith('BUY_CD_13') || f.id === 'COMBO_BUY_13') st.last13[k][0] = i;
        if (f.id.endsWith('SELL_CD_13') || f.id === 'COMBO_SELL_13') st.last13[k][1] = i;
      }
    });
    const nb = st.last13.filter((l) => i - l[0] <= cfg.window).length;
    const ns = st.last13.filter((l) => i - l[1] <= cfg.window).length;
    w.line(4, nb >= ns ? nb : -ns);
    if (nb >= cfg.minAgree && i - st.fired[0] > cfg.window) {
      st.fired[0] = i;
      w.signal('CONSENSUS_BUY_13', 'bull', x.c[i], `${nb}/4 variants`);
      w.marker({ i, text: `${nb}/4`, pos: 'below', color: 'bull', row: 3, size: 2, style: 'boxed', tooltip: 'Count consensus (buy 13)' });
    }
    if (ns >= cfg.minAgree && i - st.fired[1] > cfg.window) {
      st.fired[1] = i;
      w.signal('CONSENSUS_SELL_13', 'bear', x.c[i], `${ns}/4 variants`);
      w.marker({ i, text: `${ns}/4`, pos: 'above', color: 'bear', row: 3, size: 2, style: 'boxed', tooltip: 'Count consensus (sell 13)' });
    }
    if (w.inspecting) VARIANTS.forEach((v, k) => w.inspect(`${v.title} 13 within ${cfg.window} bars`, i - Math.max(...st.last13[k]) <= cfg.window));
  },
});

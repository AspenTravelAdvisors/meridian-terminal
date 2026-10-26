import { z } from 'zod';
import { bool, choice, int } from '../../core/params';
import type { SeriesCtx, StudyDef, StudyStatus, Writer } from '../../core/types';
import {
  type Countdown,
  type SetupInfo,
  type SetupSide,
  type Sg,
  SIDE_UP,
  SIDES,
  countdownMgmtShape,
  f,
  markerPos,
  mC,
  mL,
  newCountdown,
  newSetupSide,
  newSetupStep,
  setupShape,
  setupStep,
  shouldRecycle,
  startCountdown,
  tdstCancelled,
} from './common';

export const comboSchema = z.object({
  ...setupShape,
  comboVersion: choice(['strict', 'v2'] as const, 'strict', {
    title: 'Combo version',
    group: 'Countdown',
    verify: 'INDICATORS §2 — v2 relaxes the rules from countdown 11 onward.',
  }),
  v2From: int(11, 2, 13, { title: 'v2 relaxed from countdown #', group: 'Countdown', verify: 'INDICATORS §2 / VERIFY_LOG "bar 11+"' }),
  countdownLength: int(13, 5, 30, { title: 'Countdown length', group: 'Countdown' }),
  ...countdownMgmtShape,
  showSetup: bool(false, { title: 'Show setup counts', group: 'Display', description: 'Off by default so Sequential and Combo can share a chart.' }),
  showCountdown: bool(true, { title: 'Show combo countdown', group: 'Display' }),
  markerRow: int(2, 0, 5, { title: 'Marker row', group: 'Display', description: 'Stacking row so Combo numbers sit beyond Sequential’s.' }),
});
export type ComboCfg = z.infer<typeof comboSchema>;

interface Side {
  su: SetupSide;
  last: SetupInfo | null;
  cd: Countdown;
  last13: number;
}

export interface ComboState {
  sides: [Side, Side];
}

const newSide = (): Side => ({ su: newSetupSide(), last: null, cd: newCountdown(), last13: -1 });

/** Combo countdown bar predicate in mirrored space (INDICATORS §2). */
export function comboCond(cfg: ComboCfg, cd: Countdown, x: SeriesCtx, s: Sg, i: number): boolean {
  if (i < 2) return false;
  const c = mC(x, s, i);
  const beatsPrev = !Number.isFinite(cd.lastClose) || c < cd.lastClose;
  if (cfg.comboVersion === 'v2' && cd.count >= cfg.v2From - 1) return beatsPrev;
  return c <= mL(x, s, i - 2) && mL(x, s, i) < mL(x, s, i - 1) && c < mC(x, s, i - 1) && beatsPrev;
}

function evalBar(cfg: ComboCfg, side: Side, x: SeriesCtx, s: Sg, j: number, w: Writer, P: string): void {
  const cd = side.cd;
  if (!cd.active) return;
  const ok = comboCond(cfg, cd, x, s, j);
  if (w.inspecting && j === w.i)
    w.inspect(
      `Combo ${s > 0 ? 'BUY' : 'SELL'} countdown bar (${cfg.comboVersion}${cfg.comboVersion === 'v2' && cd.count >= cfg.v2From - 1 ? ', relaxed' : ''})`,
      ok,
      `C=${f(x.c[j])} · prev CD close ${f(s * cd.lastClose)} · count ${cd.count}`,
    );
  if (!ok) return;
  cd.count++;
  cd.lastClose = mC(x, s, j);
  const N = cfg.countdownLength;
  const color = s > 0 ? 'info' : 'warn';
  if (cd.count >= N) {
    cd.active = false;
    side.last13 = j;
    w.signal(`${P}_${s > 0 ? 'BUY' : 'SELL'}_13`, s > 0 ? 'bull' : 'bear', x.c[j]);
    if (cfg.showCountdown)
      w.marker({ i: j, text: String(N), pos: markerPos(s), color, row: cfg.markerRow, size: 3, style: 'boxed', tooltip: `Combo ${s > 0 ? 'buy' : 'sell'} ${N}` });
  } else if (cfg.showCountdown) w.marker({ i: j, text: String(cd.count), pos: markerPos(s), color, row: cfg.markerRow, size: 1 });
}

const STEPS = [newSetupStep(), newSetupStep()];

export function comboStep(cfg: ComboCfg, st: ComboState, x: SeriesCtx, w: Writer, i: number, P = 'COMBO'): void {
  const steps = STEPS;
  setupStep(cfg, st.sides[0].su, x, 1, i, steps[0]);
  setupStep(cfg, st.sides[1].su, x, -1, i, steps[1]);
  for (let k = 0; k < 2; k++) {
    const s = SIDES[k];
    const side = st.sides[k];
    const step = steps[k];
    const name = s > 0 ? 'BUY' : 'SELL';
    if (cfg.showSetup && side.su.count > 0 && side.su.count <= cfg.setupLength)
      w.marker({ i, text: String(side.su.count), pos: markerPos(s), color: s > 0 ? 'bull' : 'bear', row: 0, size: side.su.count === cfg.setupLength ? 2 : 1 });

    if (side.cd.active) {
      let reason = '';
      if (cfg.cancelOnOppositeSetup && steps[1 - k].completed) reason = 'opposite setup';
      else if (tdstCancelled(cfg, side.cd, x, s, i)) reason = 'TDST break';
      if (reason) {
        side.cd.active = false;
        w.signal(`${P}_${name}_CD_CANCEL`, 'neutral', x.c[i], reason);
      }
    }

    const done = step.completed;
    if (done) {
      side.last = done;
      const blocked = cfg.cancelOnIntersectionFailure && !done.intersect;
      const restart = !side.cd.active ? !blocked : shouldRecycle(cfg, side.cd, done);
      if (restart) {
        if (side.cd.active) w.signal(`${P}_${name}_CD_RECYCLE`, 'neutral', x.c[i]);
        // Combo countdown begins on setup bar 1: evaluate bars 1…9 retroactively now that the setup is known.
        startCountdown(side.cd, done, done.i1);
        for (let j = done.i1; j <= i; j++) evalBar(cfg, side, x, s, j, w, P);
        continue;
      }
    } else if (step.reached18 && cfg.recycleOn18 && side.cd.active && side.last) {
      startCountdown(side.cd, side.last, i);
      w.signal(`${P}_${name}_CD_RECYCLE`, 'neutral', x.c[i], 'setup reached 18');
    }
    evalBar(cfg, side, x, s, i, w, P);
  }
}

export const newComboState = (): ComboState => ({ sides: [newSide(), newSide()] });

const comboValue = (st: ComboState, i: number, N: number): number => {
  const [b, s] = st.sides;
  if (s.cd.active) return s.cd.count;
  if (s.last13 === i) return N;
  if (b.cd.active) return -b.cd.count;
  if (b.last13 === i) return -N;
  return 0;
};

export function comboStatus(cfg: ComboCfg, st: ComboState, x: SeriesCtx): StudyStatus {
  const last = x.len - 1;
  const chips: StudyStatus['chips'] = [];
  st.sides.forEach((side, k) => {
    const s: Sg = k === 0 ? 1 : -1;
    const dir = s > 0 ? 'bull' : 'bear';
    if (side.cd.active) chips.push({ text: `Combo ${SIDE_UP(s)} ${side.cd.count}`, dir, strength: side.cd.count / cfg.countdownLength });
    if (side.last13 >= 0 && last - side.last13 <= 5) chips.push({ text: `Combo ${cfg.countdownLength} ✓`, dir, strength: 1 });
  });
  const [b, s] = st.sides;
  return {
    chips,
    values: {
      buyCombo: b.cd.active ? b.cd.count : null,
      sellCombo: s.cd.active ? s.cd.count : null,
      barsSinceBuy13: b.last13 >= 0 ? last - b.last13 : null,
      barsSinceSell13: s.last13 >= 0 ? last - s.last13 : null,
    },
  };
}

export const combo: StudyDef<ComboCfg, ComboState> = {
  id: 'td-combo',
  name: 'DeMark-style Combo',
  shortName: 'Combo',
  version: '1.0.0',
  category: 'DeMark',
  description:
    'Same setup as Sequential, but the countdown starts on setup bar 1 and each counted bar must make a lower low, a lower close and a close below the previous countdown close (strict or v2).',
  overlay: true,
  schema: comboSchema,
  presets: { Strict: { comboVersion: 'strict' }, 'Version 2': { comboVersion: 'v2' } },
  verify: [
    { key: 'comboVersion', note: 'INDICATORS §2' },
    { key: 'v2From', note: 'VERIFY_LOG: version 2 threshold' },
  ],
  outputs: () => [{ kind: 'data', id: 'combo', title: 'Combo countdown (+sell / −buy)' }],
  signals: [
    { id: 'COMBO_BUY_13', dir: 'bull', description: 'Combo buy countdown 13' },
    { id: 'COMBO_SELL_13', dir: 'bear', description: 'Combo sell countdown 13' },
    { id: 'COMBO_BUY_CD_CANCEL', dir: 'neutral', description: 'Combo buy countdown cancelled' },
    { id: 'COMBO_SELL_CD_CANCEL', dir: 'neutral', description: 'Combo sell countdown cancelled' },
    { id: 'COMBO_BUY_CD_RECYCLE', dir: 'neutral', description: 'Combo buy countdown recycled' },
    { id: 'COMBO_SELL_CD_RECYCLE', dir: 'neutral', description: 'Combo sell countdown recycled' },
  ],
  init: () => newComboState(),
  update(cfg, st, x, w) {
    comboStep(cfg, st, x, w, w.i);
    w.line(0, comboValue(st, w.i, cfg.countdownLength));
  },
  status: (cfg, st, x) => comboStatus(cfg, st, x),
  golden: (r, i) => ({ combo: r.lines.combo[i] }),
};

import { z } from 'zod';
import { smaInit, smaPush } from '../../core/rolling';
import { bool, choice, defineStudy, int, num } from '../../core/params';

/**
 * Positioning studies plot auxiliary series loaded by the chart (funding, open interest, FINRA short
 * interest). The engine stays pure: without aux the pane stays empty. See packages/data/positioning.ts.
 */

export const fundingRate = defineStudy(
  z.object({
    extremePct: num(0.05, 0, 1, { title: 'Extreme |funding| (%)', description: 'Signal when |funding| exceeds this percent.' }),
    maLength: int(21, 0, 500, { title: 'Funding MA (0 = off)' }),
  }),
  {
    id: 'funding-rate',
    name: 'Perp Funding Rate',
    shortName: 'Funding',
    version: '1.0.0',
    category: 'Volume',
    description:
      'Perpetual-futures funding rate in percent (positive = longs pay shorts). Free feed via OKX public history; crypto only.',
    overlay: false,
    needsAux: () => ['funding'],
    outputs: () => [
      { kind: 'histogram', id: 'funding', title: 'Funding %', color: 'bull', negColor: 'bear' },
      { kind: 'line', id: 'ma', title: 'Funding MA', color: '#ff9800' },
      { kind: 'hline', id: 'zero', title: 'Zero', value: 0, color: 'muted' },
    ],
    signals: [
      { id: 'FUNDING_LONG_CROWDED', dir: 'bear', description: 'Funding above the extreme threshold (longs crowded)' },
      { id: 'FUNDING_SHORT_CROWDED', dir: 'bull', description: 'Funding below −extreme (shorts crowded)' },
    ],
    init: (cfg) => ({ ma: smaInit(Math.max(1, cfg.maLength)) }),
    update(cfg, s, x, w) {
      const v = x.aux.funding?.[w.i];
      if (!Number.isFinite(v)) return;
      w.line(0, v as number);
      if (cfg.maLength > 0) w.line(1, smaPush(s.ma, v as number));
      if ((v as number) >= cfg.extremePct) w.signal('FUNDING_LONG_CROWDED', 'bear', x.c[w.i]);
      if ((v as number) <= -cfg.extremePct) w.signal('FUNDING_SHORT_CROWDED', 'bull', x.c[w.i]);
    },
  },
);

export const openInterest = defineStudy(
  z.object({
    mode: choice(['usd', 'changePct'] as const, 'usd', { title: 'Display' }),
    changeLength: int(1, 1, 50, { title: 'Change lookback (bars)' }),
  }),
  {
    id: 'open-interest',
    name: 'Perp Open Interest',
    shortName: 'OI',
    version: '1.0.0',
    category: 'Volume',
    description:
      'Perpetual-futures open interest (USD notional) or its percent change. Free feed via OKX; crypto only.',
    overlay: false,
    needsAux: () => ['openInterest'],
    outputs: (cfg) =>
      cfg.mode === 'changePct'
        ? [
            { kind: 'histogram', id: 'chg', title: 'OI change %', color: 'bull', negColor: 'bear' },
            { kind: 'hline', id: 'zero', title: 'Zero', value: 0, color: 'muted' },
          ]
        : [{ kind: 'line', id: 'oi', title: 'Open interest (USD)', color: '#29b6f6', width: 2 }],
    signals: [
      { id: 'OI_SURGE', dir: 'neutral', description: 'Open interest rose more than 5% vs the lookback' },
      { id: 'OI_DROP', dir: 'neutral', description: 'Open interest fell more than 5% vs the lookback' },
    ],
    init: () => ({ ring: [] as number[] }),
    update(cfg, s, x, w) {
      const v = x.aux.openInterest?.[w.i];
      if (!Number.isFinite(v) || !(v as number > 0)) return;
      const look = Math.max(1, cfg.changeLength);
      s.ring.push(v as number);
      if (s.ring.length > look + 1) s.ring.shift();
      const base = s.ring.length > look ? s.ring[0] : NaN;
      const chg = Number.isFinite(base) && base > 0 ? (100 * ((v as number) - base)) / base : NaN;
      if (Number.isFinite(chg)) {
        if (chg >= 5) w.signal('OI_SURGE', 'neutral', x.c[w.i]);
        if (chg <= -5) w.signal('OI_DROP', 'neutral', x.c[w.i]);
      }
      if (cfg.mode === 'changePct') {
        if (Number.isFinite(chg)) w.line(0, chg);
      } else w.line(0, v as number);
    },
  },
);

export const longShortRatio = defineStudy(z.object({}), {
  id: 'long-short-ratio',
  name: 'Perp Long/Short Ratio',
  shortName: 'L/S',
  version: '1.0.0',
  category: 'Volume',
  description: 'OKX long/short account ratio (accounts long ÷ accounts short). Above 1 means more accounts are long. Crypto only.',
  overlay: false,
  needsAux: () => ['longShort'],
  outputs: () => [
    { kind: 'line', id: 'ls', title: 'Long/short ratio', color: '#ab47bc', width: 2 },
    { kind: 'hline', id: 'one', title: '1.0', value: 1, color: 'muted', style: 'dashed' },
  ],
  init: () => ({}),
  update(_cfg, _s, x, w) {
    const v = x.aux.longShort?.[w.i];
    if (!Number.isFinite(v)) return;
    w.line(0, v as number);
  },
});

export const shortInterest = defineStudy(
  z.object({
    showChange: bool(true, { title: 'Show shares-short % change' }),
  }),
  {
    id: 'short-interest',
    name: 'Equity Short Interest',
    shortName: 'Short Int',
    version: '1.0.0',
    category: 'Volume',
    description:
      'FINRA consolidated short interest: days to cover and optional % change in shares short (twice-monthly settlement). US equities only; not percent of float.',
    overlay: false,
    needsAux: () => ['shortInterest', 'daysToCover'],
    outputs: (cfg) => [
      { kind: 'line', id: 'dtc', title: 'Days to cover', color: '#ff9800', width: 2 },
      ...(cfg.showChange
        ? ([{ kind: 'histogram' as const, id: 'chg', title: 'Shares short change %', color: 'bear' as const, negColor: 'bull' as const }] as const)
        : []),
    ],
    signals: [
      { id: 'SHORT_INTEREST_RISE', dir: 'bear', description: 'Shares short rose at least 10% vs the prior settlement' },
      { id: 'SHORT_INTEREST_FALL', dir: 'bull', description: 'Shares short fell at least 10% vs the prior settlement' },
    ],
    init: () => ({ lastShares: NaN }),
    update(cfg, s, x, w) {
      const shares = x.aux.shortInterest?.[w.i];
      const dtc = x.aux.daysToCover?.[w.i];
      if (Number.isFinite(dtc)) w.line(0, dtc as number);
      if (Number.isFinite(shares)) {
        if (cfg.showChange && Number.isFinite(s.lastShares) && s.lastShares > 0 && (shares as number) !== s.lastShares) {
          const chg = (100 * ((shares as number) - s.lastShares)) / s.lastShares;
          w.line(1, chg);
          if (chg >= 10) w.signal('SHORT_INTEREST_RISE', 'bear', x.c[w.i]);
          if (chg <= -10) w.signal('SHORT_INTEREST_FALL', 'bull', x.c[w.i]);
        }
        s.lastShares = shares as number;
      }
    },
  },
);

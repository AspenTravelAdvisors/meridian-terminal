import { z } from 'zod';
import { sumInit, sumPush } from '../../core/rolling';
import { bool, defineStudy, int, num } from '../../core/params';
import type { SeriesCtx, SignalDir, StudyStatus, Writer } from '../../core/types';
import { tr } from './common';

/**
 * Market-moving news at price flips. The chart loads dated events (company filings, industry and market-wide events)
 * and places them on bars as three aux columns holding each bar's largest event weight (1–3):
 * `newsTicker`, `newsIndustry`, `newsMarket`. See packages/data/src/news.ts.
 *
 * An event is shown only when it (a) is important enough, (b) moved this symbol, judged from the bar's true range
 * against its recent average, and (c) sits within a few bars of a price flip (INDICATORS §1.1). It is drawn on the
 * event's bar but only once every condition holds, so a flip that comes after the news finalizes the marker later.
 * The engine stays pure: without aux the study draws nothing.
 */

const SCOPES = [
  { aux: 'newsTicker', key: 'ticker', bit: 1, tag: 'CO', name: 'Company' },
  { aux: 'newsIndustry', key: 'industry', bit: 2, tag: 'IND', name: 'Industry' },
  { aux: 'newsMarket', key: 'market', bit: 4, tag: 'MKT', name: 'Market-wide' },
] as const;

interface Pending {
  /** event bar */
  e: number;
  /** scope bits present */
  mask: number;
  /** largest reaction (true range ÷ average) seen in the reaction window */
  ratio: number;
  /** flip direction found near the event: 1 bullish, −1 bearish, 0 none yet */
  flip: number;
  flipBar: number;
}

interface State {
  trs: ReturnType<typeof sumInit>;
  lastUp: number;
  lastDown: number;
  pending: Pending[];
  last: { e: number; at: number; dir: number; mask: number; ratio: number } | null;
}

const tags = (mask: number) =>
  SCOPES.filter((s) => mask & s.bit)
    .map((s) => s.tag)
    .join('+');
const names = (mask: number) =>
  SCOPES.filter((s) => mask & s.bit)
    .map((s) => s.name.toLowerCase())
    .join(' and ');

export const newsEvents = defineStudy(
  z.object({
    ticker: bool(true, { title: 'Company events', group: 'Events', description: 'SEC 8-K filings and coin-specific events.' }),
    industry: bool(true, { title: 'Industry events', group: 'Events', description: 'Events that hit this symbol’s sector.' }),
    market: bool(true, { title: 'Market-wide events', group: 'Events', description: 'Crashes, central-bank shocks, elections, wars.' }),
    minWeight: int(2, 1, 3, {
      title: 'Minimum importance (1–3)',
      group: 'Events',
      description: '1 = notable, 2 = major, 3 = landmark. Each source rates its events; see INDICATORS.md §10.',
    }),
    requireFlip: bool(true, { title: 'Only near a price flip', group: 'Price flip' }),
    flipWindow: int(3, 0, 20, { title: 'Flip window (bars either side)', group: 'Price flip' }),
    flipLookback: int(4, 1, 20, { title: 'Flip lookback', group: 'Price flip', description: 'Same comparison as the Sequential setup (default 4).' }),
    requireReaction: bool(true, { title: 'Require a price reaction', group: 'Reaction' }),
    reactionAtr: num(1.5, 0, 10, {
      title: 'Reaction (× average range)',
      group: 'Reaction',
      description: 'The event bar, or a bar right after it, must have a true range at least this multiple of the average true range before it.',
    }),
    reactionBars: int(2, 1, 5, { title: 'Reaction window (bars)', group: 'Reaction', description: 'Bars from the event bar that may show the reaction (2 covers news after the close).' }),
    atrLength: int(14, 2, 200, { title: 'Average range length', group: 'Reaction' }),
  }),
  {
    id: 'news-events',
    name: 'Market-Moving News',
    shortName: 'News',
    version: '1.0.0',
    category: 'Meridian',
    description:
      'Significant company, industry and market-wide news, shown only where price reacted and a price flip happened nearby. Free sources: SEC 8-K filings and a built-in list of landmark events.',
    overlay: true,
    needsAux: (cfg) => SCOPES.filter((s) => cfg[s.key]).map((s) => s.aux),
    outputs: () => [{ kind: 'data', id: 'news', title: 'News at flip (1 co + 2 ind + 4 mkt; − = down flip)' }],
    signals: [
      { id: 'NEWS_AT_FLIP_UP', dir: 'bull', description: 'Significant news with a bullish price flip within the window' },
      { id: 'NEWS_AT_FLIP_DOWN', dir: 'bear', description: 'Significant news with a bearish price flip within the window' },
      { id: 'NEWS_EVENT', dir: 'neutral', description: 'Significant news with no flip nearby (only when the flip requirement is off)' },
    ],
    init: (cfg): State => ({ trs: sumInit(cfg.atrLength), lastUp: -1e9, lastDown: -1e9, pending: [], last: null }),
    update(cfg, s, x, w) {
      const i = w.i;
      const c = x.c;
      const lb = cfg.flipLookback;
      const W = cfg.flipWindow;

      // price flips (INDICATORS §1.1)
      if (i > lb) {
        if (c[i - 1] < c[i - 1 - lb] && c[i] > c[i - lb]) s.lastUp = i;
        if (c[i - 1] > c[i - 1 - lb] && c[i] < c[i - lb]) s.lastDown = i;
      }

      // reaction: this bar's true range against the average of the bars before it
      const range = tr(x, i);
      const count = s.trs.ring.count;
      const avg = count ? s.trs.sum / count : NaN;
      const ratio = count ? (avg > 0 ? range / avg : range > 0 ? Infinity : 0) : NaN;
      sumPush(s.trs, range);

      // today's events
      let mask = 0;
      for (const sc of SCOPES) {
        if (!cfg[sc.key]) continue;
        const v = x.aux[sc.aux]?.[i];
        if (v !== undefined && v >= cfg.minWeight) mask |= sc.bit;
      }
      if (mask) s.pending.push({ e: i, mask, ratio: NaN, flip: 0, flipBar: -1 });

      for (let k = 0; k < s.pending.length; k++) {
        const p = s.pending[k];
        if (i - p.e < cfg.reactionBars && Number.isFinite(ratio) && !(p.ratio >= ratio)) p.ratio = ratio;
        if (!p.flip) {
          // nearest flip to the event among those already seen
          const up = Math.abs(s.lastUp - p.e) <= W ? Math.abs(s.lastUp - p.e) : Infinity;
          const dn = Math.abs(s.lastDown - p.e) <= W ? Math.abs(s.lastDown - p.e) : Infinity;
          if (up < Infinity || dn < Infinity) {
            const useUp = up < dn || (up === dn && s.lastUp > s.lastDown);
            p.flip = useUp ? 1 : -1;
            p.flipBar = useUp ? s.lastUp : s.lastDown;
          }
        }
        const reacted = !cfg.requireReaction || p.ratio >= cfg.reactionAtr;
        const flipped = !cfg.requireFlip || p.flip !== 0;
        const done = reacted && flipped;
        const expired = i - p.e >= Math.max(W, cfg.reactionBars - 1);
        if (done) {
          emit(s, x, w, p);
          s.pending.splice(k--, 1);
        } else if (expired) s.pending.splice(k--, 1);
      }
    },
    status(_cfg, s, x): StudyStatus {
      const l = s.last;
      if (!l) return { chips: [], values: { barsSince: null } };
      const since = x.len - 1 - l.e;
      const dir: SignalDir = l.dir > 0 ? 'bull' : l.dir < 0 ? 'bear' : 'neutral';
      const chips = since <= 20 ? [{ text: `News ${l.dir > 0 ? '↑' : l.dir < 0 ? '↓' : '•'} ${tags(l.mask)}`, dir }] : [];
      return { chips, values: { barsSince: since, scope: tags(l.mask), reaction: Number.isFinite(l.ratio) ? Math.round(l.ratio * 100) / 100 : null } };
    },
  },
);

function emit(s: State, x: SeriesCtx, w: Writer, p: Pending): void {
  const dir = p.flip;
  const where =
    dir === 0
      ? 'with no price flip nearby'
      : `at a ${dir > 0 ? 'bullish' : 'bearish'} price flip ${p.flipBar === p.e ? 'on the same bar' : `${Math.abs(p.flipBar - p.e)} bar${Math.abs(p.flipBar - p.e) > 1 ? 's' : ''} ${p.flipBar > p.e ? 'later' : 'earlier'}`}`;
  const moved = Number.isFinite(p.ratio) ? `; the bar moved ${p.ratio === Infinity ? 'far' : `${p.ratio.toFixed(1)}×`} its average range` : '';
  w.marker({
    i: p.e,
    text: tags(p.mask),
    pos: dir > 0 ? 'below' : 'above',
    color: dir > 0 ? 'bull' : dir < 0 ? 'bear' : 'info',
    row: 7,
    // size 2: kept when the chart is zoomed out and never dropped for overlapping a count label
    size: 2,
    style: 'boxed',
    tooltip: `${cap(names(p.mask))} news ${where}${moved}.`,
  });
  w.signal(dir > 0 ? 'NEWS_AT_FLIP_UP' : dir < 0 ? 'NEWS_AT_FLIP_DOWN' : 'NEWS_EVENT', dir > 0 ? 'bull' : dir < 0 ? 'bear' : 'neutral', x.c[w.i], tags(p.mask));
  w.line(0, dir < 0 ? -p.mask : p.mask);
  s.last = { e: p.e, at: w.i, dir, mask: p.mask, ratio: p.ratio };
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

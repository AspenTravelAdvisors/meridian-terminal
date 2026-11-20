import { INTERVAL_MS, type Interval } from '@meridian/data';
import { type Bar, alignByTime, alignEvents, alignHTF, bucketEvents, getStudy } from '@meridian/engine';
import { useEffect, useState } from 'react';
import { getBarsCached } from '../data/useBars';
import { compute } from '../engine/compute';
import { type NewsEventDto, type PositioningKind, fetchNewsClient, fetchPositioningClient } from '../lib/api';
import type { StudyInstanceCfg } from '../state/types';

const HIGHER: Partial<Record<Interval, Interval>> = { '1m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '1D', '4h': '1W', '1D': '1W', '1W': '1M', '1M': '3M' };

/** News study aux columns, by event scope. */
const NEWS_AUX = { ticker: 'newsTicker', industry: 'newsIndustry', market: 'newsMarket' } as const;
const NEWS_AUX_NAMES = new Set<string>(Object.values(NEWS_AUX));

const POSITIONING_AUX: Record<string, PositioningKind> = {
  funding: 'funding',
  openInterest: 'openInterest',
  longShort: 'longShort',
  shortInterest: 'shortInterest',
  daysToCover: 'daysToCover',
};

/**
 * Auxiliary series for studies that need them (benchmark closes for RS/correlation, higher-timeframe
 * Sequential counts for the confluence score, positioning feeds, news events), aligned onto the pane's bars WITHOUT
 * look-ahead. `notes` holds the news events of each bar that has any, for the News study's marker tooltips.
 */
export function useAux(symbol: string, cfgs: StudyInstanceCfg[], bars: Bar[], interval: Interval): AuxState {
  const [aux, setAux] = useState<AuxState>({ aux: {}, key: '' });
  const wants: { kind: 'benchmark' | 'htf' | 'positioning' | 'news'; symbol?: string; auxName?: string; posKind?: PositioningKind }[] = [];
  for (const c of cfgs) {
    const def = getStudy(c.id);
    const names = def?.needsAux?.(c.cfg) ?? [];
    if (names.includes('benchmark')) wants.push({ kind: 'benchmark', symbol: String(c.cfg.benchmark ?? 'SPY') });
    if (names.includes('htfSetup')) wants.push({ kind: 'htf' });
    for (const n of names) {
      const pk = POSITIONING_AUX[n];
      if (pk) wants.push({ kind: 'positioning', auxName: n, posKind: pk });
    }
    if (names.some((n) => NEWS_AUX_NAMES.has(n))) wants.push({ kind: 'news' });
  }
  const wantKey = JSON.stringify(wants);
  const n = bars.length;
  const first = bars[0]?.t;
  const last = bars[n - 1]?.t;
  useEffect(() => {
    if (!wants.length || !n) {
      setAux({ aux: {}, key: '' });
      return;
    }
    let dead = false;
    (async () => {
      const out: Record<string, number[]> = {};
      let notes: Record<number, NewsEventDto[]> | undefined;
      const seen = new Set<string>();
      for (const w of wants) {
        const dedupe = w.kind === 'positioning' ? `pos:${w.auxName}` : w.kind === 'benchmark' ? `bm:${w.symbol}` : w.kind;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        try {
          if (w.kind === 'benchmark' && w.symbol) out.benchmark = Array.from(alignByTime(bars, await getBarsCached(w.symbol, interval, 2000)));
          if (w.kind === 'htf') Object.assign(out, await htfSequential(symbol, interval, bars));
          if (w.kind === 'positioning' && w.auxName && w.posKind) {
            const series = await fetchPositioningClient(symbol, w.posKind, { interval, from: first });
            out[w.auxName] = Array.from(alignEvents(bars, INTERVAL_MS[interval], series.points));
          }
          if (w.kind === 'news') {
            const ms = INTERVAL_MS[interval];
            const feed = await fetchNewsClient(symbol, { from: first, to: last + ms });
            Object.assign(out, newsColumns(bars, ms, feed.events));
            notes = newsByBar(bars, ms, feed.events);
          }
        } catch {
          /* aux unavailable — study renders without it */
        }
      }
      if (!dead) setAux({ aux: out, key: `${wantKey}|${first}|${last}|${n}`, notes });
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, wantKey, first, last, n, interval]);
  return aux;
}

/** Higher-timeframe Sequential columns aligned to base bars (used when Confluence has useHtf on). */
export async function htfSequential(symbol: string, interval: Interval, bars: Bar[]): Promise<Record<string, number[]>> {
  const hiv = HIGHER[interval];
  if (!hiv) return {};
  const hb = (await getBarsCached(symbol, hiv, 1500)).filter((b) => b.final !== false);
  const lines = await compute<Record<string, number[]>>({ op: 'lines', bars: hb, study: 'td-sequential', outputs: ['setup', 'countdown'] });
  return {
    htfSetup: Array.from(alignHTF(bars, INTERVAL_MS[interval], hb, INTERVAL_MS[hiv], lines.setup ?? [])),
    htfCountdown: Array.from(alignHTF(bars, INTERVAL_MS[interval], hb, INTERVAL_MS[hiv], lines.countdown ?? [])),
  };
}

export interface AuxState {
  aux: Record<string, number[]>;
  key: string;
  /** news events by bar index (News study tooltips) */
  notes?: Record<number, NewsEventDto[]>;
}

/** One column per scope holding each bar's largest event weight (engine `newsTicker` / `newsIndustry` / `newsMarket`). */
export function newsColumns(bars: Bar[], ms: number, events: NewsEventDto[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [scope, name] of Object.entries(NEWS_AUX))
    out[name] = Array.from(bucketEvents(bars, ms, events.filter((e) => e.scope === scope).map((e) => ({ t: e.t, v: e.weight }))));
  return out;
}

/** The events behind each bar, placed with the same rule as the columns (`bucketEvents`): the bar they happen in, or the
 * next bar when they fall between bars. */
export function newsByBar(bars: Bar[], ms: number, events: NewsEventDto[]): Record<number, NewsEventDto[]> {
  const out: Record<number, NewsEventDto[]> = {};
  if (!bars.length) return out;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  let i = 0;
  for (const e of sorted) {
    if (e.t < bars[0].t) continue;
    while (i < bars.length && bars[i].t + ms <= e.t) i++;
    if (i >= bars.length) break;
    (out[i] ??= []).push(e);
  }
  return out;
}

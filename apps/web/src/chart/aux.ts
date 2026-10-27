import { INTERVAL_MS, type Interval } from '@meridian/data';
import { type Bar, alignByTime, alignHTF, getStudy } from '@meridian/engine';
import { useEffect, useState } from 'react';
import { getBarsCached } from '../data/useBars';
import { compute } from '../engine/compute';
import type { StudyInstanceCfg } from '../state/types';

const HIGHER: Partial<Record<Interval, Interval>> = { '1m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '1D', '4h': '1W', '1D': '1W', '1W': '1M', '1M': '3M' };

/**
 * Auxiliary series for studies that need them (benchmark closes for RS/correlation, higher-timeframe
 * Sequential counts for the confluence score), aligned onto the pane's bars WITHOUT look-ahead.
 */
export function useAux(symbol: string, cfgs: StudyInstanceCfg[], bars: Bar[], interval: Interval): { aux: Record<string, number[]>; key: string } {
  const [aux, setAux] = useState<{ aux: Record<string, number[]>; key: string }>({ aux: {}, key: '' });
  const wants: { kind: 'benchmark' | 'htf'; symbol?: string }[] = [];
  for (const c of cfgs) {
    const def = getStudy(c.id);
    const names = def?.needsAux?.(c.cfg) ?? [];
    if (names.includes('benchmark')) wants.push({ kind: 'benchmark', symbol: String(c.cfg.benchmark ?? 'SPY') });
    if (names.includes('htfSetup')) wants.push({ kind: 'htf' });
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
      for (const w of wants) {
        try {
          if (w.kind === 'benchmark' && w.symbol) out.benchmark = Array.from(alignByTime(bars, await getBarsCached(w.symbol, interval, 2000)));
          if (w.kind === 'htf') Object.assign(out, await htfSequential(symbol, interval, bars));
        } catch {
          /* aux unavailable — study renders without it */
        }
      }
      if (!dead) setAux({ aux: out, key: `${wantKey}|${first}|${last}|${n}` });
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

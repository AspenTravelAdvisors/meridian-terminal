import { resolveConfig } from '../core/params';
import { computeStudies } from '../core/runner';
import type { Bar, StudyStatus } from '../core/types';
import { getStudy } from '../registry';

export interface ScanStudy {
  id: string;
  cfg?: Record<string, unknown>;
}

export interface ScanRow {
  symbol: string;
  last: number;
  changePct: number;
  bars: number;
  statuses: Record<string, StudyStatus | null>;
  signals: { id: string; study: string; dir: string; barsAgo: number; price?: number }[];
  error?: string;
}

/** Run studies over one symbol's bars and summarize — identical in the browser worker and on the server. */
export function scanBars(symbol: string, bars: readonly Bar[], studies: ScanStudy[], opts: { lookback?: number; signals?: string[] } = {}): ScanRow {
  const lookback = opts.lookback ?? 10;
  const reqs = studies
    .map((s) => {
      const def = getStudy(s.id);
      return def ? { def, cfg: resolveConfig(def, s.cfg ?? {}), key: s.id } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const n = bars.length;
  const row: ScanRow = {
    symbol,
    last: n ? bars[n - 1].c : NaN,
    changePct: n > 1 ? (100 * (bars[n - 1].c - bars[n - 2].c)) / bars[n - 2].c : NaN,
    bars: n,
    statuses: {},
    signals: [],
  };
  if (!n) return row;
  const results = computeStudies(reqs, bars);
  const want = opts.signals?.length ? new Set(opts.signals) : null;
  for (const r of results) {
    row.statuses[r.id] = r.status;
    for (const s of r.signals) {
      const ago = n - 1 - s.i;
      if (ago > lookback) continue;
      if (want && !want.has(s.id)) continue;
      row.signals.push({ id: s.id, study: r.id, dir: s.dir, barsAgo: ago, price: s.price });
    }
  }
  row.signals.sort((a, b) => a.barsAgo - b.barsAgo);
  return row;
}

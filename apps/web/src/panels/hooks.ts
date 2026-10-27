import type { Interval, Quote } from '@meridian/data';
import type { StudyStatus } from '@meridian/engine';
import { useQuery } from '@tanstack/react-query';
import { getBarsCached } from '../data/useBars';
import { compute } from '../engine/compute';
import { postJson, quotesClient } from '../lib/api';
import { emptyRuntime, useUi, useWorkspace } from '../state/store';

export function useActive() {
  const pane = useWorkspace((s) => s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0]);
  const rt = useUi((s) => s.runtime[pane.id]) ?? emptyRuntime();
  return { pane, rt };
}

export function useQuotes(symbols: string[]) {
  return useQuery({
    queryKey: ['quotes', symbols.join(',')],
    queryFn: async () => {
      const q = await quotesClient(symbols);
      return Object.fromEntries(q.map((x) => [x.symbol, x])) as Record<string, Quote>;
    },
    enabled: symbols.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });
}

export interface StatusResult {
  key: string;
  status: StudyStatus | null;
  signals: { i: number; id: string; dir: string; price?: number }[];
}

/** Sequential + Combo (+ extras) status for symbol × timeframe, computed off-thread. */
export function useStatus(symbol: string, interval: Interval, studies: { key: string; id: string; cfg?: Record<string, unknown> }[] = DEFAULT_STATUS, enabled = true) {
  return useQuery({
    queryKey: ['status', symbol, interval, JSON.stringify(studies)],
    queryFn: async () => {
      const bars = (await getBarsCached(symbol, interval, 600)).filter((b) => b.final !== false);
      const res = await compute<StatusResult[]>({ op: 'statuses', bars, studies });
      return { bars, res };
    },
    enabled,
    staleTime: 120_000,
    retry: 1,
  });
}

export const DEFAULT_STATUS = [
  { key: 'seq', id: 'td-sequential' },
  { key: 'combo', id: 'td-combo' },
];

export interface MatrixCellDto {
  symbol: string;
  interval: Interval;
  cell?: { label: string; dir: string; score: number; detail: Record<string, number | null> };
  error?: string;
  simulated?: boolean;
}

/** Server-side MTF matrix with a client-side fallback (same engine code). */
export async function fetchMatrix(symbols: string[], intervals: Interval[]): Promise<MatrixCellDto[]> {
  try {
    const out: MatrixCellDto[] = [];
    for (let k = 0; k < symbols.length; k += 15) {
      const chunk = symbols.slice(k, k + 15).filter(Boolean);
      const per = Math.max(1, Math.floor(90 / intervals.length));
      for (let j = 0; j < chunk.length; j += per) out.push(...(await postJson<{ cells: MatrixCellDto[] }>('/api/matrix', { symbols: chunk.slice(j, j + per), intervals })).cells);
    }
    return out;
  } catch {
    const pairs = symbols.flatMap((s) => intervals.map((iv) => [s, iv] as const));
    return Promise.all(
      pairs.map(async ([symbol, interval]) => {
        try {
          const bars = (await getBarsCached(symbol, interval, 400)).filter((b) => b.final !== false);
          return { symbol, interval, cell: await compute<MatrixCellDto['cell']>({ op: 'matrix', bars }) };
        } catch (e) {
          return { symbol, interval, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }
}

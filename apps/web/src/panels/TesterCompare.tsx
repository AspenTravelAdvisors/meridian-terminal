import { type CI, type TestRunRecord, trialAdjustedP } from '@meridian/engine';
import { LineSeries, ColorType, createChart, type UTCTimestamp } from 'lightweight-charts';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { readTheme } from '../chart/render';
import { download } from '../lib/download';
import { fmtMoney, fmtNum, fmtPct } from '../lib/format';

// Signal Tester comparison: saved runs side by side with their uncertainty, and a per-device log of how many
// parameter sets were tried on each dataset, so the best of many tries isn't read as evidence.

const storage = createJSONStorage(() => localStorage);

// ── Trial log ───────────────────────────────────────────────────────────────
interface TrialLogState {
  /** dataset key (symbols | interval | period) → distinct parameter-set hashes tried, in order */
  trials: Record<string, string[]>;
  record(key: string, paramsHash: string): number;
  clear(key: string): void;
}
export const useTrialLog = create<TrialLogState>()(
  persist(
    (set, get) => ({
      trials: {},
      record(key, h) {
        const prev = get().trials[key] ?? [];
        const next = prev.includes(h) ? prev : [...prev, h];
        set({ trials: { ...get().trials, [key]: next } });
        return next.length;
      },
      clear: (key) => set({ trials: Object.fromEntries(Object.entries(get().trials).filter(([k]) => k !== key)) }),
    }),
    { name: 'meridian.trial-log', storage },
  ),
);

export type PooledRow = { h: number; n: number; mean: number; median: number; hit: number; baseline: number; ci95: CI; t: number; p: number };

/** "n events, p = 0.03 at 20 bars; after 12 parameter sets the best-of-12 chance is 0.31" — shown above results. */
export function TrialBanner({ trials, datasetLabel, row, onClear }: { trials: number; datasetLabel: string; row?: PooledRow; onClear(): void }) {
  const adj = row ? trialAdjustedP(row.p, trials) : NaN;
  const warn = trials > 1;
  return (
    <p className={`mb-1 text-[11px] ${warn ? 'text-warn' : 'text-faint'}`}>
      {trials === 1 ? 'First parameter set tried' : `${trials} parameter sets tried`} on {datasetLabel} (this device).
      {row && Number.isFinite(row.p) && (
        <>
          {' '}At {row.h} bars, p = {row.p.toFixed(3)}
          {warn ? `; the chance that the best of ${trials} tries looks this good by luck is about ${adj.toFixed(2)}` : ''}.
        </>
      )}{' '}
      {warn && 'Confirm on a test period or other symbols before trusting it.'}{' '}
      <button className="underline hover:text-text" onClick={onClear}>reset count</button>
    </p>
  );
}

// ── Saved runs ──────────────────────────────────────────────────────────────
export interface SavedRun {
  id: string;
  name: string;
  savedAt: number;
  symbols: string[];
  interval: string;
  study: string;
  period: string;
  data: string[];
  engineVersion: string;
  runHashes: string[];
  trials: number;
  pooled: PooledRow[];
  strategy?: {
    stats: Pick<NonNullable<TestRunRecord['strategy']>['stats'], 'trades' | 'winRate' | 'totalReturn' | 'maxDrawdown' | 'sharpe' | 'exposure' | 'profitFactor' | 'startCapital' | 'endCapital'>;
    tradeStats: NonNullable<TestRunRecord['strategy']>['tradeStats'];
    benchmarks: NonNullable<TestRunRecord['strategy']>['benchmarks'];
    /** equity multiple, thinned to ≤ 400 points */
    curve: { t: number; v: number }[];
  };
}

interface SavedState {
  runs: SavedRun[];
  save(r: SavedRun): void;
  rename(id: string, name: string): void;
  remove(id: string): void;
}
export const useSavedRuns = create<SavedState>()(
  persist(
    (set, get) => ({
      runs: [],
      save: (r) => set({ runs: [...get().runs.filter((x) => x.id !== r.id), r].slice(-30) }),
      rename: (id, name) => set({ runs: get().runs.map((r) => (r.id === id ? { ...r, name } : r)) }),
      remove: (id) => set({ runs: get().runs.filter((r) => r.id !== id) }),
    }),
    { name: 'meridian.saved-runs', storage },
  ),
);

export function savedFrom(records: TestRunRecord[], pooled: PooledRow[], meta: { name: string; study: string; period: string; trials: number; savedAt: number }): SavedRun {
  const s = records.length === 1 ? records[0].strategy : null;
  const step = s ? Math.max(1, Math.ceil(s.equity.length / 400)) : 1;
  return {
    id: records.map((r) => r.hashes.run).join('+'),
    name: meta.name,
    savedAt: meta.savedAt,
    symbols: records.map((r) => r.data.symbol),
    interval: records[0]?.data.interval ?? '',
    study: meta.study,
    period: meta.period,
    data: records.map((r) => `${r.data.symbol} ${r.data.provider} · ${r.data.adjust} · ${r.data.evaluated.from} → ${r.data.evaluated.to} · ${r.data.evaluated.bars} bars`),
    engineVersion: records[0]?.engineVersion ?? '',
    runHashes: records.map((r) => r.hashes.run),
    trials: meta.trials,
    pooled,
    ...(s
      ? {
          strategy: {
            stats: { trades: s.stats.trades, winRate: s.stats.winRate, totalReturn: s.stats.totalReturn, maxDrawdown: s.stats.maxDrawdown, sharpe: s.stats.sharpe, exposure: s.stats.exposure, profitFactor: s.stats.profitFactor, startCapital: s.stats.startCapital, endCapital: s.stats.endCapital },
            tradeStats: s.tradeStats,
            benchmarks: s.benchmarks,
            curve: s.equity.filter((_, k) => k % step === 0 || k === s.equity.length - 1).map((e) => ({ t: e.t, v: e.equity })),
          },
        }
      : {}),
  };
}

const ci = (c?: CI) => (c && Number.isFinite(c.lo) ? `${fmtPct(c.lo, 1)} … ${fmtPct(c.hi, 1)}` : '—');
const pc = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');
const COLORS = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#facc15'];

function Overlay({ runs }: { runs: SavedRun[] }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const th = readTheme();
    const chart = createChart(el.current, { autoSize: true, layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: th.text, attributionLogo: false }, grid: { vertLines: { visible: false }, horzLines: { color: th.grid } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false } });
    runs.forEach((r, k) => {
      if (!r.strategy) return;
      let prev = -Infinity;
      const pts = r.strategy.curve.map((p) => {
        let s = Math.floor(p.t / 1000);
        if (s <= prev) s = prev + 1;
        prev = s;
        return { time: s as UTCTimestamp, value: p.v };
      });
      chart.addSeries(LineSeries, { color: COLORS[k % COLORS.length], lineWidth: 2, title: r.name }).setData(pts);
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [runs]);
  return <div ref={el} className="h-44 w-full" />;
}

export function CompareView({ horizon }: { horizon: number }) {
  const runs = useSavedRuns((s) => s.runs);
  const rename = useSavedRuns((s) => s.rename);
  const remove = useSavedRuns((s) => s.remove);
  const [h, setH] = useState(horizon);
  if (!runs.length) return <p className="p-3 text-faint">No saved runs yet. Run a test, then “Save run” to compare it here.</p>;
  const hs = [...new Set(runs.flatMap((r) => r.pooled.map((p) => p.h)))].sort((a, b) => a - b);
  const at = (r: SavedRun) => r.pooled.find((p) => p.h === h);
  const strat = runs.some((r) => r.strategy);
  type Row = [string, (r: SavedRun) => string, string?];
  const rows: Row[] = [
    ['Symbols', (r) => r.symbols.join(', ')],
    ['Interval · study', (r) => `${r.interval} · ${r.study}`],
    ['Period', (r) => r.period],
    ['Parameter sets tried (at save)', (r) => String(r.trials), 'More tries make the best one less trustworthy.'],
    [`Events (${h} bars)`, (r) => String(at(r)?.n ?? '—')],
    ['Mean return', (r) => fmtPct(at(r)?.mean)],
    ['95% interval', (r) => ci(at(r)?.ci95), 'Seeded bootstrap of the mean. If it spans 0, the sample can’t tell the signal from no effect.'],
    ['Hit rate', (r) => pc(at(r)?.hit ?? NaN)],
    ['Edge vs random entries', (r) => fmtPct((at(r)?.mean ?? NaN) - (at(r)?.baseline ?? NaN))],
    ['p (single test)', (r) => (Number.isFinite(at(r)?.p ?? NaN) ? at(r)!.p.toFixed(3) : '—')],
    ['p after trials', (r) => (Number.isFinite(at(r)?.p ?? NaN) ? trialAdjustedP(at(r)!.p, r.trials).toFixed(3) : '—'), 'Chance the best of that many tries looks this good by luck.'],
  ];
  if (strat)
    rows.push(
      ['Trades', (r) => String(r.strategy?.stats.trades ?? '—')],
      ['Win rate', (r) => pc(r.strategy?.stats.winRate ?? NaN)],
      ['Average win', (r) => (r.strategy ? `${fmtPct(r.strategy.tradeStats.avgWinPct)} · ${fmtMoney(r.strategy.tradeStats.avgWinUsd, 0)}` : '—')],
      ['Average loss', (r) => (r.strategy ? `${fmtPct(r.strategy.tradeStats.avgLossPct)} · ${fmtMoney(r.strategy.tradeStats.avgLossUsd, 0)}` : '—')],
      ['Expectancy per trade', (r) => (r.strategy ? `${fmtPct(r.strategy.tradeStats.expectancyPct)} · ${fmtMoney(r.strategy.tradeStats.expectancyUsd, 0)}` : '—')],
      ['Expectancy 95% interval', (r) => ci(r.strategy?.tradeStats.expectancyCI)],
      ['Payoff (avg win ÷ avg loss)', (r) => fmtNum(r.strategy?.tradeStats.payoff)],
      ['Total return', (r) => fmtPct(r.strategy?.stats.totalReturn)],
      ['Capital', (r) => (r.strategy ? `${fmtMoney(r.strategy.stats.startCapital, 0)} → ${fmtMoney(r.strategy.stats.endCapital, 0)}` : '—')],
      ['Exposure (time / avg invested)', (r) => (r.strategy ? `${pc(r.strategy.stats.exposure)} / ${pc(r.strategy.benchmarks.avgGrossExposure)}` : '—')],
      ['Buy & hold at that exposure', (r) => fmtPct(r.strategy?.benchmarks.exposureMatchedPct), 'The underlying held at the strategy’s average invested share, every bar: what the exposure alone earned.'],
      ['Same trades at random dates', (r) => (r.strategy?.benchmarks.randomTiming.samples ? `${fmtPct(r.strategy.benchmarks.randomTiming.p05, 1)} … ${fmtPct(r.strategy.benchmarks.randomTiming.p95, 1)} avg/trade; strategy beats ${pc(r.strategy.benchmarks.randomTiming.strategyPercentile)}` : '—'), 'Same count, side, holding period and costs, placed at random: does the timing add anything?'],
      ['Max drawdown', (r) => fmtPct(r.strategy?.stats.maxDrawdown)],
      ['Sharpe', (r) => fmtNum(r.strategy?.stats.sharpe)],
    );
  rows.push(['Engine · run', (r) => `${r.engineVersion} · ${r.runHashes.map((x) => x.slice(0, 8)).join(', ')}`], ['Data', (r) => r.data.join(' | ')]);
  return (
    <div className="p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="section-title px-0">Saved runs side by side</span>
        <label className="inline-flex items-center gap-1">
          horizon
          <select className="input" value={h} onChange={(e) => setH(Number(e.target.value))}>
            {hs.map((x) => <option key={x} value={x}>{x} bars</option>)}
          </select>
        </label>
        <button className="btn h-7" onClick={() => download('meridian-saved-runs.json', JSON.stringify({ schema: 'meridian.saved-runs/1', runs }, null, 1), 'application/json')}>Export JSON</button>
      </div>
      {strat && <Overlay runs={runs} />}
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th />
              {runs.map((r, k) => (
                <th key={r.id} className="min-w-40 align-top">
                  <div className="flex items-center gap-1">
                    <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: COLORS[k % COLORS.length] }} aria-hidden />
                    <input className="input h-6 w-full min-w-0" value={r.name} onChange={(e) => rename(r.id, e.target.value)} aria-label="Run name" />
                    <button className="icon-btn size-6 shrink-0" aria-label={`Remove ${r.name}`} onClick={() => remove(r.id)}><Trash2 className="size-3.5" /></button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f, tip]) => (
              <tr key={label}>
                <td className="whitespace-nowrap text-dim" title={tip}>{label}{tip ? ' ⓘ' : ''}</td>
                {runs.map((r) => <td key={r.id} className="tabular-nums">{f(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-faint">p-values use a normal approximation and treat events as independent; overlapping horizons make them look better than they are. Intervals and random benchmarks are seeded, so they reproduce exactly.</p>
    </div>
  );
}

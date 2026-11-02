import { INTERVALS, type Interval, UNIVERSES } from '@meridian/data';
import { type Bar, DEFAULT_MATRIX_WEIGHTS, type MatrixWeights, STUDIES, type ScanRow, type SizingMode, type StrategyConfig, TEST_EXPORT_SCHEMA, type TestRunCsvPart, type TestRunEvent, type TestRunRecord, type TestRunSource, type TestRunSpec, type TestWindow, type WalkForwardResult, bootstrapMeanCI, canonicalJson, getStudy, hashString, pTwoSided, histogram, matrixScore, replayQuery, rowConfluence, ruleIntervals, testRunCsv } from '@meridian/engine';
import { useMutation } from '@tanstack/react-query';
import { AreaSeries, ColorType, createChart, LineSeries, type UTCTimestamp } from 'lightweight-charts';
import { Play, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readTheme } from '../chart/render';
import { Chip, Empty, Field, Switch } from '../components/ui';
import { getBarsCached, getBarsSourced } from '../data/useBars';
import { download } from '../lib/download';
import { compute } from '../engine/compute';
import { postJson } from '../lib/api';
import { describeBars, fmtMoney, fmtNum, fmtPct, fmtPrice, signalLabel } from '../lib/format';
import { runScriptSandboxed } from '../engine/script';
import { activePane, useOosLog, useScripts, useUi, useWatchlists, useWorkspace } from '../state/store';
import type { UserScript } from '../state/types';
import { fetchMatrix, type MatrixCellDto } from './hooks';
import { RuleBuilder, useTesterRules } from './RuleBuilder';
import { CompareView, TrialBanner, savedFrom, useSavedRuns, useTrialLog } from './TesterCompare';
import { DEFAULT_OPTIONS, OptionsControls, OptionsResults, overlayFor } from './TesterOptions';
import type { OptionsOverlayResult, OptionsOverlaySpec } from '@meridian/portfolio';
import { ByYear, PeriodControls, TrainTestCompare, WalkForwardView, defaultPeriods, evalWindow, testWindow, wfSpec } from './TesterPeriods';

function useUniverses() {
  const lists = useWatchlists((s) => s.lists);
  return { ...Object.fromEntries(lists.map((l) => [`★ ${l.name}`, l.symbols])), ...UNIVERSES };
}

const openSymbol = (s: string, iv?: Interval) => {
  const ws = useWorkspace.getState();
  ws.setSymbol(ws.activePaneId, s);
  if (iv) ws.setInterval(ws.activePaneId, iv);
};

/** A saved script's signals over `bars`, in screener-row form (study = script name). */
async function scriptSignals(sc: UserScript, bars: Parameters<typeof runScriptSandboxed>[1], lookback: number): Promise<ScanRow['signals']> {
  const { result } = await runScriptSandboxed(sc.code, bars, sc.inputs);
  if (result.error) throw new Error(`${sc.name}: ${result.error}`);
  const n = bars.length;
  return result.signals.filter((s) => n - 1 - s.i <= lookback).map((s) => ({ id: s.id, study: sc.name, dir: s.dir, barsAgo: n - 1 - s.i }));
}

// ── Screener ────────────────────────────────────────────────────────────────
const SCREEN_STUDIES = ['td-sequential', 'td-combo', 'td-demarker-1', 'td-rei', 'ichimoku', 'rsi', 'td-dwave'];

export function ScreenerPanel() {
  const universes = useUniverses();
  const [uni, setUni] = useState(Object.keys(universes)[0]);
  const [interval, setIv] = useState<Interval>('1D');
  const [studies, setStudies] = useState<string[]>(['td-sequential', 'td-combo', 'td-demarker-1']);
  const [lookback, setLookback] = useState(5);
  const [signalFilter, setSignalFilter] = useState<string[]>([]);
  const [sort, setSort] = useState<'bars' | 'symbol' | 'chg'>('bars');
  const scripts = useScripts((s) => s.scripts);
  const [scriptIds, setScriptIds] = useState<string[]>([]);
  const allSignals = useMemo(() => studies.flatMap((id) => getStudy(id)?.signals?.map((s) => s.id) ?? []), [studies]);
  const run = useMutation({
    mutationFn: async () => {
      const symbols = universes[uni] ?? [];
      const body = { symbols, interval, studies: studies.map((id) => ({ id })), lookback, signals: signalFilter.length ? signalFilter : undefined };
      const chosen = scripts.filter((sc) => scriptIds.includes(sc.id));
      // user scripts run in this browser's sandbox, so a scan that includes them runs here too
      if (!chosen.length)
        try {
          return { ...(await postJson<{ rows: (ScanRow & { name?: string })[]; ms: number }>('/api/scan', body)), where: 'server' };
        } catch {
          /* fall through to the browser */
        }
      {
        const t0 = performance.now();
        const rows = await Promise.all(
          symbols.map(async (s) => {
            try {
              const bars = await getBarsCached(s, interval, 500);
              const row = await compute<ScanRow>({ op: 'scan', symbol: s, bars, studies: body.studies, lookback, signals: body.signals });
              for (const sc of chosen) row.signals.push(...(await scriptSignals(sc, bars, lookback)));
              row.signals.sort((a, b) => a.barsAgo - b.barsAgo);
              return row;
            } catch (e) {
              return { symbol: s, error: (e as Error).message, last: NaN, changePct: NaN, bars: 0, statuses: {}, signals: [] } as ScanRow;
            }
          }),
        );
        return { rows, ms: performance.now() - t0, where: 'browser' };
      }
    },
  });
  const rows = useMemo(() => {
    const r = (run.data?.rows ?? []).slice();
    const firstAgo = (x: ScanRow) => x.signals[0]?.barsAgo ?? 9999;
    r.sort((a, b) => (sort === 'symbol' ? a.symbol.localeCompare(b.symbol) : sort === 'chg' ? (b.changePct || 0) - (a.changePct || 0) : firstAgo(a) - firstAgo(b)));
    return signalFilter.length ? r.filter((x) => x.signals.length) : r;
  }, [run.data, sort, signalFilter]);
  return (
    <div className="panel-body flex flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b border-border p-2">
        <Field label="Universe">
          <select className="input" value={uni} onChange={(e) => setUni(e.target.value)}>
            {Object.entries(universes).map(([k, v]) => <option key={k} value={k}>{k} ({v.length})</option>)}
          </select>
        </Field>
        <Field label="Interval">
          <select className="input" value={interval} onChange={(e) => setIv(e.target.value as Interval)}>
            {INTERVALS.map((iv) => <option key={iv}>{iv}</option>)}
          </select>
        </Field>
        <Field label="Signals within N bars"><input className="input w-16" type="number" min={0} max={200} value={lookback} onChange={(e) => setLookback(Number(e.target.value))} /></Field>
        <Field label="Studies">
          <div className="flex flex-wrap gap-1">
            {SCREEN_STUDIES.map((id) => (
              <button key={id} className="btn-ghost h-7" data-active={studies.includes(id)} onClick={() => setStudies((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}>
                {getStudy(id)?.shortName}
              </button>
            ))}
          </div>
        </Field>
        {!!scripts.length && (
          <Field label="Scripts">
            <div className="flex flex-wrap gap-1">
              {scripts.map((sc) => (
                <button key={sc.id} className="btn-ghost h-7" data-active={scriptIds.includes(sc.id)} aria-pressed={scriptIds.includes(sc.id)} onClick={() => setScriptIds((s) => (s.includes(sc.id) ? s.filter((x) => x !== sc.id) : [...s, sc.id]))}>
                  {sc.name}
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="Only rows with signal">
          <select className="input" multiple size={1} value={signalFilter} onChange={(e) => setSignalFilter([...e.target.selectedOptions].map((o) => o.value))} title="Ctrl/⌘-click to select several">
            {allSignals.map((s) => <option key={s} value={s}>{signalLabel(s)}</option>)}
          </select>
        </Field>
        <button className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Scan
        </button>
        {run.data && <span className="text-[11px] text-faint">{run.data.rows.length} symbols · {Math.round(run.data.ms)} ms · {run.data.where}</span>}
      </div>
      {!run.data && !run.isPending && <Empty title="Run a scan">Scans run server-side with the same engine code as the chart (falls back to your browser if the API is unreachable).</Empty>}
      {run.data && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th><button onClick={() => setSort('symbol')}>Symbol</button></th>
                <th className="text-right">Last</th>
                <th className="text-right"><button onClick={() => setSort('chg')}>Chg%</button></th>
                {studies.map((s) => <th key={s}>{getStudy(s)?.shortName}</th>)}
                <th><button onClick={() => setSort('bars')}>Recent signals (bars ago) ▾</button></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className="cursor-pointer" onClick={() => openSymbol(r.symbol, interval)}>
                  <td className="font-medium">{r.symbol}{(r as { simulated?: boolean }).simulated && <span className="ml-1 text-[9px] text-warn">SIM</span>}</td>
                  {r.error ? <td colSpan={2 + studies.length + 1} className="text-[11px] text-warn">{r.error}</td> : (
                    <>
                      <td className="text-right">{fmtPrice(r.last)}</td>
                      <td className="text-right" style={{ color: r.changePct >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtPct(r.changePct)}</td>
                      {studies.map((s) => (
                        <td key={s}><div className="flex flex-wrap gap-0.5">{(r.statuses[s]?.chips ?? []).slice(0, 3).map((c, k) => <Chip key={k} text={c.text} dir={c.dir} strength={c.strength} />)}</div></td>
                      ))}
                      <td><div className="flex flex-wrap gap-1">{r.signals.slice(0, 4).map((s, k) => <span key={k} className="text-[11px]" style={{ color: s.dir === 'bull' ? 'var(--ok)' : s.dir === 'bear' ? 'var(--danger)' : 'var(--text-dim)' }}>{signalLabel(s.id)} <span className="text-faint">{s.barsAgo}</span></span>)}</div></td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── MTF matrix ──────────────────────────────────────────────────────────────
const MTF: Interval[] = ['15m', '1h', '4h', '1D', '1W', '1M'];

export function MatrixPanel() {
  const universes = useUniverses();
  const [uni, setUni] = useState(Object.keys(universes)[0]);
  const [tfs, setTfs] = useState<Interval[]>(['1h', '4h', '1D', '1W', '1M']);
  const [tfW, setTfW] = useState<Record<string, number>>({ '15m': 0.5, '1h': 0.75, '4h': 1, '1D': 1.5, '1W': 2, '1M': 2 });
  const [w, setW] = useState<MatrixWeights>(DEFAULT_MATRIX_WEIGHTS);
  const run = useMutation({ mutationFn: () => fetchMatrix((universes[uni] ?? []).slice(0, 30), tfs) });
  const cellOf = (s: string, iv: Interval): MatrixCellDto | undefined => run.data?.find((c) => c.symbol === s && c.interval === iv);
  const symbols = (universes[uni] ?? []).slice(0, 30);
  const rescore = (c?: MatrixCellDto['cell']) => {
    if (!c) return null;
    // re-weight client-side from detail (weights are editable without refetching)
    return { ...c, score: matrixScore(c.detail as Record<string, number | null>, w) };
  };
  return (
    <div className="panel-body flex flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b border-border p-2">
        <Field label="Symbols">
          <select className="input" value={uni} onChange={(e) => setUni(e.target.value)}>
            {Object.entries(universes).map(([k, v]) => <option key={k} value={k}>{k} ({Math.min(30, v.length)})</option>)}
          </select>
        </Field>
        <Field label="Timeframes">
          <div className="flex gap-1">
            {MTF.map((iv) => <button key={iv} className="btn-ghost h-7" data-active={tfs.includes(iv)} onClick={() => setTfs((t) => (t.includes(iv) ? t.filter((x) => x !== iv) : MTF.filter((x) => [...t, iv].includes(x))))}>{iv}</button>)}
          </div>
        </Field>
        <details className="relative">
          <summary className="btn cursor-pointer list-none">Weights</summary>
          <div className="absolute z-20 mt-1 grid w-72 grid-cols-2 gap-2 rounded-md border border-border bg-panel p-3 shadow-lg">
            {(Object.keys(w) as (keyof MatrixWeights)[]).map((k) => (
              <Field key={k} label={k}><input className="input" type="number" step="0.25" value={w[k]} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} /></Field>
            ))}
            <div className="col-span-2 text-[10px] text-faint">Per-timeframe weights (row confluence):</div>
            {tfs.map((iv) => <Field key={iv} label={iv}><input className="input" type="number" step="0.25" value={tfW[iv] ?? 1} onChange={(e) => setTfW({ ...tfW, [iv]: Number(e.target.value) })} /></Field>)}
          </div>
        </details>
        <button className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Build matrix
        </button>
      </div>
      {!run.data && !run.isPending && <Empty title="Multi-timeframe exhaustion matrix">Sequential & Combo state for each symbol × timeframe, with a weighted confluence score (+ buy-side exhaustion / − sell-side).</Empty>}
      {run.data && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                {tfs.map((iv) => <th key={iv} className="text-center">{iv}</th>)}
                <th className="text-right" title="Weighted mean of cell scores (−100…+100)">Confluence</th>
              </tr>
            </thead>
            <tbody>
              {symbols.map((s) => {
                const cells = tfs.map((iv) => rescore(cellOf(s, iv)?.cell));
                const score = rowConfluence(cells.map((c) => (c ? { ...c, dir: c.dir as 'bull' } : null)), tfs.map((iv) => tfW[iv] ?? 1));
                return (
                  <tr key={s}>
                    <td><button className="font-medium hover:text-accent" onClick={() => openSymbol(s)}>{s}</button></td>
                    {tfs.map((iv, k) => {
                      const c = cells[k];
                      const err = cellOf(s, iv)?.error;
                      const bg = c ? `color-mix(in srgb, ${c.score >= 0 ? 'var(--ok)' : 'var(--danger)'} ${Math.round(Math.min(1, Math.abs(c.score)) * 60)}%, transparent)` : undefined;
                      return (
                        <td key={iv} className="cursor-pointer text-center text-[11px]" style={{ background: bg }} onClick={() => openSymbol(s, iv)} title={err ?? (c ? `${c.label} · score ${c.score.toFixed(2)}` : '')}>
                          {err ? <span className="text-warn">!</span> : (c?.label ?? '…')}
                        </td>
                      );
                    })}
                    <td className="text-right font-semibold" style={{ color: score >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{score.toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Signal tester ───────────────────────────────────────────────────────────
function EquityChart({ eq, bh, times }: { eq: number[]; bh: number[]; times: number[] }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !eq.length) return;
    const t = readTheme();
    const chart = createChart(el.current, { autoSize: true, layout: { background: { type: ColorType.Solid, color: t.panel }, textColor: t.text, attributionLogo: false }, grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } }, rightPriceScale: { borderColor: t.border }, timeScale: { borderColor: t.border } });
    let prev = -Infinity;
    const ts = times.map((x) => {
      let s = Math.floor(x / 1000);
      if (s <= prev) s = prev + 1;
      prev = s;
      return s as UTCTimestamp;
    });
    chart.addSeries(AreaSeries, { lineColor: '#38bdf8', topColor: '#38bdf855', bottomColor: '#38bdf805', lineWidth: 2, title: 'Strategy' }).setData(eq.map((v, i) => ({ time: ts[i], value: v })));
    chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, title: 'Buy & hold' }).setData(bh.map((v, i) => ({ time: ts[i], value: v })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [eq, bh, times]);
  return <div ref={el} className="h-48 w-full" />;
}

const SIGNAL_STUDIES = STUDIES.filter((s) => s.signals?.length);
const evalWindowLabel = (w?: TestWindow) => `${w?.from ?? 'start'} → ${w?.to ?? 'latest'}`;

type TesterRow = { symbol: string; rec?: TestRunRecord; err?: string; data?: string; options?: OptionsOverlayResult | null };

/** Pool every symbol's events per horizon (means over events, MAE/MFE weighted by n, baseline averaged). */
function poolRecords(per: TesterRow[], hs: number[]) {
  return hs.map((h, k) => {
    const rets = per.flatMap((p) => p.rec?.eventStudy.events.map((e) => e.returns[k]).filter((x): x is number => x !== null) ?? []);
    const sorted = rets.slice().sort((a, b) => a - b);
    const q = (x: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(x * (sorted.length - 1)))] : NaN);
    const hz = per.map((p) => p.rec?.eventStudy.horizons[k]).filter((x): x is TestRunRecord['eventStudy']['horizons'][number] => !!x);
    const base = hz.map((x) => x.baseline?.mean).filter((x): x is number => Number.isFinite(x));
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : NaN;
    const wavg = (f: (x: (typeof hz)[number]) => number) => {
      const xs = hz.filter((x) => x.n > 0);
      const n = xs.reduce((a, x) => a + x.n, 0);
      return n ? xs.reduce((a, x) => a + f(x) * x.n, 0) / n : NaN;
    };
    const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) : NaN;
    const t = sd > 0 ? mean / (sd / Math.sqrt(rets.length)) : NaN;
    return { h, n: rets.length, mean, median: q(0.5), p10: q(0.1), p90: q(0.9), hit: rets.length ? rets.filter((r) => r > 0).length / rets.length : NaN, mae: wavg((x) => x.mae), mfe: wavg((x) => x.mfe), baseline: base.length ? base.reduce((a, b) => a + b, 0) / base.length : NaN, ci95: bootstrapMeanCI(rets, { seed: 11 }), t, p: pTwoSided(t), returns: rets };
  });
}

/** Which dataset a trial counts against: the symbols, timeframe and evaluated period. */
const datasetOf = (symbols: string[], interval: string, p: { mode: string; range: TestWindow; trainFrom: string; trainTo: string }) =>
  `${symbols.join(',')} · ${interval} · ${p.mode === 'range' ? `${p.range.from ?? 'start'} → ${p.range.to ?? 'latest'}` : p.mode === 'split' ? `training ${p.trainFrom || 'start'} → ${p.trainTo || 'latest'}` : p.mode === 'walk' ? 'walk-forward' : 'all history'}`;

/** What a run needs to evaluate its frozen parameters on the test period later. */
type RunInput = { symbol: string; bars: Bar[]; spec: TestRunSpec; src: TestRunSource; events?: TestRunEvent[]; aux?: Record<string, Bar[]>; data: string };

const describeRec = (rec: TestRunRecord, full: string) => {
  const ev = rec.data.evaluated;
  const aux = rec.data.aux?.map((a) => ` · ${a.interval} ${a.from} → ${a.to} · ${a.bars.toLocaleString()} bars`).join('') ?? '';
  return (ev.warmupBars || ev.bars !== rec.data.bars ? `${full} · evaluated ${ev.from} → ${ev.to} (${ev.bars.toLocaleString()} bars; ${ev.warmupBars.toLocaleString()} earlier bars only warm up the study)` : full) + aux;
};

const CSV_PARTS: { id: TestRunCsvPart; label: string }[] = [
  { id: 'summary', label: 'Summary (config + stats)' },
  { id: 'signals', label: 'Signals' },
  { id: 'events', label: 'Event returns' },
  { id: 'trades', label: 'Trades' },
  { id: 'equity', label: 'Equity (per bar)' },
];

/** Reproducible exports: full JSON records, CSV parts keyed by run hash, and the read-only API link that reruns them. */
function ExportBar({ records, pooled, name, onSave, extra }: { records: TestRunRecord[]; pooled: unknown; name: string; onSave?: () => void; extra?: Record<string, unknown> }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!records.length) return null;
  const base = `meridian-test-${name}-${records.length === 1 ? records[0].hashes.run.slice(0, 8) : `${records.length}runs`}`.replace(/[^\w.-]+/g, '_');
  const replays = records.map((r) => (r.spec.study.startsWith('script:') ? null : `/api/tester?${replayQuery(r)}`));
  const one = records.length === 1 ? replays[0] : null;
  const json = () => download(`${base}.json`, JSON.stringify({ schema: TEST_EXPORT_SCHEMA, runs: records, replay: replays, pooled, ...extra }, null, 1), 'application/json');
  const copy = async () => {
    if (!one) return;
    await navigator.clipboard.writeText(new URL(one, location.origin).href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const hasStrategy = records.some((r) => r.strategy);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px]">
      {onSave && (
        <button
          className="btn btn-primary h-7"
          onClick={() => {
            onSave();
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
          title="Keep this run to compare side by side"
        >
          {saved ? 'Saved' : 'Save run'}
        </button>
      )}
      <button className="btn h-7" onClick={json}>Export JSON</button>
      {CSV_PARTS.filter((p) => hasStrategy || (p.id !== 'trades' && p.id !== 'equity')).map((p) => (
        <button key={p.id} className="btn-ghost h-7" onClick={() => download(`${base}-${p.id}.csv`, testRunCsv(records, p.id), 'text/csv')}>
          CSV: {p.label}
        </button>
      ))}
      {one && (
        <button className="btn-ghost h-7" onClick={copy} title="A read-only API link that reruns this exact test on the same data window">
          {copied ? 'Copied' : 'Copy API link'}
        </button>
      )}
      <span className="text-faint" title={records.map((r) => `${r.data.symbol}: run ${r.hashes.run} · spec ${r.hashes.spec} · bars ${r.hashes.bars}`).join('\n')}>
        engine {records[0].engineVersion} · run {records.length === 1 ? records[0].hashes.run.slice(0, 12) : `${records.length} runs`}
      </span>
    </div>
  );
}

/** The dataset behind each symbol in a test: provider, adjustment, coverage dates and bar count. */
function DataLines({ per }: { per: { symbol: string; data?: string }[] }) {
  if (per.length === 1) return <p className="mb-2 text-[10px] text-faint">Data: {per[0].symbol} {per[0].data} — loaded for this test, separate from the chart’s history.</p>;
  return (
    <details className="mb-2 text-[10px] text-faint">
      <summary className="cursor-pointer">Data: {per.length} symbols, each with its own history (separate from the chart’s)</summary>
      <ul className="mt-1 space-y-0.5">{per.map((p) => <li key={p.symbol}>{p.symbol} {p.data}</li>)}</ul>
    </details>
  );
}

export function TesterPanel() {
  const universes = useUniverses();
  const [scope, setScope] = useState<'active' | string>('active');
  const [interval, setIv] = useState<Interval>('1D');
  const [studyId, setStudyId] = useState('td-combo');
  const scripts = useScripts((s) => s.scripts);
  // a saved Meridian Script can be the signal source too ("script:<id>")
  const script = studyId.startsWith('script:') ? scripts.find((sc) => `script:${sc.id}` === studyId) : undefined;
  const isRules = studyId === 'rules';
  const rules = useTesterRules((s) => s.rules);
  const study = script || isRules ? undefined : getStudy(studyId);
  const [scriptSigs, setScriptSigs] = useState<{ id: string; dir: string }[]>([]);
  const signalOptions = script ? scriptSigs : (study?.signals ?? []);
  const [sigs, setSigs] = useState<string[]>(['COMBO_BUY_13', 'COMBO_SELL_13']);
  const [horizons, setHorizons] = useState('1,5,10,20,60');
  const [selH, setSelH] = useState(20);
  const [strategy, setStrategy] = useState(false);
  const [periods, setPeriods] = useState(defaultPeriods);
  const [view, setView] = useState<'train' | 'test'>('train');
  const oosRecord = useOosLog((s) => s.record);
  const trialRecord = useTrialLog((s) => s.record);
  const trialClear = useTrialLog((s) => s.clear);
  const saveRun = useSavedRuns((s) => s.save);
  const savedCount = useSavedRuns((s) => s.runs.length);
  const [comparing, setComparing] = useState(false);
  const [instrument, setInstrument] = useState<'shares' | 'options'>('shares');
  const [optSpec, setOptSpec] = useState<OptionsOverlaySpec>(DEFAULT_OPTIONS);
  const [cfg, setCfg] = useState<Omit<StrategyConfig, 'entries' | 'stopLevels'>>({ exitOnOpposite: true, stop: 'level', stopPct: 5, atrMult: 2, atrLength: 14, timeStopBars: 20, takeProfitPct: 0, feesBps: 2, slippageBps: 3, entryAt: 'nextOpen', exitAt: 'nextOpen', allowShort: true, capital: 100_000, sizing: { mode: 'percentEquity', value: 100 }, maxPositions: 1, wholeShares: false, commission: 0, gapFill: 'open', sameBar: 'stopFirst', stopOnEntryBar: true });
  useEffect(() => {
    if (!script) {
      const ids = study?.signals?.filter((s) => s.dir !== 'neutral').map((s) => s.id) ?? [];
      setSigs(ids.slice(0, 2));
      return;
    }
    // learn the script's signal ids by running it on the active chart
    const rt = useUi.getState().runtime[useWorkspace.getState().activePaneId];
    let live = true;
    runScriptSandboxed(script.code, rt?.bars ?? [], script.inputs).then(({ result }) => {
      if (!live) return;
      const seen = new Map<string, string>();
      for (const s of result.signals) if (!seen.has(s.id)) seen.set(s.id, s.dir);
      const opts = [...seen].map(([id, dir]) => ({ id, dir }));
      setScriptSigs(opts);
      setSigs(opts.filter((o) => o.dir !== 'neutral').map((o) => o.id).slice(0, 2));
    });
    return () => {
      live = false;
    };
  }, [studyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    mutationFn: async () => {
      const symbols = scope === 'active' ? [activePane().symbol] : (universes[scope] ?? []).slice(0, 20);
      const hs = horizons.split(',').map((x) => Number(x.trim())).filter((x) => x > 0 && x < 1000);
      // one reproducible run record per symbol (the same builder GET /api/tester uses)
      const per: TesterRow[] = [];
      const inputs: RunInput[] = [];
      const p = periods;
      const window = evalWindow(p);
      for (const s of symbols) {
        try {
          const { bars: all, source } = await getBarsSourced(s, interval, 5000, 600_000);
          const bars = all.filter((b) => b.final !== false);
          let events: TestRunEvent[] | undefined;
          // higher-timeframe bars the combined rules read
          const aux: Record<string, Bar[]> = {};
          if (isRules) for (const iv of ruleIntervals(rules, interval)) aux[iv] = (await getBarsSourced(s, iv as Interval, 5000, 600_000)).bars.filter((b) => b.final !== false);
          if (script) {
            const { result } = await runScriptSandboxed(script.code, bars, script.inputs, { timeoutMs: 6000 });
            if (result.error) throw new Error(`${script.name}: ${result.error}`);
            const want = new Set(sigs);
            events = result.signals.filter((s) => want.has(s.id)).map((s) => ({ i: s.i, dir: s.dir, id: s.id }));
          }
          const spec: TestRunSpec = {
            symbol: source.symbol,
            interval,
            study: script ? `script:${script.name}` : studyId,
            studyConfig: script ? script.inputs : {},
            signals: isRules ? [] : sigs,
            ...(isRules ? { rules } : {}),
            horizons: hs,
            baseline: { seed: 11, samples: 600 },
            strategy: strategy && (symbols.length === 1 || p.mode === 'walk') ? cfg : null,
            ...(window ? { window } : {}),
          };
          const src: TestRunSource = { provider: source.provider, adjust: source.adjust, simulated: source.simulated, requestedBars: source.limit, ...(script ? { scriptHash: hashString(script.code) } : {}) };
          const data = describeBars(bars, source);
          inputs.push({ symbol: s, bars, spec, src, events, aux, data });
          if (p.mode === 'walk') continue;
          const rec = await compute<TestRunRecord>({ op: 'testRun', bars, spec, source: src, events, aux });
          per.push({ symbol: s, rec, data: describeRec(rec, data), options: instrument === 'options' ? overlayFor(rec, bars, optSpec) : null });
        } catch (e) {
          per.push({ symbol: s, err: (e as Error).message });
        }
      }
      let wf: WalkForwardResult | null = null;
      if (p.mode === 'walk' && inputs.length) {
        const { symbol: _s, window: _w, ...base } = inputs[0].spec;
        wf = await compute<WalkForwardResult>({ op: 'walkForward', series: inputs.map((x) => ({ bars: x.bars, source: x.src, symbol: x.spec.symbol })), spec: base, wf: wfSpec(p) });
        for (const x of inputs) per.push({ symbol: x.symbol, data: x.data });
      }
      const pooled = poolRecords(per, hs);
      // every distinct parameter set run on this dataset counts as a trial
      const dataset = datasetOf(inputs.map((x) => x.symbol), interval, p);
      let trials = 0;
      if (inputs.length) {
        const { symbol: _s2, window: _w2, ...params } = inputs[0].spec;
        trials = trialRecord(dataset, hashString(canonicalJson({ params, wf: p.mode === 'walk' ? wfSpec(p) : null })));
      }
      setView('train');
      setComparing(false);
      freeze.reset();
      return { per, pooled, strategyCfg: strategy ? cfg : null, mode: p.mode, wf, inputs, test: p.mode === 'split' ? testWindow(p) : null, dataset, trials, options: strategy && instrument === 'options' ? optSpec : null };
    },
  });
  // Train / test: the test period is evaluated only on request, with exactly the training run's parameters.
  const freeze = useMutation({
    mutationFn: async () => {
      const d = run.data!;
      const tw: TestWindow = d.test ?? {};
      const per: TesterRow[] = [];
      for (const x of d.inputs) {
        try {
          const rec = await compute<TestRunRecord>({ op: 'testRun', bars: x.bars, spec: { ...x.spec, window: tw }, source: x.src, events: x.events, aux: x.aux });
          per.push({ symbol: x.symbol, rec, data: describeRec(rec, x.data), options: d.options ? overlayFor(rec, x.bars, d.options) : null });
        } catch (e) {
          per.push({ symbol: x.symbol, err: (e as Error).message });
        }
      }
      // one entry per distinct parameter set that has seen this test period
      const { symbol: _s, window: _w, ...params } = d.inputs[0].spec;
      const key = `${d.inputs.map((x) => x.symbol).join(',')}|${interval}|${tw.from ?? ''}|${tw.to ?? ''}`;
      const seen = oosRecord(key, hashString(canonicalJson(params)));
      setView('test');
      return { per, pooled: poolRecords(per, d.inputs[0].spec.horizons), views: seen.length, label: `${tw.from ?? 'start'} → ${tw.to ?? 'latest'}` };
    },
  });
  const shown = view === 'test' && freeze.data ? freeze.data : run.data;
  const ok = shown?.per.filter((p) => !p.err) ?? [];
  const buys = ok.reduce((a, p) => a + (p.rec?.eventStudy.population.measuredLong ?? 0), 0);
  const sells = ok.reduce((a, p) => a + (p.rec?.eventStudy.population.measuredShort ?? 0), 0);
  const records = ok.flatMap((p) => (p.rec ? [p.rec] : []));
  const sel = shown?.pooled.find((p) => p.h === selH) ?? shown?.pooled[0];
  const hist = sel ? histogram(sel.returns, 24) : [];
  const hmax = Math.max(1, ...hist.map((b) => b.n));
  const strat = shown?.per[0]?.rec?.strategy;
  const sp = strat?.population;
  return (
    <div className="panel-body flex flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b border-border p-2">
        <Field label="Symbols">
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="active">Active chart symbol</option>
            {Object.keys(universes).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>
        <Field label="Interval">
          <select className="input" value={interval} onChange={(e) => setIv(e.target.value as Interval)}>
            {INTERVALS.map((iv) => <option key={iv}>{iv}</option>)}
          </select>
        </Field>
        <Field label="Study">
          <select className="input" value={studyId} onChange={(e) => setStudyId(e.target.value)}>
            <option value="rules">Combined rules…</option>
            {SIGNAL_STUDIES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {!!scripts.length && (
              <optgroup label="My scripts">
                {scripts.map((sc) => <option key={sc.id} value={`script:${sc.id}`}>{sc.name}</option>)}
              </optgroup>
            )}
          </select>
        </Field>
        {!isRules && (
        <Field label="Signals">
          <select className="input" multiple size={1} value={sigs} onChange={(e) => setSigs([...e.target.selectedOptions].map((o) => o.value))} title="Ctrl/⌘-click to select several">
            {signalOptions.map((s) => <option key={s.id} value={s.id}>{signalLabel(s.id)}</option>)}
          </select>
        </Field>
        )}
        <Field label="Horizons (bars)"><input className="input w-28" value={horizons} onChange={(e) => setHorizons(e.target.value)} /></Field>
        <div className="pb-1"><Switch checked={strategy} onChange={setStrategy} label="Strategy mode" /></div>
        <button className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending || (!isRules && !sigs.length) || (isRules && !rules.longEntry && !rules.shortEntry)}>
          {run.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run test
        </button>
        <button className="btn-ghost h-7" data-active={comparing} aria-pressed={comparing} onClick={() => setComparing((v) => !v)}>
          Saved runs ({savedCount})
        </button>
      </div>
      {isRules && <RuleBuilder baseInterval={interval} trueBars={run.data?.per.find((p) => p.rec)?.rec?.diagnostics?.trueBars} />}
      <PeriodControls p={periods} set={setPeriods} studyId={studyId} horizons={horizons.split(',').map((x) => Number(x.trim())).filter((x) => x > 0)} strategy={strategy} script={!!script || isRules} />
      {strategy && (
        <div className="flex flex-wrap items-end gap-2 border-b border-border p-2">
          <Switch checked={cfg.exitOnOpposite} onChange={(v) => setCfg({ ...cfg, exitOnOpposite: v })} label="Exit on opposite signal" />
          <Field label="Stop">
            <select className="input" value={cfg.stop} onChange={(e) => setCfg({ ...cfg, stop: e.target.value as StrategyConfig['stop'] })}>
              <option value="level">TD risk level</option>
              <option value="pct">Percent</option>
              <option value="atr">ATR multiple</option>
              <option value="none">None</option>
            </select>
          </Field>
          {cfg.stop === 'pct' && <Field label="Stop %"><input className="input w-16" type="number" value={cfg.stopPct} onChange={(e) => setCfg({ ...cfg, stopPct: Number(e.target.value) })} /></Field>}
          {cfg.stop === 'atr' && <Field label="ATR ×"><input className="input w-16" type="number" value={cfg.atrMult} onChange={(e) => setCfg({ ...cfg, atrMult: Number(e.target.value) })} /></Field>}
          <Field label="Time stop (bars, 0 = off)"><input className="input w-20" type="number" value={cfg.timeStopBars} onChange={(e) => setCfg({ ...cfg, timeStopBars: Number(e.target.value) })} /></Field>
          <Field label="Take profit % (0 = off)"><input className="input w-20" type="number" value={cfg.takeProfitPct} onChange={(e) => setCfg({ ...cfg, takeProfitPct: Number(e.target.value) })} /></Field>
          <Field label="Fees (bps/side)"><input className="input w-16" type="number" value={cfg.feesBps} onChange={(e) => setCfg({ ...cfg, feesBps: Number(e.target.value) })} /></Field>
          <Field label="Slippage (bps/side)"><input className="input w-16" type="number" value={cfg.slippageBps} onChange={(e) => setCfg({ ...cfg, slippageBps: Number(e.target.value) })} /></Field>
          <Field label="Entry">
            <select className="input" value={cfg.entryAt} onChange={(e) => setCfg({ ...cfg, entryAt: e.target.value as StrategyConfig['entryAt'] })}>
              <option value="nextOpen">Next bar open</option>
              <option value="close">Signal bar close</option>
            </select>
          </Field>
          <Field label="Signal exits">
            <select className="input" value={cfg.exitAt ?? 'close'} onChange={(e) => setCfg({ ...cfg, exitAt: e.target.value as 'nextOpen' | 'close' })} title="When exit rules and opposite signals close a trade">
              <option value="nextOpen">Next bar open</option>
              <option value="close">Signal bar close</option>
            </select>
          </Field>
          <Switch checked={cfg.allowShort} onChange={(v) => setCfg({ ...cfg, allowShort: v })} label="Allow shorts" />
          <Field label="Instrument">
            <select className="input" value={instrument} onChange={(e) => setInstrument(e.target.value as 'shares' | 'options')}>
              <option value="shares">Shares</option>
              <option value="options">Shares + options (theoretical)</option>
            </select>
          </Field>
          {scope !== 'active' && periods.mode !== 'walk' && <span className="text-[11px] text-warn">Strategy mode runs on a single symbol (choose “Active chart symbol”), except in walk-forward.</span>}
        </div>
      )}
      {strategy && instrument === 'options' && <OptionsControls o={optSpec} set={setOptSpec} />}
      {strategy && (
        <div className="flex flex-wrap items-end gap-2 border-b border-border p-2" role="group" aria-label="Capital and execution assumptions">
          <Field label="Starting capital $"><input className="input w-24" type="number" min={1} step={1000} value={cfg.capital} onChange={(e) => setCfg({ ...cfg, capital: Math.max(1, Number(e.target.value)) })} /></Field>
          <Field label="Position size">
            <span className="flex gap-1">
              <select className="input" value={cfg.sizing!.mode} onChange={(e) => setCfg({ ...cfg, sizing: { mode: e.target.value as SizingMode, value: e.target.value === 'percentEquity' ? 100 : e.target.value === 'riskPercent' ? 1 : e.target.value === 'fixedShares' ? 100 : 10_000 } })}>
                <option value="percentEquity">% of equity</option>
                <option value="riskPercent">% of equity risked to the stop</option>
                <option value="fixedDollar">fixed $</option>
                <option value="fixedShares">fixed shares</option>
              </select>
              <input className="input w-20" type="number" min={0} aria-label="Position size value" value={cfg.sizing!.value} onChange={(e) => setCfg({ ...cfg, sizing: { ...cfg.sizing!, value: Math.max(0, Number(e.target.value)) } })} />
            </span>
          </Field>
          <Field label="Max open positions"><input className="input w-14" type="number" min={1} max={100} value={cfg.maxPositions} onChange={(e) => setCfg({ ...cfg, maxPositions: Math.max(1, Math.round(Number(e.target.value))) })} /></Field>
          <div className="pb-1"><Switch checked={!!cfg.wholeShares} onChange={(v) => setCfg({ ...cfg, wholeShares: v })} label="Whole shares" /></div>
          <Field label="Commission $/order"><input className="input w-16" type="number" min={0} step={0.5} value={cfg.commission} onChange={(e) => setCfg({ ...cfg, commission: Math.max(0, Number(e.target.value)) })} /></Field>
          <Field label="Gap through stop/target">
            <select className="input" value={cfg.gapFill} onChange={(e) => setCfg({ ...cfg, gapFill: e.target.value as 'open' | 'level' })}>
              <option value="open">fills at the open</option>
              <option value="level">fills at the level (optimistic)</option>
            </select>
          </Field>
          <Field label="Stop and target in one candle">
            <select className="input" value={cfg.sameBar} onChange={(e) => setCfg({ ...cfg, sameBar: e.target.value as NonNullable<StrategyConfig['sameBar']> })}>
              <option value="stopFirst">stop first (conservative)</option>
              <option value="nearerOpen">whichever is nearer the open</option>
              <option value="targetFirst">target first (optimistic)</option>
            </select>
          </Field>
          <div className="pb-1"><Switch checked={cfg.stopOnEntryBar !== false} onChange={(v) => setCfg({ ...cfg, stopOnEntryBar: v })} label="Check stops on the entry bar" /></div>
        </div>
      )}
      {comparing && (
        <div className="min-h-0 flex-1 overflow-auto">
          <CompareView horizon={selH} />
        </div>
      )}
      {!comparing && !run.data && !run.isPending && <Empty title="Event study">“After {isRules ? 'these rules fired' : `a ${study?.shortName ?? 'script'} signal`} on this symbol, what happened?” Forward returns at each horizon vs. a seeded random-entry baseline.</Empty>}
      {!comparing && run.data?.wf && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px]">
            <button className="btn h-7" onClick={() => download(`meridian-walkforward-${interval}-${run.data!.wf!.hashes.spec.slice(0, 8)}.json`, JSON.stringify(run.data!.wf, null, 1), 'application/json')}>Export JSON</button>
            <span className="text-faint">engine {run.data.wf.engineVersion} · spec {run.data.wf.hashes.spec.slice(0, 12)}</span>
          </div>
          <WalkForwardView r={run.data.wf} selH={selH} />
          <DataLines per={run.data.per.filter((p) => !p.err)} />
          {run.data.per.some((p) => p.err) && <p className="mt-1 text-[11px] text-warn">Skipped: {run.data.per.filter((p) => p.err).map((p) => `${p.symbol} (${p.err})`).join(', ')}</p>}
        </div>
      )}
      {!comparing && run.data && shown && !run.data.wf && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {run.data.mode === 'split' && (
            <div className="mb-2 rounded border border-border p-2 text-[11px]">
              {!freeze.data ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    <b>Training period</b> results below. The test period ({run.data.test?.from ?? 'start'} → {run.data.test?.to ?? 'latest'}) stays hidden until you freeze these exact parameters.
                  </span>
                  <button className="btn btn-primary h-7" onClick={() => freeze.mutate()} disabled={freeze.isPending}>
                    {freeze.isPending ? 'Evaluating…' : 'Freeze parameters & evaluate test period'}
                  </button>
                </div>
              ) : (
                <>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Parameters frozen.</span>
                    <div className="flex gap-1" role="group" aria-label="Period shown">
                      <button className="btn-ghost h-7" data-active={view === 'train'} aria-pressed={view === 'train'} onClick={() => setView('train')}>Show training</button>
                      <button className="btn-ghost h-7" data-active={view === 'test'} aria-pressed={view === 'test'} onClick={() => setView('test')}>Show test</button>
                    </div>
                    <span className={freeze.data.views > 1 ? 'text-warn' : 'text-faint'}>
                      This test period has been evaluated with {freeze.data.views} parameter set{freeze.data.views === 1 ? '' : 's'} on this device
                      {freeze.data.views > 1 ? ' — only the first look was truly out of sample; later ones were chosen knowing it.' : '.'}
                    </span>
                  </div>
                  <TrainTestCompare
                    train={run.data.pooled}
                    test={freeze.data.pooled}
                    trainLabel={evalWindowLabel(run.data.inputs[0]?.spec.window)}
                    testLabel={freeze.data.label}
                    trainStrat={run.data.per[0]?.rec?.strategy?.stats.totalReturn}
                    testStrat={freeze.data.per[0]?.rec?.strategy?.stats.totalReturn}
                  />
                </>
              )}
            </div>
          )}
          <ExportBar
            records={records}
            pooled={shown.pooled.map(({ returns: _r, ...p }) => p)}
            extra={shown.per[0]?.options ? { optionsOverlay: { spec: run.data.options, ...shown.per[0].options } } : undefined}
            name={`${scope === 'active' ? (records[0]?.data.symbol ?? 'test') : scope}-${interval}-${script ? 'script' : studyId}`}
            onSave={() =>
              saveRun(
                savedFrom(records, shown.pooled.map(({ returns: _r, ...p }) => p), {
                  name: `${records.map((r) => r.data.symbol).join(',')} ${isRules ? 'rules' : script ? script.name : (study?.shortName ?? studyId)}${run.data!.mode === 'split' ? (view === 'test' && freeze.data ? ' · test' : ' · train') : ''}`,
                  study: isRules ? 'combined rules' : script ? `script ${script.name}` : (study?.name ?? studyId),
                  period: view === 'test' && freeze.data ? `test ${freeze.data.label}` : run.data!.dataset,
                  trials: run.data!.trials,
                  savedAt: Date.now(),
                }),
              )
            }
          />
          <TrialBanner trials={run.data.trials} datasetLabel={run.data.dataset} row={sel} onClear={() => trialClear(run.data!.dataset)} />
          <div className="section-title px-0">Event study · forward returns after every selected signal{run.data.mode === 'split' ? (view === 'test' && freeze.data ? ' · TEST period' : ' · training period') : ''}</div>
          <p className="mb-1 text-[11px] text-dim">
            Population: {buys} {isRules ? 'long-entry' : 'buy'} signal{buys === 1 ? '' : 's'} measured long{sells ? ` + ${sells} ${isRules ? 'short-entry' : 'sell'} signal${sells === 1 ? '' : 's'} measured short` : ''}, {ok.length} symbol{ok.length === 1 ? '' : 's'} · entry at the signal bar’s close · no stops, no position overlap rules.
          </p>
          <DataLines per={ok} />
          <table className="table">
            <thead>
              <tr><th>Horizon</th><th className="text-right">n</th><th className="text-right">Mean</th><th className="text-right" title="Seeded bootstrap 95% interval for the mean">95% interval</th><th className="text-right" title="Two-sided p-value of the mean, before any correction for how many variations were tried">p</th><th className="text-right">Median</th><th className="text-right">Hit rate</th><th className="text-right">MAE</th><th className="text-right">MFE</th><th className="text-right">P10 / P90</th><th className="text-right">Random baseline</th><th className="text-right">Edge</th></tr>
            </thead>
            <tbody>
              {shown.pooled.map((p) => (
                <tr key={p.h} className={`cursor-pointer ${p.h === sel?.h ? 'bg-raised' : ''}`} onClick={() => setSelH(p.h)}>
                  <td>{p.h} bars</td>
                  <td className="text-right">{p.n}</td>
                  <td className="text-right">{fmtPct(p.mean)}</td>
                  <td className="text-right text-dim" style={{ color: p.ci95.lo > 0 || p.ci95.hi < 0 ? 'var(--text)' : undefined }}>{Number.isFinite(p.ci95.lo) ? `${fmtPct(p.ci95.lo, 1)} … ${fmtPct(p.ci95.hi, 1)}` : '—'}</td>
                  <td className="text-right text-dim">{Number.isFinite(p.p) ? p.p.toFixed(3) : '—'}</td>
                  <td className="text-right">{fmtPct(p.median)}</td>
                  <td className="text-right">{Number.isFinite(p.hit) ? `${(p.hit * 100).toFixed(0)}%` : '—'}</td>
                  <td className="text-right text-danger">{fmtPct(p.mae)}</td>
                  <td className="text-right text-ok">{fmtPct(p.mfe)}</td>
                  <td className="text-right">{fmtPct(p.p10, 1)} / {fmtPct(p.p90, 1)}</td>
                  <td className="text-right text-dim">{fmtPct(p.baseline)}</td>
                  <td className="text-right font-semibold" style={{ color: p.mean - p.baseline >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtPct(p.mean - p.baseline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.per.some((p) => p.err) && <p className="mt-1 text-[11px] text-warn">Skipped: {shown.per.filter((p) => p.err).map((p) => `${p.symbol} (${p.err})`).join(', ')}</p>}
          {sel && hist.length > 0 && (
            <div className="mt-3">
              <div className="section-title px-0">Distribution of {sel.h}-bar directional returns (n = {sel.n})</div>
              <svg viewBox={`0 0 ${hist.length * 20} 100`} className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="Return histogram">
                {hist.map((b, k) => (
                  <rect key={k} x={k * 20 + 1} width={18} y={100 - (90 * b.n) / hmax} height={(90 * b.n) / hmax} fill={b.x1 <= 0 ? 'var(--danger)' : b.x0 >= 0 ? 'var(--ok)' : 'var(--text-dim)'} opacity={0.75}>
                    <title>{`${b.x0.toFixed(1)}% … ${b.x1.toFixed(1)}%: ${b.n}`}</title>
                  </rect>
                ))}
              </svg>
              <div className="flex justify-between text-[10px] text-faint"><span>{fmtPct(hist[0].x0, 1)}</span><span>0%</span><span>{fmtPct(hist[hist.length - 1].x1, 1)}</span></div>
            </div>
          )}
          {strat && (
            <div className="mt-3">
              <div className="section-title px-0">Strategy · {shown.per[0].symbol} · {run.data.strategyCfg?.allowShort ? 'long & short' : 'long only'} — a different test from the event study above</div>
              <p className="mb-1 text-[11px] text-dim">
                Population: {sp!.trades} trade{sp!.trades === 1 ? '' : 's'} ({sp!.long} long, {sp!.short} short) from {sp!.buySignals} {isRules ? 'long-entry' : 'buy'}
                {sp!.sellSignals === 'entries' ? ` and ${sells} ${isRules ? 'short-entry' : 'sell'}` : ''} signals
                {sp!.sellSignals !== 'entries' && sells ? `; the ${sells} sell signals only ${sp!.sellSignals === 'exits' ? 'close longs' : 'are ignored'}` : ''}
                {sp!.ruleExits !== undefined ? `; ${sp!.ruleExits} closed by exit rules` : ''} · one position at a time, signals while in a trade are skipped · entry at {run.data.strategyCfg?.entryAt === 'close' ? 'the signal bar’s close' : 'the next bar’s open'}.
              </p>
              <p className="mb-2 text-[10px] text-faint">Data: {shown.per[0].symbol} {shown.per[0].data}</p>
              <div className="mb-2 grid grid-cols-3 gap-2 text-[12px] sm:grid-cols-5 lg:grid-cols-9">
                {[
                  ['Trades', String(strat.stats.trades)],
                  ['Win rate', Number.isFinite(strat.stats.winRate) ? `${(strat.stats.winRate * 100).toFixed(0)}%` : '—'],
                  ['Total return', fmtPct(strat.stats.totalReturn)],
                  ['Buy & hold', fmtPct(strat.stats.buyHold)],
                  ['Profit factor', fmtNum(strat.stats.profitFactor)],
                  ['Avg trade', fmtPct(strat.stats.avgTrade)],
                  ['Max DD', fmtPct(strat.stats.maxDrawdown)],
                  ['Sharpe', fmtNum(strat.stats.sharpe)],
                  ['Exposure', `${(strat.stats.exposure * 100).toFixed(0)}%`],
                  ['Capital', `${fmtMoney(strat.stats.startCapital, 0)} → ${fmtMoney(strat.stats.endCapital, 0)}`],
                  ['Avg win', `${fmtPct(strat.tradeStats.avgWinPct)} · ${fmtMoney(strat.tradeStats.avgWinUsd, 0)}`],
                  ['Avg loss', `${fmtPct(strat.tradeStats.avgLossPct)} · ${fmtMoney(strat.tradeStats.avgLossUsd, 0)}`],
                  ['Expectancy / trade', `${fmtPct(strat.tradeStats.expectancyPct)} · ${fmtMoney(strat.tradeStats.expectancyUsd, 0)}`],
                  ['Expectancy 95%', Number.isFinite(strat.tradeStats.expectancyCI.lo) ? `${fmtPct(strat.tradeStats.expectancyCI.lo, 1)} … ${fmtPct(strat.tradeStats.expectancyCI.hi, 1)}` : '—'],
                  ['Payoff', fmtNum(strat.tradeStats.payoff)],
                  ['B&H at same exposure', fmtPct(strat.benchmarks.exposureMatchedPct)],
                  ['Random dates beat', strat.benchmarks.randomTiming.samples ? `${(100 * (1 - strat.benchmarks.randomTiming.strategyPercentile)).toFixed(0)}% of the time` : '—'],
                  ['Most open at once', String(strat.stats.maxConcurrent)],
                  ['Gap fills', String(strat.stats.gapExits)],
                  ['Stop + target same bar', String(strat.stats.ambiguousExits)],
                  ['Signals skipped', String(Object.values(strat.stats.skipped).reduce((a, b) => a + b, 0))],
                ].map(([k, v]) => (
                  <div key={k}><div className="text-[10px] uppercase text-faint">{k}</div><div className="font-semibold tabular-nums">{v}</div></div>
                ))}
              </div>
              {Object.values(strat.stats.skipped).some((x) => x > 0) && (
                <p className="mb-1 text-[10px] text-faint">
                  Skipped entries: {Object.entries(strat.stats.skipped).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${({ maxPositions: 'at the position limit', noCapital: 'with no capital left', noStop: 'without a stop to size from', tooSmall: 'too small for one share', shortsOff: 'shorts (off)' } as Record<string, string>)[k]}`).join(' · ')}.
                </p>
              )}
              <p className="mb-1 text-[10px] text-faint">
                Rules: {run.data.strategyCfg?.sizing?.mode === 'riskPercent' ? `risk ${run.data.strategyCfg.sizing.value}% of equity to the stop` : run.data.strategyCfg?.sizing?.mode === 'fixedDollar' ? `${fmtMoney(run.data.strategyCfg.sizing.value, 0)} per position` : run.data.strategyCfg?.sizing?.mode === 'fixedShares' ? `${run.data.strategyCfg.sizing.value} shares per position` : `${run.data.strategyCfg?.sizing?.value ?? 100}% of equity per position`}, up to {run.data.strategyCfg?.maxPositions ?? 1} open, no leverage · gaps through a level fill {run.data.strategyCfg?.gapFill === 'level' ? 'at the level' : 'at the open'} · a candle touching stop and target counts as {run.data.strategyCfg?.sameBar === 'targetFirst' ? 'the target' : run.data.strategyCfg?.sameBar === 'nearerOpen' ? 'whichever is nearer the open' : 'the stop'} · stops {run.data.strategyCfg?.stopOnEntryBar === false ? 'start the bar after entry' : 'apply from the entry bar'} · {(run.data.strategyCfg?.feesBps ?? 0) + (run.data.strategyCfg?.slippageBps ?? 0)} bps per side{run.data.strategyCfg?.commission ? ` + ${fmtMoney(run.data.strategyCfg.commission)} per order` : ''}.
              </p>
              <EquityChart eq={strat.equity.map((e) => e.equity)} bh={strat.equity.map((e) => e.buyHold)} times={strat.equity.map((e) => e.t)} />
              <details className="mt-2">
                <summary className="cursor-pointer text-dim">Trades ({strat.trades.length})</summary>
                <table className="table">
                  <thead><tr><th>Entry</th><th>Exit</th><th>Side</th><th className="text-right">Shares</th><th className="text-right">Entry px</th><th className="text-right">Exit px</th><th className="text-right">Return</th><th className="text-right">P/L $</th><th>Exit reason</th></tr></thead>
                  <tbody>
                    {strat.trades.slice(-200).reverse().map((t, k) => (
                      <tr key={k}>
                        <td>{t.entryDate}</td>
                        <td>{t.exitDate}</td>
                        <td>{t.side}</td>
                        <td className="text-right">{fmtNum(t.shares, t.shares % 1 ? 2 : 0)}</td>
                        <td className="text-right">{fmtPrice(t.entry)}</td>
                        <td className="text-right">{fmtPrice(t.exit)}</td>
                        <td className="text-right" style={{ color: t.retPct >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtPct(t.retPct)}</td>
                        <td className="text-right" style={{ color: t.pnl >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtMoney(t.pnl, 0)}</td>
                        <td>{t.reason}{t.gap ? ' · gap' : ''}{t.ambiguous ? ' · stop+target bar' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
              {shown.per[0]?.options && <OptionsResults r={shown.per[0].options} />}
            </div>
          )}
          <ByYear records={records} horizons={shown.pooled.map((p) => p.h)} selH={sel?.h ?? selH} />
          <p className="mt-3 text-[10px] text-faint">Past behaviour of a signal is not a forecast.{run.data.strategyCfg ? ` Strategy costs: ${run.data.strategyCfg.feesBps + run.data.strategyCfg.slippageBps} bps per side.` : ''}</p>
        </div>
      )}
    </div>
  );
}

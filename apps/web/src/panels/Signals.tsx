import { INTERVALS, type Interval, UNIVERSES } from '@meridian/data';
import { DEFAULT_MATRIX_WEIGHTS, type EventStudyResult, type MatrixWeights, STUDIES, type ScanRow, type StrategyConfig, type StrategyResult, getStudy, histogram, rowConfluence } from '@meridian/engine';
import { useMutation } from '@tanstack/react-query';
import { AreaSeries, ColorType, createChart, LineSeries, type UTCTimestamp } from 'lightweight-charts';
import { Play, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readTheme } from '../chart/render';
import { Chip, Empty, Field, Switch } from '../components/ui';
import { getBarsCached } from '../data/useBars';
import { compute } from '../engine/compute';
import { postJson } from '../lib/api';
import { fmtNum, fmtPct, fmtPrice, signalLabel } from '../lib/format';
import { runScriptSandboxed } from '../engine/script';
import { activePane, useScripts, useUi, useWatchlists, useWorkspace } from '../state/store';
import type { UserScript } from '../state/types';
import { fetchMatrix, type MatrixCellDto } from './hooks';

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
    const v = c.detail as Record<string, number | null>;
    const rec = (k: string) => typeof v[k] === 'number' && (v[k] as number) <= 3;
    const side = (p: 'buy' | 'sell') => {
      const P = p === 'buy' ? 'Buy' : 'Sell';
      const parts = [[w.setup, Math.min(1, ((v[`${p}Setup`] as number) ?? 0) / 9)], [w.setup9, rec(`barsSince${P}9`) ? 1 : 0], [w.countdown, ((v[`${p}Countdown`] as number) ?? 0) / 13], [w.cd13, rec(`barsSince${P}13`) ? 1 : 0], [w.combo, ((v[`${p}Combo`] as number) ?? 0) / 13]];
      const tot = parts.reduce((a, [x]) => a + x, 0);
      return tot ? parts.reduce((a, [x, y]) => a + x * y, 0) / tot : 0;
    };
    return { ...c, score: side('buy') - side('sell') };
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

export function TesterPanel() {
  const universes = useUniverses();
  const [scope, setScope] = useState<'active' | string>('active');
  const [interval, setIv] = useState<Interval>('1D');
  const [studyId, setStudyId] = useState('td-combo');
  const scripts = useScripts((s) => s.scripts);
  // a saved Meridian Script can be the signal source too ("script:<id>")
  const script = studyId.startsWith('script:') ? scripts.find((sc) => `script:${sc.id}` === studyId) : undefined;
  const study = script ? undefined : getStudy(studyId);
  const [scriptSigs, setScriptSigs] = useState<{ id: string; dir: string }[]>([]);
  const signalOptions = script ? scriptSigs : (study?.signals ?? []);
  const [sigs, setSigs] = useState<string[]>(['COMBO_BUY_13', 'COMBO_SELL_13']);
  const [horizons, setHorizons] = useState('1,5,10,20,60');
  const [selH, setSelH] = useState(20);
  const [strategy, setStrategy] = useState(false);
  const [cfg, setCfg] = useState<Omit<StrategyConfig, 'entries' | 'stopLevels'>>({ exitOnOpposite: true, stop: 'level', stopPct: 5, atrMult: 2, atrLength: 14, timeStopBars: 20, takeProfitPct: 0, feesBps: 2, slippageBps: 3, entryAt: 'nextOpen', allowShort: true });
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
      const per: { symbol: string; es: EventStudyResult; strat?: StrategyResult & { times: number[]; bh: number[] }; err?: string }[] = [];
      for (const s of symbols) {
        try {
          const bars = (await getBarsCached(s, interval, 5000, 600_000)).filter((b) => b.final !== false);
          type Events = { events: { i: number; dir: 'bull' | 'bear' | 'neutral'; id: string }[]; lines: { riskBuy?: Float64Array; riskSell?: Float64Array } };
          let ev: Events;
          if (script) {
            const { result } = await runScriptSandboxed(script.code, bars, script.inputs, { timeoutMs: 6000 });
            if (result.error) throw new Error(`${script.name}: ${result.error}`);
            const want = new Set(sigs);
            ev = { events: result.signals.filter((s) => want.has(s.id)).map((s) => ({ i: s.i, dir: s.dir, id: s.id })), lines: {} };
          } else ev = await compute<Events>({ op: 'events', bars, study: studyId, signals: sigs });
          const es = await compute<EventStudyResult>({ op: 'eventStudy', bars, events: ev.events, horizons: hs, seed: 11, samples: 600 });
          let strat;
          if (strategy && symbols.length === 1) {
            const r = await compute<StrategyResult>({ op: 'strategy', bars, config: { ...cfg, entries: ev.events, stopLevels: { long: ev.lines.riskBuy ? Array.from(ev.lines.riskBuy) : undefined, short: ev.lines.riskSell ? Array.from(ev.lines.riskSell) : undefined } } });
            strat = { ...r, times: bars.map((b) => b.t), bh: bars.map((b) => b.c / bars[0].c) };
          }
          per.push({ symbol: s, es, strat });
        } catch (e) {
          per.push({ symbol: s, es: { events: 0, horizons: [] }, err: (e as Error).message });
        }
      }
      // pool across symbols
      const pooled = hs.map((h, k) => {
        const rets = per.flatMap((p) => p.es.horizons[k]?.returns ?? []);
        const sorted = rets.slice().sort((a, b) => a - b);
        const q = (x: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(x * (sorted.length - 1)))] : NaN);
        const base = per.map((p) => p.es.horizons[k]?.baseline?.mean).filter((x): x is number => Number.isFinite(x));
        const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : NaN;
        const wavg = (f: (x: NonNullable<EventStudyResult['horizons'][number]>) => number) => {
          const xs = per.map((p) => p.es.horizons[k]).filter((x): x is EventStudyResult['horizons'][number] => !!x && x.n > 0);
          const n = xs.reduce((a, x) => a + x.n, 0);
          return n ? xs.reduce((a, x) => a + f(x) * x.n, 0) / n : NaN;
        };
        return { h, n: rets.length, mean, median: q(0.5), p10: q(0.1), p90: q(0.9), hit: rets.length ? rets.filter((r) => r > 0).length / rets.length : NaN, mae: wavg((x) => x.mae), mfe: wavg((x) => x.mfe), baseline: base.length ? base.reduce((a, b) => a + b, 0) / base.length : NaN, returns: rets };
      });
      return { per, pooled };
    },
  });
  const sel = run.data?.pooled.find((p) => p.h === selH) ?? run.data?.pooled[0];
  const hist = sel ? histogram(sel.returns, 24) : [];
  const hmax = Math.max(1, ...hist.map((b) => b.n));
  const strat = run.data?.per[0]?.strat;
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
            {SIGNAL_STUDIES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {!!scripts.length && (
              <optgroup label="My scripts">
                {scripts.map((sc) => <option key={sc.id} value={`script:${sc.id}`}>{sc.name}</option>)}
              </optgroup>
            )}
          </select>
        </Field>
        <Field label="Signals">
          <select className="input" multiple size={1} value={sigs} onChange={(e) => setSigs([...e.target.selectedOptions].map((o) => o.value))} title="Ctrl/⌘-click to select several">
            {signalOptions.map((s) => <option key={s.id} value={s.id}>{signalLabel(s.id)}</option>)}
          </select>
        </Field>
        <Field label="Horizons (bars)"><input className="input w-28" value={horizons} onChange={(e) => setHorizons(e.target.value)} /></Field>
        <div className="pb-1"><Switch checked={strategy} onChange={setStrategy} label="Strategy mode" /></div>
        <button className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending || !sigs.length}>
          {run.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run test
        </button>
      </div>
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
          <Switch checked={cfg.allowShort} onChange={(v) => setCfg({ ...cfg, allowShort: v })} label="Allow shorts" />
          {scope !== 'active' && <span className="text-[11px] text-warn">Strategy mode runs on a single symbol (choose “Active chart symbol”).</span>}
        </div>
      )}
      {!run.data && !run.isPending && <Empty title="Event study">“After a {study?.shortName} signal on this symbol, what happened?” Forward returns at each horizon vs. a seeded random-entry baseline.</Empty>}
      {run.data && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <table className="table">
            <thead>
              <tr><th>Horizon</th><th className="text-right">n</th><th className="text-right">Mean</th><th className="text-right">Median</th><th className="text-right">Hit rate</th><th className="text-right">MAE</th><th className="text-right">MFE</th><th className="text-right">P10 / P90</th><th className="text-right">Random baseline</th><th className="text-right">Edge</th></tr>
            </thead>
            <tbody>
              {run.data.pooled.map((p) => (
                <tr key={p.h} className={`cursor-pointer ${p.h === sel?.h ? 'bg-raised' : ''}`} onClick={() => setSelH(p.h)}>
                  <td>{p.h} bars</td>
                  <td className="text-right">{p.n}</td>
                  <td className="text-right">{fmtPct(p.mean)}</td>
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
          {run.data.per.some((p) => p.err) && <p className="mt-1 text-[11px] text-warn">Skipped: {run.data.per.filter((p) => p.err).map((p) => `${p.symbol} (${p.err})`).join(', ')}</p>}
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
              <div className="section-title px-0">Strategy · {run.data.per[0].symbol}</div>
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
                ].map(([k, v]) => (
                  <div key={k}><div className="text-[10px] uppercase text-faint">{k}</div><div className="font-semibold tabular-nums">{v}</div></div>
                ))}
              </div>
              <EquityChart eq={Array.from(strat.equity)} bh={strat.bh} times={strat.times} />
              <details className="mt-2">
                <summary className="cursor-pointer text-dim">Trades ({strat.trades.length})</summary>
                <table className="table">
                  <thead><tr><th>Entry</th><th>Exit</th><th>Side</th><th className="text-right">Entry px</th><th className="text-right">Exit px</th><th className="text-right">Return</th><th>Exit reason</th></tr></thead>
                  <tbody>
                    {strat.trades.slice(-200).reverse().map((t, k) => (
                      <tr key={k}>
                        <td>{new Date(strat.times[t.entryI]).toISOString().slice(0, 10)}</td>
                        <td>{new Date(strat.times[t.exitI]).toISOString().slice(0, 10)}</td>
                        <td>{t.dir > 0 ? 'long' : 'short'}</td>
                        <td className="text-right">{fmtPrice(t.entry)}</td>
                        <td className="text-right">{fmtPrice(t.exit)}</td>
                        <td className="text-right" style={{ color: t.ret >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtPct(t.ret)}</td>
                        <td>{t.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          )}
          <p className="mt-3 text-[10px] text-faint">Entries at the signal bar’s close (event study) or next open (strategy). Past behaviour of a signal is not a forecast. Costs: {cfg.feesBps + cfg.slippageBps} bps per side in strategy mode.</p>
        </div>
      )}
    </div>
  );
}

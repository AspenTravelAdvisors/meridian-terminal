import { INTERVAL_MS, type Interval, heikinAshi, parseSymbol, rangeBars, renko } from '@meridian/data';
import { type Bar, type InspectRow, type StudyResult, getStudy, volumeProfileBars } from '@meridian/engine';
import { LINK_COLORS, type LinkGroup, palette } from '@meridian/ui';
import type { IChartApi, ISeriesApi, Logical, MouseEventParams, SeriesType, Time } from 'lightweight-charts';
import { createChart } from 'lightweight-charts';
import { AlertTriangle, ChevronsRight, Eye, EyeOff, Loader2, Radio, Settings2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBars } from '../data/useBars';
import { EngineClient } from '../engine/engineClient';
import { runScriptSandboxed } from '../engine/script';
import { fmtPrice, fmtTime, fmtVol } from '../lib/format';
import { useDrawings, useJournal, useScripts, useSettings, useUi, useWorkspace } from '../state/store';
import type { Drawing, PaneConfig, StudyInstanceCfg, TfBucket } from '../state/types';
import { useAux } from './aux';
import { chartActions, crosshairBus, rangeBus, snapshotters } from './bus';
import { DrawingController, DrawingsPrimitive } from './drawings';
import { ExplainCard } from './ExplainCard';
import { explain } from './explain';
import { type ChartHit, HeatStripPrimitive, LevelsPrimitive, type MarkerItem, TextMarkersPrimitive } from './primitives';
import { StudyRenderer, chartOptions, createMainSeries, mainData, readTheme, setScaleMode } from './render';
import { TimeMap, displayTz } from './timeMap';
import { type View, anchoredRange, following, viewOf } from './viewport';

export const tfBucket = (iv: Interval): TfBucket => {
  const ms = INTERVAL_MS[iv];
  return ms < 3_600_000 ? 'minutes' : ms < 86_400_000 ? 'hours' : ms < 7 * 86_400_000 ? 'days' : ms < 28 * 86_400_000 ? 'weeks' : 'months';
};

/** Inspector rows for the active pane (Rule Inspector panel). */
export const inspectors = new Map<string, (i: number) => Promise<InspectRow[]>>();

/** Last view per pane, relative to the newest bar; outlives chart-type remounts so the zoom carries over. */
const views = new Map<string, View>();
/** Mouse with hover (not touch): explanations follow the pointer; touch gets them on tap only. */
const canHover = () => typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

type ScriptPlots = { uid: string; overlay: boolean; name: string; plots: { title: string; color: string; values: number[]; style: string }[]; hlines: { value: number; title: string; color: string }[]; signals: { i: number; id: string; dir: string; text: string }[]; error?: string };

export const ChartPane = memo(function ChartPane({ pane, active, solo }: { pane: PaneConfig; active: boolean; solo: boolean }) {
  const data = useBars(pane.symbol, pane.interval, pane.adjust);
  const setRuntime = useUi((s) => s.setRuntime);
  const replay = useUi((s) => s.replay[pane.id]);
  const tzSetting = useSettings((s) => s.timezone);

  // analysis bars: Renko/Range bricks replace time bars; everything else analyses real bars
  const analysis = useMemo(() => {
    if (pane.chartType === 'renko') return renko(data.bars.filter((b) => b.final !== false), pane.boxSize || undefined);
    if (pane.chartType === 'range') return rangeBars(data.bars, pane.boxSize || undefined);
    return data.bars;
  }, [data.bars, pane.chartType, pane.boxSize]);
  const effective = useMemo(() => (replay?.active ? analysis.slice(0, Math.max(1, replay.index + 1)) : analysis), [analysis, replay?.active, replay?.index]);
  const display = useMemo(() => (pane.chartType === 'heikin' ? heikinAshi(effective) : effective), [effective, pane.chartType]);
  const tm = useMemo(
    () => new TimeMap(effective, displayTz(tzSetting, data.info?.timezone ?? 'UTC'), pane.chartType === 'renko' || pane.chartType === 'range' ? 60_000 : INTERVAL_MS[pane.interval], data.info?.calendar ?? '24x7'),
    [effective, tzSetting, data.info?.timezone, data.info?.calendar, pane.interval, pane.chartType],
  );

  const bucket = tfBucket(pane.interval);
  const cfgs = useMemo(() => pane.studies.filter((s) => s.visible && s.visibility[bucket] !== false), [pane.studies, bucket]);
  const engineStudies = useMemo(() => cfgs.filter((c) => c.id !== 'script' && getStudy(c.id)).map((c) => ({ key: c.uid, id: c.id, cfg: c.cfg })), [cfgs]);
  const studiesKey = JSON.stringify(engineStudies);
  const aux = useAux(pane.symbol, cfgs, effective, pane.interval);

  // ── engine worker: full load vs incremental append ─────────────────────
  const [results, setResults] = useState<StudyResult[]>([]);
  const [computeMs, setComputeMs] = useState(0);
  const clientRef = useRef<EngineClient | null>(null);
  const sent = useRef({ key: '', firstT: NaN, finalLen: 0, lastFinalT: NaN });
  useEffect(() => {
    const c = new EngineClient();
    c.onResults = (r) => {
      setResults(r.results);
      setComputeMs(r.ms);
    };
    clientRef.current = c;
    inspectors.set(pane.id, (i) => c.inspect(i));
    return () => {
      c.dispose();
      inspectors.delete(pane.id);
    };
  }, [pane.id]);
  // a different series: drop the previous one's results at once so they are never drawn against the new bars
  const seriesKey = `${pane.symbol}|${pane.interval}|${pane.adjust}|${pane.chartType}`;
  useEffect(() => {
    setResults([]);
    sent.current = { key: '', firstT: NaN, finalLen: 0, lastFinalT: NaN };
  }, [seriesKey]);
  useEffect(() => {
    const c = clientRef.current;
    if (!c) return;
    if (!effective.length || !engineStudies.length) {
      setResults([]);
      sent.current = { key: '', firstT: NaN, finalLen: 0, lastFinalT: NaN };
      return;
    }
    const s = sent.current;
    const key = `${studiesKey}|${aux.key}|${pane.interval}`;
    const finalLen = effective[effective.length - 1].final === false ? effective.length - 1 : effective.length;
    const canAppend = s.key === key && s.firstT === effective[0].t && s.finalLen <= effective.length && s.finalLen > 0 && effective[s.finalLen - 1]?.t === s.lastFinalT;
    if (canAppend) c.append(effective.slice(s.finalLen));
    else c.load(engineStudies, effective, INTERVAL_MS[pane.interval], aux.aux);
    sent.current = { key, firstT: effective[0].t, finalLen, lastFinalT: effective[finalLen - 1]?.t ?? NaN };
  }, [effective, studiesKey, aux.key, aux.aux, engineStudies, pane.interval]);

  // ── user scripts (sandboxed worker, throttled on live ticks) ────────────
  const scripts = useScripts((s) => s.scripts);
  const [scriptPlots, setScriptPlots] = useState<ScriptPlots[]>([]);
  const scriptCfgs = cfgs.filter((c) => c.id === 'script');
  const scriptKey = scriptCfgs.map((c) => `${c.uid}:${scripts.find((s) => s.id === c.scriptId)?.updatedAt}`).join('|');
  const lastScriptRun = useRef(0);
  useEffect(() => {
    if (!scriptCfgs.length || !effective.length) {
      setScriptPlots([]);
      return;
    }
    const now = Date.now();
    if (now - lastScriptRun.current < 1500 && scriptPlots.length) return;
    lastScriptRun.current = now;
    let dead = false;
    Promise.all(
      scriptCfgs.map(async (c) => {
        const sc = scripts.find((s) => s.id === c.scriptId);
        if (!sc) return null;
        const { result } = await runScriptSandboxed(sc.code, effective, sc.inputs);
        return { uid: c.uid, overlay: result.overlay, name: result.name, plots: result.plots, hlines: result.hlines, signals: result.signals, error: result.error } as ScriptPlots;
      }),
    ).then((r) => !dead && setScriptPlots(r.filter((x): x is ScriptPlots => x !== null)));
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptKey, effective]);

  // ── publish runtime for panels ──────────────────────────────────────────
  useEffect(() => {
    setRuntime(pane.id, {
      bars: effective,
      totalBars: analysis.length,
      info: data.info,
      results,
      status: data.status,
      error: data.error,
      provider: data.provider,
      simulated: data.simulated,
      fallbacks: data.fallbacks,
      live: data.live,
      lastUpdate: data.lastUpdate,
      computeMs,
    });
  }, [pane.id, effective, analysis.length, data.info, results, data.status, data.error, data.provider, data.simulated, data.fallbacks, data.live, data.lastUpdate, computeMs, setRuntime]);

  return (
    <ChartSurface
      key={pane.chartType}
      pane={pane}
      active={active}
      solo={solo}
      display={display}
      tm={tm}
      results={results}
      cfgs={cfgs}
      scriptPlots={scriptPlots}
      status={data.status}
      error={data.error}
      simulated={!!data.simulated}
      provider={data.provider}
      live={data.live}
      loadingMore={data.loadingMore}
      onNeedMore={data.hasMore && !replay?.active ? data.loadMore : undefined}
      onRetry={data.reload}
      name={data.info?.name ?? pane.symbol}
      replayActive={!!replay?.active}
    />
  );
});

interface SurfaceProps {
  pane: PaneConfig;
  active: boolean;
  solo: boolean;
  display: Bar[];
  tm: TimeMap;
  results: StudyResult[];
  cfgs: StudyInstanceCfg[];
  scriptPlots: ScriptPlots[];
  status: string;
  error?: string;
  simulated: boolean;
  provider?: string;
  live: string;
  loadingMore: boolean;
  onNeedMore?: () => void;
  onRetry(): void;
  name: string;
  replayActive: boolean;
}

function ChartSurface(p: SurfaceProps) {
  const { pane, display, tm } = p;
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const prims = useRef<{ markers: TextMarkersPrimitive; levels: LevelsPrimitive; heat: HeatStripPrimitive; drawings: DrawingsPrimitive } | null>(null);
  const renderer = useRef<StudyRenderer | null>(null);
  const controller = useRef<DrawingController | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const [hoverI, setHoverI] = useState<number | null>(null);
  const [paneTops, setPaneTops] = useState<number[]>([0]);
  const [editText, setEditText] = useState<Drawing | null>(null);
  const [tip, setTip] = useState<{ hit: ChartHit; x: number; y: number; pinned: boolean } | null>(null);
  const tipRef = useRef(tip);
  tipRef.current = tip;
  const [behind, setBehind] = useState(false);

  const settings = useSettings();
  const themeName = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const pal = palette(themeName, settings.palette);
  const ui = useUi;
  const ws = useWorkspace;
  const drawings = useDrawings((s) => s.bySymbol[pane.symbol]);
  const tool = useUi((s) => s.tool);
  const selected = useUi((s) => s.selectedDrawing);
  const notes = useJournal((s) => s.notes);

  // ── create chart once per surface ───────────────────────────────────────
  useEffect(() => {
    const el = box.current!;
    const theme = readTheme();
    const chart = createChart(el, chartOptions(theme));
    const series = createMainSeries(chart, pane.chartType, pal);
    const markers = new TextMarkersPrimitive();
    const levels = new LevelsPrimitive();
    const heat = new HeatStripPrimitive();
    const dr = new DrawingsPrimitive();
    markers.bg = theme.bg;
    dr.bg = theme.bg;
    dr.text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#d6dee7';
    levels.textColor = theme.text;
    series.attachPrimitive(levels);
    series.attachPrimitive(markers);
    series.attachPrimitive(heat);
    series.attachPrimitive(dr);
    chartRef.current = chart;
    seriesRef.current = series;
    prims.current = { markers, levels, heat, drawings: dr };
    renderer.current = new StudyRenderer(chart, series, levels, markers, heat);
    setScaleMode(chart, pane.scaleMode);

    controller.current = new DrawingController({
      chart,
      series,
      prim: dr,
      container: el,
      getTimeMap: () => latest.current.tm,
      getBars: () => latest.current.display,
      getTool: () => ui.getState().tool,
      getMagnet: () => useSettings.getState().magnet,
      getDrawings: () => useDrawings.getState().bySymbol[latest.current.pane.symbol] ?? [],
      defaultColor: () => (document.documentElement.dataset.theme === 'light' ? '#0284c7' : '#38bdf8'),
      onCreate: (d) => {
        const full = useDrawings.getState().add(latest.current.pane.symbol, d);
        ui.getState().set({ selectedDrawing: full.id });
      },
      onUpdate: (id, patch, record) => useDrawings.getState().update(latest.current.pane.symbol, id, patch, record),
      onSelect: (id) => ui.getState().set({ selectedDrawing: id }),
      onToolDone: () => ui.getState().set({ tool: null }),
      onEditText: (d) => setEditText(d.id ? d : (useDrawings.getState().bySymbol[latest.current.pane.symbol] ?? []).slice(-1)[0] ?? null),
    });

    // chart element under the pointer (markers, counts, levels, geometry, study lines) for the explainer
    const hitFrom = (param: MouseEventParams<Time>) => {
      const ev = param.sourceEvent;
      if (!ev || param.paneIndex === undefined || param.logical === undefined) return null;
      const paneEl = chart.panes()[param.paneIndex]?.getHTMLElement();
      if (!paneEl) return null;
      const pr = paneEl.getBoundingClientRect();
      const x = ev.clientX - pr.left;
      const y = ev.clientY - pr.top;
      if (x < 0 || x > chart.timeScale().width()) return null;
      let hit: ChartHit | null = param.paneIndex === 0 ? (markers.explainAt(x, y) ?? levels.explainAt(x, y) ?? heat.explainAt(x, y)) : null;
      hit ??= renderer.current?.seriesHitAt(param.paneIndex, Math.round(param.logical), y, (s) => (param.seriesData.get(s) as { value?: number } | undefined)?.value) ?? null;
      if (!hit) return null;
      const br = el.getBoundingClientRect();
      return { hit, x: ev.clientX - br.left, y: ev.clientY - br.top };
    };
    const tipsOn = () => useSettings.getState().chartTips && !ui.getState().tool;

    // crosshair → runtime + sync bus
    let raf = 0;
    const onMove = (param: MouseEventParams<Time>) => {
      const l = param.logical;
      const i = l === undefined ? null : Math.max(0, Math.min(latest.current.display.length - 1, Math.round(l)));
      const hover = param.sourceEvent && tipsOn() && canHover() && !tipRef.current?.pinned ? hitFrom(param) : null;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setHoverI(i);
        if (ws.getState().activePaneId === latest.current.pane.id) ui.getState().setRuntime(latest.current.pane.id, { crosshairI: i });
        if (!tipRef.current?.pinned) setTip(hover ? { ...hover, pinned: false } : null);
      });
      if (!param.sourceEvent) return; // programmatic (synced) moves don't re-broadcast
      const s = useSettings.getState();
      if (!s.syncCrosshair) return;
      const price = param.point ? series.coordinateToPrice(param.point.y) ?? undefined : undefined;
      crosshairBus.emit({ source: latest.current.pane.id, t: i === null ? null : latest.current.tm.t[i] ?? null, price: price ?? undefined, symbol: latest.current.pane.symbol });
    };
    chart.subscribeCrosshairMove(onMove);

    // replay start selection
    const onClick = (param: MouseEventParams<Time>) => {
      const rp = ui.getState().replay[latest.current.pane.id];
      if (rp?.selecting && param.logical !== undefined) {
        const i = Math.max(10, Math.round(param.logical));
        ui.getState().set({ replay: { ...ui.getState().replay, [latest.current.pane.id]: { ...rp, selecting: false, active: true, index: i, playing: false } } });
      } else if (tipsOn()) {
        // click / tap pins an explanation; clicking empty chart closes it
        const h = hitFrom(param);
        setTip(h ? { ...h, pinned: true } : null);
      }
      ws.getState().setActive(latest.current.pane.id);
    };
    chart.subscribeClick(onClick);

    // backfill on scroll + time sync + visible-range volume profile
    let applyingRange = false;
    let vpTimer: ReturnType<typeof setTimeout> | null = null;
    const onRange = (r: { from: number; to: number } | null) => {
      if (!r) return;
      const n = latest.current.display.length;
      if (n) {
        const v = viewOf(r, n);
        views.set(latest.current.pane.id, v);
        setBehind(!following(v));
      }
      if (tipRef.current && !tipRef.current.pinned) setTip(null);
      if (r.from < 25) latest.current.onNeedMore?.();
      if (!applyingRange && useSettings.getState().syncTime && ws.getState().activePaneId === latest.current.pane.id) {
        const tmx = latest.current.tm;
        rangeBus.emit({ source: latest.current.pane.id, from: tmx.fromLogical(r.from), to: tmx.fromLogical(r.to) });
      }
      if (latest.current.pane.showVolumeProfile) {
        if (vpTimer) clearTimeout(vpTimer);
        vpTimer = setTimeout(() => updateVrvp(), 120);
      }
    };
    const updateVrvp = () => {
      const r = chart.timeScale().getVisibleLogicalRange();
      const bars = latest.current.display;
      if (!r || !bars.length || !latest.current.pane.showVolumeProfile) return levels.setVrvp(null);
      const vp = volumeProfileBars(bars, Math.max(0, Math.floor(r.from)), Math.min(bars.length - 1, Math.ceil(r.to)), 28);
      levels.setVrvp(vp ? { ...vp, color: '#38bdf8', upColor: 'rgba(34,197,94,0.5)' } : null);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange as never);
    const offRange = rangeBus.on((m) => {
      if (m.source === latest.current.pane.id || !useSettings.getState().syncTime) return;
      const tmx = latest.current.tm;
      applyingRange = true;
      chart.timeScale().setVisibleLogicalRange({ from: tmx.toLogical(m.from), to: tmx.toLogical(m.to) });
      requestAnimationFrame(() => (applyingRange = false));
    });
    const offCross = crosshairBus.on((m) => {
      if (m.source === latest.current.pane.id) return;
      if (m.t === null) return chart.clearCrosshairPosition();
      const tmx = latest.current.tm;
      const l = Math.round(tmx.toLogical(m.t));
      const bars = latest.current.display;
      if (l < 0 || l >= bars.length) return chart.clearCrosshairPosition();
      const price = m.symbol === latest.current.pane.symbol && m.price !== undefined ? m.price : bars[l].c;
      chart.setCrosshairPosition(price, tmx.disp[l], series);
    });

    // pane layout for per-pane legends
    const measure = () => {
      const top0 = el.getBoundingClientRect().top;
      setPaneTops(chart.panes().map((pn) => (pn.getHTMLElement()?.getBoundingClientRect().top ?? top0) - top0));
    };
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);

    snapshotters.set(pane.id, () => {
      const c = chart.takeScreenshot(true, false);
      const out = document.createElement('canvas');
      out.width = c.width;
      out.height = c.height + 28;
      const g = out.getContext('2d')!;
      g.fillStyle = readTheme().bg;
      g.fillRect(0, 0, out.width, out.height);
      g.drawImage(c, 0, 28);
      g.fillStyle = readTheme().text;
      g.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      const lp = latest.current;
      g.fillText(`${lp.pane.symbol} · ${lp.pane.interval} · ${lp.cfgs.map((s) => getStudy(s.id)?.shortName ?? 'Script').join(', ')}${lp.simulated ? ' · SIMULATED DATA' : ''}`, 8, 18);
      g.textAlign = 'right';
      g.fillText(`Meridian Terminal · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, out.width - 8, 18);
      return out;
    });
    chartActions.set(pane.id, {
      fit: () => chart.timeScale().fitContent(),
      scroll: (n) => chart.timeScale().scrollToPosition(chart.timeScale().scrollPosition() + n, false),
      zoom: (f) => {
        const r = chart.timeScale().getVisibleLogicalRange();
        if (!r) return;
        const mid = r.to;
        const span = (r.to - r.from) * f;
        chart.timeScale().setVisibleLogicalRange({ from: mid - span, to: mid });
      },
      cancelTool: () => controller.current?.cancel(),
      finishPath: () => controller.current?.finishPath(),
      goTo: (t) => {
        const l = latest.current.tm.toLogical(t);
        const r = chart.timeScale().getVisibleLogicalRange();
        const span = r ? (r.to - r.from) / 2 : 60;
        chart.timeScale().setVisibleLogicalRange({ from: (l - span) as Logical, to: (l + span) as Logical });
      },
    });

    return () => {
      cancelAnimationFrame(raf);
      if (vpTimer) clearTimeout(vpTimer);
      offRange();
      offCross();
      ro.disconnect();
      controller.current?.dispose();
      snapshotters.delete(pane.id);
      chartActions.delete(pane.id);
      renderer.current?.dispose();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      prims.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // theme / palette changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const obs = new MutationObserver(() => {
      const t = readTheme();
      chart.applyOptions(chartOptions(t));
      if (prims.current) {
        prims.current.markers.bg = t.bg;
        prims.current.drawings.bg = t.bg;
      }
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (chartRef.current) setScaleMode(chartRef.current, pane.compare.length ? 'percent' : pane.scaleMode);
  }, [pane.scaleMode, pane.compare.length]);

  // main series data (incremental update for live ticks)
  const lastData = useRef<{ firstT: number; len: number; type: string; key: string }>({ firstT: NaN, len: 0, type: '', key: '' });
  const seriesKey = `${pane.symbol}|${pane.interval}|${pane.adjust}`;
  useEffect(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (!s || !chart) return;
    const d = mainData(display, tm, pane.chartType, pal);
    const prev = lastData.current;
    const firstT = display[0]?.t ?? NaN;
    if (prev.key === seriesKey && prev.firstT === firstT && prev.type === pane.chartType && (d.length === prev.len || d.length === prev.len + 1) && d.length > 0) {
      if (d.length === prev.len + 1 && d.length >= 2) s.update(d[d.length - 2] as never);
      s.update(d[d.length - 1] as never);
    } else {
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      const prior = views.get(pane.id) ?? null;
      s.setData(d as never);
      if (d.length) {
        if (prev.key === seriesKey && prev.len > 0 && range) {
          // same series reloaded or backfilled: follow the newest bar if we were, else keep the same bars on screen
          if (prior && following(prior)) ts.setVisibleLogicalRange(anchoredRange(d.length, prior, 'keep'));
          else {
            const shift = tm.toLogical(prev.firstT);
            if (shift) ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
          }
        } else ts.setVisibleLogicalRange(anchoredRange(d.length, prior, prev.len > 0 || prev.key ? settings.viewOnChange : 'latest'));
      }
    }
    lastData.current = { firstT, len: d.length, type: pane.chartType, key: seriesKey };
    if (prims.current) {
      prims.current.drawings.tm = tm;
      prims.current.drawings.fmt = (v) => fmtPrice(v);
      prims.current.drawings.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, tm, pane.chartType, settings.palette, seriesKey]);
  useEffect(() => setTip(null), [seriesKey]);
  useEffect(() => {
    if (!prims.current) return;
    const on = settings.chartTips && !tool;
    for (const pr of [prims.current.markers, prims.current.levels, prims.current.heat]) pr.explain = on;
    if (!on) setTip(null);
  }, [settings.chartTips, tool]);

  // studies → series + primitives
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    const map = new Map(p.results.map((x) => [x.id, x]));
    const n = display.length;
    const provisionalFrom = n && display[n - 1].final === false ? n - 1 : n;
    const extra: MarkerItem[] = [];
    // journal notes on this symbol
    for (const note of notes)
      if (note.symbol === pane.symbol && note.barT) {
        const i = Math.round(tm.toLogical(note.barT));
        if (i >= 0 && i < n) extra.push({ i, text: '✎', pos: 'above', color: pal.warn, row: 7, size: 2, style: 'solid', src: 'journal', tip: note.body ? `${note.title} — ${note.body}` : note.title });
      }
    for (const sp of p.scriptPlots) for (const s of sp.signals) if (s.i < n) extra.push({ i: s.i, text: s.text, pos: s.dir === 'bear' ? 'above' : 'below', color: s.dir === 'bull' ? pal.bull : s.dir === 'bear' ? pal.bear : pal.info, row: 6, size: 1, style: 'solid', src: sp.uid, tip: s.id });
    r.render({ results: map, cfgs: p.cfgs, tm, pal, bars: display, provisionalFrom, hollowProvisional: settings.hollowProvisional, extraMarkers: extra, scriptPlots: p.scriptPlots });
    if (prims.current) prims.current.heat.enabled = settings.showHeatStrip;
    requestAnimationFrame(() => {
      const el = box.current;
      const chart = chartRef.current;
      if (!el || !chart) return;
      const top0 = el.getBoundingClientRect().top;
      setPaneTops(chart.panes().map((pn) => (pn.getHTMLElement()?.getBoundingClientRect().top ?? top0) - top0));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.results, p.cfgs, p.scriptPlots, tm, settings.palette, settings.hollowProvisional, settings.showHeatStrip, notes, pane.symbol]);

  // drawings
  useEffect(() => {
    const d = prims.current?.drawings;
    if (!d) return;
    d.selected = selected;
    d.setDrawings(drawings ?? []);
  }, [drawings, selected]);
  useEffect(() => {
    if (box.current) box.current.style.cursor = tool ? 'crosshair' : '';
    if (!tool) controller.current?.cancel();
  }, [tool]);

  // volume profile toggle
  useEffect(() => {
    const chart = chartRef.current;
    const lv = prims.current?.levels;
    if (!chart || !lv) return;
    if (!pane.showVolumeProfile) return lv.setVrvp(null);
    const r = chart.timeScale().getVisibleLogicalRange();
    if (!r || !display.length) return;
    const vp = volumeProfileBars(display, Math.max(0, Math.floor(r.from)), Math.min(display.length - 1, Math.ceil(r.to)), 28);
    lv.setVrvp(vp ? { ...vp, color: '#38bdf8', upColor: 'rgba(34,197,94,0.5)' } : null);
  }, [pane.showVolumeProfile, display]);

  // compare symbols (percent scale)
  useCompare(chartRef, pane, tm, display);

  const i = hoverI ?? display.length - 1;
  const closeTip = useCallback(() => setTip(null), []);
  const explained = useMemo(
    () => (tip ? explain(tip.hit, { cfgs: p.cfgs, results: new Map(p.results.map((r) => [r.id, r])), scriptPlots: p.scriptPlots }) : null),
    [tip, p.cfgs, p.results, p.scriptPlots],
  );
  const tipTime = tip && tip.hit.i >= 0 && tm.length ? fmtTime(tm.realAt(tip.hit.i), tfBucket(pane.interval) === 'minutes' || tfBucket(pane.interval) === 'hours', tm.tz) : undefined;
  const tipCfg = explained?.uid ? p.cfgs.find((c) => c.uid === explained.uid) : undefined;
  return (
    <div className="relative h-full w-full" onPointerDown={() => useWorkspace.getState().setActive(pane.id)}>
      <div ref={box} className="absolute inset-0" data-testid={`chart-${pane.id}`} />
      <Legend surface={p} i={i} paneTops={paneTops} />
      {tip && explained && (
        <ExplainCard
          e={explained}
          x={tip.x}
          y={tip.y}
          w={box.current?.clientWidth ?? 0}
          h={box.current?.clientHeight ?? 0}
          time={tipTime}
          pinned={tip.pinned}
          onClose={closeTip}
          onSettings={tipCfg && tipCfg.id !== 'script' ? () => (setTip(null), ui.getState().set({ studySettings: { paneId: pane.id, uid: tipCfg.uid } })) : undefined}
        />
      )}
      {behind && display.length > 0 && (
        <button
          className="absolute bottom-8 right-[72px] z-20 grid size-7 place-items-center rounded-full border border-border bg-panel text-dim shadow hover:text-text"
          title="Scroll to the newest bar"
          aria-label="Scroll to the newest bar"
          onClick={() => chartRef.current?.timeScale().setVisibleLogicalRange(anchoredRange(display.length, views.get(pane.id) ?? null, 'latest'))}
        >
          <ChevronsRight className="size-4" />
        </button>
      )}
      {p.status === 'loading' && !display.length && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center text-dim">
          <span className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Loading {pane.symbol}…</span>
        </div>
      )}
      {p.status === 'error' && !display.length && <ErrorState pane={pane} error={p.error} onRetry={p.onRetry} />}
      {p.loadingMore && <div className="absolute left-2 bottom-8 z-20 rounded bg-raised px-2 py-0.5 text-[11px] text-dim">loading history…</div>}
      {editText && (
        <TextEditor
          initial={editText.text ?? ''}
          onDone={(t) => {
            if (t !== null) useDrawings.getState().update(pane.symbol, editText.id, { text: t });
            setEditText(null);
          }}
        />
      )}
      {!p.solo && <LinkDot pane={pane} />}
    </div>
  );
}

function useCompare(chartRef: React.RefObject<IChartApi | null>, pane: PaneConfig, tm: TimeMap, display: Bar[]) {
  const seriesMap = useRef(new Map<string, ISeriesApi<SeriesType>>());
  const key = pane.compare.join(',');
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const want = new Set(pane.compare);
    for (const [sym, s] of seriesMap.current)
      if (!want.has(sym)) {
        chart.removeSeries(s);
        seriesMap.current.delete(sym);
      }
    const colors = ['#f59e0b', '#a78bfa', '#22d3ee', '#f472b6', '#84cc16'];
    let dead = false;
    pane.compare.forEach(async (sym, k) => {
      const { getBarsCached } = await import('../data/useBars');
      const { alignByTime } = await import('@meridian/engine');
      try {
        const other = await getBarsCached(sym, pane.interval, 2000);
        if (dead || !chartRef.current) return;
        const al = alignByTime(display, other);
        let s = seriesMap.current.get(sym);
        if (!s) {
          const { LineSeries } = await import('lightweight-charts');
          s = chart.addSeries(LineSeries, { color: colors[k % colors.length], lineWidth: 2, priceLineVisible: false, title: sym });
          seriesMap.current.set(sym, s);
        }
        s.setData(Array.from(al, (v, i) => (Number.isFinite(v) ? { time: tm.disp[i], value: v } : { time: tm.disp[i] })) as never);
      } catch {
        /* compare symbol unavailable */
      }
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tm, display.length]);
}

function LinkDot({ pane }: { pane: PaneConfig }) {
  const order: (LinkGroup | null)[] = [null, 'red', 'green', 'blue', 'yellow', 'purple'];
  const next = order[(order.indexOf(pane.linkGroup) + 1) % order.length];
  return (
    <button
      className="absolute right-[70px] top-1.5 z-10 size-3 rounded-full border border-border-strong"
      style={{ background: pane.linkGroup ? LINK_COLORS[pane.linkGroup] : 'transparent' }}
      title={`Link group: ${pane.linkGroup ?? 'none'} (click to cycle) — panes in the same group share symbol${useSettings.getState().syncInterval ? ' and interval' : ''}`}
      aria-label="Cycle link group"
      onClick={(e) => {
        e.stopPropagation();
        useWorkspace.getState().updatePane(pane.id, { linkGroup: next });
      }}
    />
  );
}

function ErrorState({ pane, error, onRetry }: { pane: PaneConfig; error?: string; onRetry(): void }) {
  const isSim = parseSymbol(pane.symbol).provider === 'sim';
  return (
    <div className="absolute inset-0 z-20 grid place-items-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-panel p-4 text-sm shadow-lg">
        <div className="mb-1 flex items-center gap-2 font-semibold text-warn"><AlertTriangle className="size-4" /> Couldn’t load {pane.symbol}</div>
        <p className="mb-3 text-dim break-words">{error ?? 'Unknown error'}</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={onRetry}>Retry</button>
          {!isSim && (
            <button className="btn" onClick={() => useWorkspace.getState().setSymbol(pane.id, 'SIM:DEMO')}>
              Use simulated demo data
            </button>
          )}
        </div>
        {!isSim && <p className="mt-2 text-[11px] text-faint">Real symbols never fall back to simulated prices automatically.</p>}
      </div>
    </div>
  );
}

function TextEditor({ initial, onDone }: { initial: string; onDone(t: string | null): void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="absolute left-1/2 top-12 z-30 w-72 -translate-x-1/2 rounded-md border border-border bg-panel p-2 shadow-lg">
      <textarea autoFocus className="input h-20 w-full" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onDone(v); if (e.key === 'Escape') onDone(null); }} aria-label="Drawing text" />
      <div className="mt-1 flex justify-end gap-2">
        <button className="btn" onClick={() => onDone(null)}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onDone(v)}>Save</button>
      </div>
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────
function Legend({ surface: p, i, paneTops }: { surface: SurfaceProps; i: number; paneTops: number[] }) {
  const b = p.display[i];
  const prev = p.display[i - 1];
  const showValues = useSettings((s) => s.showLegendValues);
  const ws = useWorkspace.getState();
  const ui = useUi.getState();
  // touch has no hover: tapping a study name toggles its controls
  const [openUid, setOpenUid] = useState<string | null>(null);
  const chg = b && prev ? b.c - prev.c : 0;
  const byUid = useMemo(() => new Map(p.results.map((r) => [r.id, r])), [p.results]);
  // which pane each non-overlay study occupies (same rule as the renderer)
  let next = 1;
  const placement = p.cfgs.map((c) => {
    const def = getStudy(c.id);
    if (c.id === 'script') {
      const sp = p.scriptPlots.find((x) => x.uid === c.uid);
      return sp && !sp.overlay ? next++ : 0;
    }
    if (!def || def.overlay || c.id === 'volume') return 0;
    return def.outputs(c.cfg).some((o) => o.kind === 'line' || o.kind === 'histogram') ? next++ : 0;
  });
  // Toggle on pointerup: Chromium's touch adjustment can retarget a tap's click onto the chart canvas next to this small
  // label. Keyboard activation still arrives as a click with detail 0.
  const toggleProps = (uid: string) => ({
    'aria-expanded': openUid === uid,
    onPointerUp: () => setOpenUid(openUid === uid ? null : uid),
    onClick: (e: React.MouseEvent) => e.detail === 0 && setOpenUid(openUid === uid ? null : uid),
  });
  const row = (c: StudyInstanceCfg) => {
    const def = getStudy(c.id);
    const r = byUid.get(c.uid);
    const sp = p.scriptPlots.find((x) => x.uid === c.uid);
    const name = c.id === 'script' ? (sp?.name ?? 'Script') : (def?.shortName ?? c.id);
    const nums = Object.entries(c.cfg)
      .filter(([, v]) => typeof v === 'number')
      .slice(0, 3)
      .map(([, v]) => v)
      .join(' ');
    const vals =
      showValues && r && i >= 0
        ? r.outputs
            .filter((o) => (o.kind === 'line' && (o as { render?: string }).render !== 'level') || o.kind === 'histogram')
            .slice(0, 5)
            .map((o) => ({ id: o.id, v: r.lines[o.id]?.[i] }))
            .filter((x) => x.v !== undefined && Number.isFinite(x.v))
        : [];
    const err = (r as (StudyResult & { error?: string }) | undefined)?.error ?? sp?.error;
    return (
      <div key={c.uid} className="legend-row group flex items-center gap-1.5">
        <button type="button" className="font-medium text-text" aria-label={`${name} controls`} {...toggleProps(c.uid)}>{name}</button>
        {nums && <span className="text-faint">{nums}</span>}
        {r?.provisional && <span className="rounded bg-raised px-1 text-[9px] uppercase tracking-wide text-warn" title="Forming bar — counts are provisional until the bar closes">prov</span>}
        {err && <span className="text-danger" title={err}>⚠</span>}
        {vals.map((x) => (
          <span key={x.id} className="tabular-nums text-dim">{c.id === 'volume' ? fmtVol(Math.abs(x.v!)) : fmtPrice(x.v!)}</span>
        ))}
        <span className={`pointer-events-auto ml-1 items-center gap-0.5 group-focus-within:flex group-hover:flex ${openUid === c.uid ? 'flex' : 'hidden'}`}>
          <button className="icon-btn" title="Hide" aria-label={`Hide ${name}`} onClick={() => ws.updateStudy(p.pane.id, c.uid, { visible: false })}><EyeOff className="size-3" /></button>
          {c.id !== 'script' && <button className="icon-btn" title="Settings" aria-label={`${name} settings`} onClick={() => ui.set({ studySettings: { paneId: p.pane.id, uid: c.uid } })}><Settings2 className="size-3" /></button>}
          <button className="icon-btn" title="Remove" aria-label={`Remove ${name}`} onClick={() => ws.removeStudy(p.pane.id, c.uid)}><X className="size-3" /></button>
        </span>
      </div>
    );
  };
  const hidden = p.pane.studies.filter((s) => !s.visible);
  return (
    <>
      <div className="pointer-events-none absolute left-2 top-1.5 z-10 max-w-[calc(100%-90px)] text-[11px] leading-[17px]">
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="font-semibold text-text">{p.pane.symbol}</span>
          <span className="text-dim">{p.pane.interval}</span>
          <span className="hidden truncate text-faint sm:inline">{p.name !== p.pane.symbol ? p.name : ''}</span>
          {p.simulated && <span className="rounded bg-warn/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-warn" title="Deterministic simulated data — not market prices">Simulated</span>}
          {p.live !== 'off' && <span className="flex items-center gap-0.5 text-[10px] text-ok" title={p.live === 'stream' ? 'Live stream' : 'Live (polling)'}><Radio className="size-3" />{p.live}</span>}
          {p.replayActive && <span className="rounded bg-accent/20 px-1 text-[9px] font-semibold uppercase text-accent">Replay</span>}
        </div>
        {b && (
          <div className="flex flex-wrap gap-x-2 tabular-nums text-dim">
            <span>O <b className="font-normal text-text">{fmtPrice(b.o)}</b></span>
            <span>H <b className="font-normal text-text">{fmtPrice(b.h)}</b></span>
            <span>L <b className="font-normal text-text">{fmtPrice(b.l)}</b></span>
            <span>C <b className="font-normal text-text">{fmtPrice(b.c)}</b></span>
            <span style={{ color: chg >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{chg >= 0 ? '+' : ''}{fmtPrice(chg)} ({prev ? ((100 * chg) / prev.c).toFixed(2) : '0.00'}%)</span>
            <span>V {fmtVol(b.v)}</span>
            {b.final === false && <span className="text-warn">forming</span>}
          </div>
        )}
        {p.cfgs.filter((_, k) => placement[k] === 0).map(row)}
        {hidden.length > 0 && (
          <div className="pointer-events-auto flex flex-wrap gap-1 text-faint">
            {hidden.map((h) => (
              <button key={h.uid} className="flex items-center gap-0.5 hover:text-text" onClick={() => ws.updateStudy(p.pane.id, h.uid, { visible: true })} title="Show">
                <Eye className="size-3" /> {getStudy(h.id)?.shortName ?? 'Script'}
              </button>
            ))}
          </div>
        )}
      </div>
      {p.cfgs.map((c, k) =>
        placement[k] > 0 && paneTops[placement[k]] !== undefined ? (
          <div key={c.uid} className="pointer-events-none absolute left-2 z-10 text-[11px] leading-[17px]" style={{ top: paneTops[placement[k]] + 3 }}>
            {row(c)}
          </div>
        ) : null,
      )}
    </>
  );
}


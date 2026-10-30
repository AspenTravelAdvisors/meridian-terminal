import { type Bar, type LineOutput, type OutputSpec, type StudyResult, getStudy } from '@meridian/engine';
import { type SignalPalette, resolveColor, withAlpha } from '@meridian/ui';
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  type DeepPartial,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  LineType,
  PriceScaleMode,
  type SeriesType,
  type ChartOptions,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartType, ScaleMode, StudyInstanceCfg } from '../state/types';
import type { ChartHit, CloudData, GeoSegment, HeatStripPrimitive, LabelColumn, LevelRun, LevelsPrimitive, MarkerItem, PivotPath, TextMarkersPrimitive } from './primitives';
import { dropFailedRuns } from './labels';
import type { TimeMap } from './timeMap';
import { RIGHT_MARGIN } from './viewport';

export interface ChartTheme {
  bg: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  panel: string;
}

export function readTheme(): ChartTheme {
  const s = getComputedStyle(document.documentElement);
  const v = (k: string, d: string) => s.getPropertyValue(k).trim() || d;
  return { bg: v('--bg', '#0b0f14'), text: v('--text-dim', '#8b9aab'), grid: v('--grid', 'rgba(139,154,171,0.08)'), border: v('--border', '#233140'), crosshair: v('--crosshair', 'rgba(214,222,231,0.35)'), panel: v('--panel', '#111821') };
}

export function chartOptions(t: ChartTheme): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: t.bg }, textColor: t.text, fontSize: 11, fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', attributionLogo: false, panes: { separatorColor: t.border, separatorHoverColor: withAlpha('#38bdf8', 0.3), enableResize: true } },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: t.crosshair, labelBackgroundColor: t.border }, horzLine: { color: t.crosshair, labelBackgroundColor: t.border } },
    rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: RIGHT_MARGIN, barSpacing: 7, minBarSpacing: 0.5 },
    localization: { locale: navigator.language },
    kineticScroll: { mouse: false, touch: true },
  };
}

export const scaleModeOf = (m: ScaleMode) => (m === 'log' ? PriceScaleMode.Logarithmic : m === 'percent' ? PriceScaleMode.Percentage : m === 'indexed' ? PriceScaleMode.IndexedTo100 : PriceScaleMode.Normal);

export function createMainSeries(chart: IChartApi, type: ChartType, p: SignalPalette): ISeriesApi<SeriesType> {
  const common = { priceLineVisible: true, lastValueVisible: true };
  switch (type) {
    case 'bars':
      return chart.addSeries(BarSeries, { ...common, upColor: p.up, downColor: p.down, thinBars: false });
    case 'line':
      return chart.addSeries(LineSeries, { ...common, color: p.info, lineWidth: 2 });
    case 'area':
      return chart.addSeries(AreaSeries, { ...common, lineColor: p.info, topColor: withAlpha(p.info, 0.35), bottomColor: withAlpha(p.info, 0.02), lineWidth: 2 });
    case 'baseline':
      return chart.addSeries(BaselineSeries, { ...common, topLineColor: p.up, bottomLineColor: p.down, topFillColor1: withAlpha(p.up, 0.28), topFillColor2: withAlpha(p.up, 0.03), bottomFillColor1: withAlpha(p.down, 0.03), bottomFillColor2: withAlpha(p.down, 0.28) });
    case 'hollow':
      return chart.addSeries(CandlestickSeries, { ...common, upColor: 'rgba(0,0,0,0)', downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down, borderVisible: true });
    default:
      return chart.addSeries(CandlestickSeries, { ...common, upColor: p.up, downColor: p.down, borderVisible: false, wickUpColor: p.up, wickDownColor: p.down });
  }
}

/** Main-series data. The forming (provisional) bar is drawn translucent. */
export function mainData(bars: readonly Bar[], tm: TimeMap, type: ChartType, p: SignalPalette) {
  const ohlc = !(type === 'line' || type === 'area' || type === 'baseline');
  return bars.map((b, i) => {
    const time = tm.disp[i];
    if (!ohlc) return { time, value: b.c };
    const up = b.c >= b.o;
    if (b.final === false) {
      const col = withAlpha(up ? p.up : p.down, 0.5);
      return { time, open: b.o, high: b.h, low: b.l, close: b.c, color: type === 'hollow' && up ? 'rgba(0,0,0,0)' : col, borderColor: col, wickColor: col };
    }
    return { time, open: b.o, high: b.h, low: b.l, close: b.c };
  });
}

const lineStyleOf = (s?: string) => (s === 'dashed' ? LineStyle.Dashed : s === 'dotted' ? LineStyle.Dotted : LineStyle.Solid);

interface Entry {
  series: Map<string, ISeriesApi<SeriesType>>;
  priceLines: IPriceLine[];
  pane: number;
}

export interface RenderInput {
  results: Map<string, StudyResult>;
  cfgs: StudyInstanceCfg[];
  tm: TimeMap;
  pal: SignalPalette;
  bars: readonly Bar[];
  provisionalFrom: number;
  hollowProvisional: boolean;
  extraMarkers: MarkerItem[];
  scriptPlots: { uid: string; overlay: boolean; plots: { title: string; color: string; values: number[]; style: string }[]; hlines: { value: number; title: string; color: string }[] }[];
}

/** Keeps LWC series in sync with study results; dense annotations go to primitives. */
/** Bars of dated time axis kept past the furthest projection (time marks, forward segments). */
export const FUTURE_PAD = 5;

/** Compact date for a projected bar; display seconds are already shifted into the chart's time zone. */
function shortDate(dispS: number, intraday: boolean, withYear: boolean): string {
  const o: Intl.DateTimeFormatOptions = intraday ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) };
  return new Intl.DateTimeFormat(undefined, { ...o, timeZone: 'UTC' }).format(dispS * 1000);
}

export class StudyRenderer {
  private entries = new Map<string, Entry>();
  private sig = '';
  /** whitespace-only series that gives the time axis dated slots past the last bar, out to the furthest projection */
  private future: ISeriesApi<SeriesType> | null = null;
  private futureKey = '';
  constructor(
    private chart: IChartApi,
    private main: ISeriesApi<SeriesType>,
    private levels: LevelsPrimitive,
    private markers: TextMarkersPrimitive,
    private heat: HeatStripPrimitive,
  ) {}

  /** pane index per study; non-overlay studies get their own pane in list order */
  private layout(cfgs: StudyInstanceCfg[], scripts: RenderInput['scriptPlots']): Map<string, number> {
    const m = new Map<string, number>();
    let next = 1;
    for (const c of cfgs) {
      const def = getStudy(c.id);
      if (c.id === 'script') {
        const s = scripts.find((x) => x.uid === c.uid);
        m.set(c.uid, s && !s.overlay ? next++ : 0);
      } else if (!def || def.overlay || c.id === 'volume') m.set(c.uid, 0);
      else if (def.outputs(c.cfg).some((o) => o.kind === 'line' || o.kind === 'histogram')) m.set(c.uid, next++);
      else m.set(c.uid, 0);
    }
    return m;
  }

  private reset() {
    for (const e of this.entries.values()) for (const s of e.series.values()) this.chart.removeSeries(s);
    this.entries.clear();
    for (let k = this.chart.panes().length - 1; k >= 1; k--) this.chart.removePane(k);
  }

  dispose() {
    this.entries.clear();
  }

  /** Dated empty slots for bars n … n + k − 1 (k = 0 removes them). */
  private setFuture(tm: TimeMap, k: number) {
    const n = tm.length;
    const key = `${n}|${n ? tm.disp[n - 1] : ''}|${k}`;
    if (key === this.futureKey) return;
    this.futureKey = key;
    if (!this.future) this.future = this.chart.addSeries(LineSeries, { lineVisible: false, pointMarkersVisible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }, 0);
    const pts: { time: UTCTimestamp }[] = [];
    for (let j = 0; j < k; j++) {
      const time = tm.displayAt(n + j);
      if (time !== null) pts.push({ time });
    }
    this.future.setData(pts as never);
  }

  /** Draws every study; returns how many bars past the last bar the furthest projected time mark lies (0 = none). */
  render(inp: RenderInput): number {
    const { results, cfgs, tm, pal } = inp;
    const layout = this.layout(cfgs, inp.scriptPlots);
    const sig = cfgs.map((c) => `${c.uid}:${layout.get(c.uid)}:${c.id === 'script' ? inp.scriptPlots.find((s) => s.uid === c.uid)?.plots.length : ''}`).join('|');
    if (sig !== this.sig) {
      this.reset();
      this.sig = sig;
    }
    const col = (c: string) => resolveColor(c, pal);
    const runs: LevelRun[] = [];
    const segments: GeoSegment[] = [];
    const paths: PivotPath[] = [];
    const timeMarks: LevelsPrimitive['timeMarks'] = [];
    const profiles: LevelsPrimitive['profiles'] = [];
    const clouds: CloudData[] = [];
    const columns: LabelColumn[] = [];
    const marks: MarkerItem[] = [...inp.extraMarkers];
    const heat = new Map<number, { bull: number; bear: number; neutral: number }>();
    const n = tm.length;
    const intraday = tm.intervalMs < 86_400_000;
    const lastYear = n ? new Date(tm.disp[n - 1] * 1000).getUTCFullYear() : 0;
    // bars past the last bar reached by projected time marks (the view makes room for these) and by anything drawn there
    let marksAhead = 0;
    let ahead = 0;

    const pointsOf = (values: ArrayLike<number>, offset = 0, abs = false) => {
      const out: { time: UTCTimestamp; value?: number }[] = [];
      for (let i = 0; i < values.length; i++) {
        const k = i + offset;
        if (k < 0) continue;
        const time = tm.displayAt(k);
        if (time === null) continue;
        const v = values[i];
        out.push(Number.isFinite(v) ? { time, value: abs ? Math.abs(v) : v } : { time });
      }
      return out;
    };

    const ensure = (uid: string, key: string, pane: number, make: () => ISeriesApi<SeriesType>) => {
      let e = this.entries.get(uid);
      if (!e) {
        e = { series: new Map(), priceLines: [], pane };
        this.entries.set(uid, e);
      }
      let s = e.series.get(key);
      if (!s) {
        s = make();
        e.series.set(key, s);
        if (pane > 0) this.chart.panes()[pane]?.setStretchFactor(0.32);
      }
      return { s, e };
    };

    for (const c of cfgs) {
      const pane = layout.get(c.uid) ?? 0;
      if (c.id === 'script') {
        const sp = inp.scriptPlots.find((x) => x.uid === c.uid);
        if (!sp) continue;
        sp.plots.forEach((p, k) => {
          const { s, e } = ensure(c.uid, `p${k}`, pane, () =>
            p.style === 'histogram'
              ? this.chart.addSeries(HistogramSeries, { color: p.color, priceLineVisible: false, lastValueVisible: false }, pane)
              : this.chart.addSeries(LineSeries, { color: p.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, lineType: p.style === 'step' ? LineType.WithSteps : LineType.Simple }, pane),
          );
          s.setData(pointsOf(p.values) as never);
          if (k === 0 && !e.priceLines.length) for (const h of sp.hlines) e.priceLines.push(s.createPriceLine({ price: h.value, color: h.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: h.title }));
        });
        continue;
      }
      const def = getStudy(c.id);
      const r = results.get(c.uid);
      // results longer than the series belong to the previous symbol/interval (the engine has not caught up yet).
      // Empty the study's series meanwhile: their old points would stay on the shared time scale, shifting every logical
      // index, so the view set for the new bars lands somewhere else once the new results replace them.
      if (!def || !r || r.len > n) {
        for (const s of this.entries.get(c.uid)?.series.values() ?? []) s.setData([]);
        continue;
      }
      const isVol = c.id === 'volume';
      const outs: OutputSpec[] = r.outputs;
      let firstSeries: ISeriesApi<SeriesType> | null = null;
      for (const o of outs) {
        const st = c.style[o.id] ?? {};
        if (st.visible === false) continue;
        if (o.kind === 'line' || o.kind === 'histogram') {
          const lo = o as LineOutput;
          if (o.kind === 'line' && lo.render === 'level') {
            const v = r.lines[o.id];
            const color = st.color ?? col(lo.color);
            let start = -1;
            for (let i = 0; i <= v.length; i++) {
              const same = i < v.length && start >= 0 && v[i] === v[start];
              if (same) continue;
              if (start >= 0 && Number.isFinite(v[start])) runs.push({ i1: start, i2: i - 1, price: v[start], color, dash: lo.style ?? 'solid', width: st.width ?? lo.width ?? 1, label: lo.label, src: c.uid, out: o.id });
              start = i < v.length && Number.isFinite(v[i]) ? i : -1;
            }
            continue;
          }
          if (o.hiddenByDefault && st.visible !== true) continue;
          const color = st.color ?? col(o.color);
          const { s } = ensure(c.uid, o.id, pane, () => {
            if (o.kind === 'histogram') {
              const hs = this.chart.addSeries(HistogramSeries, { color, priceLineVisible: false, lastValueVisible: false, priceScaleId: isVol ? 'vol' : undefined, priceFormat: isVol ? { type: 'volume' } : undefined }, pane);
              if (isVol) hs.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
              return hs;
            }
            return this.chart.addSeries(
              LineSeries,
              {
                color,
                lineWidth: (st.width ?? lo.width ?? 1) as 1,
                lineStyle: lineStyleOf(lo.style),
                lineType: lo.render === 'step' ? LineType.WithSteps : LineType.Simple,
                lineVisible: lo.render !== 'dots',
                pointMarkersVisible: lo.render === 'dots',
                pointMarkersRadius: 1.5,
                priceLineVisible: false,
                lastValueVisible: pane > 0,
                crosshairMarkerVisible: false,
                priceScaleId: isVol ? 'vol' : undefined,
              },
              pane,
            );
          });
          s.applyOptions({ color });
          firstSeries ??= s;
          const vals = r.lines[o.id];
          if (o.kind === 'histogram' || (isVol && o.id === 'vol')) {
            const pos = st.color ?? col(o.color);
            const neg = col((o as { negColor?: string }).negColor ?? o.color);
            const pts = [];
            for (let i = 0; i < vals.length; i++) {
              const v = vals[i];
              const time = tm.displayAt(i);
              if (time === null) continue;
              pts.push(Number.isFinite(v) ? { time, value: isVol ? Math.abs(v) : v, color: withAlpha(v >= 0 ? pos : neg, isVol ? 0.45 : 0.8) } : { time });
            }
            s.setData(pts as never);
          } else s.setData(pointsOf(vals, lo.offset ?? 0) as never);
        } else if (o.kind === 'cloud') {
          if (o.hiddenByDefault && st.visible !== true) continue;
          const a = r.lines[o.a];
          const b = r.lines[o.b];
          if (a && b) clouds.push({ src: c.uid, out: o.id, a, b, offset: o.offset ?? 0, up: withAlpha(col(o.upColor), 0.16), down: withAlpha(col(o.downColor), 0.16) });
        } else if (o.kind === 'labels') {
          const hf = o.hideFailedRuns;
          const counts = hf && r.lines[hf.count];
          const values = hf && counts ? dropFailedRuns(r.lines[o.id], counts, hf.length, inp.provisionalFrom) : r.lines[o.id];
          columns.push({ src: c.uid, out: o.id, values, row: o.row, posColor: col(o.posColor), negColor: col(o.negColor), mutedAbove: o.mutedAbove, provisionalFrom: inp.provisionalFrom });
        }
      }
      // horizontal reference lines on the study's first series
      const e = this.entries.get(c.uid);
      if (e && firstSeries && !e.priceLines.length)
        for (const o of outs) if (o.kind === 'hline') e.priceLines.push(firstSeries.createPriceLine({ price: o.value, color: col(o.color), lineWidth: 1, lineStyle: lineStyleOf(o.style), axisLabelVisible: false, title: '' }));
      // markers
      for (const m of r.markers)
        if (m.i < n) marks.push({ i: m.i, text: m.text, pos: m.pos, color: col(m.color), row: m.row ?? 0, size: m.size ?? 1, style: m.style ?? 'solid', provisional: m.provisional, price: m.price, src: c.uid, tip: m.tooltip });
      // geometry
      const g = r.geometry;
      // the engine names a segment's dash `style`; the primitive reads `dash`
      for (const s of g.segments ?? []) segments.push({ ...s, dash: s.style, color: col(s.color), src: c.uid });
      if (g.pivots?.length) paths.push({ points: g.pivots, color: col(g.polylineColor ?? 'accent'), src: c.uid });
      for (const t of g.timeMarks ?? []) {
        // projected marks carry their date: the point of a forward time mark is when it lands
        const at = t.i >= n ? tm.displayAt(t.i) : null;
        const label = at === null ? t.label : `${t.label} · ${shortDate(at, intraday, new Date(at * 1000).getUTCFullYear() !== lastYear)}`;
        timeMarks.push({ ...t, label, color: col(t.color ?? 'muted'), src: c.uid });
        marksAhead = Math.max(marksAhead, t.i - (n - 1));
      }
      for (const s of g.segments ?? []) ahead = Math.max(ahead, s.i2 - (n - 1));
      for (const p of g.profiles ?? []) profiles.push({ ...p, color: col('info'), upColor: withAlpha(col('bull'), 0.5) });
      // heat strip
      for (const s of r.signals) {
        const h = heat.get(s.i) ?? { bull: 0, bear: 0, neutral: 0 };
        h[s.dir]++;
        heat.set(s.i, h);
      }
    }
    ahead = Math.max(ahead, marksAhead);
    this.setFuture(tm, ahead > 0 ? ahead + FUTURE_PAD : 0);
    this.levels.setData({ runs, segments, paths, timeMarks, profiles, clouds, last: n - 1 });
    this.markers.hollowProvisional = inp.hollowProvisional;
    this.markers.setData(
      marks,
      columns,
      inp.bars.map((b) => b.h),
      inp.bars.map((b) => b.l),
    );
    this.heat.colors = { bull: pal.bull, bear: pal.bear, neutral: pal.neutral };
    this.heat.setData(heat);
    void this.main;
    return marksAhead;
  }

  /** Series of a study (for legend values / crosshair). */
  seriesOf(uid: string) {
    return this.entries.get(uid);
  }

  /**
   * The study line or histogram under pane-local `y` on pane `pane`, from the values LWC reports at the pointer's bar.
   * Lines hit within a few pixels; histogram columns hit anywhere between zero and their value.
   */
  seriesHitAt(pane: number, i: number, y: number, valueAt: (s: ISeriesApi<SeriesType>) => number | undefined): ChartHit | null {
    let best: { hit: ChartHit; d: number } | null = null;
    for (const [uid, e] of this.entries) {
      if (e.pane !== pane) continue;
      for (const [out, s] of e.series) {
        const v = valueAt(s);
        if (v === undefined || !Number.isFinite(v)) continue;
        const yv = s.priceToCoordinate(v);
        if (yv === null) continue;
        const color = String((s.options() as { color?: string }).color ?? '');
        if (s.seriesType() === 'Histogram') {
          const y0 = s.priceToCoordinate(0) ?? yv;
          if (y >= Math.min(y0, yv) - 2 && y <= Math.max(y0, yv) + 2 && (!best || best.d > 6)) best = { hit: { kind: 'histogram', src: uid, out, i, value: v, color }, d: 6 };
          continue;
        }
        const d = Math.abs(y - yv);
        if (d <= 6 && (!best || d < best.d)) best = { hit: { kind: 'line', src: uid, out, i, value: v, color }, d };
      }
    }
    return best?.hit ?? null;
  }
}

export function setScaleMode(chart: IChartApi, mode: ScaleMode) {
  chart.priceScale('right').applyOptions({ mode: scaleModeOf(mode) });
}

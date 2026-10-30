import type { VolumeProfile } from '@meridian/engine';
import type { AutoscaleInfo, Coordinate, IChartApi, IPrimitivePaneRenderer, ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView, Logical, PrimitiveHoveredItem, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';

type CanvasRenderingTarget2D = Parameters<IPrimitivePaneRenderer['draw']>[0];

type Ctx = CanvasRenderingContext2D;
export type Dash = 'solid' | 'dashed' | 'dotted';

export function setDash(ctx: Ctx, d: Dash | undefined, w = 1) {
  ctx.setLineDash(d === 'dashed' ? [6 * w, 4 * w] : d === 'dotted' ? [1.5 * w, 3 * w] : []);
}

/** A chart element under the pointer, resolved to a human explanation by `explain.ts`. */
export interface ChartHit {
  kind: 'marker' | 'count' | 'level' | 'segment' | 'pivot' | 'time' | 'cloud' | 'line' | 'histogram' | 'heat' | 'note';
  /** study instance uid ('journal' for notes); absent for anonymous geometry */
  src?: string;
  /** study output id (levels, lines, count columns, clouds) */
  out?: string;
  /** bar index the element belongs to */
  i: number;
  /** text as drawn on the chart */
  text?: string;
  /** engine-provided detail (marker tooltip, note body) */
  tip?: string;
  value?: number;
  /** side of the bar a marker sits on */
  pos?: 'above' | 'below' | 'at';
  color: string;
  provisional?: boolean;
}
type Scored = { hit: ChartHit; prio: number; dist: number };
const better = (a: Scored | null, b: Scored) => (!a || b.prio > a.prio || (b.prio === a.prio && b.dist < a.dist) ? b : a);
const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

/**
 * x coordinate of a possibly fractional logical index. Lightweight Charts 5.2 returns 0 for a non-integer logical, which
 * collapsed every half-bar-edged level (TDST, risk) and between-bar drawing anchor to the left edge; interpolate instead.
 */
export function logicalX(chart: Pick<IChartApi, 'timeScale'> | null, logical: number): number | null {
  const ts = chart?.timeScale();
  if (!ts || !Number.isFinite(logical)) return null;
  const i0 = Math.floor(logical);
  const x0 = ts.logicalToCoordinate(i0 as Logical);
  const f = logical - i0;
  if (x0 === null || f === 0) return x0;
  const x1 = ts.logicalToCoordinate((i0 + 1) as Logical);
  return x1 === null ? null : x0 + f * (x1 - x0);
}

/** Base series primitive drawing in media (CSS-pixel) coordinates on the series' pane. */
export abstract class BasePrimitive implements ISeriesPrimitive<Time> {
  protected chart: IChartApi | null = null;
  protected series: ISeriesApi<SeriesType> | null = null;
  private request: (() => void) | null = null;
  private readonly views = [
    {
      zOrder: () => this.zOrder,
      renderer: () => ({
        draw: (target: CanvasRenderingTarget2D) =>
          target.useMediaCoordinateSpace(({ context, mediaSize }) => {
            if (!this.chart || !this.series) return;
            context.save();
            this.size = { w: mediaSize.width, h: mediaSize.height };
            try {
              this.draw(context, mediaSize.width, mediaSize.height);
            } finally {
              context.restore();
            }
          }),
      }),
    },
  ];
  protected zOrder: 'bottom' | 'normal' | 'top' = 'normal';
  /** pane size at the last draw (hit tests run between draws) */
  protected size = { w: 0, h: 0 };
  /** report hits to the chart (pointer cursor); off while a drawing tool is active or explanations are disabled */
  explain = true;

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series;
    this.request = p.requestUpdate;
  }
  detached() {
    this.chart = null;
    this.series = null;
    this.request = null;
  }
  paneViews() {
    return this.views;
  }
  update() {
    this.request?.();
  }
  protected x(logical: number): number | null {
    return logicalX(this.chart, logical);
  }
  protected y(price: number): number | null {
    return this.series?.priceToCoordinate(price) ?? null;
  }
  protected visible(): { from: number; to: number } | null {
    const r = this.chart?.timeScale().getVisibleLogicalRange();
    return r ? { from: Math.floor(r.from) - 1, to: Math.ceil(r.to) + 1 } : null;
  }
  protected barSpacing(): number {
    return (this.chart?.timeScale().options().barSpacing as number | undefined) ?? 6;
  }
  protected abstract draw(ctx: Ctx, w: number, h: number): void;
  /** The explainable element at pane-local (x, y), if any. */
  explainAt(_x: number, _y: number): ChartHit | null {
    return null;
  }
  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (!this.explain || !this.explainAt(x, y)) return null;
    return { externalId: 'explain', zOrder: this.zOrder, cursorStyle: 'pointer' };
  }
}

// ── Text markers (DeMark counts, pattern labels, journal notes) ─────────────
export interface MarkerItem {
  i: number;
  text: string;
  pos: 'above' | 'below' | 'at';
  color: string;
  row: number;
  size: 1 | 2 | 3;
  style: 'solid' | 'hollow' | 'muted' | 'boxed';
  provisional?: boolean;
  price?: number;
  /** study uid, or 'journal' */
  src?: string;
  tip?: string;
}
export interface LabelColumn {
  src: string;
  out: string;
  values: Float64Array;
  row: number;
  posColor: string;
  negColor: string;
  mutedAbove?: number;
  provisionalFrom: number; // indices ≥ this are provisional
}

/** A label waiting for layout: `slot` is its compact stacking position on its bar side. */
interface Cand {
  i: number;
  pos: 'above' | 'below' | 'at';
  row: number;
  text: string;
  color: string;
  size: number;
  style: MarkerItem['style'];
  provisional: boolean;
  price?: number;
  slot?: number;
  hit: () => ChartHit;
}

export class TextMarkersPrimitive extends BasePrimitive {
  private markers: MarkerItem[] = [];
  private byIndex = new Map<number, MarkerItem[]>();
  private columns: LabelColumn[] = [];
  private highs: ArrayLike<number> = [];
  private lows: ArrayLike<number> = [];
  private boxes: { x1: number; y1: number; x2: number; y2: number; hit: ChartHit }[] = [];
  hollowProvisional = true;
  bg = '#0b0f14';
  protected override zOrder = 'top' as const;

  setData(markers: MarkerItem[], columns: LabelColumn[], highs: ArrayLike<number>, lows: ArrayLike<number>) {
    this.markers = markers;
    this.byIndex.clear();
    for (const m of markers) {
      const a = this.byIndex.get(m.i);
      if (a) a.push(m);
      else this.byIndex.set(m.i, [m]);
    }
    this.columns = columns;
    this.highs = highs;
    this.lows = lows;
    this.update();
  }

  protected draw(ctx: Ctx) {
    const vr = this.visible();
    if (!vr) return;
    const spacing = this.barSpacing();
    const dense = spacing < 5.5;
    const from = Math.max(0, vr.from);
    const to = Math.min(this.highs.length - 1, vr.to);
    ctx.textAlign = 'center';
    this.boxes = [];
    // Collect every label, then stack each bar side compactly in row order (empty rows leave no gap) and draw
    // the most important first; small labels that would overlap one already drawn are dropped.
    const cands: Cand[] = [];
    const add = (c: Cand) => cands.push(c);
    for (const col of this.columns) {
      if (dense) continue;
      for (let i = from; i <= to; i++) {
        const v = col.values[i];
        if (!Number.isFinite(v) || v === 0) continue;
        const pos = v > 0 ? 'above' : 'below';
        const a = Math.abs(v);
        const color = v > 0 ? col.posColor : col.negColor;
        const provisional = i >= col.provisionalFrom;
        add({ i, pos, row: col.row, text: String(a), color, size: 1, style: col.mutedAbove !== undefined && a > col.mutedAbove ? 'muted' : 'solid', provisional, hit: () => ({ kind: 'count', src: col.src, out: col.out, i, value: v, text: String(a), color, provisional }) });
      }
    }
    for (let i = from; i <= to; i++) {
      const ms = this.byIndex.get(i);
      if (!ms) continue;
      for (const m of ms)
        if (!dense || m.size >= 2)
          add({ i: m.i, pos: m.pos, row: m.row, text: m.text, color: m.color, size: m.size, style: m.style, provisional: !!m.provisional, price: m.price, hit: () => ({ kind: m.src === 'journal' ? 'note' : 'marker', src: m.src, i: m.i, text: m.text, tip: m.tip, pos: m.pos, color: m.color, provisional: m.provisional }) });
    }
    const slots = new Map<string, Cand[]>();
    for (const c of cands) {
      if (c.price !== undefined) continue;
      const k = `${c.i}|${c.pos}`;
      const a = slots.get(k);
      if (a) a.push(c);
      else slots.set(k, [c]);
    }
    for (const a of slots.values()) {
      a.sort((p, q) => p.row - q.row);
      a.forEach((c, k) => (c.slot = k));
    }
    const prio = (c: Cand) => c.size * 10 + (c.style === 'boxed' ? 5 : 0) - (c.style === 'muted' ? 3 : 0);
    const order = cands.map((c, k) => ({ c, k, p: prio(c) })).sort((a, b) => b.p - a.p || a.c.row - b.c.row || a.k - b.k);
    const occ = new Map<number, { x1: number; x2: number; y1: number; y2: number }[]>();
    const CELL = 24;
    const clashes = (b: { x1: number; x2: number; y1: number; y2: number }) => {
      for (let g = Math.floor(b.x1 / CELL); g <= Math.floor(b.x2 / CELL); g++)
        for (const o of occ.get(g) ?? []) if (b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1) return true;
      return false;
    };
    const claim = (b: { x1: number; x2: number; y1: number; y2: number }) => {
      for (let g = Math.floor(b.x1 / CELL); g <= Math.floor(b.x2 / CELL); g++) {
        const a = occ.get(g);
        if (a) a.push(b);
        else occ.set(g, [b]);
      }
    };
    for (const { c } of order) {
      const x = this.x(c.i);
      if (x === null) continue;
      const anchor = c.price ?? (c.pos === 'above' ? this.highs[c.i] : this.lows[c.i]);
      const ya = this.y(anchor);
      if (ya === null) continue;
      const fs = c.size === 3 ? 13 : c.size === 2 ? 12 : 10;
      const off = 6 + (c.slot ?? 0) * 12;
      const y = c.pos === 'above' ? ya - off : c.pos === 'below' ? ya + off + fs * 0.7 : ya + fs * 0.35;
      ctx.font = `${c.size >= 2 ? 700 : 500} ${fs}px ui-sans-serif, system-ui, sans-serif`;
      const tw = ctx.measureText(c.text).width;
      // tight ink box for overlap tests, so single-digit counts on neighbouring bars still fit side by side
      const ink = { x1: x - tw / 2, x2: x + tw / 2, y1: y - fs * 0.75, y2: y + 1 };
      if (c.size < 2 && clashes(ink)) continue;
      claim(ink);
      this.drawLabel(ctx, x, y, fs, c);
      const half = tw / 2 + 3;
      this.boxes.push({ x1: x - half, x2: x + half, y1: y - fs - 1, y2: y + 3, hit: c.hit() });
    }
  }

  private drawLabel(ctx: Ctx, x: number, y: number, fs: number, c: Cand) {
    const { text, color, style, provisional } = c;
    ctx.globalAlpha = style === 'muted' ? 0.55 : 1;
    const hollow = style === 'hollow' || (provisional && this.hollowProvisional);
    if (style === 'boxed') {
      const tw = ctx.measureText(text).width + 6;
      ctx.fillStyle = this.bg;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      setDash(ctx, provisional ? 'dashed' : 'solid');
      ctx.beginPath();
      ctx.roundRect(x - tw / 2, y - fs + 1, tw, fs + 3, 3);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    } else if (hollow) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.strokeText(text, x, y);
    } else {
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  override explainAt(x: number, y: number): ChartHit | null {
    let best: Scored | null = null;
    for (const b of this.boxes)
      if (x >= b.x1 - 2 && x <= b.x2 + 2 && y >= b.y1 - 2 && y <= b.y2 + 2) best = better(best, { hit: b.hit, prio: 0, dist: Math.hypot(x - (b.x1 + b.x2) / 2, y - (b.y1 + b.y2) / 2) });
    return best?.hit ?? null;
  }
}

// ── Levels, geometry, clouds, profiles ──────────────────────────────────────
export interface LevelRun {
  i1: number;
  i2: number;
  price: number;
  color: string;
  dash: Dash;
  width: number;
  label?: string;
  src?: string;
  out?: string;
}
export interface GeoSegment {
  i1: number;
  p1: number;
  i2: number;
  p2: number;
  color: string;
  dash?: Dash;
  width?: number;
  label?: string;
  src?: string;
}
export interface PivotPath {
  points: { i: number; price: number; label: string; locked: boolean; first?: { i: number; price: number } }[];
  color: string;
  src?: string;
}
export interface CloudData {
  src?: string;
  out?: string;
  a: Float64Array;
  b: Float64Array;
  offset: number;
  up: string;
  down: string;
}

export class LevelsPrimitive extends BasePrimitive {
  runs: LevelRun[] = [];
  segments: GeoSegment[] = [];
  paths: PivotPath[] = [];
  timeMarks: { i: number; label: string; color: string; src?: string }[] = [];
  profiles: (VolumeProfile & { color: string; upColor: string })[] = [];
  vrvp: (VolumeProfile & { color: string; upColor: string }) | null = null;
  clouds: CloudData[] = [];
  textColor = '#8b9aab';
  /** index of the newest bar: labelled runs reaching it (active TDST and risk levels) get a price-scale tag */
  last = -1;
  protected override zOrder = 'normal' as const;
  private axisViews: ISeriesPrimitiveAxisView[] = [];

  setData(p: Partial<Pick<LevelsPrimitive, 'runs' | 'segments' | 'paths' | 'timeMarks' | 'profiles' | 'clouds' | 'last'>>) {
    Object.assign(this, p);
    this.axisViews = this.runs
      .filter((r) => r.label && r.i2 === this.last)
      .map((r) => ({
        coordinate: () => this.y(r.price) ?? -1000,
        text: () => this.series?.priceFormatter().format(r.price) ?? r.price.toFixed(2),
        textColor: () => '#ffffff',
        backColor: () => r.color,
      }));
    this.update();
  }
  priceAxisViews() {
    return this.axisViews;
  }
  /** TDST levels spanning the visible bars stay on screen, as on reference DeMark charts */
  autoscaleInfo(from: Logical, to: Logical): AutoscaleInfo | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of this.runs) {
      if (!r.out?.startsWith('tdst') || r.i2 < from || r.i1 > to) continue;
      lo = Math.min(lo, r.price);
      hi = Math.max(hi, r.price);
    }
    return lo <= hi ? { priceRange: { minValue: lo, maxValue: hi } } : null;
  }
  setVrvp(v: LevelsPrimitive['vrvp']) {
    this.vrvp = v;
    this.update();
  }

  protected draw(ctx: Ctx, w: number, h: number) {
    const vr = this.visible();
    if (!vr) return;
    // clouds (Ichimoku kumo, band fills)
    for (const c of this.clouds) {
      for (let k = vr.from; k < vr.to; k++) {
        const j = k - c.offset;
        const a0 = c.a[j];
        const b0 = c.b[j];
        const a1 = c.a[j + 1];
        const b1 = c.b[j + 1];
        if (![a0, b0, a1, b1].every(Number.isFinite)) continue;
        const x0 = this.x(k);
        const x1 = this.x(k + 1);
        const ya0 = this.y(a0);
        const yb0 = this.y(b0);
        const ya1 = this.y(a1);
        const yb1 = this.y(b1);
        if (x0 === null || x1 === null || ya0 === null || yb0 === null || ya1 === null || yb1 === null) continue;
        ctx.fillStyle = a0 >= b0 ? c.up : c.down;
        ctx.beginPath();
        ctx.moveTo(x0, ya0);
        ctx.lineTo(x1, ya1);
        ctx.lineTo(x1, yb1);
        ctx.lineTo(x0, yb0);
        ctx.closePath();
        ctx.fill();
      }
    }
    // session volume profiles
    for (const p of this.profiles) this.drawProfile(ctx, p, false, w);
    if (this.vrvp) this.drawProfile(ctx, this.vrvp, true, w);
    // horizontal level runs: expired runs are faded and unlabelled (hover still explains them); only the live
    // levels, which also carry a price-scale tag, get a text label, and a label overlapping another is skipped
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    const taken: { x1: number; x2: number; y1: number; y2: number }[] = [];
    const label = (text: string, color: string, x: number, y: number, align: 'left' | 'right') => {
      const tw = ctx.measureText(text).width;
      const b = align === 'right' ? { x1: x - tw, x2: x, y1: y - 9, y2: y + 1 } : { x1: x, x2: x + tw, y1: y - 9, y2: y + 1 };
      if (taken.some((o) => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1)) return;
      taken.push(b);
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.fillText(text, x, y);
    };
    for (const r of this.runs) {
      if (r.i2 < vr.from || r.i1 > vr.to) continue;
      const x1 = this.x(r.i1 - 0.5);
      let x2 = this.x(r.i2 + 0.5);
      const y = this.y(r.price);
      if (x1 === null || x2 === null || y === null) continue;
      const live = r.i2 === this.last;
      // live levels run on to the price scale, like a price line, with their label in the empty right margin
      if (live) x2 = Math.max(x2, w);
      ctx.globalAlpha = live ? 1 : 0.45;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width;
      setDash(ctx, r.dash);
      ctx.beginPath();
      ctx.moveTo(x1, Math.round(y) + 0.5);
      ctx.lineTo(x2, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (live && r.label && x2 - x1 > 28) label(r.label, r.color, w - 4, y - 3, 'right');
    }
    ctx.setLineDash([]);
    // free segments (TD Lines, Fibonacci guides, regression channel, RP next bar)
    for (const s of this.segments) {
      const x1 = this.x(s.i1);
      const x2 = this.x(s.i2);
      const y1 = this.y(s.p1);
      const y2 = this.y(s.p2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1;
      setDash(ctx, s.dash);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (s.label) {
        if (x2 + 40 < w) label(s.label, s.color, x2 + 3, y2 - 3, 'left');
        else {
          // the line runs off the right edge: label it where it meets the price scale
          const ye = y1 + ((w - x1) / (x2 - x1 || 1)) * (y2 - y1);
          label(s.label, s.color, w - 4, ye - 4, 'right');
        }
      }
    }
    ctx.setLineDash([]);
    // pivot paths (D-Wave, ZigZag)
    for (const p of this.paths) {
      const pts = p.points;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      pts.forEach((pt, k) => {
        const x = this.x(pt.i);
        const y = this.y(pt.price);
        if (x === null || y === null) return;
        if (k > 0 && pt.label === '0') started = false;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      pts.forEach((pt, k) => {
        const x = this.x(pt.i);
        const y = this.y(pt.price);
        if (x === null || y === null) return;
        const prev = pts[k - 1]?.price ?? pt.price;
        const next = pts[k + 1]?.price ?? prev;
        const peak = pt.price >= prev && pt.price >= next;
        const ty = peak ? y - 8 : y + 16;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        if (pt.locked) {
          ctx.fillStyle = p.color;
          ctx.fill();
        } else {
          ctx.strokeStyle = p.color;
          ctx.stroke();
        }
        if (pt.label && pt.label !== '◦') {
          ctx.fillStyle = p.color;
          if (pt.locked) ctx.fillText(pt.label, x, ty);
          else {
            ctx.lineWidth = 1;
            ctx.strokeText(pt.label, x, ty);
          }
        }
        // "+" where the wave was first recognised before it shifted right
        if (pt.first) {
          const fx = this.x(pt.first.i);
          const fy = this.y(pt.first.price);
          if (fx !== null && fy !== null) {
            ctx.fillStyle = p.color;
            ctx.fillText('+', fx, peak ? fy - 8 : fy + 16);
          }
        }
      });
    }
    // time marks (Ichimoku time theory) — may lie in the future
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    // labels of nearby marks stack upward instead of overprinting (rowEnd = right edge of the last label in each row)
    const rowEnd: number[] = [];
    const placed = this.timeMarks
      .map((m) => ({ m, x: this.x(m.i) }))
      .filter((p): p is { m: LevelsPrimitive['timeMarks'][number]; x: number } => p.x !== null && p.x >= 0 && p.x <= w)
      .sort((a, b) => a.x - b.x);
    for (const { m, x } of placed) {
      const half = ctx.measureText(m.label).width / 2 + 3;
      // keep the label inside the plot: a mark near the right edge would otherwise run under the price scale
      const lx = Math.max(half, Math.min(w - half, x));
      let row = rowEnd.findIndex((end) => lx - half >= end);
      if (row < 0) row = rowEnd.push(-Infinity) - 1;
      rowEnd[row] = lx + half;
      ctx.strokeStyle = m.color;
      setDash(ctx, 'dotted');
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.textAlign = 'center';
      ctx.fillText(m.label, lx, h - 16 - row * 12);
    }
  }

  override explainAt(x: number, y: number): ChartHit | null {
    const vr = this.visible();
    if (!vr) return null;
    let best: Scored | null = null;
    const near = 5;
    for (const p of this.paths)
      for (const pt of p.points) {
        const px = this.x(pt.i);
        const py = this.y(pt.price);
        if (px === null || py === null) continue;
        const d = Math.hypot(x - px, y - py);
        // the wave label sits beside the pivot, so accept a generous radius
        if (d <= 14) best = better(best, { hit: { kind: 'pivot', src: p.src, i: pt.i, text: pt.label, value: pt.price, color: p.color, provisional: !pt.locked }, prio: 3, dist: d });
      }
    for (const r of this.runs) {
      if (r.i2 < vr.from || r.i1 > vr.to) continue;
      const x1 = this.x(r.i1 - 0.5);
      const x2 = this.x(r.i2 + 0.5);
      const ry = this.y(r.price);
      if (x1 === null || x2 === null || ry === null || x < x1 || (x > x2 && r.i2 !== this.last)) continue;
      const d = Math.abs(y - ry);
      if (d <= near) best = better(best, { hit: { kind: 'level', src: r.src, out: r.out, i: r.i1, text: r.label, value: r.price, color: r.color }, prio: 2, dist: d });
    }
    for (const s of this.segments) {
      const x1 = this.x(s.i1);
      const x2 = this.x(s.i2);
      const y1 = this.y(s.p1);
      const y2 = this.y(s.p2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      const d = segDist(x, y, x1, y1, x2, y2);
      if (d <= near) {
        const l = this.chart?.timeScale().coordinateToLogical(x as Coordinate);
        const t = x2 === x1 ? 0 : (x - x1) / (x2 - x1);
        best = better(best, { hit: { kind: 'segment', src: s.src, i: l === null || l === undefined ? s.i2 : Math.round(l), text: s.label, value: s.p1 + t * (s.p2 - s.p1), color: s.color }, prio: 2, dist: d });
      }
    }
    for (const m of this.timeMarks) {
      const mx = this.x(m.i);
      if (mx === null) continue;
      const d = Math.abs(x - mx);
      if (d <= 4) best = better(best, { hit: { kind: 'time', src: m.src, i: m.i, text: m.label, color: m.color }, prio: 1, dist: d });
    }
    if (!best && this.clouds.length) {
      const l = this.chart?.timeScale().coordinateToLogical(x as Coordinate);
      const k = l === null || l === undefined ? NaN : Math.round(l);
      for (const c of this.clouds) {
        const j = k - c.offset;
        const ya = this.y(c.a[j]);
        const yb = this.y(c.b[j]);
        if (ya === null || yb === null || !Number.isFinite(c.a[j]) || !Number.isFinite(c.b[j])) continue;
        if (y >= Math.min(ya, yb) && y <= Math.max(ya, yb)) return { kind: 'cloud', src: c.src, out: c.out, i: k, color: c.a[j] >= c.b[j] ? c.up : c.down, value: c.a[j] - c.b[j] };
      }
    }
    return best?.hit ?? null;
  }

  private drawProfile(ctx: Ctx, p: VolumeProfile & { color: string; upColor: string }, right: boolean, w: number) {
    let x1: number;
    let width: number;
    if (right) {
      width = w * 0.22;
      x1 = w - width;
    } else {
      const a = this.x(p.i1 - 0.5);
      const b = this.x(p.i2 + 0.5);
      if (a === null || b === null || b < 0 || a > w) return;
      x1 = a;
      width = (b - a) * 0.9;
    }
    const max = Math.max(...p.rows.map((r) => r.vol), 1e-12);
    for (const r of p.rows) {
      const y1 = this.y(r.p2);
      const y2 = this.y(r.p1);
      if (y1 === null || y2 === null) continue;
      const hgt = Math.max(1, y2 - y1 - 1);
      const len = (width * r.vol) / max;
      const inVa = r.p2 > p.val && r.p1 < p.vah;
      ctx.globalAlpha = inVa ? 0.42 : 0.2;
      ctx.fillStyle = p.color;
      if (right) ctx.fillRect(w - len, y1, len, hgt);
      else ctx.fillRect(x1, y1, len, hgt);
      ctx.fillStyle = p.upColor;
      const lu = (width * r.up) / max;
      if (right) ctx.fillRect(w - len, y1, lu, hgt);
      else ctx.fillRect(x1, y1, lu, hgt);
    }
    ctx.globalAlpha = 1;
    const yp = this.y(p.poc);
    if (yp !== null) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(right ? w - width : x1, yp);
      ctx.lineTo(right ? w : x1 + width, yp);
      ctx.stroke();
    }
  }
}

// ── Signal heat strip (SPEC §8) ─────────────────────────────────────────────
/** Drawn strip height and the taller band at the bottom of the pane that accepts clicks/hovers (px). */
const HEAT_H = 8;
const HEAT_HIT = 16;
const HEAT_MIN_W = 3;

export class HeatStripPrimitive extends BasePrimitive {
  private cells = new Map<number, { bull: number; bear: number; neutral: number }>();
  colors = { bull: '#22c55e', bear: '#f43f5e', neutral: '#94a3b8' };
  enabled = true;
  protected override zOrder = 'top' as const;
  setData(cells: Map<number, { bull: number; bear: number; neutral: number }>) {
    this.cells = cells;
    this.update();
  }
  override explainAt(x: number, y: number): ChartHit | null {
    if (!this.enabled || y < this.size.h - HEAT_HIT) return null;
    const l = this.chart?.timeScale().coordinateToLogical(x as Coordinate);
    if (l === null || l === undefined) return null;
    // cells are drawn at least HEAT_MIN_W wide, so on tightly packed bars also accept the nearest neighbour
    const reach = Math.round(HEAT_MIN_W / 2 / Math.max(1, this.barSpacing()));
    const r = Math.round(l);
    for (let d = 0; d <= reach; d++)
      for (const i of d ? [r - d, r + d] : [r]) {
        const c = this.cells.get(i);
        if (c) return { kind: 'heat', i, color: c.bull >= c.bear ? this.colors.bull : this.colors.bear };
      }
    return null;
  }
  protected draw(ctx: Ctx, _w: number, h: number) {
    if (!this.enabled) return;
    const vr = this.visible();
    if (!vr) return;
    const sp = Math.max(HEAT_MIN_W, this.barSpacing() * 0.8);
    for (let i = vr.from; i <= vr.to; i++) {
      const c = this.cells.get(i);
      if (!c) continue;
      const x = this.x(i);
      if (x === null) continue;
      const tot = c.bull + c.bear + c.neutral;
      let y = h - 2;
      for (const k of ['bull', 'bear', 'neutral'] as const) {
        if (!c[k]) continue;
        const hh = Math.max(3, (HEAT_H * c[k]) / tot);
        ctx.fillStyle = this.colors[k];
        ctx.fillRect(x - sp / 2, y - hh, sp, hh);
        y -= hh;
      }
    }
  }
}

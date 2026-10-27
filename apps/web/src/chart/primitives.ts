import type { VolumeProfile } from '@meridian/engine';
import type { IChartApi, IPrimitivePaneRenderer, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';

type CanvasRenderingTarget2D = Parameters<IPrimitivePaneRenderer['draw']>[0];

type Ctx = CanvasRenderingContext2D;
export type Dash = 'solid' | 'dashed' | 'dotted';

export function setDash(ctx: Ctx, d: Dash | undefined, w = 1) {
  ctx.setLineDash(d === 'dashed' ? [6 * w, 4 * w] : d === 'dotted' ? [1.5 * w, 3 * w] : []);
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
    return this.chart?.timeScale().logicalToCoordinate(logical as Logical) ?? null;
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
}
export interface LabelColumn {
  values: Float64Array;
  row: number;
  posColor: string;
  negColor: string;
  mutedAbove?: number;
  provisionalFrom: number; // indices ≥ this are provisional
}

export class TextMarkersPrimitive extends BasePrimitive {
  private markers: MarkerItem[] = [];
  private byIndex = new Map<number, MarkerItem[]>();
  private columns: LabelColumn[] = [];
  private highs: ArrayLike<number> = [];
  private lows: ArrayLike<number> = [];
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
    const used = new Map<string, number>();
    const place = (i: number, pos: string, row: number, text: string, color: string, size: number, style: string, provisional: boolean, price?: number) => {
      const x = this.x(i);
      if (x === null) return;
      const anchor = price ?? (pos === 'above' ? this.highs[i] : this.lows[i]);
      const ya = this.y(anchor);
      if (ya === null) return;
      const k = `${i}|${pos}|${row}`;
      const dup = used.get(k) ?? 0;
      used.set(k, dup + 1);
      const fs = size === 3 ? 13 : size === 2 ? 12 : 10;
      const step = 12;
      const off = 8 + (row + dup) * step;
      const y = pos === 'above' ? ya - off : pos === 'below' ? ya + off + fs * 0.7 : ya + fs * 0.35;
      ctx.font = `${size >= 2 ? 700 : 500} ${fs}px ui-sans-serif, system-ui, sans-serif`;
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
    };
    // dense columnar labels (setup / countdown numbers)
    for (const col of this.columns) {
      if (dense) continue;
      for (let i = from; i <= to; i++) {
        const v = col.values[i];
        if (!Number.isFinite(v) || v === 0) continue;
        const pos = v > 0 ? 'above' : 'below';
        const a = Math.abs(v);
        place(i, pos, col.row, String(a), v > 0 ? col.posColor : col.negColor, 1, col.mutedAbove !== undefined && a > col.mutedAbove ? 'muted' : 'solid', i >= col.provisionalFrom);
      }
    }
    for (let i = from; i <= to; i++) {
      const ms = this.byIndex.get(i);
      if (!ms) continue;
      for (const m of ms) if (!dense || m.size >= 2) place(m.i, m.pos, m.row, m.text, m.color, m.size, m.style, !!m.provisional, m.price);
    }
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
}
export interface PivotPath {
  points: { i: number; price: number; label: string; locked: boolean }[];
  color: string;
}
export interface CloudData {
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
  timeMarks: { i: number; label: string; color: string }[] = [];
  profiles: (VolumeProfile & { color: string; upColor: string })[] = [];
  vrvp: (VolumeProfile & { color: string; upColor: string }) | null = null;
  clouds: CloudData[] = [];
  textColor = '#8b9aab';
  protected override zOrder = 'normal' as const;

  setData(p: Partial<Pick<LevelsPrimitive, 'runs' | 'segments' | 'paths' | 'timeMarks' | 'profiles' | 'clouds'>>) {
    Object.assign(this, p);
    this.update();
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
    // horizontal level runs
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    for (const r of this.runs) {
      if (r.i2 < vr.from || r.i1 > vr.to) continue;
      const x1 = this.x(r.i1 - 0.5);
      const x2 = this.x(r.i2 + 0.5);
      const y = this.y(r.price);
      if (x1 === null || x2 === null || y === null) continue;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width;
      setDash(ctx, r.dash);
      ctx.beginPath();
      ctx.moveTo(x1, Math.round(y) + 0.5);
      ctx.lineTo(x2, Math.round(y) + 0.5);
      ctx.stroke();
      if (r.label && x2 - x1 > 28) {
        ctx.setLineDash([]);
        ctx.fillStyle = r.color;
        ctx.textAlign = 'right';
        ctx.fillText(r.label, x2 - 2, y - 3);
      }
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
        ctx.setLineDash([]);
        ctx.fillStyle = s.color;
        ctx.textAlign = 'left';
        ctx.fillText(s.label, Math.min(x2, w - 60) + 3, y2 - 3);
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
      });
    }
    // time marks (Ichimoku time theory) — may lie in the future
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    for (const m of this.timeMarks) {
      const x = this.x(m.i);
      if (x === null || x < 0 || x > w) continue;
      ctx.strokeStyle = m.color;
      setDash(ctx, 'dotted');
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.textAlign = 'center';
      ctx.fillText(m.label, x, h - 16);
    }
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
export class HeatStripPrimitive extends BasePrimitive {
  private cells = new Map<number, { bull: number; bear: number; neutral: number }>();
  colors = { bull: '#22c55e', bear: '#f43f5e', neutral: '#94a3b8' };
  enabled = true;
  protected override zOrder = 'top' as const;
  setData(cells: Map<number, { bull: number; bear: number; neutral: number }>) {
    this.cells = cells;
    this.update();
  }
  protected draw(ctx: Ctx, _w: number, h: number) {
    if (!this.enabled) return;
    const vr = this.visible();
    if (!vr) return;
    const sp = Math.max(1, this.barSpacing() * 0.8);
    for (let i = vr.from; i <= vr.to; i++) {
      const c = this.cells.get(i);
      if (!c) continue;
      const x = this.x(i);
      if (x === null) continue;
      const tot = c.bull + c.bear + c.neutral;
      let y = h - 2;
      for (const k of ['bull', 'bear', 'neutral'] as const) {
        if (!c[k]) continue;
        const hh = Math.max(1.5, (4 * c[k]) / tot);
        ctx.fillStyle = this.colors[k];
        ctx.fillRect(x - sp / 2, y - hh, sp, hh);
        y -= hh;
      }
    }
  }
}

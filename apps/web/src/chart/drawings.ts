import type { Bar } from '@meridian/engine';
import { withAlpha } from '@meridian/ui';
import type { IChartApi, ISeriesApi, Logical, SeriesType } from 'lightweight-charts';
import type { Drawing, DrawingPoint, DrawingType } from '../state/types';
import { BasePrimitive, setDash } from './primitives';
import type { TimeMap } from './timeMap';

type Ctx = CanvasRenderingContext2D;

export const POINTS_NEEDED: Record<DrawingType, number> = {
  trendline: 2,
  ray: 2,
  extended: 2,
  hline: 1,
  hray: 1,
  vline: 1,
  channel: 3,
  fib: 2,
  fibext: 3,
  fibtime: 2,
  rect: 2,
  ellipse: 2,
  path: 99,
  text: 1,
  pricelabel: 1,
  long: 1,
  short: 1,
  measure: 2,
};

export const TOOL_LABELS: Record<DrawingType, string> = {
  trendline: 'Trend line',
  ray: 'Ray',
  extended: 'Extended line',
  hline: 'Horizontal line',
  hray: 'Horizontal ray',
  vline: 'Vertical line',
  channel: 'Parallel channel',
  fib: 'Fib retracement',
  fibext: 'Fib extension',
  fibtime: 'Fib time zones',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  path: 'Path',
  text: 'Text / note',
  pricelabel: 'Price label',
  long: 'Long position',
  short: 'Short position',
  measure: 'Measure',
};

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];
const FIB_EXT = [0, 0.618, 1, 1.272, 1.618, 2, 2.618];
const FIB_TIME = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

export interface Hit {
  id: string;
  handle: number; // −1 = body
}

export class DrawingsPrimitive extends BasePrimitive {
  drawings: Drawing[] = [];
  draft: Drawing | null = null;
  selected: string | null = null;
  hover: string | null = null;
  tm: TimeMap | null = null;
  fmt: (p: number) => string = (p) => p.toFixed(2);
  bg = '#0b0f14';
  text = '#d6dee7';
  protected override zOrder = 'top' as const;
  private lastW = 0;
  private lastH = 0;

  setDrawings(d: Drawing[]) {
    this.drawings = d.slice().sort((a, b) => a.z - b.z);
    this.update();
  }

  px(pt: DrawingPoint): [number, number] | null {
    if (!this.tm) return null;
    const x = this.x(this.tm.toLogical(pt.t));
    const y = this.y(pt.p);
    return x === null || y === null ? null : [x, y];
  }

  protected draw(ctx: Ctx, w: number, h: number) {
    this.lastW = w;
    this.lastH = h;
    for (const d of this.drawings) if (!d.hidden) this.drawOne(ctx, d, w, h);
    if (this.draft) this.drawOne(ctx, this.draft, w, h);
  }

  private drawOne(ctx: Ctx, d: Drawing, w: number, h: number) {
    const pts = d.points.map((p) => this.px(p)).filter((p): p is [number, number] => p !== null);
    if (!pts.length) return;
    const sel = d.id === this.selected || d.id === this.hover;
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.lineWidth = d.width + (d.id === this.hover && d.id !== this.selected ? 0.5 : 0);
    setDash(ctx, d.dash);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    const line = (a: [number, number], b: [number, number]) => {
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    };
    const extend = (a: [number, number], b: [number, number], back: boolean): [[number, number], [number, number]] => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      if (Math.abs(dx) < 1e-6) return [[a[0], back ? 0 : a[1]], [b[0], dy > 0 ? h : 0]];
      const m = dy / dx;
      const right: [number, number] = dx >= 0 ? [w, a[1] + m * (w - a[0])] : [0, a[1] - m * a[0]];
      const left: [number, number] = dx >= 0 ? [0, a[1] - m * a[0]] : [w, a[1] + m * (w - a[0])];
      return [back ? left : a, right];
    };
    const label = (txt: string, x: number, y: number, align: CanvasTextAlign = 'left', color = d.color) => {
      ctx.setLineDash([]);
      ctx.textAlign = align;
      const tw = ctx.measureText(txt).width;
      const bx = align === 'right' ? x - tw - 4 : align === 'center' ? x - tw / 2 - 2 : x;
      ctx.fillStyle = withAlpha(this.bg.startsWith('#') ? this.bg : '#0b0f14', 0.85);
      ctx.fillRect(bx - 2, y - 11, tw + 8, 15);
      ctx.fillStyle = color;
      ctx.fillText(txt, align === 'right' ? x - 2 : align === 'center' ? x + 2 : x + 2, y);
      setDash(ctx, d.dash);
    };
    const [a, b, c] = pts;
    switch (d.type) {
      case 'trendline':
        if (b) line(a, b);
        break;
      case 'ray':
        if (b) {
          const [p, q] = extend(a, b, false);
          line(p, q);
        }
        break;
      case 'extended':
        if (b) {
          const [p, q] = extend(a, b, true);
          line(p, q);
        }
        break;
      case 'hline':
        line([0, a[1]], [w, a[1]]);
        label(this.fmt(d.points[0].p), w - 4, a[1] - 3, 'right');
        break;
      case 'hray':
        line(a, [w, a[1]]);
        label(this.fmt(d.points[0].p), w - 4, a[1] - 3, 'right');
        break;
      case 'vline':
        line([a[0], 0], [a[0], h]);
        break;
      case 'channel':
        if (b) {
          line(a, b);
          if (c) {
            const m = (b[1] - a[1]) / (b[0] - a[0] || 1e-9);
            const off = c[1] - (a[1] + m * (c[0] - a[0]));
            const a2: [number, number] = [a[0], a[1] + off];
            const b2: [number, number] = [b[0], b[1] + off];
            line(a2, b2);
            ctx.fillStyle = withAlpha(d.color, 0.08);
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.lineTo(b2[0], b2[1]);
            ctx.lineTo(a2[0], a2[1]);
            ctx.closePath();
            ctx.fill();
            setDash(ctx, 'dashed');
            line([a[0], (a[1] + a2[1]) / 2], [b[0], (b[1] + b2[1]) / 2]);
          }
        }
        break;
      case 'fib':
        if (b) {
          const p0 = d.points[0].p;
          const p1 = d.points[1].p;
          const x1 = Math.min(a[0], b[0]);
          for (const r of FIB) {
            const price = p1 + (p0 - p1) * r;
            const y = this.y(price);
            if (y === null) continue;
            ctx.globalAlpha = r === 0 || r === 1 ? 1 : 0.75;
            line([x1, y], [w, y]);
            ctx.globalAlpha = 1;
            label(`${r} (${this.fmt(price)})`, x1 + 2, y - 2);
          }
          setDash(ctx, 'dotted');
          line(a, b);
        }
        break;
      case 'fibext':
        if (b && c) {
          const A = d.points[0].p;
          const B = d.points[1].p;
          const C = d.points[2].p;
          line(a, b);
          line(b, c);
          for (const r of FIB_EXT) {
            const price = C + (B - A) * r;
            const y = this.y(price);
            if (y === null) continue;
            line([c[0], y], [w, y]);
            label(`${r} (${this.fmt(price)})`, c[0] + 2, y - 2);
          }
        } else if (b) line(a, b);
        break;
      case 'fibtime':
        if (b) {
          const la = this.tm!.toLogical(d.points[0].t);
          const lb = this.tm!.toLogical(d.points[1].t);
          for (const k of FIB_TIME) {
            const x = this.x(la + k * (lb - la));
            if (x === null || x < 0 || x > w) continue;
            line([x, 0], [x, h]);
            label(String(k), x + 2, 12);
          }
        }
        break;
      case 'rect':
        if (b) {
          ctx.fillStyle = d.fill ?? withAlpha(d.color, 0.12);
          ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
          ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        }
        break;
      case 'ellipse':
        if (b) {
          ctx.beginPath();
          ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
          ctx.fillStyle = d.fill ?? withAlpha(d.color, 0.1);
          ctx.fill();
          ctx.stroke();
        }
        break;
      case 'path':
        ctx.beginPath();
        pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
        break;
      case 'text':
        ctx.setLineDash([]);
        ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = d.color;
        (d.text || 'Text').split('\n').forEach((ln, k) => ctx.fillText(ln, a[0], a[1] + k * 16));
        break;
      case 'pricelabel':
        label(this.fmt(d.points[0].p), a[0] + 6, a[1] + 4);
        ctx.beginPath();
        ctx.arc(a[0], a[1], 3, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'long':
      case 'short': {
        const entry = d.points[0];
        const tgt = d.points[1];
        const stp = d.points[2];
        if (!tgt || !stp || !b || !c) break;
        const xEnd = b[0];
        const x0 = a[0];
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(34,197,94,0.18)';
        ctx.fillRect(x0, Math.min(a[1], b[1]), xEnd - x0, Math.abs(b[1] - a[1]));
        ctx.fillStyle = 'rgba(244,63,94,0.18)';
        ctx.fillRect(x0, Math.min(a[1], c[1]), xEnd - x0, Math.abs(c[1] - a[1]));
        ctx.strokeStyle = d.color;
        line([x0, a[1]], [xEnd, a[1]]);
        const risk = Math.abs(entry.p - stp.p);
        const reward = Math.abs(tgt.p - entry.p);
        const rr = risk > 0 ? reward / risk : 0;
        const pct = (v: number) => `${((100 * (v - entry.p)) / entry.p).toFixed(2)}%`;
        label(`Target ${this.fmt(tgt.p)} (${pct(tgt.p)})`, x0 + 4, b[1] + (d.type === 'long' ? -4 : 14), 'left', '#22c55e');
        label(`Stop ${this.fmt(stp.p)} (${pct(stp.p)})`, x0 + 4, c[1] + (d.type === 'long' ? 14 : -4), 'left', '#f43f5e');
        label(`${d.type === 'long' ? 'Long' : 'Short'} ${this.fmt(entry.p)} · R:R ${rr.toFixed(2)}`, x0 + 4, a[1] - 4, 'left', this.text);
        break;
      }
      case 'measure':
        if (b) {
          const dp = d.points[1].p - d.points[0].p;
          const up = dp >= 0;
          ctx.fillStyle = up ? 'rgba(56,189,248,0.16)' : 'rgba(244,63,94,0.16)';
          ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
          const bars = this.tm ? Math.round(this.tm.toLogical(d.points[1].t) - this.tm.toLogical(d.points[0].t)) : 0;
          const days = (d.points[1].t - d.points[0].t) / 86_400_000;
          label(`${up ? '+' : ''}${this.fmt(dp)} (${((100 * dp) / d.points[0].p).toFixed(2)}%) · ${bars} bars · ${Math.abs(days) >= 1 ? `${days.toFixed(1)}d` : `${(days * 24).toFixed(1)}h`}`, (a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 6, 'center', this.text);
        }
        break;
    }
    ctx.setLineDash([]);
    if (sel && !d.locked) {
      for (const p of pts) {
        ctx.fillStyle = this.bg;
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p[0], p[1], 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /** Hit-test in pane coordinates (topmost first). */
  hitAt(x: number, y: number): Hit | null {
    const tol = 6;
    const dSeg = (p: [number, number], a: [number, number], b: [number, number]) => {
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const len = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len));
      return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
    };
    const w = this.lastW || 2000;
    const h = this.lastH || 1000;
    const list = this.drawings.filter((d) => !d.hidden).sort((a, b) => b.z - a.z);
    for (const d of list) {
      const pts = d.points.map((p) => this.px(p));
      if (pts.some((p) => p === null)) continue;
      const P = pts as [number, number][];
      for (let k = 0; k < P.length; k++) if (Math.hypot(P[k][0] - x, P[k][1] - y) <= tol + 2) return { id: d.id, handle: k };
      const q: [number, number] = [x, y];
      let hit = false;
      switch (d.type) {
        case 'hline':
          hit = Math.abs(y - P[0][1]) <= tol;
          break;
        case 'hray':
          hit = x >= P[0][0] - tol && Math.abs(y - P[0][1]) <= tol;
          break;
        case 'vline':
        case 'fibtime':
          hit = Math.abs(x - P[0][0]) <= tol;
          break;
        case 'rect':
        case 'measure':
        case 'ellipse':
        case 'fib':
          if (P[1]) hit = x >= Math.min(P[0][0], P[1][0]) - tol && x <= Math.max(P[0][0], P[1][0], d.type === 'fib' ? w : 0) + tol && y >= Math.min(P[0][1], P[1][1]) - tol && y <= Math.max(P[0][1], P[1][1]) + tol;
          break;
        case 'long':
        case 'short':
          if (P[1] && P[2]) hit = x >= P[0][0] && x <= P[1][0] && y >= Math.min(P[1][1], P[2][1]) && y <= Math.max(P[1][1], P[2][1]);
          break;
        case 'text':
        case 'pricelabel':
          hit = x >= P[0][0] - 4 && x <= P[0][0] + 120 && y >= P[0][1] - 16 && y <= P[0][1] + 8;
          break;
        case 'ray':
        case 'extended': {
          const dx = P[1][0] - P[0][0];
          const m = (P[1][1] - P[0][1]) / (dx || 1e-9);
          const yl = P[0][1] + m * (x - P[0][0]);
          hit = Math.abs(yl - y) <= tol && (d.type === 'extended' || (dx >= 0 ? x >= P[0][0] - tol : x <= P[0][0] + tol));
          break;
        }
        default:
          for (let k = 0; k + 1 < P.length && !hit; k++) hit = dSeg(q, P[k], P[k + 1]) <= tol;
          if (d.type === 'channel' && P[2] && !hit) {
            const m = (P[1][1] - P[0][1]) / (P[1][0] - P[0][0] || 1e-9);
            const off = P[2][1] - (P[0][1] + m * (P[2][0] - P[0][0]));
            hit = dSeg(q, [P[0][0], P[0][1] + off], [P[1][0], P[1][1] + off]) <= tol;
          }
      }
      if (hit) return { id: d.id, handle: -1 };
    }
    void h;
    return null;
  }
}

/** Default extra points for one-click tools (position tools get a target and stop). */
export function seedPoints(type: DrawingType, p: DrawingPoint, tm: TimeMap): DrawingPoint[] {
  if (type === 'long' || type === 'short') {
    const end = tm.fromLogical(tm.toLogical(p.t) + 24);
    const s = type === 'long' ? 1 : -1;
    return [p, { t: end, p: p.p * (1 + s * 0.03) }, { t: end, p: p.p * (1 - s * 0.015) }];
  }
  return [p];
}

export interface ControllerDeps {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  prim: DrawingsPrimitive;
  container: HTMLElement;
  getTimeMap(): TimeMap | null;
  getBars(): Bar[];
  getTool(): DrawingType | null;
  getMagnet(): 'off' | 'weak' | 'strong';
  getDrawings(): Drawing[];
  defaultColor(): string;
  onCreate(d: Omit<Drawing, 'id' | 'z' | 'locked' | 'hidden'>): void;
  onUpdate(id: string, patch: Partial<Drawing>, record: boolean): void;
  onSelect(id: string | null): void;
  onToolDone(): void;
  onEditText(d: Drawing): void;
}

/** Pointer interaction: placing new drawings, selecting, dragging handles/bodies. */
export class DrawingController {
  private drag: { id: string; handle: number; start: DrawingPoint; orig: DrawingPoint[] } | null = null;
  private consuming = false;
  private cleanup: (() => void)[] = [];

  constructor(private d: ControllerDeps) {
    const el = d.container;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener, { capture: true });
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, { capture: true }));
    };
    on('pointerdown', (e) => this.down(e));
    on('pointermove', (e) => this.move(e));
    on('pointerup', (e) => this.up(e));
    on('dblclick', (e) => this.dbl(e));
    for (const t of ['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove'] as const)
      on(t, (e) => {
        if (this.consuming) {
          e.stopPropagation();
          if (t !== 'mousemove') e.preventDefault();
        }
      });
  }

  dispose() {
    this.cleanup.forEach((f) => f());
  }

  private local(e: PointerEvent | MouseEvent): { x: number; y: number; inPane: boolean } {
    const pane = this.d.chart.panes()[0]?.getHTMLElement();
    const r = (pane ?? this.d.container).getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const w = this.d.chart.timeScale().width();
    return { x, y, inPane: x >= 0 && y >= 0 && y <= r.height && x <= w };
  }

  private toPoint(x: number, y: number): DrawingPoint | null {
    const tm = this.d.getTimeMap();
    if (!tm) return null;
    const l = this.d.chart.timeScale().coordinateToLogical(x);
    const p0 = this.d.series.coordinateToPrice(y);
    if (l === null || p0 === null) return null;
    let p: number = p0;
    let logical = l as number;
    const mag = this.d.getMagnet();
    const bars = this.d.getBars();
    const i = Math.round(logical);
    if (mag !== 'off' && i >= 0 && i < bars.length) {
      const b = bars[i];
      let best: number = p;
      let bestD = Infinity;
      for (const v of [b.o, b.h, b.l, b.c]) {
        const yy = this.d.series.priceToCoordinate(v);
        if (yy === null) continue;
        const dd = Math.abs(yy - y);
        if (dd < bestD) {
          bestD = dd;
          best = v;
        }
      }
      if (mag === 'strong' || bestD < 14) {
        p = best;
        logical = i;
      }
    }
    return { t: tm.fromLogical(logical), p };
  }

  private lockChart(lock: boolean) {
    this.consuming = lock;
    this.d.chart.applyOptions({ handleScroll: !lock, handleScale: !lock });
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    const { x, y, inPane } = this.local(e);
    if (!inPane) return;
    const tool = this.d.getTool();
    const pt = this.toPoint(x, y);
    const tm = this.d.getTimeMap();
    if (tool && pt && tm) {
      e.stopPropagation();
      e.preventDefault();
      this.lockChart(true);
      const prim = this.d.prim;
      const need = POINTS_NEEDED[tool];
      if (!prim.draft) {
        const pts = need === 1 ? seedPoints(tool, pt, tm) : [pt, pt];
        prim.draft = { id: 'draft', type: tool, points: pts, color: this.d.defaultColor(), width: tool === 'text' ? 1 : 1.5, dash: 'solid', locked: false, hidden: false, z: 9999 };
        if (need === 1) this.finishDraft(tool);
      } else {
        prim.draft.points = [...prim.draft.points.slice(0, -1), pt, pt];
        if (prim.draft.points.length > need) this.finishDraft(tool);
      }
      prim.update();
      return;
    }
    const hit = this.d.prim.hitAt(x, y);
    if (hit) {
      const dr = this.d.getDrawings().find((q) => q.id === hit.id);
      this.d.onSelect(hit.id);
      if (dr && !dr.locked && pt) {
        e.stopPropagation();
        e.preventDefault();
        this.lockChart(true);
        this.drag = { id: hit.id, handle: hit.handle, start: pt, orig: dr.points.map((q) => ({ ...q })) };
      }
    } else if (this.d.prim.selected) this.d.onSelect(null);
  }

  private finishDraft(tool: DrawingType) {
    const prim = this.d.prim;
    if (!prim.draft) return;
    const need = POINTS_NEEDED[tool];
    const pts = need === 99 ? prim.draft.points.slice(0, -1) : prim.draft.points.slice(0, Math.max(need, tool === 'long' || tool === 'short' ? 3 : need));
    const { id: _id, z: _z, locked: _l, hidden: _h, ...rest } = prim.draft;
    prim.draft = null;
    this.lockChart(false);
    if (pts.length >= Math.min(need, 2) || need === 1) {
      const created = { ...rest, points: pts };
      this.d.onCreate(created);
      if (tool === 'text') queueMicrotask(() => this.d.onEditText({ ...created, id: '', z: 0, locked: false, hidden: false }));
    }
    this.d.onToolDone();
  }

  private move(e: PointerEvent) {
    const { x, y } = this.local(e);
    const prim = this.d.prim;
    if (prim.draft) {
      const pt = this.toPoint(x, y);
      if (pt) {
        prim.draft.points = [...prim.draft.points.slice(0, -1), pt];
        prim.update();
      }
      return;
    }
    if (this.drag) {
      e.stopPropagation();
      const pt = this.toPoint(x, y);
      if (!pt) return;
      const tm = this.d.getTimeMap()!;
      const { handle, orig, start } = this.drag;
      let next: DrawingPoint[];
      if (handle >= 0) {
        next = orig.map((q, k) => (k === handle ? pt : q));
        const dr = this.d.getDrawings().find((q) => q.id === this.drag!.id);
        if (dr && (dr.type === 'long' || dr.type === 'short') && handle > 0) next = orig.map((q, k) => (k === handle ? { t: k === 1 || k === 2 ? pt.t : q.t, p: pt.p } : k > 0 ? { ...q, t: pt.t } : q));
      } else {
        const dl = tm.toLogical(pt.t) - tm.toLogical(start.t);
        const dp = pt.p - start.p;
        next = orig.map((q) => ({ t: tm.fromLogical(tm.toLogical(q.t) + dl), p: q.p + dp }));
      }
      this.d.onUpdate(this.drag.id, { points: next }, false);
      return;
    }
    if (!this.d.getTool()) {
      const hit = prim.hitAt(x, y);
      const id = hit?.id ?? null;
      if (id !== prim.hover) {
        prim.hover = id;
        prim.update();
      }
      this.d.container.style.cursor = hit ? (hit.handle >= 0 ? 'grab' : 'pointer') : '';
    } else this.d.container.style.cursor = 'crosshair';
  }

  private up(e: PointerEvent) {
    if (this.drag) {
      e.stopPropagation();
      const dr = this.d.getDrawings().find((q) => q.id === this.drag!.id);
      // record one undo step for the whole drag
      if (dr) {
        this.d.onUpdate(dr.id, { points: this.drag.orig }, false);
        this.d.onUpdate(dr.id, { points: dr.points }, true);
      }
      this.drag = null;
      this.lockChart(false);
      return;
    }
    const prim = this.d.prim;
    if (prim.draft) {
      // press–drag–release completes two-point tools
      const tool = prim.draft.type;
      const [p0, p1] = prim.draft.points;
      const tm = this.d.getTimeMap();
      if (POINTS_NEEDED[tool] === 2 && p0 && p1 && tm && Math.abs(tm.toLogical(p1.t) - tm.toLogical(p0.t)) > 1.5) {
        prim.draft.points = [p0, p1, p1];
        this.finishDraft(tool);
      }
    }
  }

  private dbl(e: MouseEvent) {
    const prim = this.d.prim;
    if (prim.draft && prim.draft.type === 'path') {
      e.stopPropagation();
      this.finishDraft('path');
      return;
    }
    const { x, y } = this.local(e);
    const hit = prim.hitAt(x, y);
    if (hit) {
      const dr = this.d.getDrawings().find((q) => q.id === hit.id);
      if (dr && dr.type === 'text') {
        e.stopPropagation();
        this.d.onEditText(dr);
      }
    }
  }

  cancel() {
    if (this.d.prim.draft) {
      this.d.prim.draft = null;
      this.d.prim.update();
    }
    this.lockChart(false);
  }

  /** Enter finishes a path. */
  finishPath() {
    if (this.d.prim.draft?.type === 'path') this.finishDraft('path');
  }
}

export const logicalOf = (chart: IChartApi, x: number) => chart.timeScale().coordinateToLogical(x) as Logical | null;

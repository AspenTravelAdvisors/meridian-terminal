import { computeStudy } from '../core/runner';
import type { Bar } from '../core/types';
import { getStudy } from '../registry';
import { resolveConfig } from '../core/params';

/**
 * Alert conditions and their evaluation, shared by the in-browser alert manager and the server scheduler
 * (`/api/cron/alerts`) so both fire on exactly the same bars with the same messages. Pure: no clock, no I/O.
 */
export type AlertOp = 'crosses_above' | 'crosses_below' | 'above' | 'below';

export type AlertCondition =
  | { kind: 'signal'; study: string; signal: string }
  | { kind: 'price'; op: AlertOp; value: number }
  | { kind: 'study'; study: string; output: string; op: 'crosses_above' | 'crosses_below'; value: number }
  | { kind: 'drawing'; drawingId: string; op: 'crosses_above' | 'crosses_below' }
  /** a `signal(…)` emitted by a Meridian Script (evaluated by the caller's script sandbox) */
  | { kind: 'script'; scriptId: string; signal: string };

export interface AlertChannels {
  app: boolean;
  /** local notification from the open tab */
  browser: boolean;
  /** Web Push to every device that enabled notifications for the account (server scheduler only) */
  push?: boolean;
  webhook?: string;
  email?: string;
}

export interface AlertSpec {
  id: string;
  name: string;
  symbol: string;
  interval: string;
  condition: AlertCondition;
  studyCfg?: Record<string, unknown>;
  mode: 'once' | 'every_bar';
  timing: 'close' | 'intrabar';
  expires?: number;
  channels: AlertChannels;
  enabled: boolean;
  createdAt: number;
  lastFiredBar?: number;
  lastFiredAt?: number;
  lastError?: string;
  /** set when the user resumes or edits the alert, so a fired 'once' alert can fire again */
  rearmedAt?: number;
}

/** The parts of a chart drawing an alert can follow (horizontal levels and two-point lines). */
export interface AlertDrawing {
  type: string;
  points: { t: number; p: number }[];
}

export interface AlertContext {
  drawing?: AlertDrawing;
  /** signals of the alert's script run over the same bars the evaluator receives */
  scriptSignals?: { i: number; id: string }[];
}

export interface AlertHit {
  fired: boolean;
  /** open time of the bar the condition was evaluated on (one firing per bar) */
  barT: number;
  message: string;
  provisional: boolean;
}

export const ALERT_DRAWING_TYPES = ['hline', 'hray', 'trendline', 'ray', 'extended'];

/** Fixed-format price (locale independent, so server and browser messages match). */
export function alertPrice(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return v.toFixed(a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8);
}
export const alertSignalLabel = (id: string) => id.replace(/_/g, ' ').replace(/\bSEQ\b/, 'Seq');
const opText = (op: string) => op.replace('_', ' ');

const crossed = (p0: number, p1: number, v0: number, v1: number, op: string) =>
  op === 'crosses_above' ? p0 <= v0 && p1 > v1 : op === 'crosses_below' ? p0 >= v0 && p1 < v1 : op === 'above' ? p1 > v1 : p1 < v1;

/** Bars the alert looks at: closed bars only unless it evaluates intrabar. */
export function alertBars(a: Pick<AlertSpec, 'timing'>, bars: readonly Bar[]): Bar[] {
  return a.timing === 'close' ? bars.filter((b) => b.final !== false) : bars.slice();
}

/** Price of a drawing at time t (two-point lines extrapolate). */
export function drawingPriceAt(d: AlertDrawing, t: number): number {
  if (d.type === 'hline' || d.type === 'hray' || d.points.length < 2) return d.points[0]?.p ?? NaN;
  const [p, q] = d.points;
  return p.p + ((q.p - p.p) * (t - p.t)) / (q.t - p.t || 1);
}

/**
 * Evaluate an alert on its bars (already filtered with `alertBars`). Returns null when there is not enough
 * history. Throws when the alert refers to something that no longer exists (deleted drawing, unknown study).
 */
export function evaluateAlert(a: AlertSpec, bars: readonly Bar[], ctx: AlertContext = {}): AlertHit | null {
  const n = bars.length;
  if (n < 3) return null;
  const last = bars[n - 1];
  const prev = bars[n - 2];
  const provisional = last.final === false;
  const base = { barT: last.t, provisional };
  const c = a.condition;
  switch (c.kind) {
    case 'price':
      return { ...base, fired: crossed(prev.c, last.c, c.value, c.value, c.op), message: `close ${alertPrice(last.c)} ${opText(c.op)} ${alertPrice(c.value)}` };
    case 'drawing': {
      const d = ctx.drawing;
      if (!d) throw new Error('drawing was deleted');
      const v0 = drawingPriceAt(d, prev.t);
      const v1 = drawingPriceAt(d, last.t);
      return { ...base, fired: crossed(prev.c, last.c, v0, v1, c.op), message: `close ${alertPrice(last.c)} ${opText(c.op)} drawing ${alertPrice(v1)}` };
    }
    case 'script': {
      if (!ctx.scriptSignals) throw new Error('script result missing');
      const hit = ctx.scriptSignals.some((s) => s.i === n - 1 && s.id === c.signal);
      return { ...base, fired: hit, message: alertSignalLabel(c.signal) };
    }
    case 'signal':
    case 'study': {
      const def = getStudy(c.study);
      if (!def) throw new Error(`unknown study ${c.study}`);
      const r = computeStudy(def, resolveConfig(def, a.studyCfg ?? {}), bars);
      if (c.kind === 'signal') return { ...base, fired: r.signals.some((s) => s.i === n - 1 && s.id === c.signal), message: alertSignalLabel(c.signal) };
      const line = r.lines[c.output];
      const v0 = line?.[n - 2] ?? NaN;
      const v1 = line?.[n - 1] ?? NaN;
      return {
        ...base,
        fired: Number.isFinite(v0) && Number.isFinite(v1) && crossed(v0, v1, c.value, c.value, c.op),
        message: `${def.shortName}.${c.output} = ${alertPrice(v1)} ${opText(c.op)} ${c.value}`,
      };
    }
  }
}

/** Should a hit fire now? (One firing per bar; 'once' alerts disable themselves after firing.) */
export const shouldFire = (hit: AlertHit | null, lastFiredBar: number | undefined | null): hit is AlertHit => !!hit?.fired && hit.barT !== lastFiredBar;

/** Text/JSON payload used by webhook, e-mail and push deliveries. */
export function alertPayload(a: Pick<AlertSpec, 'name' | 'symbol' | 'interval'>, hit: AlertHit) {
  return {
    alert: a.name,
    symbol: a.symbol,
    interval: a.interval,
    message: hit.message,
    barTime: new Date(hit.barT).toISOString(),
    provisional: hit.provisional,
    source: 'Meridian Terminal',
    text: `${a.name}: ${hit.message}`,
  };
}

import type { Bar, SignalDir } from '../core/types';

/**
 * Meridian Script — a tiny vectorized DSL for user studies. The code runs inside a locked-down Worker
 * (see apps/web script worker) with a time budget; this module only provides the pure runtime.
 *
 *   meta({ name: 'My MA cross', overlay: true })
 *   const fast = sma(close, input('Fast', 10, { min: 1, max: 200 }))
 *   const slow = sma(close, input('Slow', 30))
 *   plot(fast, { title: 'Fast', color: '#29b6f6' })
 *   plot(slow, { title: 'Slow', color: '#ff9800' })
 *   signal(crossover(fast, slow), { id: 'MY_CROSS_UP', dir: 'bull', text: '▲' })
 */
type Series = Float64Array;

export interface ScriptPlot {
  title: string;
  color: string;
  values: number[];
  style: 'line' | 'histogram' | 'step';
}
export interface ScriptResult {
  name: string;
  overlay: boolean;
  plots: ScriptPlot[];
  hlines: { value: number; title: string; color: string }[];
  signals: { i: number; id: string; dir: SignalDir; text: string }[];
  inputs: { name: string; value: number; min?: number; max?: number }[];
  error?: string;
  ms: number;
}

/**
 * The script API. Self-contained on purpose (no references to anything outside its own body), so its source text
 * can also be evaluated inside the server's QuickJS sandbox — see SCRIPT_API_SOURCE.
 */
function build(bars: readonly Bar[], inputValues: Record<string, number>, out: ScriptResult) {
  const NaNs = (len: number) => new Float64Array(len).fill(NaN);
  const n = bars.length;
  const col = (f: (b: Bar) => number) => Float64Array.from(bars, f);
  const open = col((b) => b.o);
  const high = col((b) => b.h);
  const low = col((b) => b.l);
  const close = col((b) => b.c);
  const volume = col((b) => b.v);
  const time = col((b) => b.t);
  const hl2 = col((b) => (b.h + b.l) / 2);
  const hlc3 = col((b) => (b.h + b.l + b.c) / 3);
  const asS = (x: Series | number): Series => (typeof x === 'number' ? new Float64Array(n).fill(x) : x);
  const len = (l: number) => Math.max(1, Math.floor(l));

  const sma = (s: Series, l: number): Series => {
    l = len(l);
    const o = NaNs(n);
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(s[i])) {
        sum += s[i];
        cnt++;
      }
      if (i >= l && !Number.isNaN(s[i - l])) {
        sum -= s[i - l];
        cnt--;
      }
      if (i >= l - 1 && cnt === l) o[i] = sum / l;
    }
    return o;
  };
  const emaK = (s: Series, alpha: number, seedLen: number): Series => {
    const o = NaNs(n);
    let v = NaN;
    let seed = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(s[i])) continue;
      c++;
      if (c < seedLen) seed += s[i];
      else if (c === seedLen) v = (seed + s[i]) / seedLen;
      else v = v + alpha * (s[i] - v);
      o[i] = v;
    }
    return o;
  };
  const ema = (s: Series, l: number) => emaK(s, 2 / (len(l) + 1), len(l));
  const rma = (s: Series, l: number) => emaK(s, 1 / len(l), len(l));
  const wma = (s: Series, l: number): Series => {
    l = len(l);
    const o = NaNs(n);
    const d = (l * (l + 1)) / 2;
    for (let i = l - 1; i < n; i++) {
      let acc = 0;
      for (let k = 0; k < l; k++) acc += s[i - k] * (l - k);
      o[i] = acc / d;
    }
    return o;
  };
  const roll = (s: Series, l: number, f: (a: number, b: number) => number, init: number): Series => {
    l = len(l);
    const o = NaNs(n);
    for (let i = l - 1; i < n; i++) {
      let v = init;
      for (let k = 0; k < l; k++) v = f(v, s[i - k]);
      o[i] = v;
    }
    return o;
  };
  const highest = (s: Series, l: number) => roll(s, l, Math.max, -Infinity);
  const lowest = (s: Series, l: number) => roll(s, l, Math.min, Infinity);
  const stdev = (s: Series, l: number): Series => {
    const m = sma(s, l);
    const o = NaNs(n);
    l = len(l);
    for (let i = l - 1; i < n; i++) {
      let acc = 0;
      for (let k = 0; k < l; k++) acc += (s[i - k] - m[i]) ** 2;
      o[i] = Math.sqrt(acc / l);
    }
    return o;
  };
  const change = (s: Series, l = 1): Series => {
    const o = NaNs(n);
    for (let i = l; i < n; i++) o[i] = s[i] - s[i - l];
    return o;
  };
  const tr = (): Series => {
    const o = NaNs(n);
    for (let i = 0; i < n; i++) o[i] = i ? Math.max(high[i], close[i - 1]) - Math.min(low[i], close[i - 1]) : high[i] - low[i];
    return o;
  };
  const atr = (l: number) => rma(tr(), l);
  const rsi = (s: Series, l: number): Series => {
    const up = NaNs(n);
    const dn = NaNs(n);
    for (let i = 1; i < n; i++) {
      const d = s[i] - s[i - 1];
      up[i] = Math.max(0, d);
      dn[i] = Math.max(0, -d);
    }
    const u = rma(up, l);
    const dd = rma(dn, l);
    return Float64Array.from(u, (x, i) => (dd[i] === 0 ? 100 : 100 - 100 / (1 + x / dd[i])));
  };
  const map2 = (a: Series | number, b: Series | number, f: (x: number, y: number) => number): Series => {
    const A = asS(a);
    const B = asS(b);
    return Float64Array.from(A, (x, i) => f(x, B[i]));
  };
  const crossover = (a: Series | number, b: Series | number): boolean[] => {
    const A = asS(a);
    const B = asS(b);
    return Array.from(A, (x, i) => i > 0 && A[i - 1] <= B[i - 1] && x > B[i]);
  };
  const crossunder = (a: Series | number, b: Series | number): boolean[] => {
    const A = asS(a);
    const B = asS(b);
    return Array.from(A, (x, i) => i > 0 && A[i - 1] >= B[i - 1] && x < B[i]);
  };
  const nz = (s: Series, v = 0) => Float64Array.from(s, (x) => (Number.isFinite(x) ? x : v));
  const series = (f: (i: number) => number): Series => Float64Array.from({ length: n }, (_, i) => f(i));

  const input = (name: string, def: number, o: { min?: number; max?: number } = {}) => {
    const v = inputValues[name] ?? def;
    if (!out.inputs.some((x) => x.name === name)) out.inputs.push({ name, value: v, min: o.min, max: o.max });
    return v;
  };
  const meta = (m: { name?: string; overlay?: boolean }) => {
    if (m.name) out.name = String(m.name).slice(0, 80);
    if (m.overlay !== undefined) out.overlay = !!m.overlay;
  };
  const plot = (s: Series | number[], o: { title?: string; color?: string; style?: ScriptPlot['style'] } = {}) => {
    if (out.plots.length >= 16) throw new Error('at most 16 plots');
    out.plots.push({ title: o.title ?? `Plot ${out.plots.length + 1}`, color: o.color ?? '#29b6f6', style: o.style ?? 'line', values: Array.from(s, Number) });
  };
  const hline = (value: number, title = '', color = '#787b86') => out.hlines.push({ value, title, color });
  const signal = (cond: ArrayLike<boolean | number>, o: { id?: string; dir?: SignalDir; text?: string } = {}) => {
    const id = (o.id ?? 'SCRIPT_SIGNAL').replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 48);
    for (let i = 0; i < n; i++) if (cond[i]) out.signals.push({ i, id, dir: o.dir ?? 'neutral', text: o.text ?? '◆' });
    if (out.signals.length > 20000) throw new Error('too many signals');
  };
  return {
    open, high, low, close, volume, time, hl2, hlc3, n,
    sma, ema, rma, wma, highest, lowest, stdev, change, atr, tr, rsi, crossover, crossunder, nz, series, map2,
    input, meta, plot, hline, signal,
    abs: Math.abs, max: Math.max, min: Math.min, sqrt: Math.sqrt, log: Math.log, pow: Math.pow, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  };
}

/** Source of the script API function, for runtimes that evaluate scripts in an isolated interpreter. */
export const SCRIPT_API_SOURCE: string = build.toString();

/** Execute a script. Callers are responsible for sandboxing (Worker without network) and time limits. */
export function runScript(code: string, bars: readonly Bar[], inputValues: Record<string, number> = {}, now: () => number = () => 0): ScriptResult {
  const out: ScriptResult = { name: 'Custom script', overlay: true, plots: [], hlines: [], signals: [], inputs: [], ms: 0 };
  const t0 = now();
  try {
    if (code.length > 50_000) throw new Error('script too long');
    const api = build(bars, inputValues, out);
    const names = Object.keys(api);
    // Shadow dangerous globals inside the function scope as a second line of defence.
    const shadow = ['self', 'globalThis', 'window', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'postMessage', 'Function', 'indexedDB', 'caches', 'navigator', 'location'];
    const fn = new Function(...names, ...shadow, `'use strict';\n${code}\n`);
    fn(...names.map((k) => (api as Record<string, unknown>)[k]), ...shadow.map(() => undefined));
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  out.ms = now() - t0;
  return out;
}

/**
 * Look-ahead check for user scripts: outputs on a prefix of the data must equal the same bars'
 * outputs on the full data. Returns the first offending bar, if any.
 */
export function checkScriptLookAhead(code: string, bars: readonly Bar[], inputs: Record<string, number> = {}): { ok: boolean; bar?: number; plot?: string } {
  const full = runScript(code, bars, inputs);
  if (full.error) return { ok: false };
  const cuts = [0.5, 0.75, 0.9].map((f) => Math.floor(bars.length * f)).filter((c) => c > 5);
  for (const cut of cuts) {
    const part = runScript(code, bars.slice(0, cut), inputs);
    for (let p = 0; p < part.plots.length; p++)
      for (let i = 0; i < cut; i++) {
        const a = part.plots[p].values[i];
        const b = full.plots[p]?.values[i];
        if (!(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9)) return { ok: false, bar: i, plot: part.plots[p].title };
      }
    const sigA = new Set(part.signals.map((s) => `${s.i}:${s.id}`));
    for (const s of full.signals) if (s.i < cut && !sigA.has(`${s.i}:${s.id}`)) return { ok: false, bar: s.i, plot: s.id };
  }
  return { ok: true };
}

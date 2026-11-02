import { alignHTF } from '../core/mtf';
import { resolveConfig } from '../core/params';
import { computeStudy } from '../core/runner';
import type { Bar, StudyResult } from '../core/types';
import { getStudy } from '../registry';

// Combined signal rules: entry and exit conditions built from study signals and comparisons, optionally on a higher
// timeframe ("daily buy setup 9 AND weekly close above its 40-week SMA"). Each condition is evaluated on its own
// timeframe's bars and mapped onto the base bars without look-ahead (a higher-timeframe value is visible only once that
// bar has closed).

export type RuleOperand =
  | { kind: 'price'; field: 'o' | 'h' | 'l' | 'c' }
  | { kind: 'line'; study: string; cfg?: Record<string, unknown>; output: string }
  | { kind: 'value'; value: number };

export type CompareOp = '>' | '<' | '>=' | '<=' | 'crossesAbove' | 'crossesBelow';

export type RuleCondition =
  /** the study fired `signal` on this bar or within the previous `withinBars` bars of the condition's timeframe */
  | { kind: 'signal'; interval?: string; study: string; cfg?: Record<string, unknown>; signal: string; withinBars: number }
  | { kind: 'compare'; interval?: string; left: RuleOperand; op: CompareOp; right: RuleOperand };

export interface RuleGroup {
  combine: 'all' | 'any';
  conditions: RuleCondition[];
}

export interface RuleSet {
  longEntry?: RuleGroup;
  shortEntry?: RuleGroup;
  /** exits close the matching side; they fire on every bar their group is true */
  longExit?: RuleGroup;
  shortExit?: RuleGroup;
  /** entries: 'rising' = only on the bar the group turns true; 'every' = every bar it is true */
  trigger: 'rising' | 'every';
}

export interface RuleSeries {
  bars: readonly Bar[];
  intervalMs: number;
}

export interface RuleEvent {
  i: number;
  dir: 'bull' | 'bear';
  id: 'RULE_LONG_ENTRY' | 'RULE_SHORT_ENTRY' | 'RULE_LONG_EXIT' | 'RULE_SHORT_EXIT';
}

export interface RuleEvaluation {
  entries: RuleEvent[];
  /** dir 'bull' closes longs, 'bear' closes shorts */
  exits: RuleEvent[];
  /** per group and condition: base bars on which it was true (to see how restrictive each part is) */
  trueBars: Record<string, number[]>;
}

const DAY = 86_400_000;
/** Nominal interval length for the interval strings the app uses (1m … 3M). */
export function intervalMs(iv: string): number {
  const m = /^(\d+)(m|h|D|W|M)$/.exec(iv);
  if (!m) throw new Error(`unknown interval ${iv}`);
  const n = Number(m[1]);
  return n * { m: 60_000, h: 3_600_000, D: DAY, W: 7 * DAY, M: 30 * DAY }[m[2] as 'm' | 'h' | 'D' | 'W' | 'M'];
}

/** Every interval the rules read besides the base timeframe. */
export function ruleIntervals(rules: RuleSet, base: string): string[] {
  const out = new Set<string>();
  for (const g of [rules.longEntry, rules.shortEntry, rules.longExit, rules.shortExit]) for (const c of g?.conditions ?? []) if (c.interval && c.interval !== base) out.add(c.interval);
  return [...out].sort();
}

const key = (o: unknown) => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

export function evaluateRules(base: RuleSeries, rules: RuleSet, aux: Record<string, RuleSeries> = {}, baseInterval = ''): RuleEvaluation {
  const cache = new Map<string, StudyResult>();
  const seriesFor = (iv?: string): RuleSeries => {
    if (!iv || iv === baseInterval) return base;
    const s = aux[iv];
    if (!s) throw new Error(`rules need ${iv} bars`);
    return s;
  };
  const run = (s: RuleSeries, study: string, cfg: Record<string, unknown> | undefined) => {
    const k = `${s === base ? '' : s.intervalMs}|${study}|${key(cfg ?? {})}`;
    let r = cache.get(k);
    if (!r) {
      const def = getStudy(study);
      if (!def) throw new Error(`unknown study ${study}`);
      r = computeStudy(def, resolveConfig(def, cfg ?? {}), s.bars);
      cache.set(k, r);
    }
    return r;
  };
  const operand = (s: RuleSeries, o: RuleOperand): ArrayLike<number> => {
    const n = s.bars.length;
    if (o.kind === 'value') return new Float64Array(n).fill(o.value);
    if (o.kind === 'price') return Float64Array.from(s.bars, (b) => b[o.field]);
    const r = run(s, o.study, o.cfg);
    const line = r.lines[o.output];
    if (!line) throw new Error(`${o.study} has no output ${o.output}`);
    // displaced outputs (e.g. the Ichimoku cloud) are read where they are drawn; a backward shift would need future bars
    const offset = (r.outputs.find((x) => x.kind === 'line' && x.id === o.output) as { offset?: number } | undefined)?.offset ?? 0;
    if (offset < 0) throw new Error(`${o.study} ${o.output} is drawn from later bars and can't be used in a rule`);
    if (!offset) return line;
    const out = new Float64Array(n).fill(NaN);
    for (let i = offset; i < n; i++) out[i] = line[i - offset];
    return out;
  };
  const onOwn = (c: RuleCondition, s: RuleSeries): Float64Array => {
    const n = s.bars.length;
    const out = new Float64Array(n);
    if (c.kind === 'signal') {
      const r = run(s, c.study, c.cfg);
      let last = -Infinity;
      const fired = new Set(r.signals.filter((x) => x.id === c.signal).map((x) => x.i));
      for (let i = 0; i < n; i++) {
        if (fired.has(i)) last = i;
        out[i] = i - last <= Math.max(0, c.withinBars) ? 1 : 0;
      }
      return out;
    }
    const L = operand(s, c.left);
    const R = operand(s, c.right);
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
      const pl = L[i - 1];
      const pr = R[i - 1];
      const prevOk = i > 0 && Number.isFinite(pl) && Number.isFinite(pr);
      out[i] = (c.op === '>' ? l > r : c.op === '<' ? l < r : c.op === '>=' ? l >= r : c.op === '<=' ? l <= r : c.op === 'crossesAbove' ? prevOk && l > r && pl <= pr : prevOk && l < r && pl >= pr) ? 1 : 0;
    }
    return out;
  };
  const cond = (c: RuleCondition): Uint8Array => {
    const s = seriesFor(c.interval);
    const own = onOwn(c, s);
    const v = s === base ? own : alignHTF(base.bars, base.intervalMs, s.bars, s.intervalMs, own);
    return Uint8Array.from(v, (x) => (x === 1 ? 1 : 0));
  };
  const trueBars: Record<string, number[]> = {};
  const group = (name: string, g?: RuleGroup): Uint8Array | null => {
    if (!g?.conditions.length) return null;
    const cs = g.conditions.map(cond);
    trueBars[name] = cs.map((a) => a.reduce((x, y) => x + y, 0));
    const n = base.bars.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (g.combine === 'all' ? cs.every((a) => a[i]) : cs.some((a) => a[i])) ? 1 : 0;
    return out;
  };
  const events = (a: Uint8Array | null, dir: RuleEvent['dir'], id: RuleEvent['id'], rising: boolean): RuleEvent[] => {
    const out: RuleEvent[] = [];
    if (a) for (let i = 0; i < a.length; i++) if (a[i] && (!rising || i === 0 || !a[i - 1])) out.push({ i, dir, id });
    return out;
  };
  const rising = rules.trigger === 'rising';
  const entries = [...events(group('longEntry', rules.longEntry), 'bull', 'RULE_LONG_ENTRY', rising), ...events(group('shortEntry', rules.shortEntry), 'bear', 'RULE_SHORT_ENTRY', rising)].sort((a, b) => a.i - b.i);
  const exits = [...events(group('longExit', rules.longExit), 'bull', 'RULE_LONG_EXIT', false), ...events(group('shortExit', rules.shortExit), 'bear', 'RULE_SHORT_EXIT', false)].sort((a, b) => a.i - b.i);
  return { entries, exits, trueBars };
}

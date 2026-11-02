import { INTERVALS } from '@meridian/data';
import { type CompareOp, type RuleCondition, type RuleGroup, type RuleOperand, type RuleSet, STUDIES, getStudy, inputsSchema, resolveConfig } from '@meridian/engine';
import { Plus, X } from 'lucide-react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { signalLabel } from '../lib/format';

// Combined-rule editor for the Signal Tester: four groups (long/short entry, long/short exit), each ALL or ANY of
// conditions built from study signals and comparisons, on the chart's timeframe or a higher one.

const sma = (length: number): RuleOperand => ({ kind: 'line', study: 'sma', cfg: { length }, output: 'ma' });
const close: RuleOperand = { kind: 'price', field: 'c' };

export const RULE_TEMPLATES: { name: string; rules: RuleSet }[] = [
  {
    name: 'Daily buy setup 9 AND weekly trend up',
    rules: {
      trigger: 'rising',
      longEntry: { combine: 'all', conditions: [{ kind: 'signal', study: 'td-sequential', signal: 'SEQ_BUY_SETUP_9', withinBars: 0 }, { kind: 'compare', interval: '1W', left: close, op: '>', right: sma(40) }] },
      longExit: { combine: 'any', conditions: [{ kind: 'signal', study: 'td-sequential', signal: 'SEQ_SELL_SETUP_9', withinBars: 0 }, { kind: 'compare', interval: '1W', left: close, op: 'crossesBelow', right: sma(40) }] },
    },
  },
  {
    name: 'Combo buy 13 AND above the daily cloud',
    rules: {
      trigger: 'rising',
      longEntry: { combine: 'all', conditions: [{ kind: 'signal', study: 'td-combo', signal: 'COMBO_BUY_13', withinBars: 3 }, { kind: 'compare', left: close, op: '>', right: { kind: 'line', study: 'ichimoku', output: 'senkouB' } }] },
      longExit: { combine: 'any', conditions: [{ kind: 'compare', left: close, op: 'crossesBelow', right: { kind: 'line', study: 'ichimoku', output: 'kijun' } }] },
    },
  },
];

interface RulesState {
  rules: RuleSet;
  set(r: RuleSet): void;
}
export const useTesterRules = create<RulesState>()(persist((set) => ({ rules: RULE_TEMPLATES[0].rules, set: (rules) => set({ rules }) }), { name: 'meridian.tester-rules', storage: createJSONStorage(() => localStorage) }));

const SIGNAL_STUDIES = STUDIES.filter((s) => s.signals?.length);
const LINE_STUDIES = STUDIES.filter((s) => s.outputs(resolveConfig(s, {})).some((o) => o.kind === 'line'));
const OPS: { v: CompareOp; label: string }[] = [
  { v: '>', label: '>' },
  { v: '<', label: '<' },
  { v: '>=', label: '≥' },
  { v: '<=', label: '≤' },
  { v: 'crossesAbove', label: 'crosses above' },
  { v: 'crossesBelow', label: 'crosses below' },
];
const PRICE = { o: 'Open', h: 'High', l: 'Low', c: 'Close' } as const;

/** Up to two numeric study parameters (length, multiplier…) inline; the rest keep their defaults. */
function CfgInputs({ study, cfg, onChange }: { study: string; cfg?: Record<string, unknown>; onChange(c: Record<string, unknown>): void }) {
  const def = getStudy(study);
  if (!def) return null;
  const props = Object.entries(inputsSchema(def).properties ?? {}).filter(([, s]) => (s.type === 'integer' || s.type === 'number') && (s as { group?: string }).group !== 'Display').slice(0, 2);
  const full = resolveConfig(def, cfg ?? {});
  return (
    <>
      {props.map(([k, s]) => (
        <input key={k} className="input w-14" type="number" title={s.title ?? k} aria-label={s.title ?? k} value={Number(full[k])} onChange={(e) => onChange({ ...cfg, [k]: Number(e.target.value) })} />
      ))}
    </>
  );
}

function OperandEdit({ o, onChange, label }: { o: RuleOperand; onChange(o: RuleOperand): void; label: string }) {
  const kind = o.kind === 'price' ? o.field : o.kind;
  const def = o.kind === 'line' ? getStudy(o.study) : undefined;
  const lines = def ? def.outputs(resolveConfig(def, o.kind === 'line' ? (o.cfg ?? {}) : {})).filter((x) => x.kind === 'line') : [];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <select
        className="input"
        aria-label={`${label} kind`}
        value={kind}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'line') onChange(sma(20));
          else if (v === 'value') onChange({ kind: 'value', value: 0 });
          else onChange({ kind: 'price', field: v as 'o' | 'h' | 'l' | 'c' });
        }}
      >
        {Object.entries(PRICE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        <option value="line">Study line</option>
        <option value="value">Number</option>
      </select>
      {o.kind === 'value' && <input className="input w-20" type="number" aria-label={`${label} value`} value={o.value} onChange={(e) => onChange({ kind: 'value', value: Number(e.target.value) })} />}
      {o.kind === 'line' && (
        <>
          <select
            className="input"
            aria-label={`${label} study`}
            value={o.study}
            onChange={(e) => {
              const d = getStudy(e.target.value)!;
              const first = d.outputs(resolveConfig(d, {})).find((x) => x.kind === 'line');
              onChange({ kind: 'line', study: d.id, output: first?.id ?? '' });
            }}
          >
            {LINE_STUDIES.map((s) => <option key={s.id} value={s.id}>{s.shortName}</option>)}
          </select>
          <select className="input" aria-label={`${label} output`} value={o.output} onChange={(e) => onChange({ ...o, output: e.target.value })}>
            {lines.map((x) => <option key={x.id} value={x.id}>{x.kind === 'line' ? (x.title ?? x.id) : x.id}</option>)}
          </select>
          <CfgInputs study={o.study} cfg={o.cfg} onChange={(cfg) => onChange({ ...o, cfg })} />
        </>
      )}
    </span>
  );
}

function ConditionEdit({ c, onChange, onRemove, baseLabel }: { c: RuleCondition; onChange(c: RuleCondition): void; onRemove(): void; baseLabel: string }) {
  const def = c.kind === 'signal' ? getStudy(c.study) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-1 py-0.5">
      <select className="input" aria-label="Timeframe" value={c.interval ?? ''} onChange={(e) => onChange({ ...c, interval: e.target.value || undefined })}>
        <option value="">{baseLabel}</option>
        {INTERVALS.map((iv) => <option key={iv} value={iv}>{iv}</option>)}
      </select>
      <select
        className="input"
        aria-label="Condition type"
        value={c.kind}
        onChange={(e) => onChange(e.target.value === 'signal' ? { kind: 'signal', interval: c.interval, study: 'td-sequential', signal: 'SEQ_BUY_SETUP_9', withinBars: 0 } : { kind: 'compare', interval: c.interval, left: close, op: '>', right: sma(20) })}
      >
        <option value="signal">signal</option>
        <option value="compare">comparison</option>
      </select>
      {c.kind === 'signal' ? (
        <>
          <select className="input" aria-label="Signal study" value={c.study} onChange={(e) => onChange({ ...c, study: e.target.value, cfg: undefined, signal: getStudy(e.target.value)?.signals?.[0]?.id ?? '' })}>
            {SIGNAL_STUDIES.map((s) => <option key={s.id} value={s.id}>{s.shortName}</option>)}
          </select>
          <select className="input" aria-label="Signal" value={c.signal} onChange={(e) => onChange({ ...c, signal: e.target.value })}>
            {(def?.signals ?? []).map((s) => <option key={s.id} value={s.id}>{signalLabel(s.id)}</option>)}
          </select>
          <span className="text-dim">within</span>
          <input className="input w-12" type="number" min={0} aria-label="Within bars" value={c.withinBars} onChange={(e) => onChange({ ...c, withinBars: Math.max(0, Number(e.target.value)) })} />
          <span className="text-dim">bars</span>
        </>
      ) : (
        <>
          <OperandEdit label="Left" o={c.left} onChange={(left) => onChange({ ...c, left })} />
          <select className="input" aria-label="Comparison" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as CompareOp })}>
            {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
          <OperandEdit label="Right" o={c.right} onChange={(right) => onChange({ ...c, right })} />
        </>
      )}
      <button className="icon-btn size-6" aria-label="Remove condition" onClick={onRemove}><X className="size-3.5" /></button>
    </div>
  );
}

const GROUPS: { key: 'longEntry' | 'shortEntry' | 'longExit' | 'shortExit'; label: string }[] = [
  { key: 'longEntry', label: 'Long entry' },
  { key: 'longExit', label: 'Long exit' },
  { key: 'shortEntry', label: 'Short entry' },
  { key: 'shortExit', label: 'Short exit' },
];

export function RuleBuilder({ baseInterval, trueBars }: { baseInterval: string; trueBars?: Record<string, number[]> }) {
  const rules = useTesterRules((s) => s.rules);
  const set = useTesterRules((s) => s.set);
  const setGroup = (k: (typeof GROUPS)[number]['key'], g: RuleGroup | undefined) => set({ ...rules, [k]: g?.conditions.length ? g : undefined });
  return (
    <div className="border-b border-border p-2 text-[12px]">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-semibold">Combined rules</span>
        <select className="input" aria-label="Load a template" value="" onChange={(e) => e.target.value && set(RULE_TEMPLATES[Number(e.target.value)].rules)}>
          <option value="">Templates…</option>
          {RULE_TEMPLATES.map((t, k) => <option key={t.name} value={k}>{t.name}</option>)}
        </select>
        <label className="inline-flex items-center gap-1">
          <span className="text-dim">Entries fire</span>
          <select className="input" value={rules.trigger} onChange={(e) => set({ ...rules, trigger: e.target.value as RuleSet['trigger'] })}>
            <option value="rising">on the bar the rule turns true</option>
            <option value="every">on every bar it is true</option>
          </select>
        </label>
        <span className="text-[10px] text-faint">Exits fire on every bar their rule is true. Higher-timeframe values count only once that bar has closed.</span>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {GROUPS.map(({ key, label }) => {
          const g = rules[key];
          return (
            <fieldset key={key} className="rounded border border-border px-2 py-1">
              <legend className="px-1 text-[11px] font-semibold">
                {label}{' '}
                {g && (
                  <select className="input h-6 py-0" aria-label={`${label}: combine`} value={g.combine} onChange={(e) => setGroup(key, { ...g, combine: e.target.value as RuleGroup['combine'] })}>
                    <option value="all">ALL of</option>
                    <option value="any">ANY of</option>
                  </select>
                )}
              </legend>
              {g?.conditions.map((c, k) => (
                <div key={k} className="flex items-center gap-1">
                  {k > 0 && <span className="w-8 shrink-0 text-[10px] font-semibold text-faint">{g.combine === 'all' ? 'AND' : 'OR'}</span>}
                  <ConditionEdit
                    c={c}
                    baseLabel={`chart (${baseInterval})`}
                    onChange={(nc) => setGroup(key, { ...g, conditions: g.conditions.map((x, j) => (j === k ? nc : x)) })}
                    onRemove={() => setGroup(key, { ...g, conditions: g.conditions.filter((_, j) => j !== k) })}
                  />
                  {trueBars?.[key] && <span className="shrink-0 text-[10px] text-faint" title="Base bars on which this condition was true">{trueBars[key][k]} bars</span>}
                </div>
              ))}
              <button className="btn-ghost h-6 text-[11px]" onClick={() => setGroup(key, { combine: g?.combine ?? 'all', conditions: [...(g?.conditions ?? []), { kind: 'signal', study: 'td-sequential', signal: key.startsWith('long') === key.endsWith('Entry') ? 'SEQ_BUY_SETUP_9' : 'SEQ_SELL_SETUP_9', withinBars: 0 }] })}>
                <Plus className="size-3" /> condition
              </button>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

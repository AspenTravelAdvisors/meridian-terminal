import { type PeriodSummary, type TestRunRecord, type TestWindow, type WalkForwardResult, type WalkForwardSpec, eventsByYear, getStudy, inputsSchema } from '@meridian/engine';
import { Field, Switch } from '../components/ui';
import { fmtPct } from '../lib/format';

// Signal Tester periods: an explicit evaluation window, a train/test split whose test period stays hidden until the
// parameters are frozen, and walk-forward folds. Results by year for whatever was evaluated.

export type PeriodMode = 'all' | 'range' | 'split' | 'walk';

export interface PeriodState {
  mode: PeriodMode;
  range: TestWindow;
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  wf: Omit<WalkForwardSpec, 'param'> & { paramKey: string; values: string };
}

const isoToday = () => new Date().toLocaleDateString('en-CA');
const shiftYears = (iso: string, y: number) => `${Number(iso.slice(0, 4)) + y}${iso.slice(4)}`;
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function defaultPeriods(): PeriodState {
  const testFrom = shiftYears(isoToday(), -3);
  return {
    mode: 'all',
    range: {},
    trainFrom: '',
    trainTo: dayBefore(testFrom),
    testFrom,
    testTo: '',
    wf: { trainYears: 5, testYears: 1, anchored: false, metric: 'eventMean', metricHorizon: 20, minEvents: 10, paramKey: '', values: '' },
  };
}

/** The window a run evaluates: the chosen range, or the training period of a split. */
export function evalWindow(p: PeriodState): TestWindow | undefined {
  const w = p.mode === 'range' ? p.range : p.mode === 'split' ? { from: p.trainFrom || undefined, to: p.trainTo || undefined } : undefined;
  return w && (w.from || w.to) ? { ...(w.from ? { from: w.from } : {}), ...(w.to ? { to: w.to } : {}) } : undefined;
}
export const testWindow = (p: PeriodState): TestWindow => ({ ...(p.testFrom ? { from: p.testFrom } : {}), ...(p.testTo ? { to: p.testTo } : {}) });

/** Walk-forward settings for the engine; parameter values are parsed as numbers where they look like numbers. */
export function wfSpec(p: PeriodState): WalkForwardSpec {
  const { paramKey, values, ...rest } = p.wf;
  const vals = values
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x === 'true' ? true : x === 'false' ? false : Number.isFinite(Number(x)) ? Number(x) : x));
  return { ...rest, ...(paramKey && vals.length ? { param: { key: paramKey, values: vals } } : {}) };
}

const PRESETS: { label: string; from: () => string }[] = [
  { label: 'YTD', from: () => `${isoToday().slice(0, 4)}-01-01` },
  { label: '1Y', from: () => shiftYears(isoToday(), -1) },
  { label: '3Y', from: () => shiftYears(isoToday(), -3) },
  { label: '5Y', from: () => shiftYears(isoToday(), -5) },
  { label: '10Y', from: () => shiftYears(isoToday(), -10) },
];

const DateIn = ({ value, onChange, label }: { value: string; onChange(v: string): void; label: string }) => <input className="input" type="date" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />;

export function PeriodControls({ p, set, studyId, horizons, strategy, script }: { p: PeriodState; set(p: PeriodState): void; studyId: string; horizons: number[]; strategy: boolean; script: boolean }) {
  const def = getStudy(studyId);
  const props = def ? Object.entries(inputsSchema(def).properties ?? {}) : [];
  // display-only settings can't change a signal, so they aren't offered for tuning
  const numeric = props.filter(([, s]) => (s.type === 'integer' || s.type === 'number') && (s as { group?: string }).group !== 'Display');
  const w = p.wf;
  const setWf = (patch: Partial<PeriodState['wf']>) => set({ ...p, wf: { ...w, ...patch } });
  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-border p-2">
      <Field label="Period">
        <select className="input" value={p.mode} onChange={(e) => set({ ...p, mode: e.target.value as PeriodMode })}>
          <option value="all">All history</option>
          <option value="range">Date range</option>
          <option value="split">Train / test</option>
          <option value="walk" disabled={script}>Walk-forward{script ? ' (built-in studies)' : ''}</option>
        </select>
      </Field>
      {p.mode === 'range' && (
        <>
          <div className="flex gap-1 pb-0.5" role="group" aria-label="Recent-period presets">
            {PRESETS.map((x) => {
              const from = x.from();
              const on = p.range.from === from && !p.range.to;
              return (
                <button key={x.label} className="btn-ghost h-7" data-active={on} aria-pressed={on} onClick={() => set({ ...p, range: { from } })}>
                  {x.label}
                </button>
              );
            })}
          </div>
          <Field label="From"><DateIn label="Range start" value={p.range.from ?? ''} onChange={(v) => set({ ...p, range: { ...p.range, from: v || undefined } })} /></Field>
          <Field label="To (blank = latest)"><DateIn label="Range end" value={p.range.to ?? ''} onChange={(v) => set({ ...p, range: { ...p.range, to: v || undefined } })} /></Field>
        </>
      )}
      {p.mode === 'split' && (
        <>
          <Field label="Train from (blank = first bar)"><DateIn label="Training start" value={p.trainFrom} onChange={(v) => set({ ...p, trainFrom: v })} /></Field>
          <Field label="Train to"><DateIn label="Training end" value={p.trainTo} onChange={(v) => set({ ...p, trainTo: v })} /></Field>
          <Field label="Test from"><DateIn label="Test start" value={p.testFrom} onChange={(v) => set({ ...p, testFrom: v })} /></Field>
          <Field label="Test to (blank = latest)"><DateIn label="Test end" value={p.testTo} onChange={(v) => set({ ...p, testTo: v })} /></Field>
          {p.testFrom && p.trainTo && p.testFrom <= p.trainTo && <span className="pb-1 text-[11px] text-warn">The test period must start after training ends.</span>}
        </>
      )}
      {p.mode === 'walk' && (
        <>
          <Field label="Train years"><input className="input w-14" type="number" min={1} max={50} value={w.trainYears} onChange={(e) => setWf({ trainYears: Math.max(1, Number(e.target.value)) })} /></Field>
          <Field label="Test years"><input className="input w-14" type="number" min={1} max={20} value={w.testYears} onChange={(e) => setWf({ testYears: Math.max(1, Number(e.target.value)) })} /></Field>
          <div className="pb-1"><Switch checked={w.anchored} onChange={(v) => setWf({ anchored: v })} label="Anchored" /></div>
          <Field label="Choose on training">
            <select className="input" value={w.paramKey} onChange={(e) => setWf({ paramKey: e.target.value })}>
              <option value="">nothing (fixed parameters)</option>
              {numeric.map(([k, s]) => <option key={k} value={k}>{s.title ?? k}</option>)}
            </select>
          </Field>
          {w.paramKey && <Field label="Candidate values"><input className="input w-28" value={w.values} placeholder="e.g. 7, 9, 11" onChange={(e) => setWf({ values: e.target.value })} aria-label="Candidate values" /></Field>}
          <Field label="Best by">
            <select className="input" value={w.metric} onChange={(e) => setWf({ metric: e.target.value as WalkForwardSpec['metric'] })}>
              <option value="eventMean">Mean event return</option>
              <option value="strategyReturn" disabled={!strategy}>Strategy return{strategy ? '' : ' (turn on strategy mode)'}</option>
            </select>
          </Field>
          {w.metric === 'eventMean' && (
            <Field label="at horizon">
              <select className="input" value={w.metricHorizon} onChange={(e) => setWf({ metricHorizon: Number(e.target.value) })}>
                {horizons.map((h) => <option key={h} value={h}>{h} bars</option>)}
              </select>
            </Field>
          )}
          <Field label={w.metric === 'eventMean' ? 'Min training events' : 'Min training trades'}><input className="input w-16" type="number" min={0} value={w.minEvents} onChange={(e) => setWf({ minEvents: Math.max(0, Number(e.target.value)) })} /></Field>
        </>
      )}
    </div>
  );
}

const pct = (v: number) => fmtPct(v);
const hit = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');

/** Pooled event results and (single-symbol) strategy results per calendar year. */
export function ByYear({ records, horizons, selH }: { records: TestRunRecord[]; horizons: number[]; selH: number }) {
  const k = Math.max(0, horizons.indexOf(selH));
  const rows = eventsByYear(records.flatMap((r) => r.eventStudy.events), horizons);
  const strat = records.length === 1 ? records[0].strategy?.byYear : undefined;
  if (!rows.length && !strat?.length) return null;
  const years = [...new Set([...rows.map((r) => r.year), ...(strat ?? []).map((s) => s.year)])].sort((a, b) => a - b);
  return (
    <details className="mt-3" open>
      <summary className="section-title cursor-pointer px-0">Results by year · {horizons[k]}-bar returns{strat ? ' · strategy' : ''}</summary>
      <table className="table">
        <thead>
          <tr>
            <th>Year</th>
            <th className="text-right">Signals</th>
            <th className="text-right">n ({horizons[k]} bars)</th>
            <th className="text-right">Mean</th>
            <th className="text-right">Hit rate</th>
            {strat && <><th className="text-right">Strategy</th><th className="text-right">Trades closed</th><th className="text-right">Max DD</th></>}
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const r = rows.find((x) => x.year === y);
            const s = strat?.find((x) => x.year === y);
            return (
              <tr key={y}>
                <td>{y}</td>
                <td className="text-right">{r?.signals ?? 0}</td>
                <td className="text-right">{r?.n[k] ?? 0}</td>
                <td className="text-right">{r ? pct(r.mean[k]) : '—'}</td>
                <td className="text-right">{r ? hit(r.hitRate[k]) : '—'}</td>
                {strat && (
                  <>
                    <td className="text-right" style={{ color: s && s.returnPct >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{s ? pct(s.returnPct) : '—'}</td>
                    <td className="text-right">{s?.trades ?? 0}</td>
                    <td className="text-right">{s ? pct(s.maxDrawdownPct) : '—'}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-faint">A signal counts in the year it fired. Signals whose horizon runs past the end of the evaluated period are left out.</p>
    </details>
  );
}

type Pooled = { h: number; n: number; mean: number; median: number; hit: number; baseline: number }[];

/** Training vs. test, side by side, after the parameters were frozen. */
export function TrainTestCompare({ train, test, trainLabel, testLabel, trainStrat, testStrat }: { train: Pooled; test: Pooled; trainLabel: string; testLabel: string; trainStrat?: number; testStrat?: number }) {
  return (
    <table className="table mb-2">
      <thead>
        <tr>
          <th>Horizon</th>
          <th className="text-right">Train n</th>
          <th className="text-right">Train mean</th>
          <th className="text-right">Train hit</th>
          <th className="text-right">Train edge</th>
          <th className="text-right">Test n</th>
          <th className="text-right">Test mean</th>
          <th className="text-right">Test hit</th>
          <th className="text-right">Test edge</th>
        </tr>
      </thead>
      <tbody>
        {train.map((a, k) => {
          const b = test[k];
          return (
            <tr key={a.h}>
              <td>{a.h} bars</td>
              <td className="text-right">{a.n}</td>
              <td className="text-right">{pct(a.mean)}</td>
              <td className="text-right">{hit(a.hit)}</td>
              <td className="text-right">{pct(a.mean - a.baseline)}</td>
              <td className="text-right">{b?.n ?? 0}</td>
              <td className="text-right font-semibold">{b ? pct(b.mean) : '—'}</td>
              <td className="text-right">{b ? hit(b.hit) : '—'}</td>
              <td className="text-right font-semibold" style={{ color: b && b.mean - b.baseline >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{b ? pct(b.mean - b.baseline) : '—'}</td>
            </tr>
          );
        })}
        {trainStrat !== undefined && (
          <tr>
            <td>Strategy</td>
            <td colSpan={4} className="text-right">{pct(trainStrat)}</td>
            <td colSpan={4} className="text-right font-semibold">{testStrat !== undefined ? pct(testStrat) : '—'}</td>
          </tr>
        )}
      </tbody>
      <caption className="caption-bottom pt-1 text-left text-[10px] text-faint">Train: {trainLabel} · Test: {testLabel}. Edge = mean minus the random-entry baseline drawn from the same period.</caption>
    </table>
  );
}

const years = (s: { from: string; to: string }) => (s.from.slice(0, 4) === s.to.slice(0, 4) ? s.from.slice(0, 4) : `${s.from.slice(0, 4)}–${s.to.slice(0, 4)}`);
const cellSummary = (s: PeriodSummary | null, k: number) => (s ? `${s.horizons[k].n} · ${pct(s.horizons[k].mean)} · ${hit(s.horizons[k].hitRate)}` : '—');

export function WalkForwardView({ r, selH }: { r: WalkForwardResult; selH: number }) {
  const k = Math.max(0, r.spec.horizons.indexOf(selH));
  const varied = r.walkForward.param;
  const strat = r.folds.some((f) => f.train.strategyReturnPct !== null);
  return (
    <div>
      <div className="section-title px-0">
        Walk-forward · {r.walkForward.anchored ? 'anchored' : 'rolling'} {r.walkForward.trainYears}y train → {r.walkForward.testYears}y test · {r.spec.symbols.length} symbol{r.spec.symbols.length === 1 ? '' : 's'}
      </div>
      <p className="mb-1 text-[11px] text-dim">
        {varied
          ? `Each fold picks the ${varied.key} value with the best ${r.walkForward.metric === 'eventMean' ? `mean ${r.walkForward.metricHorizon}-bar event return` : 'strategy return'} on its training years (at least ${r.walkForward.minEvents} ${r.walkForward.metric === 'eventMean' ? 'events' : 'trades'}), freezes it, then measures it on the next, unseen years.`
          : 'Fixed parameters: each fold measures the same rule on its training and test years, to show how stable it is.'}{' '}
        Cells: n · mean · hit rate at {r.spec.horizons[k]} bars.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Fold</th>
            <th>Train</th>
            <th>Test</th>
            {varied && <th>Chosen {varied.key}</th>}
            <th className="text-right">Train</th>
            <th className="text-right">Test (out of sample)</th>
            {strat && <><th className="text-right">Train strategy</th><th className="text-right">Test strategy</th></>}
          </tr>
        </thead>
        <tbody>
          {r.folds.map((f) => (
            <tr key={f.fold}>
              <td>{f.fold}</td>
              <td className="whitespace-nowrap">{years(f.train)}</td>
              <td className="whitespace-nowrap">{f.test ? years(f.test) : 'skipped'}</td>
              {varied && (
                <td title={f.candidates.map((c) => `${String(c.value)}: ${Number.isFinite(c.metric) ? pct(c.metric) : `n=${c.n}, too few`}`).join('\n')}>{f.chosen === null ? 'none qualified' : String(f.chosen)}</td>
              )}
              <td className="text-right">{cellSummary(f.train, k)}</td>
              <td className="text-right font-semibold">{cellSummary(f.test, k)}</td>
              {strat && (
                <>
                  <td className="text-right">{f.train.strategyReturnPct !== null ? pct(f.train.strategyReturnPct) : '—'}</td>
                  <td className="text-right font-semibold">{f.test?.strategyReturnPct != null ? pct(f.test.strategyReturnPct) : '—'}</td>
                </>
              )}
            </tr>
          ))}
          {r.outOfSample && (
            <tr className="bg-raised">
              <td colSpan={varied ? 4 : 3}>All test windows pooled ({years(r.outOfSample)})</td>
              <td />
              <td className="text-right font-semibold">{cellSummary(r.outOfSample, k)}</td>
              {strat && <><td /><td className="text-right font-semibold">{r.outOfSample.strategyReturnPct !== null ? pct(r.outOfSample.strategyReturnPct) : '—'}</td></>}
            </tr>
          )}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-faint">
        {r.trials} parameter evaluation{r.trials === 1 ? '' : 's'} on training data ({r.folds.length} folds × {r.trials / Math.max(1, r.folds.length)} candidate{r.trials / Math.max(1, r.folds.length) === 1 ? '' : 's'}). Training numbers are flattered by the choice; the pooled test row is the honest one. Training signals whose horizon would reach into the test years are left out, and studies warm up on earlier bars.
      </p>
    </div>
  );
}

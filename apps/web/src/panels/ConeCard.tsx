import type { StudyResult } from '@meridian/engine';
import { fmtPct, fmtPrice } from '../lib/format';
import { coneReading } from '../lib/cone';

const TRUST_COLOR = { good: 'var(--ok)', range: 'var(--text-dim)', poor: 'var(--warn)', unknown: 'var(--text-faint)' } as const;
const share = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(100 * v)}%` : '—');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The Forward Cone on the active chart, in words: what the similar cases say, the levels to trade against, and its track record. */
export function ConeCard({ result, interval }: { result: StudyResult | undefined; interval: string }) {
  const v = (result?.status?.values ?? {}) as Record<string, unknown>;
  const r = coneReading(v);
  if (!result)
    return (
      <>
        <div className="section-title">Forward Cone</div>
        <p className="px-3 text-faint">Add Forward Cone to the chart to see the range of outcomes for the next bars.</p>
      </>
    );
  if (!r)
    return (
      <>
        <div className="section-title">Forward Cone ({interval})</div>
        <p className="px-3 text-faint">Not enough history yet: the cone needs past bars whose next {String(v.horizon ?? 21)} bars are known.</p>
      </>
    );
  const entry = num(v.entry);
  const target = num(v.target);
  const stop = num(v.stop);
  const leanColor = r.lean === 'up' ? 'var(--ok)' : r.lean === 'down' ? 'var(--danger)' : undefined;
  return (
    <div data-testid="cone-card">
      <div className="section-title">
        Forward Cone ({interval}) · next {String(v.horizon)} bars
      </div>
      <p className="px-3 text-[12px] font-medium" style={{ color: leanColor }}>
        {r.headline}
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 px-3 pt-1 text-[12px]">
        <dt className="text-dim">Median outcome</dt>
        <dd className="m-0 text-right tabular-nums">{fmtPct(num(v.medPct), 1)}</dd>
        <dt className="text-dim" title="Half of the similar cases ended inside this range">Half of cases</dt>
        <dd className="m-0 text-right tabular-nums">
          {fmtPct(num(v.lo50Pct), 1)} to {fmtPct(num(v.hi50Pct), 1)}
        </dd>
        <dt className="text-dim" title="Four in five similar cases ended inside this range">Four in five</dt>
        <dd className="m-0 text-right tabular-nums">
          {fmtPct(num(v.lo80Pct), 1)} to {fmtPct(num(v.hi80Pct), 1)}
        </dd>
        <dt className="text-dim" title="Neighbouring bars share most of their outcome, so only cases a full horizon apart count as separate evidence">
          Similar bars (non-overlapping)
        </dt>
        <dd className="m-0 text-right tabular-nums">
          {String(v.cases)} ({String(v.independent)})
        </dd>
        <dt className="text-dim">Matched on</dt>
        <dd className="m-0 max-w-[14rem] text-right">{String(v.match)}</dd>
      </dl>
      {entry !== null && target !== null && stop !== null && (
        <>
          <div className="section-title">Levels from those cases</div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 px-3 text-[12px]">
            <dt className="text-dim">Entry (last close)</dt>
            <dd className="m-0 text-right tabular-nums">{fmtPrice(entry)}</dd>
            <dt className="text-dim" title="Median best excursion of the similar cases within the horizon">Target · reached first</dt>
            <dd className="m-0 text-right tabular-nums" style={{ color: r.lean === 'up' ? 'var(--ok)' : 'var(--danger)' }}>
              {fmtPrice(target, entry)} · {share(v.hitTarget)}
            </dd>
            <dt className="text-dim" title="A bar that touches both the target and the stop counts as stopped">
              Stop ({String(v.stopSrc)}) · hit first
            </dt>
            <dd className="m-0 text-right tabular-nums" style={{ color: 'var(--warn)' }}>
              {fmtPrice(stop, entry)} · {share(v.hitStop)}
            </dd>
            <dt className="text-dim">Reward : risk</dt>
            <dd className="m-0 text-right tabular-nums">{num(v.rr)?.toFixed(2) ?? '—'} : 1</dd>
          </dl>
        </>
      )}
      <div className="section-title">Track record on this chart</div>
      <p className="px-3 text-[12px]" style={{ color: TRUST_COLOR[r.trust] }}>
        {r.verdict}
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 px-3 pt-1 text-[12px]">
        <dt className="text-dim">Forecasts scored</dt>
        <dd className="m-0 text-right tabular-nums">{String(v.scored)}</dd>
        <dt className="text-dim">Closed inside 80% / 50% range</dt>
        <dd className="m-0 text-right tabular-nums">
          {share(v.cover80)} / {share(v.cover50)}
        </dd>
        <dt className="text-dim" title="When the cases leaned, how often price closed that way">Lean calls right</dt>
        <dd className="m-0 text-right tabular-nums">{num(v.calls) ? `${share(v.callHitRate)} of ${String(v.calls)}` : '—'}</dd>
      </dl>
      <p className="px-3 pt-1 text-[10px] text-faint">
        Every forecast is scored against the close that came {String(v.horizon)} bars after it was made, so the record is out of sample. Forecasts on neighbouring bars overlap, so the count overstates the independent evidence. A range of past outcomes, not advice.
      </p>
    </div>
  );
}

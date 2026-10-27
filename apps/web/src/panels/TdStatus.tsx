import type { Interval } from '@meridian/data';
import type { EventStudyResult, StudyStatus } from '@meridian/engine';
import { useQuery } from '@tanstack/react-query';
import { chartActions } from '../chart/bus';
import { Chip } from '../components/ui';
import { getBarsCached } from '../data/useBars';
import { compute } from '../engine/compute';
import { fmtPct, fmtPrice } from '../lib/format';
import { useWorkspace } from '../state/store';
import { useActive, useStatus } from './hooks';

const TFS: Interval[] = ['1D', '1W', '1M'];

function TfRow({ symbol, tf }: { symbol: string; tf: Interval }) {
  const q = useStatus(symbol, tf);
  const go = (t?: number) => {
    const ws = useWorkspace.getState();
    ws.setInterval(ws.activePaneId, tf);
    if (t) setTimeout(() => chartActions.get(ws.activePaneId)?.goTo(t), 900);
  };
  const chips: StudyStatus['chips'] = [];
  for (const r of q.data?.res ?? []) chips.push(...(r.status?.chips ?? []));
  const lastSig = (q.data?.res ?? []).flatMap((r) => r.signals).filter((s) => /SETUP_9|CD_13|COMBO_(BUY|SELL)_13/.test(s.id)).sort((a, b) => b.i - a.i)[0];
  const bars = q.data?.bars ?? [];
  return (
    <div className="flex items-start gap-2 border-b border-border/60 px-3 py-1.5">
      <button className="w-6 shrink-0 font-semibold text-dim hover:text-accent" onClick={() => go()} title={`Open ${tf}`}>
        {tf.replace('1', '')}
      </button>
      <div className="flex flex-1 flex-wrap gap-1">
        {q.isLoading && <span className="text-faint">…</span>}
        {q.isError && <span className="text-[11px] text-warn">unavailable</span>}
        {chips.map((c, k) => (
          <Chip key={k} text={c.text} dir={c.dir} strength={c.strength} onClick={() => go(lastSig ? bars[lastSig.i]?.t : undefined)} title="Open the chart at this timeframe" />
        ))}
        {!q.isLoading && !chips.length && !q.isError && <span className="text-faint">no active count</span>}
      </div>
      {lastSig && (
        <button className="shrink-0 text-right text-[10px] text-faint hover:text-text" onClick={() => go(bars[lastSig.i]?.t)} title="Jump to bar">
          {lastSig.id.replace(/_/g, ' ').replace('SEQ ', '')}
          <br />
          {bars.length - 1 - lastSig.i} bars ago
        </button>
      )}
    </div>
  );
}

const STAT_SIGNALS: { study: string; ids: string[]; label: string }[] = [
  { study: 'td-sequential', ids: ['SEQ_BUY_SETUP_9'], label: 'Seq buy 9' },
  { study: 'td-sequential', ids: ['SEQ_SELL_SETUP_9'], label: 'Seq sell 9' },
  { study: 'td-sequential', ids: ['SEQ_BUY_CD_13'], label: 'Seq buy 13' },
  { study: 'td-sequential', ids: ['SEQ_SELL_CD_13'], label: 'Seq sell 13' },
  { study: 'td-combo', ids: ['COMBO_BUY_13'], label: 'Combo buy 13' },
  { study: 'td-combo', ids: ['COMBO_SELL_13'], label: 'Combo sell 13' },
];

function SignalStats({ symbol, tf }: { symbol: string; tf: Interval }) {
  const q = useQuery({
    queryKey: ['sigstats', symbol, tf],
    queryFn: async () => {
      const bars = (await getBarsCached(symbol, tf, 5000)).filter((b) => b.final !== false);
      const out: { label: string; r: EventStudyResult }[] = [];
      for (const s of STAT_SIGNALS) {
        const ev = await compute<{ events: { i: number; dir: 'bull' | 'bear' | 'neutral' }[] }>({ op: 'events', bars, study: s.study, signals: s.ids });
        out.push({ label: s.label, r: await compute<EventStudyResult>({ op: 'eventStudy', bars, events: ev.events, horizons: [20], seed: 7, samples: 400 }) });
      }
      return { out, n: bars.length };
    },
    staleTime: 600_000,
    retry: 0,
  });
  return (
    <div className="px-3 pb-3">
      <div className="section-title px-0">{tf === '1D' ? 'Daily' : 'Weekly'} signal statistics · next 20 bars</div>
      {q.isLoading && <p className="text-faint">computing…</p>}
      {q.data && (
        <table className="table">
          <thead>
            <tr>
              <th>Signal</th>
              <th className="text-right">n</th>
              <th className="text-right">Median</th>
              <th className="text-right">Hit</th>
              <th className="text-right" title="Mean minus random-entry baseline">Edge</th>
            </tr>
          </thead>
          <tbody>
            {q.data.out.map(({ label, r }) => {
              const h = r.horizons[0];
              return (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="text-right">{h.n}</td>
                  <td className="text-right">{h.n ? fmtPct(h.median) : '—'}</td>
                  <td className="text-right">{h.n ? `${Math.round(h.hitRate * 100)}%` : '—'}</td>
                  <td className="text-right" style={{ color: (h.edge ?? 0) >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{h.n && h.edge !== null ? fmtPct(h.edge) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {q.data && <p className="mt-1 text-[10px] text-faint">Directional returns (sell signals measured short) over {q.data.n} bars. Small samples are noisy — this is descriptive, not predictive.</p>}
    </div>
  );
}

export function TdStatusPanel() {
  const { pane, rt } = useActive();
  const seq = rt.results.find((r) => pane.studies.find((s) => s.uid === r.id)?.id === 'td-sequential');
  const v = (seq?.status?.values ?? {}) as Record<string, number | null>;
  const levels: [string, number | null | undefined, string][] = [
    ['TDST resistance', v.tdstResistance, 'bear'],
    ['TDST support', v.tdstSupport, 'bull'],
    ['Buy setup risk', v.buyRisk, 'bull'],
    ['Sell setup risk', v.sellRisk, 'bear'],
  ];
  return (
    <div className="panel-body">
      <div className="section-title">{pane.symbol} · DeMark-style status</div>
      {TFS.map((tf) => (
        <TfRow key={tf} symbol={pane.symbol} tf={tf} />
      ))}
      <div className="section-title">Active chart ({pane.interval}) levels</div>
      {seq ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 px-3 text-[12px]">
          {levels.map(([k, val, d]) => (
            <div key={k} className="contents">
              <dt className="text-dim">{k}</dt>
              <dd className="m-0 text-right tabular-nums" style={{ color: val ? (d === 'bull' ? 'var(--ok)' : 'var(--danger)') : undefined }}>{val ? fmtPrice(val) : '—'}</dd>
            </div>
          ))}
          <dt className="text-dim">Setup (buy / sell)</dt>
          <dd className="m-0 text-right">{v.buySetup ?? 0} / {v.sellSetup ?? 0}</dd>
          <dt className="text-dim">Countdown (buy / sell)</dt>
          <dd className="m-0 text-right">{v.buyCountdown ?? '—'} / {v.sellCountdown ?? '—'}</dd>
        </dl>
      ) : (
        <p className="px-3 text-faint">Add DeMark-style Sequential to the chart to see its live levels.</p>
      )}
      <SignalStats symbol={pane.symbol} tf="1D" />
      <SignalStats symbol={pane.symbol} tf="1W" />
    </div>
  );
}

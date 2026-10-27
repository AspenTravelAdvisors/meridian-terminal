import { isIntraday } from '@meridian/data';
import { type InspectRow, getStudy } from '@meridian/engine';
import { CheckCircle2, Copy, Eye, EyeOff, Lock, MoveDown, MoveUp, Settings2, Trash2, Unlock, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { inspectors } from '../chart/ChartPane';
import { TOOL_LABELS } from '../chart/drawings';
import { Empty } from '../components/ui';
import { getBarsCached } from '../data/useBars';
import { fmtPct, fmtPrice, fmtTime, fmtVol, signalLabel } from '../lib/format';
import { useDrawings, useUi, useWorkspace } from '../state/store';
import { useActive } from './hooks';

export function SymbolDetailsPanel() {
  const { pane, rt } = useActive();
  const [daily, setDaily] = useState<{ hi52: number; lo52: number; avgVol: number; ytd: number | null } | null>(null);
  useEffect(() => {
    let dead = false;
    setDaily(null);
    getBarsCached(pane.symbol, '1D', 400)
      .then((b) => {
        if (dead || !b.length) return;
        const yr = b.slice(-252);
        const y0 = b.find((x) => new Date(x.t).getUTCFullYear() === new Date(b[b.length - 1].t).getUTCFullYear());
        setDaily({ hi52: Math.max(...yr.map((x) => x.h)), lo52: Math.min(...yr.map((x) => x.l)), avgVol: yr.slice(-30).reduce((a, x) => a + x.v, 0) / Math.min(30, yr.length), ytd: y0 ? (100 * (b[b.length - 1].c - y0.o)) / y0.o : null });
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [pane.symbol]);
  const last = rt.bars[rt.bars.length - 1];
  const prev = rt.bars[rt.bars.length - 2];
  const info = rt.info;
  const rows: [string, React.ReactNode][] = [
    ['Name', info?.name ?? '—'],
    ['Exchange', info?.exchange ?? '—'],
    ['Type', info?.type === 'sim' ? 'simulated' : (info?.type ?? '—')],
    ['Currency', info?.currency ?? '—'],
    ['Session', info ? `${info.calendar} · ${info.timezone}` : '—'],
    ['Last', last ? <span className="font-semibold">{fmtPrice(last.c)}</span> : '—'],
    ['Change', last && prev ? <span style={{ color: last.c >= prev.c ? 'var(--ok)' : 'var(--danger)' }}>{fmtPrice(last.c - prev.c)} ({fmtPct((100 * (last.c - prev.c)) / prev.c)})</span> : '—'],
    ['Bar range', last ? `${fmtPrice(last.l)} – ${fmtPrice(last.h)}` : '—'],
    ['52-week range', daily ? `${fmtPrice(daily.lo52)} – ${fmtPrice(daily.hi52)}` : '…'],
    ['YTD', daily?.ytd !== null && daily ? fmtPct(daily.ytd) : '…'],
    ['Avg volume (30d)', daily ? fmtVol(daily.avgVol) : '…'],
    ['Data', `${rt.provider ?? '—'}${rt.simulated ? ' (simulated)' : ''}`],
    ['Live', rt.live],
    ['Bars loaded', rt.bars.length.toLocaleString()],
  ];
  return (
    <div className="panel-body p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[15px] font-semibold">{pane.symbol}</span>
        {rt.simulated && <span className="chip bg-warn/20 text-warn">SIMULATED</span>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-dim">{k}</dt>
            <dd className="m-0 truncate text-right tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {rt.fallbacks?.length ? <p className="mt-3 text-[11px] text-faint">Provider fallbacks: {rt.fallbacks.join(' · ')}</p> : null}
      {rt.error && <p className="mt-2 text-[11px] text-warn">{rt.error}</p>}
    </div>
  );
}

export function DataWindowPanel() {
  const { pane, rt } = useActive();
  const i = rt.crosshairI ?? rt.bars.length - 1;
  const b = rt.bars[i];
  if (!b) return <Empty title="No data" />;
  const tz = rt.info?.timezone;
  const signals = rt.results.flatMap((r) => r.signals.filter((s) => s.i === i).map((s) => ({ ...s, study: r.id })));
  return (
    <div className="panel-body p-2">
      <div className="mb-1 px-1 text-[11px] text-dim">{fmtTime(b.t, isIntraday(pane.interval), tz)} {b.final === false && <span className="text-warn">· forming</span>}</div>
      <table className="table">
        <tbody>
          {(
            [
              ['Open', fmtPrice(b.o)],
              ['High', fmtPrice(b.h)],
              ['Low', fmtPrice(b.l)],
              ['Close', fmtPrice(b.c)],
              ['Volume', fmtVol(b.v)],
            ] as const
          ).map(([k, v]) => (
            <tr key={k}>
              <td className="text-dim">{k}</td>
              <td className="text-right">{v}</td>
            </tr>
          ))}
          {pane.studies.map((s) => {
            const r = rt.results.find((x) => x.id === s.uid);
            const def = getStudy(s.id);
            if (!r || !def) return null;
            const outs = r.outputs.filter((o) => o.kind === 'line' || o.kind === 'histogram' || o.kind === 'data');
            return outs.map((o, k) => {
              const v = r.lines[o.id]?.[i];
              if (v === undefined || !Number.isFinite(v)) return null;
              return (
                <tr key={`${s.uid}-${o.id}`}>
                  <td className="text-dim">{k === 0 ? <b className="font-medium text-text">{def.shortName} </b> : null}{o.title}</td>
                  <td className="text-right">{o.kind === 'data' ? v : s.id === 'volume' ? fmtVol(Math.abs(v)) : fmtPrice(v)}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
      {signals.length > 0 && (
        <div className="mt-2 px-1">
          <div className="section-title px-0">Signals on this bar</div>
          {signals.map((s, k) => (
            <div key={k} className="flex justify-between py-0.5">
              <span style={{ color: s.dir === 'bull' ? 'var(--ok)' : s.dir === 'bear' ? 'var(--danger)' : undefined }}>{signalLabel(s.id)}</span>
              {s.label && <span className="text-faint">{s.label}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ObjectTreePanel() {
  const { pane } = useActive();
  const ws = useWorkspace();
  const drawings = useDrawings((s) => s.bySymbol[pane.symbol]) ?? [];
  const dr = useDrawings.getState();
  const selected = useUi((s) => s.selectedDrawing);
  const sorted = drawings.slice().sort((a, b) => b.z - a.z);
  return (
    <div className="panel-body">
      <div className="section-title">Studies · {pane.symbol} {pane.interval}</div>
      <ul>
        {pane.studies.map((s) => {
          const def = getStudy(s.id);
          return (
            <li key={s.uid} className="flex items-center gap-1 px-3 py-1 hover:bg-raised/60">
              <span className={`flex-1 truncate ${s.visible ? '' : 'text-faint line-through'}`}>{def?.name ?? 'Script'}</span>
              <button className="icon-btn" aria-label="Toggle visibility" onClick={() => ws.updateStudy(pane.id, s.uid, { visible: !s.visible })}>{s.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}</button>
              {def && <button className="icon-btn" aria-label="Settings" onClick={() => useUi.getState().set({ studySettings: { paneId: pane.id, uid: s.uid } })}><Settings2 className="size-3.5" /></button>}
              <button className="icon-btn" aria-label="Remove" onClick={() => ws.removeStudy(pane.id, s.uid)}><Trash2 className="size-3.5" /></button>
            </li>
          );
        })}
        {!pane.studies.length && <li className="px-3 py-1 text-faint">No studies</li>}
      </ul>
      <div className="section-title">Drawings · {pane.symbol}</div>
      <ul>
        {sorted.map((d) => (
          <li key={d.id} className={`flex items-center gap-1 px-3 py-1 hover:bg-raised/60 ${selected === d.id ? 'bg-raised' : ''}`}>
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
            <button className={`flex-1 truncate text-left ${d.hidden ? 'text-faint' : ''}`} onClick={() => useUi.getState().set({ selectedDrawing: d.id })}>
              {TOOL_LABELS[d.type]}{d.text ? ` — ${d.text.slice(0, 20)}` : ''}
            </button>
            <input type="color" className="h-5 w-6 cursor-pointer border-0 bg-transparent" value={d.color.startsWith('#') ? d.color : '#38bdf8'} onChange={(e) => dr.update(pane.symbol, d.id, { color: e.target.value })} aria-label="Colour" />
            <button className="icon-btn" aria-label="Bring forward" onClick={() => dr.update(pane.symbol, d.id, { z: d.z + 1.5 })}><MoveUp className="size-3.5" /></button>
            <button className="icon-btn" aria-label="Send backward" onClick={() => dr.update(pane.symbol, d.id, { z: d.z - 1.5 })}><MoveDown className="size-3.5" /></button>
            <button className="icon-btn" aria-label={d.hidden ? 'Show' : 'Hide'} onClick={() => dr.update(pane.symbol, d.id, { hidden: !d.hidden })}>{d.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</button>
            <button className="icon-btn" aria-label={d.locked ? 'Unlock' : 'Lock'} onClick={() => dr.update(pane.symbol, d.id, { locked: !d.locked })}>{d.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}</button>
            <button className="icon-btn" aria-label="Clone" onClick={() => dr.add(pane.symbol, { ...d, points: d.points.map((p) => ({ t: p.t, p: p.p * 1.01 })) })}><Copy className="size-3.5" /></button>
            <button className="icon-btn" aria-label="Delete" onClick={() => dr.remove(pane.symbol, d.id)}><Trash2 className="size-3.5" /></button>
          </li>
        ))}
        {!sorted.length && <li className="px-3 py-1 text-faint">No drawings — use the toolbar on the left (Alt+T trend line).</li>}
      </ul>
      {selected && (() => {
        const d = drawings.find((x) => x.id === selected);
        if (!d) return null;
        return (
          <div className="m-3 rounded-md border border-border p-2">
            <div className="label mb-1">Selected: {TOOL_LABELS[d.type]}</div>
            <div className="flex flex-wrap gap-2">
              <select className="input h-6" value={d.width} onChange={(e) => dr.update(pane.symbol, d.id, { width: Number(e.target.value) })} aria-label="Width">
                {[1, 1.5, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
              </select>
              <select className="input h-6" value={d.dash} onChange={(e) => dr.update(pane.symbol, d.id, { dash: e.target.value as typeof d.dash })} aria-label="Line style">
                <option value="solid">solid</option>
                <option value="dashed">dashed</option>
                <option value="dotted">dotted</option>
              </select>
              {(d.type === 'text' || d.type === 'pricelabel' || d.type === 'rect') && <input className="input h-6 flex-1" placeholder="Text" value={d.text ?? ''} onChange={(e) => dr.update(pane.symbol, d.id, { text: e.target.value }, false)} onBlur={(e) => dr.update(pane.symbol, d.id, { text: e.target.value })} aria-label="Text" />}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export function RuleInspectorPanel() {
  const { pane, rt } = useActive();
  const [rows, setRows] = useState<InspectRow[]>([]);
  const [at, setAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const i = rt.crosshairI ?? rt.bars.length - 1;
  const hasDemark = pane.studies.some((s) => ['DeMark', 'Meridian', 'Ichimoku'].includes(getStudy(s.id)?.category ?? ''));
  useEffect(() => {
    if (i < 0 || !hasDemark) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const f = inspectors.get(pane.id);
      if (!f) return;
      setRows(await f(i));
      setAt(i);
    }, 160);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [i, pane.id, hasDemark, rt.results]);
  const grouped = useMemo(() => {
    const m = new Map<string, InspectRow[]>();
    for (const r of rows) m.set(r.study, [...(m.get(r.study) ?? []), r]);
    return m;
  }, [rows]);
  if (!hasDemark) return <Empty title="No DeMark-style study on this chart">Add Sequential, Combo, DeMarker or Range Projection to see which rule conditions pass or fail on each bar.</Empty>;
  const b = at !== null ? rt.bars[at] : undefined;
  return (
    <div className="panel-body p-2">
      <p className="mb-2 px-1 text-[11px] text-dim">Hover a bar to see every rule condition evaluated on it. {b && <b className="text-text">{fmtTime(b.t, isIntraday(pane.interval), rt.info?.timezone)}</b>}</p>
      {[...grouped.entries()].map(([study, rs]) => {
        const cfg = pane.studies.find((s) => s.uid === study);
        return (
          <div key={study} className="mb-2">
            <div className="section-title px-1">{getStudy(cfg?.id ?? '')?.name ?? study}</div>
            <ul>
              {rs.map((r, k) => (
                <li key={k} className="flex items-start gap-1.5 px-1 py-0.5">
                  {r.pass ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" aria-label="pass" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-faint" aria-label="fail" />}
                  <span className={r.pass ? '' : 'text-dim'}>{r.rule}</span>
                  {r.detail && <span className="ml-auto shrink-0 text-right text-[11px] text-faint">{r.detail}</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {!rows.length && <p className="px-1 text-faint">Evaluating…</p>}
    </div>
  );
}

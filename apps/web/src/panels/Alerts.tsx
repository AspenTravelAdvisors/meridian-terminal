import { INTERVALS, type Interval } from '@meridian/data';
import { getStudy } from '@meridian/engine';
import { Bell, BellOff, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Field, Switch } from '../components/ui';
import { getBarsCached } from '../data/useBars';
import { compute } from '../engine/compute';
import { postJson } from '../lib/api';
import { fmtPrice, signalLabel } from '../lib/format';
import { useAlerts, useDrawings, useUi } from '../state/store';
import type { Alert, AlertCondition } from '../state/types';
import { useActive } from './hooks';

type Kind = AlertCondition['kind'];

export function AlertsPanel() {
  const { pane, rt } = useActive();
  const { alerts, add, update, remove } = useAlerts();
  const drawings = useDrawings((s) => s.bySymbol[pane.symbol]) ?? [];
  const [kind, setKind] = useState<Kind>('signal');
  const paneStudies = pane.studies.filter((s) => getStudy(s.id)?.signals?.length);
  const [studyUid, setStudyUid] = useState(paneStudies[0]?.uid ?? '');
  const studyCfg = pane.studies.find((s) => s.uid === studyUid);
  const sigs = useMemo(() => getStudy(studyCfg?.id ?? '')?.signals ?? [], [studyCfg?.id]);
  const [signal, setSignal] = useState('');
  const [op, setOp] = useState<'crosses_above' | 'crosses_below' | 'above' | 'below'>('crosses_above');
  const last = rt.bars[rt.bars.length - 1]?.c;
  const [value, setValue] = useState<string>('');
  const [output, setOutput] = useState('');
  const [drawingId, setDrawingId] = useState('');
  const [mode, setMode] = useState<Alert['mode']>('every_bar');
  const [timing, setTiming] = useState<Alert['timing']>('close');
  const [browser, setBrowser] = useState(false);
  const [webhook, setWebhook] = useState('');
  const [email, setEmail] = useState('');
  const [expires, setExpires] = useState('');
  const [interval, setIv] = useState<Interval>(pane.interval);
  useEffect(() => setIv(pane.interval), [pane.interval]);
  useEffect(() => {
    if (!signal && sigs[0]) setSignal(sigs[0].id);
  }, [sigs, signal]);
  const outputs = useMemo(() => (studyCfg ? getStudy(studyCfg.id)?.outputs(studyCfg.cfg).filter((o) => o.kind === 'line' || o.kind === 'histogram' || o.kind === 'data') ?? [] : []), [studyCfg]);

  const create = () => {
    let condition: AlertCondition;
    let name: string;
    if (kind === 'signal') {
      if (!studyCfg || !signal) return;
      condition = { kind, study: studyCfg.id, signal };
      name = `${pane.symbol} ${interval}: ${signalLabel(signal)}`;
    } else if (kind === 'price') {
      const v = Number(value || last);
      condition = { kind, op, value: v };
      name = `${pane.symbol} ${op.replace('_', ' ')} ${fmtPrice(v)}`;
    } else if (kind === 'study') {
      if (!studyCfg || !output) return;
      condition = { kind, study: studyCfg.id, output, op: op === 'above' ? 'crosses_above' : op === 'below' ? 'crosses_below' : op, value: Number(value || 0) };
      name = `${pane.symbol} ${getStudy(studyCfg.id)?.shortName}.${output} ${op.replace('_', ' ')} ${value || 0}`;
    } else {
      if (!drawingId) return;
      condition = { kind, drawingId, op: op === 'above' ? 'crosses_above' : op === 'below' ? 'crosses_below' : op };
      name = `${pane.symbol}: price ${op.replace('_', ' ')} drawing`;
    }
    add({ name, symbol: pane.symbol, interval, condition, studyCfg: studyCfg?.cfg, mode, timing, expires: expires ? Date.parse(expires) : undefined, channels: { app: true, browser, webhook: webhook || undefined, email: email || undefined } });
    if (browser && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    useUi.getState().toast({ title: 'Alert created', body: name, tone: 'ok' });
  };

  return (
    <div className="panel-body">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex gap-1">
          {(['signal', 'price', 'study', 'drawing'] as Kind[]).map((k) => (
            <button key={k} className="btn-ghost h-6 capitalize" data-active={kind === k} onClick={() => setKind(k)}>
              {k}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Symbol">
            <input className="input" value={pane.symbol} readOnly aria-label="Alert symbol" />
          </Field>
          <Field label="Interval">
            <select className="input" value={interval} onChange={(e) => setIv(e.target.value as Interval)}>
              {INTERVALS.map((iv) => <option key={iv}>{iv}</option>)}
            </select>
          </Field>
          {(kind === 'signal' || kind === 'study') && (
            <Field label="Study (from this chart)">
              <select className="input" value={studyUid} onChange={(e) => (setStudyUid(e.target.value), setSignal(''), setOutput(''))}>
                {(kind === 'signal' ? paneStudies : pane.studies.filter((s) => getStudy(s.id))).map((s) => (
                  <option key={s.uid} value={s.uid}>{getStudy(s.id)?.name}</option>
                ))}
              </select>
            </Field>
          )}
          {kind === 'signal' && (
            <Field label="Signal">
              <select className="input" value={signal} onChange={(e) => setSignal(e.target.value)}>
                {sigs.map((s) => <option key={s.id} value={s.id} title={s.description}>{signalLabel(s.id)}</option>)}
              </select>
            </Field>
          )}
          {kind === 'study' && (
            <Field label="Output">
              <select className="input" value={output} onChange={(e) => setOutput(e.target.value)}>
                <option value="">—</option>
                {outputs.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
              </select>
            </Field>
          )}
          {kind === 'drawing' && (
            <Field label="Drawing (horizontal / trend line)">
              <select className="input" value={drawingId} onChange={(e) => setDrawingId(e.target.value)}>
                <option value="">—</option>
                {drawings.filter((d) => ['hline', 'hray', 'trendline', 'ray', 'extended'].includes(d.type)).map((d) => (
                  <option key={d.id} value={d.id}>{d.type} @ {fmtPrice(d.points[0].p)}</option>
                ))}
              </select>
            </Field>
          )}
          {kind !== 'signal' && (
            <Field label="Condition">
              <select className="input" value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
                <option value="crosses_above">crosses above</option>
                <option value="crosses_below">crosses below</option>
                {kind === 'price' && <option value="above">is above</option>}
                {kind === 'price' && <option value="below">is below</option>}
              </select>
            </Field>
          )}
          {(kind === 'price' || kind === 'study') && (
            <Field label="Value">
              <input className="input" type="number" step="any" placeholder={last ? fmtPrice(last) : ''} value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          )}
          <Field label="Frequency">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as Alert['mode'])}>
              <option value="every_bar">Once per bar</option>
              <option value="once">Only once</option>
            </select>
          </Field>
          <Field label="Evaluate on">
            <select className="input" value={timing} onChange={(e) => setTiming(e.target.value as Alert['timing'])}>
              <option value="close">Bar close (final)</option>
              <option value="intrabar">Intrabar (provisional)</option>
            </select>
          </Field>
          <Field label="Expires">
            <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Switch checked={browser} onChange={setBrowser} label="Browser notification" />
          </div>
          <Field label="Webhook URL (optional)">
            <input className="input" placeholder="https://hooks.example.com/…" value={webhook} onChange={(e) => setWebhook(e.target.value)} />
          </Field>
          <Field label="E-mail (optional, server-configured)">
            <input className="input" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <button className="btn btn-primary self-start" onClick={create}>
          <Bell className="size-3.5" /> Create alert
        </button>
        <p className="text-[10px] text-faint">Alerts are evaluated in this browser while Meridian is open (every 30–60 s); webhook and e-mail delivery go through the server relay.</p>
      </div>
      <div className="section-title">Active alerts ({alerts.length})</div>
      {!alerts.length && <Empty title="No alerts yet" />}
      <ul>
        {alerts.map((a) => (
          <li key={a.id} className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
            <button className="icon-btn" aria-label={a.enabled ? 'Pause alert' : 'Resume alert'} onClick={() => update(a.id, { enabled: !a.enabled })}>
              {a.enabled ? <Bell className="size-3.5 text-accent" /> : <BellOff className="size-3.5" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className={`truncate ${a.enabled ? '' : 'text-faint'}`}>{a.name}</div>
              <div className="text-[10px] text-faint">
                {a.mode === 'once' ? 'once' : 'per bar'} · {a.timing} {a.lastFiredAt ? `· last ${new Date(a.lastFiredAt).toLocaleString()}` : ''} {a.lastError ? `· ⚠ ${a.lastError}` : ''}
              </div>
            </div>
            <button className="icon-btn" aria-label="Rename" onClick={() => { const n = prompt('Alert name', a.name); if (n) update(a.id, { name: n }); }}><Pencil className="size-3.5" /></button>
            <button className="icon-btn" aria-label="Delete alert" onClick={() => remove(a.id)}><Trash2 className="size-3.5" /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AlertLogPanel() {
  const { log, clearLog } = useAlerts();
  return (
    <div className="panel-body flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-dim">{log.length} events</span>
        <button className="btn h-6" onClick={clearLog} disabled={!log.length}>Clear</button>
      </div>
      {!log.length ? (
        <Empty title="No alerts fired yet" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="table">
            <thead>
              <tr><th>Time</th><th>Alert</th><th>Message</th><th>Bar</th><th>Delivered</th></tr>
            </thead>
            <tbody>
              {log.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{new Date(e.at).toLocaleString()}</td>
                  <td>{e.name}</td>
                  <td>{e.message}{e.provisional && <span className="ml-1 text-warn">(provisional)</span>}</td>
                  <td className="whitespace-nowrap">{new Date(e.barT).toISOString().slice(0, 16).replace('T', ' ')}</td>
                  <td>{e.delivered.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Alert manager: periodic evaluation + delivery ───────────────────────────
async function evaluate(a: Alert): Promise<{ fired: boolean; barT: number; message: string; provisional: boolean } | null> {
  const all = await getBarsCached(a.symbol, a.interval, 500, 20_000);
  const bars = a.timing === 'close' ? all.filter((b) => b.final !== false) : all;
  const n = bars.length;
  if (n < 3) return null;
  const lastBar = bars[n - 1];
  const provisional = lastBar.final === false;
  const c = a.condition;
  const cross = (p0: number, p1: number, v0: number, v1: number, o: string) => (o === 'crosses_above' ? p0 <= v0 && p1 > v1 : o === 'crosses_below' ? p0 >= v0 && p1 < v1 : o === 'above' ? p1 > v1 : p1 < v1);
  if (c.kind === 'price') {
    const hit = cross(bars[n - 2].c, lastBar.c, c.value, c.value, c.op);
    return { fired: hit, barT: lastBar.t, message: `close ${fmtPrice(lastBar.c)} ${c.op.replace('_', ' ')} ${fmtPrice(c.value)}`, provisional };
  }
  if (c.kind === 'drawing') {
    const d = (useDrawings.getState().bySymbol[a.symbol] ?? []).find((x) => x.id === c.drawingId);
    if (!d) throw new Error('drawing was deleted');
    const at = (t: number) => {
      if (d.type === 'hline' || d.type === 'hray' || d.points.length < 2) return d.points[0].p;
      const [p, q] = d.points;
      return p.p + ((q.p - p.p) * (t - p.t)) / (q.t - p.t || 1);
    };
    const hit = cross(bars[n - 2].c, lastBar.c, at(bars[n - 2].t), at(lastBar.t), c.op);
    return { fired: hit, barT: lastBar.t, message: `close ${fmtPrice(lastBar.c)} ${c.op.replace('_', ' ')} drawing ${fmtPrice(at(lastBar.t))}`, provisional };
  }
  const res = await compute<{ key: string; signals: { i: number; id: string }[]; last: Record<string, [number, number]> }[]>({ op: 'evaluate', bars, studies: [{ key: 'a', id: c.study, cfg: a.studyCfg }] });
  const r = res[0];
  if (!r) return null;
  if (c.kind === 'signal') {
    const s = r.signals.find((x) => x.id === c.signal && x.i === n - 1);
    return { fired: !!s, barT: lastBar.t, message: signalLabel(c.signal), provisional };
  }
  const [v0, v1] = r.last[c.output] ?? [NaN, NaN];
  return { fired: Number.isFinite(v0) && Number.isFinite(v1) && cross(v0, v1, c.value, c.value, c.op), barT: lastBar.t, message: `${getStudy(c.study)?.shortName}.${c.output} = ${fmtPrice(v1)} ${c.op.replace('_', ' ')} ${c.value}`, provisional };
}

async function deliver(a: Alert, msg: string, barT: number, provisional: boolean) {
  const delivered = ['app'];
  useUi.getState().toast({ title: `🔔 ${a.name}`, body: msg, tone: 'warn' });
  if (a.channels.browser && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(a.name, { body: msg, tag: a.id, icon: '/favicon.svg' });
      else new Notification(a.name, { body: msg, tag: a.id, icon: '/favicon.svg' });
      delivered.push('browser');
    } catch {
      /* notifications blocked */
    }
  }
  const payload = { alert: a.name, symbol: a.symbol, interval: a.interval, message: msg, barTime: new Date(barT).toISOString(), provisional, source: 'Meridian Terminal', text: `${a.name}: ${msg}` };
  if (a.channels.webhook)
    try {
      await postJson('/api/notify', { channel: 'webhook', url: a.channels.webhook, payload });
      delivered.push('webhook');
    } catch (e) {
      useAlerts.getState().update(a.id, { lastError: `webhook: ${(e as Error).message}` });
    }
  if (a.channels.email)
    try {
      await postJson('/api/notify', { channel: 'email', to: a.channels.email, subject: `Meridian alert: ${a.name}`, text: `${msg}\n\nBar: ${new Date(barT).toISOString()}${provisional ? ' (provisional)' : ''}\n\nInformational only — not investment advice.` });
      delivered.push('email');
    } catch (e) {
      useAlerts.getState().update(a.id, { lastError: `email: ${(e as Error).message}` });
    }
  useAlerts.getState().pushLog({ alertId: a.id, name: a.name, symbol: a.symbol, interval: a.interval, at: Date.now(), barT, message: msg, provisional, delivered });
}

export function useAlertManager() {
  const running = useRef(false);
  useEffect(() => {
    const tick = async () => {
      if (running.current) return;
      running.current = true;
      try {
        const now = Date.now();
        for (const a of useAlerts.getState().alerts) {
          if (!a.enabled) continue;
          if (a.expires && a.expires < now) {
            useAlerts.getState().update(a.id, { enabled: false, lastError: 'expired' });
            continue;
          }
          try {
            const r = await evaluate(a);
            if (r?.fired && r.barT !== a.lastFiredBar) {
              useAlerts.getState().update(a.id, { lastFiredBar: r.barT, lastFiredAt: now, lastError: undefined, ...(a.mode === 'once' ? { enabled: false } : {}) });
              await deliver(a, r.message, r.barT, r.provisional);
            }
          } catch (e) {
            useAlerts.getState().update(a.id, { lastError: (e as Error).message });
          }
        }
      } finally {
        running.current = false;
      }
    };
    const t = setInterval(tick, 30_000);
    const first = setTimeout(tick, 4000);
    return () => (clearInterval(t), clearTimeout(first));
  }, []);
}


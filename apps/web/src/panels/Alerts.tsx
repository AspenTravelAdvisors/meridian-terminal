import { INTERVALS, type Interval } from '@meridian/data';
import { ALERT_DRAWING_TYPES, type AlertContext, type AlertHit, alertBars, alertPayload, getStudy, shouldFire } from '@meridian/engine';
import { Bell, BellOff, Cloud, CloudOff, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { openPanel } from '../components/panels';
import { Empty, Field, Switch } from '../components/ui';
import { getBarsCached } from '../data/useBars';
import { compute } from '../engine/compute';
import { runScriptSandboxed } from '../engine/script';
import { alertActivity } from '../lib/account';
import { postJson } from '../lib/api';
import { fmtPrice, signalLabel } from '../lib/format';
import { useAccount } from '../state/account';
import { useAlerts, useDrawings, useScripts, useUi } from '../state/store';
import type { Alert, AlertCondition } from '../state/types';
import { useActive } from './hooks';

type Kind = AlertCondition['kind'];
const KINDS: Kind[] = ['signal', 'price', 'study', 'drawing', 'script'];

/** The server scheduler counts as running when it has checked alerts in the last few minutes. */
export const SERVER_FRESH_MS = 3 * 60_000;
const serverLive = (lastRunAt?: number) => !!lastRunAt && Date.now() - lastRunAt < SERVER_FRESH_MS;

function since(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172_800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`;
}

/** Where alerts are being checked right now, in one line. */
function WhereAlertsRun() {
  const { status, scheduler } = useAccount();
  if (status !== 'signed-in')
    return (
      <p className="flex items-start gap-1.5 text-[10px] text-faint">
        <CloudOff className="mt-px size-3 shrink-0" />
        <span>
          Checked in this browser while Meridian is open (every 30 s).{' '}
          {status !== 'unavailable' && (
            <button className="text-accent underline" onClick={() => openPanel('account')}>
              Sign in
            </button>
          )}{' '}
          {status !== 'unavailable' && 'to have them checked and pushed to your devices with Meridian closed.'}
        </span>
      </p>
    );
  const live = serverLive(scheduler?.lastRunAt);
  return (
    <p className="flex items-start gap-1.5 text-[10px] text-faint">
      <Cloud className={`mt-px size-3 shrink-0 ${live ? 'text-ok' : ''}`} />
      <span>
        {live
          ? `Checked on the server (last run ${since(scheduler!.lastRunAt)}) and pushed to your devices, even with Meridian closed.`
          : scheduler
            ? `Server last checked ${since(scheduler.lastRunAt)}; until it runs every minute this browser also checks while open. See Account → Background alerts.`
            : 'The server scheduler has not run yet, so this browser checks while open. See Account → Background alerts.'}
      </span>
    </p>
  );
}

export function AlertsPanel() {
  const { pane, rt } = useActive();
  const { alerts, add, update, remove } = useAlerts();
  const scripts = useScripts((s) => s.scripts);
  const drawings = useDrawings((s) => s.bySymbol[pane.symbol]) ?? [];
  const signedIn = useAccount((s) => s.status === 'signed-in');
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
  const [scriptId, setScriptId] = useState(scripts[0]?.id ?? '');
  const [scriptSignals, setScriptSignals] = useState<string[]>([]);
  const [scriptSignal, setScriptSignal] = useState('');
  const [mode, setMode] = useState<Alert['mode']>('every_bar');
  const [timing, setTiming] = useState<Alert['timing']>('close');
  const [notify, setNotify] = useState(false);
  const [webhook, setWebhook] = useState('');
  const [email, setEmail] = useState('');
  const [expires, setExpires] = useState('');
  const [interval, setIv] = useState<Interval>(pane.interval);
  useEffect(() => setIv(pane.interval), [pane.interval]);
  useEffect(() => {
    if (!signal && sigs[0]) setSignal(sigs[0].id);
  }, [sigs, signal]);
  // the signal ids a script can emit are only known by running it: run it once on this chart's bars
  const script = scripts.find((s) => s.id === scriptId);
  useEffect(() => {
    if (kind !== 'script' || !script || rt.bars.length < 3) return setScriptSignals([]);
    let live = true;
    runScriptSandboxed(script.code, rt.bars, script.inputs).then(({ result }) => {
      if (!live) return;
      const ids = [...new Set(result.signals.map((s) => s.id))];
      setScriptSignals(ids);
      setScriptSignal((cur) => (ids.includes(cur) ? cur : (ids[0] ?? '')));
    });
    return () => {
      live = false;
    };
  }, [kind, script, rt.bars]);
  const outputs = useMemo(() => (studyCfg ? getStudy(studyCfg.id)?.outputs(studyCfg.cfg).filter((o) => o.kind === 'line' || o.kind === 'histogram' || o.kind === 'data') ?? [] : []), [studyCfg]);
  const crossOp = op === 'above' ? 'crosses_above' : op === 'below' ? 'crosses_below' : op;

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
      condition = { kind, study: studyCfg.id, output, op: crossOp, value: Number(value || 0) };
      name = `${pane.symbol} ${getStudy(studyCfg.id)?.shortName}.${output} ${op.replace('_', ' ')} ${value || 0}`;
    } else if (kind === 'drawing') {
      if (!drawingId) return;
      condition = { kind, drawingId, op: crossOp };
      name = `${pane.symbol}: price ${op.replace('_', ' ')} drawing`;
    } else {
      if (!script || !scriptSignal) return;
      condition = { kind, scriptId: script.id, signal: scriptSignal };
      name = `${pane.symbol} ${interval}: ${script.name} · ${signalLabel(scriptSignal)}`;
    }
    add({
      name,
      symbol: pane.symbol,
      interval,
      condition,
      studyCfg: kind === 'signal' || kind === 'study' ? studyCfg?.cfg : undefined,
      mode,
      timing,
      expires: expires ? Date.parse(expires) : undefined,
      channels: { app: true, browser: notify, push: notify, webhook: webhook || undefined, email: email || undefined },
    });
    if (notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    useUi.getState().toast({ title: 'Alert created', body: name, tone: 'ok' });
  };

  return (
    <div className="panel-body">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Alert condition">
          {KINDS.map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className="btn-ghost h-6 capitalize" data-active={kind === k} onClick={() => setKind(k)}>
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
                {drawings.filter((d) => ALERT_DRAWING_TYPES.includes(d.type)).map((d) => (
                  <option key={d.id} value={d.id}>{d.type} @ {fmtPrice(d.points[0].p)}</option>
                ))}
              </select>
            </Field>
          )}
          {kind === 'script' && (
            <>
              <Field label="Meridian Script">
                <select className="input" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
                  {!scripts.length && <option value="">No saved scripts</option>}
                  {scripts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Script signal" hint={script && !scriptSignals.length ? 'This script emitted no signal() on this chart.' : undefined}>
                <select className="input" value={scriptSignal} onChange={(e) => setScriptSignal(e.target.value)}>
                  {scriptSignals.map((id) => <option key={id} value={id}>{signalLabel(id)}</option>)}
                </select>
              </Field>
            </>
          )}
          {(kind === 'price' || kind === 'study' || kind === 'drawing') && (
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
            <Switch checked={notify} onChange={setNotify} label={signedIn ? 'Notify my devices (push)' : 'Browser notification'} />
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
        <WhereAlertsRun />
      </div>
      <div className="section-title">Active alerts ({alerts.length})</div>
      {!alerts.length && <Empty title="No alerts yet" />}
      <ul>
        {alerts.map((a) => (
          <li key={a.id} className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
            <button className="icon-btn" aria-label={a.enabled ? 'Pause alert' : 'Resume alert'} onClick={() => update(a.id, a.enabled ? { enabled: false } : { enabled: true, rearmedAt: Date.now(), lastError: undefined })}>
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
async function evaluate(a: Alert): Promise<AlertHit | null> {
  const bars = alertBars(a, await getBarsCached(a.symbol, a.interval, 500, 20_000));
  const c = a.condition;
  const ctx: AlertContext = {};
  if (c.kind === 'drawing') ctx.drawing = (useDrawings.getState().bySymbol[a.symbol] ?? []).find((x) => x.id === c.drawingId);
  if (c.kind === 'script') {
    const sc = useScripts.getState().scripts.find((s) => s.id === c.scriptId);
    if (!sc) throw new Error('script was deleted');
    const { result } = await runScriptSandboxed(sc.code, bars, sc.inputs);
    if (result.error) throw new Error(`script: ${result.error}`);
    ctx.scriptSignals = result.signals;
  }
  return compute<AlertHit | null>({ op: 'alert', alert: a, bars, ctx });
}

async function deliver(a: Alert, hit: AlertHit) {
  const delivered = ['app'];
  const msg = hit.message;
  useUi.getState().toast({ title: `🔔 ${a.name}`, body: msg, tone: 'warn' });
  if (a.channels.browser && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(a.name, { body: msg, tag: a.id, icon: '/icon-192.png' });
      else new Notification(a.name, { body: msg, tag: a.id, icon: '/icon-192.png' });
      delivered.push('browser');
    } catch {
      /* notifications blocked */
    }
  }
  const payload = alertPayload(a, hit);
  if (a.channels.webhook)
    try {
      await postJson('/api/notify', { channel: 'webhook', url: a.channels.webhook, payload });
      delivered.push('webhook');
    } catch (e) {
      useAlerts.getState().update(a.id, { lastError: `webhook: ${(e as Error).message}` });
    }
  if (a.channels.email)
    try {
      await postJson('/api/notify', { channel: 'email', to: a.channels.email, subject: `Meridian alert: ${a.name}`, text: `${msg}\n\nBar: ${payload.barTime}${hit.provisional ? ' (provisional)' : ''}\n\nInformational only — not investment advice.` });
      delivered.push('email');
    } catch (e) {
      useAlerts.getState().update(a.id, { lastError: `email: ${(e as Error).message}` });
    }
  useAlerts.getState().pushLog({ alertId: a.id, name: a.name, symbol: a.symbol, interval: a.interval, at: Date.now(), barT: hit.barT, message: msg, provisional: hit.provisional, delivered });
}

/** Fold the server scheduler's firings and per-alert state into the local alerts and log. */
let activitySince = 0;
const sessionStart = Date.now();
async function mergeServerActivity(): Promise<void> {
  const act = await alertActivity(activitySince);
  useAccount.getState().set({ scheduler: act.scheduler });
  activitySince = Math.max(0, act.serverTime - 60_000);
  const store = useAlerts.getState();
  const known = new Set(store.log.map((e) => e.id));
  const fresh = act.events.filter((e) => !known.has(`srv_${e.id}`));
  if (fresh.length)
    useAlerts.setState((s) => ({
      log: [...fresh.map((e) => ({ id: `srv_${e.id}`, alertId: e.alertId, name: e.name, symbol: e.symbol, interval: e.interval as Interval, at: e.at, barT: e.barT, message: e.message, provisional: e.provisional, delivered: e.delivered })), ...s.log].sort((x, y) => y.at - x.at).slice(0, 500),
    }));
  for (const e of fresh) if (e.at > sessionStart - 120_000) useUi.getState().toast({ title: `🔔 ${e.name}`, body: e.message, tone: 'warn' });
  for (const st of act.states) {
    const a = store.alerts.find((x) => x.id === st.alertId);
    if (!a) continue;
    const patch: Partial<Alert> = {};
    if (st.lastFiredBar != null && st.lastFiredBar !== a.lastFiredBar && st.lastFiredBar > (a.lastFiredBar ?? -Infinity)) Object.assign(patch, { lastFiredBar: st.lastFiredBar, lastFiredAt: st.lastFiredAt ?? undefined });
    if (st.done && a.mode === 'once' && a.enabled && !((a.rearmedAt ?? 0) > (st.lastFiredAt ?? 0))) patch.enabled = false;
    const err = st.lastError ?? undefined;
    if (err !== a.lastError && a.enabled) patch.lastError = err;
    if (Object.keys(patch).length) store.update(a.id, patch);
  }
}

export function useAlertManager() {
  const running = useRef(false);
  useEffect(() => {
    const tick = async () => {
      if (running.current) return;
      running.current = true;
      try {
        const acct = useAccount.getState();
        if (acct.status === 'signed-in') await mergeServerActivity().catch(() => undefined);
        // while the server scheduler is running it is the one that evaluates and delivers
        if (acct.status === 'signed-in' && serverLive(useAccount.getState().scheduler?.lastRunAt)) return;
        const now = Date.now();
        for (const a of useAlerts.getState().alerts) {
          if (!a.enabled) continue;
          if (a.expires && a.expires < now) {
            useAlerts.getState().update(a.id, { enabled: false, lastError: 'expired' });
            continue;
          }
          try {
            const hit = await evaluate(a);
            const fresh = useAlerts.getState().alerts.find((x) => x.id === a.id) ?? a;
            if (shouldFire(hit, fresh.lastFiredBar)) {
              useAlerts.getState().update(a.id, { lastFiredBar: hit.barT, lastFiredAt: now, lastError: undefined, ...(a.mode === 'once' ? { enabled: false } : {}) });
              await deliver(a, hit);
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

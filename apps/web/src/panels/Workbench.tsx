import { buildLedger, valuePositions } from '@meridian/portfolio';
import { getStudy } from '@meridian/engine';
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import { Bot, Camera, Check, FilePlus2, Play, Plus, Save, Send, ShieldAlert, Square, Trash2 } from 'lucide-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { chartActions, snapshotters } from '../chart/bus';
import { Empty, Select } from '../components/ui';
import { runScriptSandboxed } from '../engine/script';
import { canvasToBlob } from '../lib/download';
import { fmtTime, signalLabel } from '../lib/format';
import { Markdown } from '../lib/markdown';
import { newStudy, useJournal, usePortfolio, useScripts, useUi, useWorkspace } from '../state/store';
import { fetchMatrix, useActive, useQuotes } from './hooks';

// ── Script editor ──────────────────────────────────────────────────────────
const MonacoEditor = lazy(() => import('@monaco-editor/react').then((m) => ({ default: m.default })));

/** Monaco loads from a CDN; probe once and fall back to the plain editor when it is unreachable (offline, strict proxies). */
let monacoProbe: Promise<boolean> | null = null;
const probeMonaco = () =>
  (monacoProbe ??= fetch('https://cdn.jsdelivr.net/', { mode: 'no-cors', cache: 'no-store' })
    // reachability check first: the loader leaves an unhandled rejection behind when its script fails to load
    .then(() => import('@monaco-editor/react'))
    .then((m) => Promise.race([m.loader.init().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]))
    .catch(() => false));

function useMonacoAvailable(enabled: boolean) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void probeMonaco().then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, [enabled]);
  return ok;
}

const TEMPLATES: { name: string; code: string }[] = [
  {
    name: 'MA crossover',
    code: `meta({ name: 'MA crossover', overlay: true })
const fast = ema(close, input('Fast', 12, { min: 1, max: 200 }))
const slow = sma(close, input('Slow', 30, { min: 2, max: 400 }))
plot(fast, { title: 'Fast', color: '#29b6f6' })
plot(slow, { title: 'Slow', color: '#ff9800' })
signal(crossover(fast, slow), { id: 'MA_CROSS_UP', dir: 'bull', text: '▲' })
signal(crossunder(fast, slow), { id: 'MA_CROSS_DN', dir: 'bear', text: '▼' })
`,
  },
  {
    name: 'RSI bands (pane)',
    code: `meta({ name: 'RSI bands', overlay: false })
const r = rsi(close, input('Length', 14, { min: 2, max: 100 }))
plot(r, { title: 'RSI', color: '#ab47bc' })
hline(70, 'Upper', '#ef5350')
hline(30, 'Lower', '#26a69a')
signal(crossunder(r, 30), { id: 'RSI_OVERSOLD', dir: 'bull', text: '●' })
`,
  },
  {
    name: 'ATR channel',
    code: `meta({ name: 'ATR channel', overlay: true })
const len = input('Length', 20, { min: 2 })
const k = input('Multiplier', 2, { min: 0.5, max: 6 })
const mid = ema(close, len)
const a = atr(len)
plot(map2(mid, a, (m, x) => m + k * x), { title: 'Upper', color: '#ef5350' })
plot(mid, { title: 'Mid', color: '#787b86' })
plot(map2(mid, a, (m, x) => m - k * x), { title: 'Lower', color: '#26a69a' })
`,
  },
  {
    name: 'Volume spike',
    code: `meta({ name: 'Volume spike', overlay: false })
const avg = sma(volume, input('Average', 20, { min: 2 }))
const ratio = map2(volume, avg, (v, a) => (a ? v / a : NaN))
plot(ratio, { title: 'Volume / avg', color: '#42a5f5', style: 'histogram' })
hline(input('Threshold', 2.5), 'Threshold', '#ffb74d')
signal(series((i) => ratio[i] > 2.5), { id: 'VOL_SPIKE', dir: 'neutral', text: '◆' })
`,
  },
];

const REFERENCE = 'Series: open high low close volume time hl2 hlc3 · sma ema rma wma highest lowest stdev change atr tr rsi · crossover crossunder nz series map2 · input meta plot hline signal';

function useIsDark() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light');
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.documentElement.dataset.theme !== 'light'));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

export function ScriptEditorPanel() {
  const { pane, rt } = useActive();
  const { scripts, activeId, save, remove, setActive } = useScripts();
  const active = scripts.find((s) => s.id === activeId) ?? null;
  const [name, setName] = useState(active?.name ?? 'My script');
  const [code, setCode] = useState(active?.code ?? TEMPLATES[0].code);
  const [inputs, setInputs] = useState<Record<string, number>>(active?.inputs ?? {});
  const [out, setOut] = useState<Awaited<ReturnType<typeof runScriptSandboxed>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [plain, setPlain] = useState(false);
  const dark = useIsDark();
  const monacoOk = useMonacoAvailable(!plain);
  const dirty = !active || active.code !== code || active.name !== name || JSON.stringify(active.inputs) !== JSON.stringify(inputs);

  useEffect(() => {
    // load a different saved script into the editor (a save of the current buffer keeps the last run's results)
    if (!active || active.code === code) return;
    setName(active.name);
    setCode(active.code);
    setInputs(active.inputs ?? {});
    setOut(null);
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    const bars = rt.bars.filter((b) => b.final !== false);
    if (!bars.length) return;
    setBusy(true);
    setOut(await runScriptSandboxed(code, bars, inputs, { check: true }));
    setBusy(false);
  };
  const doSave = () => save({ id: active?.id, name: name.trim() || 'Untitled script', code, inputs });
  const addToChart = () => {
    const id = doSave();
    const p = useWorkspace.getState().panes.find((x) => x.id === pane.id);
    if (!p) return;
    const existing = p.studies.find((s) => s.id === 'script' && s.scriptId === id);
    if (existing) return useUi.getState().toast({ title: 'Already on chart', body: 'The chart re-runs the script whenever you save.', tone: 'info' });
    const st = newStudy('script');
    st.scriptId = id;
    useWorkspace.getState().updatePane(p.id, { studies: [...p.studies, st] });
    useUi.getState().toast({ title: `${name} added to ${p.symbol}`, tone: 'ok' });
  };

  const r = out?.result;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Select
          label="Saved scripts"
          value={active?.id ?? ''}
          onChange={(v) => setActive(v || null)}
          options={[{ value: '', label: 'New script…' }, ...scripts.map((s) => ({ value: s.id, label: s.name }))]}
        />
        <input className="input h-7 w-44" value={name} onChange={(e) => setName(e.target.value)} aria-label="Script name" />
        <Select
          label="Insert template"
          value=""
          onChange={(v) => {
            const t = TEMPLATES.find((x) => x.name === v);
            if (t) setCode(t.code);
          }}
          options={[{ value: '', label: 'Template…' }, ...TEMPLATES.map((t) => ({ value: t.name, label: t.name }))]}
        />
        <button className="btn btn-primary" onClick={run} disabled={busy || !rt.bars.length} title="Run on the active chart (Ctrl+Enter)">
          <Play className="size-3.5" /> {busy ? 'Running…' : 'Run'}
        </button>
        <button className="btn" onClick={doSave} disabled={!dirty}><Save className="size-3.5" /> Save</button>
        <button className="btn" onClick={addToChart}><FilePlus2 className="size-3.5" /> Add to chart</button>
        {active && (
          <button className="icon-btn" aria-label="Delete script" title="Delete script" onClick={() => {
            remove(active.id);
            setActive(null);
          }}><Trash2 className="size-3.5" /></button>
        )}
        <label className="ml-auto flex items-center gap-1 text-[11px] text-dim">
          <input type="checkbox" checked={plain || monacoOk === false} disabled={monacoOk === false} onChange={(e) => setPlain(e.target.checked)} /> {monacoOk === false ? 'Plain editor (Monaco unavailable)' : 'Plain editor'}
        </label>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className="min-w-0 flex-1"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void run();
            }
          }}
        >
          {plain || !monacoOk ? (
            <PlainEditor code={code} onChange={setCode} />
          ) : (
            <Suspense fallback={<PlainEditor code={code} onChange={setCode} />}>
              <MonacoEditor
                height="100%"
                language="javascript"
                theme={dark ? 'vs-dark' : 'light'}
                value={code}
                onChange={(v) => setCode(v ?? '')}
                loading={<PlainEditor code={code} onChange={setCode} />}
                options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, tabSize: 2, automaticLayout: true, lineNumbersMinChars: 3 }}
              />
            </Suspense>
          )}
        </div>
        <aside className="flex w-64 shrink-0 flex-col gap-2 overflow-auto border-l border-border p-2 text-[12px]">
          <div className="text-[11px] text-faint">Runs on {pane.symbol} · {pane.interval} in a sandboxed worker (no network, 3 s budget).</div>
          {r?.inputs.length ? (
            <div className="space-y-1">
              <div className="section-title px-0">Inputs</div>
              {r.inputs.map((inp) => (
                <label key={inp.name} className="flex items-center justify-between gap-2">
                  <span className="text-dim">{inp.name}</span>
                  <input
                    type="number"
                    className="input h-6 w-20"
                    min={inp.min}
                    max={inp.max}
                    value={inputs[inp.name] ?? inp.value}
                    onChange={(e) => setInputs({ ...inputs, [inp.name]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
          ) : null}
          {r && (
            <div className="space-y-1">
              <div className="section-title px-0">Result</div>
              {r.error ? (
                <p className="rounded border border-danger/40 bg-danger/10 p-2 font-mono text-[11px] text-danger">{r.error}</p>
              ) : (
                <>
                  <p>
                    <span className="font-medium">{r.name}</span> · {r.overlay ? 'overlay' : 'own pane'} · {r.plots.length} plot(s), {r.signals.length} signal(s) · {r.ms.toFixed(1)} ms
                  </p>
                  {out?.lookAhead && (
                    <p className={`flex items-start gap-1 ${out.lookAhead.ok ? 'text-ok' : 'text-warn'}`}>
                      {out.lookAhead.ok ? <Check className="mt-0.5 size-3.5" /> : <ShieldAlert className="mt-0.5 size-3.5" />}
                      {out.lookAhead.ok ? 'No look-ahead detected (prefix replay matches).' : `Look-ahead: "${out.lookAhead.plot}" changes at bar ${out.lookAhead.bar} when future bars are added.`}
                    </p>
                  )}
                  <ul className="space-y-0.5">
                    {r.plots.map((p) => {
                      const last = [...p.values].reverse().find((v) => Number.isFinite(v));
                      return (
                        <li key={p.title} className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full" style={{ background: p.color }} />
                          <span className="flex-1 truncate">{p.title}</span>
                          <span className="tabular-nums text-dim">{last === undefined ? '—' : last.toFixed(2)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
          <div className="mt-auto rounded bg-raised/60 p-2 text-[11px] leading-relaxed text-dim">
            <div className="mb-1 font-semibold text-text">Reference</div>
            {REFERENCE}
          </div>
        </aside>
      </div>
    </div>
  );
}

function PlainEditor({ code, onChange }: { code: string; onChange(v: string): void }) {
  return (
    <textarea
      className="h-full w-full resize-none bg-bg p-2 font-mono text-[12px] leading-5 text-text outline-none"
      spellCheck={false}
      value={code}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Script code"
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const t = e.currentTarget;
          const { selectionStart: a, selectionEnd: b } = t;
          onChange(code.slice(0, a) + '  ' + code.slice(b));
          requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
        }
      }}
    />
  );
}

// ── Journal ────────────────────────────────────────────────────────────────
const imgKey = (id: string) => `meridian.journal.img.${id}`;

function NoteImage({ k }: { k: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    void idbGet<Blob>(k).then((b) => {
      if (b) setUrl((u = URL.createObjectURL(b)));
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [k]);
  return url ? <img src={url} alt="Chart snapshot attached to note" className="mt-1 max-h-40 rounded border border-border" /> : null;
}

export function JournalPanel() {
  const { pane, rt } = useActive();
  const { notes, add, remove, update } = useJournal();
  const [scope, setScope] = useState<'symbol' | 'all'>('symbol');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [attach, setAttach] = useState(true);
  const [snap, setSnap] = useState(false);
  const [q, setQ] = useState('');
  const bars = rt.bars;
  const atI = rt.crosshairI ?? bars.length - 1;
  const atBar = bars[atI];
  const intraday = !/^1[DWM]$/.test(pane.interval);

  const shown = notes.filter((n) => (scope === 'all' || n.symbol === pane.symbol) && (!q || `${n.title} ${n.body} ${n.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())));

  const save = async () => {
    if (!title.trim() && !body.trim()) return;
    let imageKey: string | undefined;
    if (snap) {
      const c = snapshotters.get(pane.id)?.();
      if (c) {
        imageKey = imgKey(`${Date.now().toString(36)}`);
        await idbSet(imageKey, await canvasToBlob(c, 'image/jpeg', 0.85));
      }
    }
    add({ symbol: pane.symbol, interval: pane.interval, barT: attach && atBar ? atBar.t : undefined, title: title.trim() || body.trim().slice(0, 60), body: body.trim(), tags: tags.split(',').map((t) => t.trim()).filter(Boolean), imageKey });
    setTitle('');
    setBody('');
    setTags('');
    setSnap(false);
  };

  /** Signals that fired within ±3 bars of the note's bar on the active chart (review context). */
  const nearby = (t: number) => {
    if (!bars.length) return [];
    let i = bars.findIndex((b) => b.t >= t);
    if (i < 0) return [];
    if (bars[i].t !== t && i > 0) i--;
    const out: string[] = [];
    for (const r of rt.results) for (const s of r.signals) if (Math.abs(s.i - i) <= 3) out.push(`${signalLabel(s.id)} (${s.i - i >= 0 ? '+' : ''}${s.i - i})`);
    return [...new Set(out)].slice(0, 6);
  };

  return (
    <div className="panel-body">
      <form
        className="space-y-1.5 border-b border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input className="input w-full" placeholder={`Note on ${pane.symbol}…`} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Note title" />
        <textarea className="input min-h-16 w-full py-1" placeholder="Thesis, plan, what you saw…" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Note body" />
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-dim">
          <input className="input h-6 w-32" placeholder="tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
          <label className="flex items-center gap-1"><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Pin to {atBar ? fmtTime(atBar.t, intraday) : 'bar'}</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> <Camera className="size-3" /> Snapshot</label>
          <button className="btn btn-primary ml-auto" type="submit"><Plus className="size-3.5" /> Add</button>
        </div>
      </form>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Select<'symbol' | 'all'> label="Scope" value={scope} onChange={setScope} options={[{ value: 'symbol', label: `${pane.symbol} only` }, { value: 'all', label: 'All symbols' }]} />
        <input className="input h-7 flex-1" placeholder="Filter notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter notes" />
      </div>
      {!shown.length && <Empty title="No notes yet">Pinned notes appear as markers on the chart.</Empty>}
      <ul>
        {shown.map((n) => {
          const near = n.barT && n.symbol === pane.symbol ? nearby(n.barT) : [];
          return (
            <li key={n.id} className="group border-b border-border/60 px-3 py-2">
              <div className="flex items-start gap-2">
                <button
                  className="flex-1 text-left"
                  title={n.barT ? 'Jump to the pinned bar' : undefined}
                  onClick={() => {
                    const ws = useWorkspace.getState();
                    if (n.symbol !== pane.symbol) ws.setSymbol(ws.activePaneId, n.symbol);
                    if (n.barT) setTimeout(() => chartActions.get(ws.activePaneId)?.goTo(n.barT!), n.symbol !== pane.symbol ? 1200 : 0);
                  }}
                >
                  <div className="font-medium">{n.title}</div>
                  <div className="text-[10px] text-faint">
                    {n.symbol} · {n.interval} · {new Date(n.createdAt).toLocaleString()}
                    {n.barT ? ` · bar ${fmtTime(n.barT, !/^1[DWM]$/.test(n.interval))}` : ''}
                  </div>
                </button>
                <button className="icon-btn opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Delete note" onClick={() => {
                  if (n.imageKey) void idbDel(n.imageKey);
                  remove(n.id);
                }}><Trash2 className="size-3.5" /></button>
              </div>
              {n.body && <p className="mt-1 whitespace-pre-wrap text-dim">{n.body}</p>}
              {n.imageKey && <NoteImage k={n.imageKey} />}
              <div className="mt-1 flex flex-wrap gap-1">
                {n.tags.map((t) => (
                  <button key={t} className="chip" onClick={() => setQ(t)}>#{t}</button>
                ))}
                {near.map((s) => (
                  <span key={s} className="chip" title="Signal near the pinned bar on the active chart">{s}</span>
                ))}
                {n.barT && n.symbol === pane.symbol && !near.length && rt.results.length > 0 && <span className="text-[10px] text-faint">no signals within ±3 bars</span>}
              </div>
              <label className="mt-1 flex items-center gap-1 text-[10px] text-faint">
                <input type="checkbox" checked={n.tags.includes('reviewed')} onChange={(e) => update(n.id, { tags: e.target.checked ? [...n.tags, 'reviewed'] : n.tags.filter((t) => t !== 'reviewed') })} /> reviewed
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── AI Analyst ─────────────────────────────────────────────────────────────
const SUGGESTIONS = ['Where is the nearest exhaustion risk?', 'Do the timeframes agree?', 'What would invalidate the current setup?'];

export function AnalystPanel() {
  const { pane, rt } = useActive();
  const pf = usePortfolio();
  const [kind, setKind] = useState<'chart' | 'portfolio'>('chart');
  const [question, setQuestion] = useState('');
  const [text, setText] = useState('');
  const [engine, setEngine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withMtf, setWithMtf] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const ledger = useMemo(() => (pf.txs.length ? buildLedger(pf.accounts, pf.txs) : null), [pf.accounts, pf.txs]);
  const quotes = useQuotes(kind === 'portfolio' ? (ledger?.positions.map((p) => p.symbol) ?? []) : []);

  const chartContext = async () => {
    const n = rt.bars.length;
    const chips: { study: string; text: string; dir: string }[] = [];
    const levels: Record<string, number | null> = {};
    const recentSignals: { study: string; id: string; barsAgo: number; dir: string; price?: number; provisional?: boolean }[] = [];
    for (const r of rt.results) {
      const cfg = pane.studies.find((s) => s.uid === r.id);
      const def = cfg ? getStudy(cfg.id) : undefined;
      const label = def ? `DeMark-style ${def.shortName}`.replace(/^DeMark-style (?!TD)/, '') : (cfg?.id ?? r.id);
      for (const c of r.status?.chips ?? []) chips.push({ study: label, text: c.text, dir: c.dir });
      for (const [k, v] of Object.entries(r.status?.values ?? {})) if (typeof v === 'number' && Number.isFinite(v) && /tdst|risk|target|proj|support|resist|stop|level/i.test(k)) levels[`${def?.shortName ?? r.id} ${k}`] = +v.toPrecision(8);
      for (const s of r.signals) if (n - 1 - s.i <= 60) recentSignals.push({ study: def?.shortName ?? r.id, id: s.id, barsAgo: n - 1 - s.i, dir: s.dir, price: s.price, provisional: s.i === n - 1 && rt.bars[n - 1]?.final === false ? true : undefined });
    }
    recentSignals.sort((a, b) => a.barsAgo - b.barsAgo);
    const last = rt.bars[n - 1];
    let mtf: { interval: string; label: string; score: number }[] | undefined;
    if (withMtf) {
      try {
        const cells = await fetchMatrix([pane.symbol], ['1h', '4h', '1D', '1W', '1M']);
        mtf = cells.filter((c) => c.cell).map((c) => ({ interval: c.interval, label: c.cell!.label, score: +c.cell!.score.toFixed(3) }));
      } catch {
        /* optional */
      }
    }
    const ret = (k: number) => (n > k ? +((100 * (rt.bars[n - 1].c / rt.bars[n - 1 - k].c - 1)).toFixed(2)) : null);
    return {
      simulated: !!rt.simulated,
      provider: rt.provider,
      lastBar: last ? { t: new Date(last.t).toISOString(), o: last.o, h: last.h, l: last.l, c: last.c, forming: last.final === false } : null,
      returnsPct: { '5 bars': ret(5), '20 bars': ret(20), '60 bars': ret(60) },
      chips,
      levels,
      recentSignals: recentSignals.slice(0, 25),
      mtf,
    };
  };

  const portfolioContext = () => {
    if (!ledger) return { positions: [] };
    const qmap = Object.fromEntries(Object.entries(quotes.data ?? {}).map(([k, v]) => [k, { last: v.last, prevClose: v.prevClose }]));
    const v = valuePositions(ledger, qmap);
    return {
      total: +v.total.toFixed(2),
      cash: +v.cash.toFixed(2),
      positions: v.rows.map((r) => ({ symbol: r.symbol, weightPct: +(100 * r.weight).toFixed(2), unrealizedPct: +r.unrealizedPct.toFixed(2), dayChangePct: +r.dayChangePct.toFixed(2) })),
      quotesMissing: v.rows.filter((r) => !qmap[r.symbol]).map((r) => r.symbol),
    };
  };

  const ask = async (qText = question) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setErr(null);
    setText('');
    setEngine(null);
    try {
      const context = kind === 'chart' ? await chartContext() : portfolioContext();
      const res = await fetch('/api/analyst', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, symbol: kind === 'chart' ? pane.symbol : undefined, interval: kind === 'chart' ? pane.interval : undefined, question: qText || undefined, context }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `HTTP ${res.status} — the analyst API is unavailable on this host`);
      }
      setEngine(res.headers.get('X-Meridian-Analyst'));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setText(acc);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-1.5 border-b border-border p-2">
        <div className="flex items-center gap-2">
          <Select<'chart' | 'portfolio'> label="Briefing type" value={kind} onChange={setKind} options={[{ value: 'chart', label: `Chart · ${pane.symbol} ${pane.interval}` }, { value: 'portfolio', label: 'Portfolio' }]} />
          {kind === 'chart' && (
            <label className="flex items-center gap-1 text-[11px] text-dim"><input type="checkbox" checked={withMtf} onChange={(e) => setWithMtf(e.target.checked)} /> include MTF</label>
          )}
        </div>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <input className="input flex-1" placeholder="Ask about this chart (optional)" value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Question for the analyst" />
          {busy ? (
            <button type="button" className="btn" onClick={() => abort.current?.abort()}><Square className="size-3.5" /> Stop</button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={kind === 'chart' ? !rt.bars.length : !ledger}><Send className="size-3.5" /> Brief me</button>
          )}
        </form>
        <div className="flex flex-wrap gap-1">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => (setQuestion(s), void ask(s))} disabled={busy}>{s}</button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[13px] leading-relaxed" aria-live="polite">
        {err && <p className="rounded border border-warn/40 bg-warn/10 p-2 text-warn">{err}</p>}
        {!text && !busy && !err && (
          <Empty icon={<Bot className="size-6" />} title="AI chart analyst">
            Sends the engine's structured output (signals, levels, timeframe matrix) — never screenshots — and returns a plain-English briefing. Analysis only, not advice.
          </Empty>
        )}
        {busy && !text && <p className="text-faint">Assembling the snapshot and thinking…</p>}
        {text && <Markdown text={text} />}
      </div>
      {engine && (
        <div className="border-t border-border px-3 py-1 text-[10px] text-faint">
          {engine === 'rule-based' ? 'Rule-based summary (no ANTHROPIC_API_KEY on the server)' : `Generated by ${engine}`} · verify numbers against the chart
        </div>
      )}
    </div>
  );
}

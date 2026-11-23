import { getStudy } from '@meridian/engine';
import { buildLedger, valuePositions } from '@meridian/portfolio';
import { Bell, BellRing, Bookmark, BookmarkCheck, Bot, ChevronDown, ChevronRight, Copy, Pencil, Search, Send, Square, Trash2, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { openPanel } from '../components/panels';
import { Empty, Select, Switch } from '../components/ui';
import { isPriceLevel, levelAlert, parseQuery, searchAnalyses, snapshotLevels, syncLevelAlerts, tracksLevel } from '../lib/analyst';
import { signInIfRequired } from '../lib/api';
import { fmtPct, fmtPrice } from '../lib/format';
import { Markdown } from '../lib/markdown';
import { MAX_SAVED_ANALYSES, uid, useAlerts, useAnalystLibrary, useAnalystSession, usePortfolio, useSettings, useUi } from '../state/store';
import type { AnalystKind, AnalystLevel, AnalystRun, SavedAnalysis } from '../state/types';
import { fetchMatrix, useActive, useQuotes } from './hooks';

// ── Briefing runner ────────────────────────────────────────────────────────
// Lives outside the component: the stream keeps writing into the store when the panel is hidden or the phone page
// changes, and the result is held until the user starts a new briefing.
let controller: AbortController | null = null;

interface Snapshot {
  context: Record<string, unknown>;
  levels: AnalystLevel[];
  lastClose?: number;
  simulated?: boolean;
}

export const stopBriefing = () => controller?.abort();

function finishBriefing(id: string) {
  const session = useAnalystSession.getState();
  const run = session.current;
  if (!run || run.id !== id) return;
  const lib = useAnalystLibrary.getState();
  if (run.kind === 'chart' && lib.syncLevels) {
    const s = syncLevelAlerts(useAlerts.getState().alerts, run);
    for (const p of s.patches) useAlerts.getState().update(p.id, p.patch);
    if (s.updated || s.stale) session.patchRun(id, { levelSync: { updated: s.updated, stale: s.stale } });
    if (s.updated)
      useUi.getState().toast({
        title: `Updated ${s.updated} level alert${s.updated > 1 ? 's' : ''}`,
        body: `${run.symbol} ${run.interval}: key levels from the new briefing.`,
        tone: 'ok',
        action: { label: 'Open alerts', run: () => openPanel('alerts') },
      });
  }
  if (lib.autoSave && run.text.trim()) {
    const sid = lib.save(useAnalystSession.getState().current ?? run);
    if (sid) session.patchRun(id, { savedId: sid });
  }
}

async function startBriefing(req: { kind: AnalystKind; symbol?: string; interval?: AnalystRun['interval']; question?: string }, build: () => Promise<Snapshot> | Snapshot) {
  controller?.abort();
  const ac = new AbortController();
  controller = ac;
  const id = uid('run');
  const { set, patchRun } = useAnalystSession.getState();
  set({ current: { id, ...req, text: '', engine: null, createdAt: Date.now(), status: 'streaming', levels: [] }, tab: 'briefing' });
  let acc = '';
  try {
    const snap = await build();
    if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
    patchRun(id, { levels: snap.levels, lastClose: snap.lastClose, simulated: snap.simulated });
    const res = await fetch('/api/analyst', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req, question: req.question || undefined, context: snap.context }),
      signal: ac.signal,
    });
    signInIfRequired(res);
    if (!res.ok || !res.body) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(j?.error ?? `HTTP ${res.status} — the analyst API is unavailable on this host`);
    }
    patchRun(id, { engine: res.headers.get('X-Meridian-Analyst') });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let flushed = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
      // the held briefing is persisted; write it a few times a second rather than on every token
      const now = performance.now();
      if (now - flushed > 80) {
        flushed = now;
        patchRun(id, { text: acc });
      }
    }
    patchRun(id, { text: acc, status: 'done' });
    finishBriefing(id);
  } catch (e) {
    if ((e as Error).name === 'AbortError') patchRun(id, { text: acc, status: 'stopped' });
    else patchRun(id, { text: acc, status: 'error', error: (e as Error).message });
  } finally {
    if (controller === ac) controller = null;
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────
function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
}

function runLabel(r: { kind: AnalystKind; symbol?: string; interval?: string }) {
  return r.kind === 'portfolio' ? 'Portfolio' : `${r.symbol ?? ''} ${r.interval ?? ''}`.trim();
}

/** Wrap query words in <mark> (case-insensitive), for result titles and snippets. */
function highlight(text: string, words: string[]): ReactNode {
  const ws = words.filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ws.length) return text;
  const re = new RegExp(`(${ws.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-accent/25 text-text">{part}</mark> : part));
}

const confirmDelete = (what: string) => !useSettings.getState().confirmBeforeDelete || confirm(`Delete ${what}?`);

// ── Key levels → alerts ────────────────────────────────────────────────────
function KeyLevels({ run }: { run: AnalystRun }) {
  const alerts = useAlerts((s) => s.alerts);
  const syncLevels = useAnalystLibrary((s) => s.syncLevels);
  const setPrefs = useAnalystLibrary((s) => s.setPrefs);
  if (run.kind !== 'chart' || !run.levels.length || !run.symbol || !run.interval) return null;
  const tracked = (key: string) => alerts.find((a) => tracksLevel(a, run, key));
  const untracked = run.levels.filter((l) => !tracked(l.key));
  const addAlert = (l: AnalystLevel) => useAlerts.getState().add(levelAlert(run, l));
  const addAll = () => {
    untracked.forEach(addAlert);
    useUi.getState().toast({ title: `Created ${untracked.length} level alert${untracked.length > 1 ? 's' : ''}`, body: `${run.symbol} ${run.interval} — they follow each new briefing of this chart.`, tone: 'ok' });
  };
  return (
    <section className="mt-3 rounded border border-border" aria-label="Key levels">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-dim">Key levels</span>
        <span className="text-[10px] text-faint">from the engine snapshot{run.lastClose !== undefined ? ` · close ${fmtPrice(run.lastClose)}` : ''}</span>
        {untracked.length > 1 && (
          <button className="btn ml-auto h-6" onClick={addAll} title="Create a price alert for every level not yet alerted">
            <Bell className="size-3.5" /> Alert all
          </button>
        )}
      </div>
      <ul>
        {run.levels.map((l) => {
          const a = tracked(l.key);
          const dist = run.lastClose ? (100 * (l.value - run.lastClose)) / run.lastClose : null;
          return (
            <li key={l.key} className="flex items-center gap-2 border-b border-border/50 px-2 py-1 last:border-b-0">
              <span className="min-w-0 flex-1 truncate">{l.key}</span>
              <span className="shrink-0 tabular-nums">{fmtPrice(l.value)}</span>
              <span className="w-16 shrink-0 text-right tabular-nums text-[11px] text-faint">{fmtPct(dist)}</span>
              {a ? (
                <button className="btn h-6 text-ok" onClick={() => openPanel('alerts')} title={`${a.name}${a.enabled ? '' : ' (paused)'} — open Alerts`}>
                  <BellRing className="size-3.5" /> {a.enabled ? 'Alerting' : 'Paused'}
                </button>
              ) : (
                <button className="btn h-6" onClick={() => (addAlert(l), useUi.getState().toast({ title: 'Level alert created', body: `${run.symbol} ${run.interval}: ${l.key} ${fmtPrice(l.value)}`, tone: 'ok' }))} aria-label={`Alert when price reaches ${l.key}`}>
                  <Bell className="size-3.5" /> Alert
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-1 text-[10px] text-faint">
        <Switch checked={syncLevels} onChange={(v) => setPrefs({ syncLevels: v })} label="Keep level alerts updated" />
        <span>Each finished briefing of {run.symbol} {run.interval} moves its level alerts to the new values.</span>
        {run.levelSync && (
          <span className="w-full">
            This briefing updated {run.levelSync.updated} alert{run.levelSync.updated === 1 ? '' : 's'}
            {run.levelSync.stale ? ` · ${run.levelSync.stale} level${run.levelSync.stale > 1 ? 's' : ''} no longer in the data (alert kept at its last value)` : ''}.
          </span>
        )}
      </div>
    </section>
  );
}

// ── Held briefing ──────────────────────────────────────────────────────────
function HeldBriefing({ run, paneSymbol, paneInterval }: { run: AnalystRun; paneSymbol: string; paneInterval: string }) {
  const save = useAnalystLibrary((s) => s.save);
  const isSaved = useAnalystLibrary((s) => !!run.savedId && s.saved.some((x) => x.id === run.savedId));
  const streaming = run.status === 'streaming';
  const otherChart = run.kind === 'chart' && (run.symbol !== paneSymbol || run.interval !== paneInterval);
  const doSave = () => {
    const id = save(run);
    if (!id) return useUi.getState().toast({ title: 'Saved briefings are full', body: `Delete some of the ${MAX_SAVED_ANALYSES} saved briefings first.`, tone: 'warn' });
    useAnalystSession.getState().patchRun(run.id, { savedId: id });
    useUi.getState().toast({ title: 'Briefing saved', body: 'Find it in the Saved tab or with Ctrl/⌘ K.', tone: 'ok' });
  };
  return (
    <>
      <div className="mb-2 flex items-start gap-2 border-b border-border pb-1.5 text-[11px] text-faint">
        <div className="min-w-0 flex-1">
          <span className="font-medium text-dim">{runLabel(run)}</span> · {ago(run.createdAt)}
          {run.question && <span className="block truncate italic" title={run.question}>“{run.question}”</span>}
        </div>
        <button className="icon-btn" disabled={!run.text} onClick={() => void navigator.clipboard?.writeText(run.text)} aria-label="Copy briefing" title="Copy as Markdown"><Copy className="size-3.5" /></button>
        <button className={`btn h-6 ${isSaved ? 'text-ok' : ''}`} disabled={streaming || !run.text.trim() || isSaved} onClick={doSave} title={isSaved ? 'In your saved briefings' : 'Save to your library (syncs when signed in)'}>
          {isSaved ? <BookmarkCheck className="size-3.5" /> : <Bookmark className="size-3.5" />} {isSaved ? 'Saved' : 'Save'}
        </button>
        <button className="icon-btn" disabled={streaming} onClick={() => useAnalystSession.getState().set({ current: null })} aria-label="Clear briefing" title="Clear"><X className="size-3.5" /></button>
      </div>
      {otherChart && !streaming && (
        <p className="mb-2 rounded border border-border bg-raised/50 p-1.5 text-[11px] text-dim">
          Held from {runLabel(run)}. The chart now shows {paneSymbol} {paneInterval} — press <b>Brief me</b> for a fresh briefing.
        </p>
      )}
      {run.status === 'error' && <p className="mb-2 rounded border border-warn/40 bg-warn/10 p-2 text-warn">{run.error}</p>}
      {streaming && !run.text && <p className="text-faint">Assembling the snapshot and thinking…</p>}
      {run.text && <Markdown text={run.text} />}
      {run.status === 'stopped' && <p className="mt-1 text-[11px] text-faint">Stopped before the briefing finished.</p>}
      <KeyLevels run={run} />
    </>
  );
}

// ── Saved library ──────────────────────────────────────────────────────────
function SavedItem({ s, words, open, onTag }: { s: SavedAnalysis; words: string[]; open: boolean; onTag(t: string): void }) {
  const { update, remove } = useAnalystLibrary.getState();
  const [tags, setTags] = useState(s.tags.join(', '));
  useEffect(() => setTags(s.tags.join(', ')), [s.tags]);
  const commitTags = () => {
    const next = [...new Set(tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
    if (next.join(',') !== s.tags.join(',')) update(s.id, { tags: next });
  };
  return (
    <div className="px-3 pb-2">
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {s.levels.slice(0, 6).map((l) => (
          <span key={l.key} className="chip" title="Key level in this briefing's snapshot">{l.key} {fmtPrice(l.value)}</span>
        ))}
      </div>
      {open && (
        <div className="mt-2 rounded border border-border p-2 text-[13px] leading-relaxed">
          {s.question && <p className="mb-1 text-[11px] italic text-faint">“{s.question}”</p>}
          <Markdown text={s.text} />
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2 text-[11px]">
            <input
              className="input h-6 flex-1"
              placeholder="tags, comma separated"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onBlur={commitTags}
              onKeyDown={(e) => e.key === 'Enter' && commitTags()}
              aria-label="Tags for this briefing"
            />
            <button className="icon-btn" onClick={() => { const t = prompt('Briefing title', s.title); if (t?.trim()) update(s.id, { title: t.trim() }); }} aria-label="Rename saved briefing"><Pencil className="size-3.5" /></button>
            <button className="icon-btn" onClick={() => void navigator.clipboard?.writeText(s.text)} aria-label="Copy saved briefing"><Copy className="size-3.5" /></button>
            <button className="icon-btn" onClick={() => confirmDelete(`“${s.title}”`) && remove(s.id)} aria-label="Delete saved briefing"><Trash2 className="size-3.5" /></button>
          </div>
          <div className="mt-1 text-[10px] text-faint">{s.engine === 'rule-based' ? 'Rule-based summary' : s.engine ? `Generated by ${s.engine}` : ''}{s.simulated ? ' · simulated data' : ''}</div>
        </div>
      )}
      {!open && s.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {s.tags.map((t) => <button key={t} className="chip" onClick={() => onTag(t)}>#{highlight(t, words)}</button>)}
        </div>
      )}
    </div>
  );
}

function SavedBriefings({ paneSymbol }: { paneSymbol: string }) {
  const saved = useAnalystLibrary((s) => s.saved);
  const autoSave = useAnalystLibrary((s) => s.autoSave);
  const { query, scope, focusId, set } = useAnalystSession();
  const [open, setOpen] = useState<string | null>(focusId);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusId) {
      setOpen(focusId);
      set({ focusId: null });
      requestAnimationFrame(() => document.getElementById(`saved-${focusId}`)?.scrollIntoView({ block: 'nearest' }));
    } else input.current?.focus();
  }, [focusId, set]);
  const hits = useMemo(() => searchAnalyses(saved, query, scope === 'symbol' ? paneSymbol : undefined), [saved, query, scope, paneSymbol]);
  const words = useMemo(() => parseQuery(query).words, [query]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 border-b border-border p-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <input
              ref={input}
              className="input w-full pl-7"
              placeholder="Search saved briefings — words, #tag, sym:AAPL, kind:portfolio"
              value={query}
              onChange={(e) => set({ query: e.target.value })}
              onKeyDown={(e) => e.key === 'Escape' && set({ query: '' })}
              aria-label="Search saved briefings"
            />
          </div>
          <Select<'symbol' | 'all'> label="Scope" value={scope} onChange={(v) => set({ scope: v })} options={[{ value: 'all', label: 'All symbols' }, { value: 'symbol', label: `${paneSymbol} only` }]} />
        </div>
        <div className="flex items-center justify-between text-[10px] text-faint">
          <span>{query || scope === 'symbol' ? `${hits.length} of ${saved.length}` : `${saved.length}`} saved</span>
          <Switch checked={autoSave} onChange={(v) => useAnalystLibrary.getState().setPrefs({ autoSave: v })} label="Save every briefing" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!saved.length && <Empty icon={<Bookmark className="size-6" />} title="No saved briefings">Press <b>Save</b> on a briefing, or turn on <i>Save every briefing</i>. Saved briefings sync to your account when you are signed in.</Empty>}
        {saved.length > 0 && !hits.length && <Empty title="No matches">Try fewer words, or set the scope to all symbols.</Empty>}
        <ul>
          {hits.map(({ item: s, snippet }) => {
            const isOpen = open === s.id;
            return (
              <li key={s.id} id={`saved-${s.id}`} className="border-b border-border/60">
                <button className="flex w-full items-start gap-1.5 px-3 pt-2 text-left" onClick={() => setOpen(isOpen ? null : s.id)} aria-expanded={isOpen}>
                  {isOpen ? <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-faint" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-faint" />}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{highlight(s.title, words)}</span>
                    <span className="block text-[10px] text-faint">{runLabel(s)} · {new Date(s.createdAt).toLocaleString()}</span>
                    {!isOpen && snippet && <span className="mt-0.5 block text-[11px] text-dim">{highlight(snippet, words)}</span>}
                  </span>
                </button>
                <SavedItem s={s} words={words} open={isOpen} onTag={(t) => set({ query: `#${t}` })} />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────
const SUGGESTIONS = ['Where is the nearest exhaustion risk?', 'Do the timeframes agree?', 'What would invalidate the current setup?'];

export function AnalystPanel() {
  const { pane, rt } = useActive();
  const pf = usePortfolio();
  const current = useAnalystSession((s) => s.current);
  const tab = useAnalystSession((s) => s.tab);
  const savedCount = useAnalystLibrary((s) => s.saved.length);
  const [kind, setKind] = useState<AnalystKind>(current?.kind ?? 'chart');
  const [question, setQuestion] = useState(current?.question ?? '');
  const [withMtf, setWithMtf] = useState(true);
  const busy = current?.status === 'streaming';
  const ledger = useMemo(() => (pf.txs.length ? buildLedger(pf.accounts, pf.txs) : null), [pf.accounts, pf.txs]);
  const quotes = useQuotes(kind === 'portfolio' ? (ledger?.positions.map((p) => p.symbol) ?? []) : []);

  const chartSnapshot = async (): Promise<Snapshot> => {
    const n = rt.bars.length;
    const last = rt.bars[n - 1];
    const chips: { study: string; text: string; dir: string }[] = [];
    const levels: Record<string, number | null> = {};
    const recentSignals: { study: string; id: string; barsAgo: number; dir: string; price?: number; provisional?: boolean }[] = [];
    for (const r of rt.results) {
      const cfg = pane.studies.find((s) => s.uid === r.id);
      const def = cfg ? getStudy(cfg.id) : undefined;
      const label = def ? `DeMark-style ${def.shortName}`.replace(/^DeMark-style (?!TD)/, '') : (cfg?.id ?? r.id);
      for (const c of r.status?.chips ?? []) chips.push({ study: label, text: c.text, dir: c.dir });
      for (const [k, v] of Object.entries(r.status?.values ?? {})) if (isPriceLevel(k, v, last?.c)) levels[`${def?.shortName ?? r.id} ${k}`] = +v.toPrecision(8);
      for (const s of r.signals) if (n - 1 - s.i <= 60) recentSignals.push({ study: def?.shortName ?? r.id, id: s.id, barsAgo: n - 1 - s.i, dir: s.dir, price: s.price, provisional: s.i === n - 1 && rt.bars[n - 1]?.final === false ? true : undefined });
    }
    recentSignals.sort((a, b) => a.barsAgo - b.barsAgo);
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
      context: {
        simulated: !!rt.simulated,
        provider: rt.provider,
        lastBar: last ? { t: new Date(last.t).toISOString(), o: last.o, h: last.h, l: last.l, c: last.c, forming: last.final === false } : null,
        returnsPct: { '5 bars': ret(5), '20 bars': ret(20), '60 bars': ret(60) },
        chips,
        levels,
        recentSignals: recentSignals.slice(0, 25),
        mtf,
      },
      levels: snapshotLevels(levels),
      lastClose: last?.c,
      simulated: !!rt.simulated,
    };
  };

  const portfolioSnapshot = (): Snapshot => {
    if (!ledger) return { context: { positions: [] }, levels: [] };
    const qmap = Object.fromEntries(Object.entries(quotes.data ?? {}).map(([k, v]) => [k, { last: v.last, prevClose: v.prevClose }]));
    const v = valuePositions(ledger, qmap);
    return {
      context: {
        total: +v.total.toFixed(2),
        cash: +v.cash.toFixed(2),
        positions: v.rows.map((r) => ({ symbol: r.symbol, weightPct: +(100 * r.weight).toFixed(2), unrealizedPct: +r.unrealizedPct.toFixed(2), dayChangePct: +r.dayChangePct.toFixed(2) })),
        quotesMissing: v.rows.filter((r) => !qmap[r.symbol]).map((r) => r.symbol),
      },
      levels: [],
    };
  };

  const ask = (qText = question) =>
    void startBriefing(
      { kind, symbol: kind === 'chart' ? pane.symbol : undefined, interval: kind === 'chart' ? pane.interval : undefined, question: qText.trim() || undefined },
      kind === 'chart' ? chartSnapshot : portfolioSnapshot,
    );

  const setTab = (t: 'briefing' | 'saved') => useAnalystSession.getState().set({ tab: t });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 pt-1" role="tablist" aria-label="Analyst view">
        <button role="tab" aria-selected={tab === 'briefing'} className="btn-ghost h-6" data-active={tab === 'briefing'} onClick={() => setTab('briefing')}>
          <Bot className="size-3.5" /> Briefing
        </button>
        <button role="tab" aria-selected={tab === 'saved'} className="btn-ghost h-6" data-active={tab === 'saved'} onClick={() => setTab('saved')}>
          <Bookmark className="size-3.5" /> Saved{savedCount ? ` (${savedCount})` : ''}
        </button>
      </div>
      {tab === 'saved' ? (
        <SavedBriefings paneSymbol={pane.symbol} />
      ) : (
        <>
          <div className="space-y-1.5 border-b border-border p-2">
            <div className="flex items-center gap-2">
              <Select<AnalystKind> label="Briefing type" value={kind} onChange={setKind} options={[{ value: 'chart', label: `Chart · ${pane.symbol} ${pane.interval}` }, { value: 'portfolio', label: 'Portfolio' }]} />
              {kind === 'chart' && (
                <label className="flex items-center gap-1 text-[11px] text-dim"><input type="checkbox" checked={withMtf} onChange={(e) => setWithMtf(e.target.checked)} /> include MTF</label>
              )}
            </div>
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                ask();
              }}
            >
              <input className="input flex-1" placeholder="Ask about this chart (optional)" value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Question for the analyst" />
              {busy ? (
                <button type="button" className="btn" onClick={stopBriefing}><Square className="size-3.5" /> Stop</button>
              ) : (
                <button type="submit" className="btn btn-primary" disabled={kind === 'chart' ? !rt.bars.length : !ledger}><Send className="size-3.5" /> Brief me</button>
              )}
            </form>
            <div className="flex flex-wrap gap-1">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => (setQuestion(s), ask(s))} disabled={busy}>{s}</button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3 text-[13px] leading-relaxed" aria-live="polite">
            {current ? (
              <HeldBriefing run={current} paneSymbol={pane.symbol} paneInterval={pane.interval} />
            ) : (
              <Empty icon={<Bot className="size-6" />} title="AI chart analyst">
                Sends the engine's structured output (signals, levels, timeframe matrix) — never screenshots — and returns a plain-English briefing. The last briefing stays here until you ask for a new one. Analysis only, not advice.
              </Empty>
            )}
          </div>
          {current?.engine && (
            <div className="border-t border-border px-3 py-1 text-[10px] text-faint">
              {current.engine === 'rule-based' ? 'Rule-based summary (no ANTHROPIC_API_KEY on the server)' : `Generated by ${current.engine}`} · verify numbers against the chart
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Open the analyst on a saved briefing (command palette). */
export function openSavedAnalysis(id: string) {
  useAnalystSession.getState().set({ tab: 'saved', focusId: id, query: '', scope: 'all' });
  openPanel('analyst');
}

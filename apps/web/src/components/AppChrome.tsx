import { INTERVALS, type Interval, autoBox } from '@meridian/data';
import { STUDIES } from '@meridian/engine';
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { chartActions } from '../chart/bus';
import { health } from '../lib/api';
import { fmtPrice } from '../lib/format';
import { activePane, useDrawings, useSettings, useUi, useWorkspace } from '../state/store';
import { CHART_TYPES, GRID_LAYOUTS, type DrawingType } from '../state/types';
import { PANEL_DEFS, openPanel } from './panels';
import { snapshot } from './TopBar';
import { Field, Modal, Select, Switch } from './ui';

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const s = useSettings();
  const close = () => useUi.getState().set({ settingsOpen: false });
  const [api, setApi] = useState<Awaited<ReturnType<typeof health>>>(null);
  useEffect(() => {
    if (open) health().then(setApi);
  }, [open]);
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Settings" width={600}>
      <div className="grid grid-cols-1 gap-5 p-4 sm:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h3 className="section-title px-0">Appearance</h3>
          <Field label="Theme">
            <Select value={s.theme} onChange={(v) => s.set({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
          </Field>
          <Field label="Signal palette" hint="Colorblind-safe uses the Okabe–Ito palette; all signals also carry text labels.">
            <Select value={s.palette} onChange={(v) => s.set({ palette: v })} options={[{ value: 'standard', label: 'Standard (green/red)' }, { value: 'colorblind', label: 'Colorblind-safe (blue/orange)' }]} />
          </Field>
          <Field label="Time zone">
            <Select value={s.timezone} onChange={(v) => s.set({ timezone: v })} options={[{ value: 'exchange', label: 'Exchange' }, { value: 'utc', label: 'UTC' }, { value: 'local', label: 'Browser local' }]} />
          </Field>
          <Switch checked={s.showLegendValues} onChange={(v) => s.set({ showLegendValues: v })} label="Show values in legend" />
          <Switch checked={s.showHeatStrip} onChange={(v) => s.set({ showHeatStrip: v })} label="Signal heat strip under price" />
          <Switch checked={s.hollowProvisional} onChange={(v) => s.set({ hollowProvisional: v })} label="Draw provisional (forming-bar) counts hollow" />
          <Switch checked={s.chartTips} onChange={(v) => s.set({ chartTips: v })} label="Explain chart elements on hover / tap" />
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="section-title px-0">Data & behaviour</h3>
          <Switch checked={s.live} onChange={(v) => s.set({ live: v })} label="Live updates (stream / polling)" />
          <Field label="Default adjustment for new charts">
            <Select value={s.defaultAdjust} onChange={(v) => s.set({ defaultAdjust: v })} options={[{ value: 'split', label: 'Split-adjusted' }, { value: 'all', label: 'Split + dividend' }, { value: 'none', label: 'Unadjusted' }]} />
          </Field>
          <Field label="When the symbol or interval changes" hint="Zoom is kept either way. New charts always open on the newest bar.">
            <Select value={s.viewOnChange} onChange={(v) => s.set({ viewOnChange: v })} options={[{ value: 'latest', label: 'Jump to the newest bar' }, { value: 'keep', label: 'Keep position relative to the newest bar' }]} />
          </Field>
          <Field label="Magnet">
            <Select value={s.magnet} onChange={(v) => s.set({ magnet: v })} options={[{ value: 'off', label: 'Off' }, { value: 'weak', label: 'Weak (near OHLC)' }, { value: 'strong', label: 'Strong (always snap)' }]} />
          </Field>
          <Switch checked={s.confirmBeforeDelete} onChange={(v) => s.set({ confirmBeforeDelete: v })} label="Confirm destructive actions" />
          <h3 className="section-title px-0 pt-2">Server</h3>
          {api ? (
            <ul className="text-[11px] text-dim">
              <li>API: <span className="text-ok">online</span></li>
              <li>AI analyst: {api.analyst === 'anthropic' ? <span className="text-ok">Anthropic API</span> : 'rule-based (set ANTHROPIC_API_KEY)'}</li>
              <li>Providers: {Object.entries(api.providers).filter(([, v]) => v).map(([k]) => k).join(', ')}</li>
            </ul>
          ) : (
            <p className="text-[11px] text-warn">API unreachable — only simulated (SIM:*) symbols work offline.</p>
          )}
          <button
            className="btn mt-2 self-start text-danger"
            onClick={() => {
              if (confirm('Reset all local Meridian data (layouts, drawings, watchlists, portfolio, alerts)?')) {
                Object.keys(localStorage).filter((k) => k.startsWith('meridian.')).forEach((k) => localStorage.removeItem(k));
                location.reload();
              }
            }}
          >
            Reset local data…
          </button>
        </section>
      </div>
    </Modal>
  );
}

/** Renko brick / range-bar size: auto (ATR of the loaded history) or a fixed price amount. */
export function BoxSizeDialog() {
  const paneId = useUi((s) => s.boxSizePane);
  const pane = useWorkspace((s) => s.panes.find((p) => p.id === paneId));
  const bars = useUi((s) => (paneId ? s.runtime[paneId]?.bars : undefined));
  const [mode, setMode] = useState<'auto' | 'fixed'>('auto');
  const [atr, setAtr] = useState('14');
  const [size, setSize] = useState('');
  useEffect(() => {
    if (!pane) return;
    setMode(pane.boxSize ? 'fixed' : 'auto');
    setAtr(String(pane.boxAtr ?? 14));
    setSize(pane.boxSize ? String(pane.boxSize) : '');
  }, [pane?.id, paneId]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => useUi.getState().set({ boxSizePane: null });
  const atrN = Math.max(2, Math.min(500, Math.round(Number(atr) || 14)));
  const autoValue = bars && bars.length > 1 ? autoBox(bars, atrN) : NaN;
  const fixed = Number(size);
  const valid = mode === 'auto' || (Number.isFinite(fixed) && fixed > 0);
  const apply = () => {
    if (!pane || !valid) return;
    useWorkspace.getState().updatePane(pane.id, mode === 'auto' ? { boxSize: undefined, boxAtr: atrN } : { boxSize: fixed, boxAtr: atrN });
    close();
  };
  const kind = pane?.chartType === 'range' ? 'Range bar size' : 'Renko box size';
  return (
    <Modal
      open={!!pane}
      onOpenChange={(o) => !o && close()}
      title={kind}
      width={380}
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={apply} disabled={!valid}>Apply</button>
        </>
      }
    >
      <form className="flex flex-col gap-3 p-4" onSubmit={(e) => (e.preventDefault(), apply())}>
        <fieldset className="flex gap-3">
          <legend className="sr-only">Sizing method</legend>
          {(['auto', 'fixed'] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input type="radio" name="box-mode" checked={mode === m} onChange={() => setMode(m)} />
              {m === 'auto' ? 'Auto (ATR)' : 'Fixed size'}
            </label>
          ))}
        </fieldset>
        <Field label="ATR length" hint={Number.isFinite(autoValue) ? `Auto size on this chart: ${fmtPrice(autoValue)}` : 'Average true range of the loaded history, rounded to a tidy step.'}>
          <input className="input" type="number" min={2} max={500} step={1} value={atr} onChange={(e) => setAtr(e.target.value)} disabled={mode !== 'auto'} aria-label="ATR length" />
        </Field>
        <Field label="Box size (price units)" hint={pane?.chartType === 'range' ? 'A new bar starts when the high–low range reaches this amount.' : 'A brick prints when the close moves one box; reversals need two boxes.'}>
          <input className="input" type="number" min={0} step="any" value={size} placeholder={Number.isFinite(autoValue) ? fmtPrice(autoValue) : ''} onChange={(e) => (setSize(e.target.value), setMode('fixed'))} aria-label="Box size" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export const SHORTCUTS: [string, string][] = [
  ['Type any letter', 'Symbol search'],
  ['/', 'Studies dialog'],
  ['Ctrl/⌘ K', 'Command palette'],
  ['Alt T / H / V / F / R / M', 'Trend line / Horizontal / Vertical / Fib / Rectangle / Measure'],
  ['Esc', 'Cancel tool, deselect'],
  ['Delete / Backspace', 'Delete selected drawing'],
  ['Enter', 'Finish a path drawing'],
  ['Ctrl/⌘ Z · Ctrl/⌘ Y', 'Undo · Redo (drawings)'],
  ['← / →', 'Scroll chart'],
  ['+ / −', 'Zoom in / out'],
  ['Shift ← / →', 'Replay: step back / forward'],
  ['Alt S', 'Snapshot active chart'],
  ['Alt 1…8', 'Focus chart pane N'],
  ['?', 'This help'],
];

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => useUi.getState().set({ shortcutsOpen: o })}
      title="Keyboard shortcuts"
      width={520}
      footer={
        <button className="btn" onClick={() => (useUi.getState().set({ shortcutsOpen: false }), openPanel('guide'))}>
          Open the full guide
        </button>
      }
    >
      <table className="table">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k}>
              <td className="w-52"><span className="kbd">{k}</span></td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

interface Cmd {
  id: string;
  label: string;
  run(): void;
  group: string;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const close = () => useUi.getState().set({ paletteOpen: false });
  const cmds = useMemo<Cmd[]>(() => {
    const ws = useWorkspace.getState;
    const p = () => activePane();
    return [
      ...INTERVALS.map((iv: Interval) => ({ id: `iv-${iv}`, group: 'Interval', label: `Interval: ${iv}`, run: () => ws().setInterval(p().id, iv) })),
      ...CHART_TYPES.map((c) => ({ id: `ct-${c.id}`, group: 'Chart type', label: `Chart type: ${c.label}`, run: () => ws().updatePane(p().id, { chartType: c.id }) })),
      ...GRID_LAYOUTS.map((g) => ({ id: `g-${g.id}`, group: 'Layout', label: `Grid: ${g.label}`, run: () => ws().setGrid(g.id) })),
      ...STUDIES.map((s) => ({ id: `st-${s.id}`, group: 'Add study', label: `Add study: ${s.name}`, run: () => ws().addStudy(p().id, s.id) })),
      ...PANEL_DEFS.map((d) => ({ id: `pn-${d.id}`, group: 'Panel', label: `Open panel: ${d.title}`, run: () => openPanel(d.id) })),
      { id: 'snap', group: 'Chart', label: 'Snapshot active chart', run: () => snapshot('pane') },
      { id: 'fit', group: 'Chart', label: 'Fit all data', run: () => chartActions.get(p().id)?.fit() },
      { id: 'theme', group: 'View', label: 'Toggle dark / light theme', run: () => useSettings.getState().set({ theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }) },
      { id: 'cb', group: 'View', label: 'Toggle colorblind-safe palette', run: () => useSettings.getState().set({ palette: useSettings.getState().palette === 'colorblind' ? 'standard' : 'colorblind' }) },
      { id: 'sim', group: 'Data', label: 'Open simulated demo series (SIM:DEMO)', run: () => ws().setSymbol(p().id, 'SIM:DEMO') },
      { id: 'clear', group: 'Drawings', label: 'Remove all drawings on this symbol', run: () => useDrawings.getState().clear(p().symbol) },
    ];
  }, []);
  const list = useMemo(() => {
    const s = q.toLowerCase().trim();
    return (s ? cmds.filter((c) => c.label.toLowerCase().includes(s)) : cmds).slice(0, 60);
  }, [q, cmds]);
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
    }
  }, [open]);
  const run = (c?: Cmd) => {
    if (!c) return;
    close();
    setTimeout(() => c.run(), 0);
  };
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Command palette" width={560}>
      <input
        autoFocus
        className="h-10 w-full border-b border-border bg-transparent px-4 text-[14px] outline-none"
        placeholder="Type a command…"
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(list.length - 1, s + 1));
          }
          else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          }
          else if (e.key === 'Enter') run(list[sel]);
        }}
        aria-label="Command"
      />
      <ul className="max-h-[50vh] overflow-auto py-1" role="listbox">
        {list.map((c, k) => (
          <li key={c.id} role="option" aria-selected={k === sel} className={`flex cursor-pointer justify-between px-4 py-1.5 ${k === sel ? 'bg-raised' : ''}`} onMouseEnter={() => setSel(k)} onClick={() => run(c)}>
            <span>{c.label}</span>
            <span className="text-[10px] uppercase text-faint">{c.group}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const Icon = { info: Info, ok: CheckCircle2, warn: TriangleAlert, error: AlertCircle };
  return (
    <div className="pointer-events-none fixed bottom-10 right-3 z-[70] flex w-80 flex-col gap-2 mobile:bottom-[calc(64px+env(safe-area-inset-bottom))] mobile:left-3 mobile:w-auto" role="status" aria-live="polite">
      {toasts.map((t) => {
        const I = Icon[t.tone];
        return (
          <div key={t.id} className="toast pointer-events-auto flex gap-2 rounded-md border border-border bg-panel p-2.5 shadow-[var(--shadow)]">
            <I className={`mt-0.5 size-4 shrink-0 ${t.tone === 'ok' ? 'text-ok' : t.tone === 'warn' ? 'text-warn' : t.tone === 'error' ? 'text-danger' : 'text-accent'}`} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t.title}</div>
              {t.body && <div className="mt-0.5 break-words text-[11px] text-dim">{t.body}</div>}
              {t.action && (
                <button className="mt-1 text-[11px] text-accent underline" onClick={t.action.run}>
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="icon-btn size-5" aria-label="Dismiss" onClick={() => useUi.getState().dismiss(t.id)}>
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function StatusBar() {
  const activeId = useWorkspace((s) => s.activePaneId);
  const rt = useUi((s) => s.runtime[activeId]);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => (removeEventListener('online', on), removeEventListener('offline', off));
  }, []);
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[10px] text-faint">
      <span>Informational tool — analysis, not investment advice.</span>
      <span className="ml-auto flex items-center gap-3">
        {!online && <span className="text-warn">offline</span>}
        {rt?.provider && (
          <span title={rt.fallbacks?.length ? `Fallbacks: ${rt.fallbacks.join(' · ')}` : undefined}>
            data: {rt.provider}
            {rt.simulated ? ' (simulated)' : ''}
            {rt.fallbacks?.length ? ' ⤳' : ''}
          </span>
        )}
        {rt?.bars.length ? <span>{rt.bars.length.toLocaleString()} bars</span> : null}
        {rt?.computeMs !== undefined && rt.results.length > 0 && <span>engine {rt.computeMs.toFixed(1)} ms</span>}
        {rt?.lastUpdate && <span>updated {new Date(rt.lastUpdate).toLocaleTimeString()}</span>}
        {/* license attribution (NOTICE text + link) — stands in for the on-chart logo, which is off */}
        <span><a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-text hover:underline">Charts by TradingView Lightweight Charts™</a> © 2025 TradingView, Inc.</span>
      </span>
    </footer>
  );
}

/** Global keyboard shortcuts (TradingView muscle memory, SPEC §2). */
export function useHotkeys() {
  const typed = useRef('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest('[role=dialog]') || !!t.closest('.monaco-editor'));
      const ui = useUi.getState();
      const pane = activePane();
      const act = chartActions.get(pane.id);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.set({ paletteOpen: true });
        return;
      }
      if (editing) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useDrawings.getState().redo();
        else useDrawings.getState().undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useDrawings.getState().redo();
        return;
      }
      if (e.altKey) {
        const map: Record<string, DrawingType> = { t: 'trendline', h: 'hline', v: 'vline', f: 'fib', r: 'rect', m: 'measure' };
        const k = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
        if (map[k]) {
          e.preventDefault();
          ui.set({ tool: map[k], selectedDrawing: null });
          return;
        }
        if (k === 's') {
          e.preventDefault();
          snapshot('pane');
          return;
        }
        const d = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : NaN;
        if (d >= 1 && d <= 8) {
          const p = useWorkspace.getState().panes[d - 1];
          if (p) useWorkspace.getState().setActive(p.id);
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Escape') {
        ui.set({ tool: null, selectedDrawing: null });
        act?.cancelTool();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selectedDrawing) {
        e.preventDefault();
        useDrawings.getState().remove(pane.symbol, ui.selectedDrawing);
        ui.set({ selectedDrawing: null });
        return;
      }
      if (e.key === 'Enter') {
        act?.finishPath();
        return;
      }
      const rp = ui.replay[pane.id];
      if (rp?.active && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        ui.set({ replay: { ...ui.replay, [pane.id]: { ...rp, playing: false, index: Math.min((ui.runtime[pane.id]?.totalBars ?? Infinity) - 1, Math.max(10, rp.index + (e.key === 'ArrowRight' ? 1 : -1))) } } });
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        act?.scroll(e.key === 'ArrowLeft' ? -5 : 5);
        return;
      }
      if (e.key === '+' || e.key === '=') return act?.zoom(0.8);
      if (e.key === '-' || e.key === '_') return act?.zoom(1.25);
      if (e.key === '/') {
        e.preventDefault();
        ui.set({ studiesOpen: true });
        return;
      }
      if (e.key === '?') {
        ui.set({ shortcutsOpen: true });
        return;
      }
      // type-to-search
      if (!mod && !e.altKey && e.key.length === 1 && /[a-z0-9^]/i.test(e.key)) {
        typed.current = e.key.toUpperCase();
        ui.set({ symbolSearch: { open: true, initial: typed.current, target: 'pane' } });
        e.preventDefault();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
}

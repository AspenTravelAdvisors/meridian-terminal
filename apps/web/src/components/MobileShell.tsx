import { INTERVALS } from '@meridian/data';
import {
  Activity,
  ArrowLeft,
  Bell,
  BookOpen,
  Bot,
  Briefcase,
  Camera,
  ChartCandlestick,
  ChevronDown,
  Code2,
  EllipsisVertical,
  FlaskConical,
  FunctionSquare,
  Grid3x3,
  History,
  Info,
  Layers,
  LayoutGrid,
  List,
  Microscope,
  Moon,
  NotebookPen,
  Pencil,
  Plus,
  Radar,
  Redo2,
  ScrollText,
  Settings,
  Sun,
  Table2,
  Undo2,
  UserRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ChartPane } from '../chart/ChartPane';
import { useDrawings, useSettings, useUi, useWorkspace } from '../state/store';
import { fmtPrice } from '../lib/format';
import { CHART_TYPES, GRID_LAYOUTS } from '../state/types';
import { ReplayBar } from './ChartGrid';
import { DrawingToolbar } from './DrawingToolbar';
import { PANELS } from './panelRegistry';
import { PANEL_DEFS, setMobileOpener } from './panels';
import { snapshot } from './TopBar';
import { Menu, MenuItem, MenuLabel, MenuSep } from './ui';

type Tab = 'chart' | 'watchlist' | 'tdstatus' | 'alerts' | 'more';

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'chart', label: 'Chart', icon: <ChartCandlestick className="size-5" /> },
  { id: 'watchlist', label: 'Watchlist', icon: <List className="size-5" /> },
  { id: 'tdstatus', label: 'DeMark', icon: <Activity className="size-5" /> },
  { id: 'alerts', label: 'Alerts', icon: <Bell className="size-5" /> },
  { id: 'more', label: 'More', icon: <LayoutGrid className="size-5" /> },
];

/** Everything that is not a bottom tab, as tiles on the More screen. */
const MORE: { id: string; icon: ReactNode; blurb: string }[] = [
  { id: 'account', icon: <UserRound className="size-5" />, blurb: 'Sign in, sync your devices, push alerts' },
  { id: 'guide', icon: <BookOpen className="size-5" />, blurb: 'How every tool works and how to combine them' },
  { id: 'analyst', icon: <Bot className="size-5" />, blurb: 'Plain-English briefing from the engine output' },
  { id: 'portfolio', icon: <Briefcase className="size-5" />, blurb: 'Holdings, P&L, returns, risk, import' },
  { id: 'screener', icon: <Radar className="size-5" />, blurb: 'Scan a universe for live counts and signals' },
  { id: 'matrix', icon: <Grid3x3 className="size-5" />, blurb: 'Exhaustion state across timeframes' },
  { id: 'tester', icon: <FlaskConical className="size-5" />, blurb: 'What happened after past signals' },
  { id: 'inspector', icon: <Microscope className="size-5" />, blurb: 'Every rule checked on a bar' },
  { id: 'details', icon: <Info className="size-5" />, blurb: 'Symbol, session and data source' },
  { id: 'datawindow', icon: <Table2 className="size-5" />, blurb: 'Values of every study at a bar' },
  { id: 'objects', icon: <Layers className="size-5" />, blurb: 'Studies and drawings on the chart' },
  { id: 'journal', icon: <NotebookPen className="size-5" />, blurb: 'Notes pinned to bars, with snapshots' },
  { id: 'script', icon: <Code2 className="size-5" />, blurb: 'Write your own studies' },
  { id: 'alertlog', icon: <ScrollText className="size-5" />, blurb: 'Every alert that fired' },
];

const titleOf = (id: string) => PANEL_DEFS.find((d) => d.id === id)?.title ?? id;
const ivLabel = (iv: string) => (iv === '1D' ? 'D' : iv === '1W' ? 'W' : iv === '1M' ? 'M' : iv);

/**
 * Phone layout: the active chart fills the screen, panels open full screen from a bottom tab bar, dialogs become sheets.
 * The chart stays mounted (hidden) while a panel is shown, so switching back is instant and live updates keep flowing.
 */
export default function MobileShell() {
  const [tab, setTab] = useState<Tab>('chart');
  const [panel, setPanel] = useState<string | null>(null);
  const [draw, setDraw] = useState(false);
  const pane = useWorkspace((s) => s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0]);
  const tool = useUi((s) => s.tool);

  // other code (watchlist rows, TopBar actions, status rows) calls openPanel(): route it here
  useEffect(() => {
    setMobileOpener((id) => {
      if (id === 'watchlist' || id === 'tdstatus' || id === 'alerts') {
        setTab(id);
        setPanel(null);
      } else {
        setTab('more');
        setPanel(id);
      }
    });
    return () => {
      setMobileOpener(null);
    };
  }, []);

  // picking a symbol or timeframe anywhere (watchlist, screener, matrix, status rows) shows the chart
  const key = `${pane.symbol}|${pane.interval}`;
  const last = useRef(key);
  useEffect(() => {
    if (last.current !== key) {
      last.current = key;
      setTab('chart');
      setPanel(null);
    }
  }, [key]);

  useEffect(() => {
    if (!draw && tool) useUi.getState().set({ tool: null });
  }, [draw, tool]);

  const showChart = tab === 'chart';
  const view = tab === 'more' ? panel : tab === 'chart' ? null : tab;
  const Panel = view ? PANELS[view] : null;

  return (
    <div className="flex h-dvh flex-col bg-bg pt-[env(safe-area-inset-top)] text-text">
      <MobileTopBar draw={draw} setDraw={setDraw} onChart={() => (setTab('chart'), setPanel(null))} />
      <main className="relative min-h-0 flex-1">
        <section className="absolute inset-0 flex flex-col" style={{ visibility: showChart ? 'visible' : 'hidden' }} aria-hidden={!showChart} aria-label="Chart">
          <div className="relative min-h-0 flex-1">
            <ChartPane pane={pane} active solo />
          </div>
          {draw && <DrawingToolbar orientation="horizontal" />}
          <ReplayBar />
        </section>
        {tab === 'more' && !panel && <MoreScreen open={setPanel} />}
        {Panel && view && (
          <section className="absolute inset-0 flex flex-col bg-panel" aria-label={titleOf(view)}>
            {tab === 'more' && (
              <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-1">
                <button className="icon-btn" aria-label="Back" onClick={() => setPanel(null)}>
                  <ArrowLeft className="size-5" />
                </button>
                <h2 className="text-[14px] font-semibold">{view === 'guide' ? 'Guide' : titleOf(view)}</h2>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              <Panel />
            </div>
          </section>
        )}
      </main>
      <nav className="flex shrink-0 border-t border-border bg-panel pb-[env(safe-area-inset-bottom)]" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium [@media(max-height:500px)]:h-10 ${tab === t.id ? 'text-accent' : 'text-dim'}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => {
              setTab(t.id);
              if (t.id === 'more' && tab === 'more') setPanel(null);
            }}
          >
            {t.icon}
            <span className="[@media(max-height:500px)]:sr-only">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function MobileTopBar({ draw, setDraw, onChart }: { draw: boolean; setDraw(v: boolean): void; onChart(): void }) {
  const ws = useWorkspace();
  const pane = ws.panes.find((p) => p.id === ws.activePaneId) ?? ws.panes[0];
  const settings = useSettings();
  const ui = useUi.getState();
  const replay = useUi((s) => s.replay[pane.id]);
  const dark = document.documentElement.dataset.theme !== 'light';
  const visible = ws.panes.slice(0, GRID_LAYOUTS.find((g) => g.id === ws.grid)!.count);
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-panel px-2" role="toolbar" aria-label="Chart toolbar">
      <svg viewBox="0 0 64 64" className="size-6 shrink-0" aria-hidden>
        <path d="M8 46 L22 28 L31 36 L42 16 L56 26" fill="none" stroke="var(--accent)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="42" cy="16" r="5" fill="var(--warn)" />
      </svg>
      <button className="btn min-w-0 flex-1 justify-start font-semibold" onClick={() => ui.set({ symbolSearch: { open: true, initial: '', target: 'pane' } })} aria-label="Symbol search">
        <span className="truncate">{pane.symbol}</span>
      </button>
      <Menu
        trigger={
          <button className="btn shrink-0 font-semibold" aria-label="Interval">
            {ivLabel(pane.interval)}
            <ChevronDown className="size-3.5 text-dim" />
          </button>
        }
      >
        {INTERVALS.map((iv) => (
          <MenuItem key={iv} active={pane.interval === iv} onSelect={() => ws.setInterval(pane.id, iv)}>
            {iv}
          </MenuItem>
        ))}
      </Menu>
      <button className="icon-btn shrink-0" aria-label="Studies" onClick={() => (onChart(), ui.set({ studiesOpen: true }))}>
        <FunctionSquare className="size-5" />
      </button>
      <button className="icon-btn shrink-0" aria-label="Drawing tools" data-active={draw} aria-pressed={draw} onClick={() => (onChart(), setDraw(!draw))}>
        <Pencil className="size-5" />
      </button>
      <Menu
        align="end"
        trigger={
          <button className="icon-btn shrink-0" aria-label="More chart options">
            <EllipsisVertical className="size-5" />
          </button>
        }
      >
        <MenuLabel>Chart type</MenuLabel>
        {CHART_TYPES.map((c) => (
          <MenuItem key={c.id} active={pane.chartType === c.id} onSelect={() => ws.updatePane(pane.id, { chartType: c.id })}>
            {c.label}
          </MenuItem>
        ))}
        {(pane.chartType === 'renko' || pane.chartType === 'range') && (
          <MenuItem onSelect={() => ui.set({ boxSizePane: pane.id })} hint={pane.boxSize ? fmtPrice(pane.boxSize) : `auto · ATR ${pane.boxAtr ?? 14}`}>
            Box size…
          </MenuItem>
        )}
        <MenuSep />
        <MenuLabel>Price scale</MenuLabel>
        {(['normal', 'log', 'percent', 'indexed'] as const).map((m) => (
          <MenuItem key={m} active={pane.scaleMode === m} onSelect={() => ws.updatePane(pane.id, { scaleMode: m })}>
            {m === 'normal' ? 'Regular' : m === 'log' ? 'Logarithmic' : m === 'percent' ? 'Percent' : 'Indexed to 100'}
          </MenuItem>
        ))}
        <MenuSep />
        <MenuItem onSelect={() => (onChart(), ui.set({ symbolSearch: { open: true, initial: '', target: 'compare' } }))}>
          <span className="flex items-center gap-2"><Plus className="size-4" /> Compare symbol</span>
        </MenuItem>
        <MenuItem
          active={!!replay?.active || !!replay?.selecting}
          onSelect={() => {
            onChart();
            ui.set({ replay: { ...useUi.getState().replay, [pane.id]: { active: false, index: 0, playing: false, speed: replay?.speed ?? 2, selecting: !(replay?.selecting || replay?.active) } } });
          }}
        >
          <span className="flex items-center gap-2"><History className="size-4" /> Bar replay</span>
        </MenuItem>
        <MenuItem active={!!pane.showVolumeProfile} onSelect={() => ws.updatePane(pane.id, { showVolumeProfile: !pane.showVolumeProfile })}>
          Visible-range volume profile
        </MenuItem>
        <MenuItem onSelect={() => snapshot('pane')}>
          <span className="flex items-center gap-2"><Camera className="size-4" /> Save chart image</span>
        </MenuItem>
        <MenuItem onSelect={() => useDrawings.getState().undo()}>
          <span className="flex items-center gap-2"><Undo2 className="size-4" /> Undo drawing</span>
        </MenuItem>
        <MenuItem onSelect={() => useDrawings.getState().redo()}>
          <span className="flex items-center gap-2"><Redo2 className="size-4" /> Redo drawing</span>
        </MenuItem>
        {visible.length > 1 && (
          <>
            <MenuSep />
            <MenuLabel>Charts in this layout</MenuLabel>
            {visible.map((p, k) => (
              <MenuItem key={p.id} active={p.id === pane.id} onSelect={() => ws.setActive(p.id)}>
                {k + 1}. {p.symbol} · {p.interval}
              </MenuItem>
            ))}
          </>
        )}
        <MenuSep />
        <MenuItem onSelect={() => settings.set({ theme: dark ? 'light' : 'dark' })}>
          <span className="flex items-center gap-2">{dark ? <Sun className="size-4" /> : <Moon className="size-4" />} {dark ? 'Light theme' : 'Dark theme'}</span>
        </MenuItem>
        <MenuItem onSelect={() => ui.set({ settingsOpen: true })}>
          <span className="flex items-center gap-2"><Settings className="size-4" /> Settings</span>
        </MenuItem>
      </Menu>
    </header>
  );
}

function MoreScreen({ open }: { open(id: string): void }) {
  return (
    <section className="absolute inset-0 overflow-auto bg-panel p-3" aria-label="More tools">
      <ul className="grid grid-cols-2 gap-2">
        {MORE.map((m) => (
          <li key={m.id}>
            <button className="flex h-full w-full flex-col items-start gap-1 rounded-lg border border-border bg-panel-2 p-3 text-left active:bg-raised" onClick={() => open(m.id)}>
              <span className="text-accent">{m.icon}</span>
              <span className="text-[13px] font-semibold">{m.id === 'guide' ? 'Guide' : titleOf(m.id)}</span>
              <span className="text-[11px] leading-snug text-dim">{m.blurb}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-center text-[10px] leading-relaxed text-faint">
        Informational tool — analysis, not investment advice.
        <br />
        DeMark-style studies are Meridian's own implementations.
        <br />
        {/* license attribution (NOTICE text + link) — stands in for the on-chart logo, which is off */}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-text hover:underline">Charts by TradingView Lightweight Charts™</a> © 2025 TradingView, Inc.
      </p>
    </section>
  );
}

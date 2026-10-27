import { INTERVALS, type Interval, SYMBOL_RE } from '@meridian/data';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps, themeDark } from 'dockview-react';
import { type ComponentType, type FunctionComponent, useEffect } from 'react';
import { CommandPalette, SettingsDialog, ShortcutsDialog, StatusBar, Toasts, useHotkeys } from './components/AppChrome';
import { ChartGrid } from './components/ChartGrid';
import { DrawingToolbar } from './components/DrawingToolbar';
import { PANEL_DEFS, buildDefaultLayout, setDockApi } from './components/panels';
import { StudiesDialog, StudySettingsDialog } from './components/StudiesDialog';
import { SymbolSearch } from './components/SymbolSearch';
import { TopBar } from './components/TopBar';
import { TooltipProvider } from './components/ui';
import { AlertLogPanel, AlertsPanel, useAlertManager } from './panels/Alerts';
import { DataWindowPanel, ObjectTreePanel, RuleInspectorPanel, SymbolDetailsPanel } from './panels/ChartInfo';
import { PortfolioPanel } from './panels/Portfolio';
import { MatrixPanel, ScreenerPanel, TesterPanel } from './panels/Signals';
import { TdStatusPanel } from './panels/TdStatus';
import { WatchlistPanel } from './panels/Watchlist';
import { AnalystPanel, JournalPanel, ScriptEditorPanel } from './panels/Workbench';
import { useSettings, useWorkspace } from './state/store';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

const wrap = (C: ComponentType) => {
  const P = (_: IDockviewPanelProps) => (
    <div className="h-full min-h-0 overflow-hidden bg-panel text-text">
      <C />
    </div>
  );
  P.displayName = `Panel(${C.displayName ?? C.name})`;
  return P;
};

const PANELS: Record<string, ComponentType> = {
  watchlist: WatchlistPanel,
  details: SymbolDetailsPanel,
  alerts: AlertsPanel,
  tdstatus: TdStatusPanel,
  datawindow: DataWindowPanel,
  inspector: RuleInspectorPanel,
  objects: ObjectTreePanel,
  analyst: AnalystPanel,
  journal: JournalPanel,
  portfolio: PortfolioPanel,
  screener: ScreenerPanel,
  matrix: MatrixPanel,
  tester: TesterPanel,
  script: ScriptEditorPanel,
  alertlog: AlertLogPanel,
};

const components: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  charts: () => <ChartGrid />,
  ...Object.fromEntries(PANEL_DEFS.map((d) => [d.id, wrap(PANELS[d.id])])),
};

const dockTheme = { ...themeDark, name: 'meridian', className: 'dockview-theme-dark dockview-theme-meridian' };

function useThemeApplier() {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const t = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = t;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#ffffff' : '#0d1117');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

/** Deep links: `?symbol=BINANCE:BTCUSDT&interval=4h` opens the active chart on that market (then cleans the URL). */
function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  const symbol = q.get('symbol');
  const interval = q.get('interval');
  if (!symbol && !interval) return;
  const ws = useWorkspace.getState();
  if (symbol && SYMBOL_RE.test(symbol)) ws.setSymbol(ws.activePaneId, symbol.toUpperCase());
  if (interval && (INTERVALS as readonly string[]).includes(interval)) ws.setInterval(ws.activePaneId, interval as Interval);
  history.replaceState(null, '', location.pathname);
}
applyDeepLink();

function onReady(e: DockviewReadyEvent) {
  setDockApi(e.api);
  const saved = useWorkspace.getState().dock;
  let restored = false;
  if (saved) {
    try {
      e.api.fromJSON(saved as Parameters<typeof e.api.fromJSON>[0]);
      restored = !!e.api.getPanel('charts');
    } catch {
      restored = false;
    }
  }
  if (!restored) buildDefaultLayout(e.api);
  let t: ReturnType<typeof setTimeout> | undefined;
  e.api.onDidLayoutChange(() => {
    clearTimeout(t);
    t = setTimeout(() => useWorkspace.getState().setDock(e.api.toJSON()), 400);
  });
}

function Shell() {
  useThemeApplier();
  useHotkeys();
  useAlertManager();
  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      <a href="#main-chart" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-accent focus:px-2 focus:py-1 focus:text-white">Skip to chart</a>
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <DrawingToolbar />
        <main id="main-chart" className="min-w-0 flex-1">
          <DockviewReact components={components} onReady={onReady} theme={dockTheme} />
        </main>
      </div>
      <StatusBar />
      <SymbolSearch />
      <StudiesDialog />
      <StudySettingsDialog />
      <SettingsDialog />
      <ShortcutsDialog />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        <Shell />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

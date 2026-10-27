import { INTERVALS, type Interval, SYMBOL_RE } from '@meridian/data';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useEffect } from 'react';
import { CommandPalette, SettingsDialog, ShortcutsDialog, Toasts, useHotkeys } from './components/AppChrome';
import { StudiesDialog, StudySettingsDialog } from './components/StudiesDialog';
import { SymbolSearch } from './components/SymbolSearch';
import { TooltipProvider } from './components/ui';
import { useIsMobile } from './lib/useMedia';
import { useAlertManager } from './panels/Alerts';
import { useSettings, useWorkspace } from './state/store';

// Each shell is its own chunk: phones never download the dock library, desktops never download the mobile shell.
const DesktopShell = lazy(() => import('./components/DesktopShell'));
const MobileShell = lazy(() => import('./components/MobileShell'));

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

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

function Shell() {
  useThemeApplier();
  useHotkeys();
  useAlertManager();
  const mobile = useIsMobile();
  useEffect(() => {
    document.documentElement.dataset.shell = mobile ? 'mobile' : 'desktop';
  }, [mobile]);
  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      <Suspense fallback={<div className="grid flex-1 place-items-center text-dim">Loading Meridian…</div>}>{mobile ? <MobileShell /> : <DesktopShell />}</Suspense>
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

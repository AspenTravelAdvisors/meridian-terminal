import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps, themeDark } from 'dockview-react';
import type { ComponentType, FunctionComponent } from 'react';
import { StatusBar } from './AppChrome';
import { ChartGrid } from './ChartGrid';
import { DrawingToolbar } from './DrawingToolbar';
import { PANELS } from './panelRegistry';
import { PANEL_DEFS, buildDefaultLayout, setDockApi } from './panels';
import { useWorkspace } from '../state/store';
import { TopBar } from './TopBar';

const wrap = (C: ComponentType) => {
  const P = (_: IDockviewPanelProps) => (
    <div className="h-full min-h-0 overflow-hidden bg-panel text-text">
      <C />
    </div>
  );
  P.displayName = `Panel(${C.displayName ?? C.name})`;
  return P;
};

const components: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  charts: () => <ChartGrid />,
  ...Object.fromEntries(PANEL_DEFS.map((d) => [d.id, wrap(PANELS[d.id])])),
};

const dockTheme = { ...themeDark, name: 'meridian', className: 'dockview-theme-dark dockview-theme-meridian' };

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

/** Desktop workstation: toolbar, drawing rail and the dockable panel layout (loaded lazily — phones never fetch it). */
export default function DesktopShell() {
  return (
    <>
      <a href="#main-chart" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-accent focus:px-2 focus:py-1 focus:text-white">Skip to chart</a>
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <DrawingToolbar />
        <main id="main-chart" className="min-w-0 flex-1">
          <DockviewReact components={components} onReady={onReady} theme={dockTheme} />
        </main>
      </div>
      <StatusBar />
    </>
  );
}

import type { DockviewApi } from 'dockview-react';

export type PanelArea = 'right-top' | 'right-bottom' | 'bottom';
export const PANEL_DEFS: { id: string; title: string; area: PanelArea }[] = [
  { id: 'watchlist', title: 'Watchlist', area: 'right-top' },
  { id: 'details', title: 'Symbol', area: 'right-top' },
  { id: 'alerts', title: 'Alerts', area: 'right-top' },
  { id: 'tdstatus', title: 'DeMark Status', area: 'right-bottom' },
  { id: 'datawindow', title: 'Data Window', area: 'right-bottom' },
  { id: 'inspector', title: 'Rule Inspector', area: 'right-bottom' },
  { id: 'objects', title: 'Object Tree', area: 'right-bottom' },
  { id: 'analyst', title: 'AI Analyst', area: 'right-bottom' },
  { id: 'journal', title: 'Journal', area: 'right-bottom' },
  { id: 'portfolio', title: 'Portfolio', area: 'bottom' },
  { id: 'screener', title: 'Screener', area: 'bottom' },
  { id: 'matrix', title: 'MTF Matrix', area: 'bottom' },
  { id: 'tester', title: 'Signal Tester', area: 'bottom' },
  { id: 'script', title: 'Script Editor', area: 'bottom' },
  { id: 'alertlog', title: 'Alert Log', area: 'bottom' },
];

let api: DockviewApi | null = null;
export const setDockApi = (a: DockviewApi | null) => (api = a);
export const getDockApi = () => api;

const anchor: Record<PanelArea, string> = { 'right-top': 'watchlist', 'right-bottom': 'tdstatus', bottom: 'portfolio' };

/** Open (or focus) a panel, placing it in its home area. */
export function openPanel(id: string) {
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const def = PANEL_DEFS.find((d) => d.id === id);
  if (!def) return;
  const home = api.getPanel(anchor[def.area]) ?? api.panels.find((p) => PANEL_DEFS.find((d) => d.id === p.id)?.area === def.area);
  if (home) api.addPanel({ id, component: id, title: def.title, position: { referencePanel: home, direction: 'within' } });
  else if (def.area === 'bottom') api.addPanel({ id, component: id, title: def.title, position: { referencePanel: 'charts', direction: 'below' } });
  else api.addPanel({ id, component: id, title: def.title, position: { referencePanel: 'charts', direction: 'right' } });
}

export function buildDefaultLayout(a: DockviewApi) {
  a.clear();
  a.addPanel({ id: 'charts', component: 'charts', title: 'Charts' });
  const right = a.addPanel({ id: 'watchlist', component: 'watchlist', title: 'Watchlist', position: { referencePanel: 'charts', direction: 'right' } });
  a.addPanel({ id: 'details', component: 'details', title: 'Symbol', position: { referencePanel: 'watchlist', direction: 'within' } });
  a.addPanel({ id: 'alerts', component: 'alerts', title: 'Alerts', position: { referencePanel: 'watchlist', direction: 'within' } });
  a.addPanel({ id: 'tdstatus', component: 'tdstatus', title: 'DeMark Status', position: { referencePanel: 'watchlist', direction: 'below' } });
  for (const id of ['datawindow', 'inspector', 'objects', 'analyst', 'journal']) a.addPanel({ id, component: id, title: PANEL_DEFS.find((d) => d.id === id)!.title, position: { referencePanel: 'tdstatus', direction: 'within' } });
  const bottom = a.addPanel({ id: 'portfolio', component: 'portfolio', title: 'Portfolio', position: { referencePanel: 'charts', direction: 'below' } });
  for (const id of ['screener', 'matrix', 'tester', 'script', 'alertlog']) a.addPanel({ id, component: id, title: PANEL_DEFS.find((d) => d.id === id)!.title, position: { referencePanel: 'portfolio', direction: 'within' } });
  a.getPanel('watchlist')?.api.setActive();
  a.getPanel('tdstatus')?.api.setActive();
  a.getPanel('portfolio')?.api.setActive();
  try {
    right.group.api.setSize({ width: 330 });
    bottom.group.api.setSize({ height: 250 });
  } catch {
    /* sizing is best-effort */
  }
  a.getPanel('charts')?.api.setActive();
}

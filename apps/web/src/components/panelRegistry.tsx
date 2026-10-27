import type { ComponentType } from 'react';
import { AlertLogPanel, AlertsPanel } from '../panels/Alerts';
import { GuidePanel } from '../panels/Guide';
import { DataWindowPanel, ObjectTreePanel, RuleInspectorPanel, SymbolDetailsPanel } from '../panels/ChartInfo';
import { PortfolioPanel } from '../panels/Portfolio';
import { MatrixPanel, ScreenerPanel, TesterPanel } from '../panels/Signals';
import { TdStatusPanel } from '../panels/TdStatus';
import { WatchlistPanel } from '../panels/Watchlist';
import { AnalystPanel, JournalPanel, ScriptEditorPanel } from '../panels/Workbench';

/** Panel id → component, shared by the desktop dock and the mobile shell (ids match PANEL_DEFS). */
export const PANELS: Record<string, ComponentType> = {
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
  guide: GuidePanel,
};

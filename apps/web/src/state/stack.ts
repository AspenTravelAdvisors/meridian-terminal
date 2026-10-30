/**
 * The default chart studies: the DeMark-style stack from docs/STRATEGY.md, one study per role.
 * Only the layout's inputs differ from the study defaults; every value stays editable in the study settings.
 */
export const DEMARK_STACK: { id: string; role: string; cfg?: Record<string, unknown> }[] = [
  // setup 9 / countdown 13, plus TDST (trend filter) and setup/countdown risk levels
  { id: 'td-sequential', role: 'Primary signal · TDST · risk' },
  // the reference workspace runs Combo version 2
  { id: 'td-combo', role: 'Cross-check', cfg: { comboVersion: 'v2' } },
  // level-3 anchors and no projection targets keep the trigger lines readable on intraday charts
  { id: 'td-lines', role: 'Breakout trigger', cfg: { level: 3, showTargets: false } },
  // 6+ bars in a zone is extreme duration (trend, don't fade it); 5 or fewer is the mild reading that confirms a reversal
  { id: 'td-demarker-1', role: 'Duration confirmation', cfg: { maxDuration: 5 } },
  { id: 'td-rei', role: 'Duration confirmation', cfg: { maxDuration: 5 } },
  // where the levels above cluster into a zone, and when the counts can complete (both overlays, no extra pane)
  { id: 'meridian-zone', role: 'Where: exhaustion zone' },
  { id: 'meridian-window', role: 'When: exhaustion window' },
];

export const STACK_NAME = 'DeMark-style stack';

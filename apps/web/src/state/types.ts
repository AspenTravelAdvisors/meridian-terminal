import type { AdjustMode, Interval } from '@meridian/data';
import type { AlertSpec } from '@meridian/engine';
import type { LinkGroup, PaletteName } from '@meridian/ui';

export type ChartType = 'candles' | 'hollow' | 'bars' | 'line' | 'area' | 'baseline' | 'heikin' | 'renko' | 'range';
export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow candles' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'heikin', label: 'Heikin Ashi' },
  { id: 'renko', label: 'Renko' },
  { id: 'range', label: 'Range' },
];

export type TfBucket = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export interface OutputStyle {
  color?: string;
  width?: number;
  visible?: boolean;
}

export interface StudyInstanceCfg {
  uid: string;
  /** registry id, or 'script' for a Meridian Script study */
  id: string;
  scriptId?: string;
  cfg: Record<string, unknown>;
  style: Record<string, OutputStyle>;
  visible: boolean;
  visibility: Record<TfBucket, boolean>;
}

export type GridLayout = '1' | '2h' | '2v' | '3' | '4' | '6' | '8';
export const GRID_LAYOUTS: { id: GridLayout; label: string; count: number }[] = [
  { id: '1', label: 'Single', count: 1 },
  { id: '2h', label: '2 side by side', count: 2 },
  { id: '2v', label: '2 stacked', count: 2 },
  { id: '3', label: '3 (1 + 2)', count: 3 },
  { id: '4', label: '4 grid', count: 4 },
  { id: '6', label: '6 grid', count: 6 },
  { id: '8', label: '8 grid', count: 8 },
];

export type ScaleMode = 'normal' | 'log' | 'percent' | 'indexed';

export interface PaneConfig {
  id: string;
  symbol: string;
  interval: Interval;
  chartType: ChartType;
  studies: StudyInstanceCfg[];
  linkGroup: LinkGroup | null;
  scaleMode: ScaleMode;
  adjust: AdjustMode;
  compare: string[];
  /** Renko brick / range-bar size in price units; unset or 0 = auto (ATR-based) */
  boxSize?: number;
  /** ATR length used to size boxes in auto mode (default 14) */
  boxAtr?: number;
  showVolumeProfile?: boolean;
}

export type DrawingType =
  | 'trendline'
  | 'ray'
  | 'extended'
  | 'hline'
  | 'hray'
  | 'vline'
  | 'channel'
  | 'fib'
  | 'fibext'
  | 'fibtime'
  | 'rect'
  | 'ellipse'
  | 'path'
  | 'text'
  | 'pricelabel'
  | 'long'
  | 'short'
  | 'measure';

export interface DrawingPoint {
  /** bar open time (ms, UTC) — fractional positions between bars are allowed */
  t: number;
  p: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  points: DrawingPoint[];
  color: string;
  width: number;
  dash: 'solid' | 'dashed' | 'dotted';
  fill?: string;
  text?: string;
  locked: boolean;
  hidden: boolean;
  z: number;
}

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  palette: PaletteName;
  syncCrosshair: boolean;
  syncTime: boolean;
  syncInterval: boolean;
  magnet: 'off' | 'weak' | 'strong';
  timezone: 'exchange' | 'utc' | 'local';
  live: boolean;
  defaultAdjust: AdjustMode;
  showHeatStrip: boolean;
  showLegendValues: boolean;
  /** draw provisional (forming-bar) counts hollow — SPEC §8.1 */
  hollowProvisional: boolean;
  /** explain chart elements (counts, levels, lines) on hover and click/tap */
  chartTips: boolean;
  /** after a symbol or interval change: snap the newest bar to the right edge, or keep the previous distance from it */
  viewOnChange: 'latest' | 'keep';
  confirmBeforeDelete: boolean;
}

/** Alert conditions and specs are shared with the server scheduler (packages/engine/src/signals/alerts.ts). */
export type { AlertCondition } from '@meridian/engine';
export interface Alert extends AlertSpec {
  interval: Interval;
  /** a price alert that follows a key level from AI analyst briefings (updated by each new briefing of the same chart) */
  track?: AlertTrack;
}

export interface AlertTrack {
  source: 'analyst';
  /** level key as it appears in the briefing snapshot, e.g. "Seq tdstBuy" */
  key: string;
  /** the name Meridian last generated; a renamed alert keeps the user's name */
  autoName: string;
  /** creation time of the briefing that last set the value */
  updatedAt: number;
  /** the latest briefing of this chart no longer has this level (the last value is kept) */
  stale?: boolean;
}

// ── AI analyst ─────────────────────────────────────────────────────────────
export type AnalystKind = 'chart' | 'portfolio';

/** A numeric key level taken from the engine snapshot sent with a briefing. */
export interface AnalystLevel {
  key: string;
  value: number;
}

/** The most recent briefing; held (and persisted) until the user asks for a new one. */
export interface AnalystRun {
  id: string;
  kind: AnalystKind;
  symbol?: string;
  interval?: Interval;
  question?: string;
  text: string;
  /** model id, 'rule-based', or null before the server answered */
  engine: string | null;
  createdAt: number;
  status: 'streaming' | 'done' | 'error' | 'stopped';
  error?: string;
  levels: AnalystLevel[];
  /** last close of the chart when the snapshot was taken */
  lastClose?: number;
  simulated?: boolean;
  /** result of updating level alerts after this briefing */
  levelSync?: { updated: number; stale: number };
  /** id in the saved library, once saved */
  savedId?: string;
}

export interface SavedAnalysis {
  id: string;
  title: string;
  tags: string[];
  kind: AnalystKind;
  symbol?: string;
  interval?: Interval;
  question?: string;
  text: string;
  engine: string | null;
  levels: AnalystLevel[];
  lastClose?: number;
  simulated?: boolean;
  /** when the briefing was generated */
  createdAt: number;
  updatedAt: number;
}

export interface AlertLogEntry {
  id: string;
  alertId: string;
  name: string;
  symbol: string;
  interval: Interval;
  at: number;
  barT: number;
  message: string;
  provisional: boolean;
  delivered: string[];
}

export interface JournalNote {
  id: string;
  symbol: string;
  interval: Interval;
  /** bar time the note is attached to (optional) */
  barT?: number;
  tradeId?: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  /** IndexedDB key of an attached screenshot */
  imageKey?: string;
}

export interface UserScript {
  id: string;
  name: string;
  code: string;
  inputs: Record<string, number>;
  updatedAt: number;
}

export interface SavedLayout {
  id: string;
  name: string;
  savedAt: number;
  grid: GridLayout;
  panes: PaneConfig[];
  dock: unknown;
}

export interface StudyTemplate {
  id: string;
  name: string;
  studies: Omit<StudyInstanceCfg, 'uid'>[];
}

import type { z } from 'zod';

/** Normalized OHLCV bar. `t` is the bar OPEN time in epoch ms (UTC). */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** false while the bar is still forming (live). Defaults to true. */
  final?: boolean;
}

export type Category =
  | 'DeMark'
  | 'Trend'
  | 'Momentum'
  | 'Volatility'
  | 'Volume'
  | 'Ichimoku'
  | 'Meridian'
  | 'Custom';

/** Semantic colour roles resolved by the theme (and the colorblind-safe palette). */
export type ColorRole =
  | 'bull'
  | 'bear'
  | 'bullAlt'
  | 'bearAlt'
  | 'neutral'
  | 'warn'
  | 'info'
  | 'accent'
  | 'muted';

export type Color = ColorRole | `#${string}` | `rgba(${string})`;

export type Pane = 'price' | 'own';

export interface LineOutput {
  kind: 'line';
  id: string;
  title: string;
  color: Color;
  width?: number;
  style?: 'solid' | 'dashed' | 'dotted';
  /** 'level' lines are horizontal levels: runs of equal values are drawn as discrete segments. */
  render?: 'line' | 'step' | 'level' | 'dots';
  /** Plot the value N bars to the right (+) or left (−) of the bar that computed it (Ichimoku). */
  offset?: number;
  /** Label printed at the right end of level segments. */
  label?: string;
  hiddenByDefault?: boolean;
}

export interface HistogramOutput {
  kind: 'histogram';
  id: string;
  title: string;
  color: Color;
  negColor?: Color;
  hiddenByDefault?: boolean;
}

export interface CloudOutput {
  kind: 'cloud';
  id: string;
  title: string;
  /** ids of the two line outputs bounding the cloud */
  a: string;
  b: string;
  upColor: Color;
  downColor: Color;
  offset?: number;
}

export interface HLineOutput {
  kind: 'hline';
  id: string;
  title: string;
  value: number;
  color: Color;
  style?: 'solid' | 'dashed' | 'dotted';
}

/** A numeric column that is not drawn (counts, states) but is shown in the Data Window and used by golden tests. */
export interface DataOutput {
  kind: 'data';
  id: string;
  title: string;
}

/**
 * Text labels drawn from a numeric column (one per bar, NaN = none) instead of one Marker object per bar.
 * Sign selects the side: value > 0 → above the bar in `posColor`, value < 0 → below in `negColor`;
 * the text is |value|. Used for the dense setup/countdown numbers (tens of thousands per chart).
 */
export interface LabelsOutput {
  kind: 'labels';
  id: string;
  title: string;
  row: number;
  posColor: Color;
  negColor: Color;
  /** |value| above this is drawn muted (e.g. setup extension 10+) */
  mutedAbove?: number;
  size?: 1 | 2 | 3;
}

export type OutputSpec = LineOutput | HistogramOutput | CloudOutput | HLineOutput | DataOutput | LabelsOutput;

export interface SignalSpec {
  id: string;
  dir: SignalDir;
  description: string;
}

export type SignalDir = 'bull' | 'bear' | 'neutral';

export type MarkerPos = 'above' | 'below' | 'at';

export interface Marker {
  /** bar index where the marker is drawn */
  i: number;
  /** bar index at which the marker became known (≥ i). Used for no-look-ahead checks and replay. */
  at: number;
  text: string;
  pos: MarkerPos;
  color: Color;
  /** stacking row away from the bar (0 = closest) so several studies can label the same bar */
  row?: number;
  size?: 1 | 2 | 3;
  /** hollow = unperfected / unconfirmed; muted = extension / low emphasis */
  style?: 'solid' | 'hollow' | 'muted' | 'boxed';
  price?: number;
  tooltip?: string;
  provisional?: boolean;
}

export interface SignalEvent {
  i: number;
  id: string;
  dir: SignalDir;
  study: string;
  price?: number;
  label?: string;
  provisional?: boolean;
}

/** Geometry describing the *current* state (e.g. D-Wave pivots, TD Lines). Rebuilt every bar. */
export interface Pivot {
  i: number;
  price: number;
  label: string;
  locked: boolean;
  /** where this pivot was first recognised, when it has since shifted right (drawn as "+") */
  first?: { i: number; price: number };
}

export interface Segment {
  i1: number;
  p1: number;
  i2: number;
  p2: number;
  color: Color;
  label?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  width?: number;
  /** extend to the right edge of the chart */
  extend?: boolean;
}

export interface Geometry {
  pivots?: Pivot[];
  polylineColor?: Color;
  segments?: Segment[];
  /** volume profiles (per session or a fixed range) drawn as horizontal histograms */
  profiles?: VolumeProfile[];
  /** time markers that may lie in the future (index > last bar) */
  timeMarks?: { i: number; label: string }[];
}

export interface VolumeProfile {
  i1: number;
  i2: number;
  rows: { p1: number; p2: number; vol: number; up: number }[];
  poc: number;
  vah: number;
  val: number;
  total: number;
}

export interface InspectRow {
  study: string;
  rule: string;
  pass: boolean;
  detail?: string;
}

/** Shared bar history passed to every study. Arrays may be longer than `len`; read only indices < len. */
export interface SeriesCtx {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  /** number of valid bars, including a provisional bar if one is being evaluated */
  len: number;
  /** interval duration in ms (0 if unknown) */
  intervalMs: number;
  /** auxiliary aligned series (benchmark closes, HTF data), keyed by name */
  aux: Record<string, Float64Array>;
}

export interface Writer {
  /** current bar index */
  i: number;
  provisional: boolean;
  line(k: number, v: number): void;
  marker(m: Omit<Marker, 'at' | 'provisional'>): void;
  signal(id: string, dir: SignalDir, price?: number, label?: string): void;
  /** Rule Inspector hook; a no-op unless the runner is inspecting this bar. */
  inspect(rule: string, pass: boolean, detail?: string): void;
  inspecting: boolean;
}

/**
 * A study definition. `init` returns a PLAIN, structured-cloneable state object (no class instances,
 * no closures) so the runner can fork it to evaluate a provisional bar without touching committed state.
 */
export interface StudyDef<Cfg extends object = Record<string, unknown>, S = unknown> {
  id: string;
  name: string;
  shortName: string;
  version: string;
  category: Category;
  description: string;
  /** true → draws on the price pane; false → own pane */
  overlay: boolean;
  schema: z.ZodType<Cfg>;
  presets?: Record<string, Partial<Cfg>>;
  /** ⚠ VERIFY knobs, documented in docs/VERIFY_LOG.md */
  verify?: { key: string; note: string }[];
  outputs(cfg: Cfg): OutputSpec[];
  signals?: SignalSpec[];
  /** true when outputs depend on the ORDER of intrabar ticks (live data can legitimately differ from history) */
  intrabar?: boolean;
  /** auxiliary series this study needs, e.g. ['benchmark'] */
  needsAux?(cfg: Cfg): string[];
  init(cfg: Cfg): S;
  /**
   * Process bar `i` (0-based; history in ctx up to and including i).
   * `intra` is a scratch object that persists across provisional ticks of the same bar and is
   * cleared after the bar is committed (used by intrabar-sequenced studies such as Range Projection).
   */
  update(cfg: Cfg, s: S, ctx: SeriesCtx, w: Writer, intra: Record<string, unknown>): void;
  /** Current-state geometry (pivots, sloped lines). */
  geometry?(cfg: Cfg, s: S, ctx: SeriesCtx): Geometry;
  /** Compact state summary for status cards / MTF matrix / screener. */
  status?(cfg: Cfg, s: S, ctx: SeriesCtx): StudyStatus;
  /** Map result columns to golden-fixture columns (INDICATORS.md §0). */
  golden?(r: StudyResult, i: number): Record<string, number>;
}

export interface StudyStatus {
  /** short chips such as "B-Setup 7", "S-CD 12" */
  chips: { text: string; dir: SignalDir; strength?: number }[];
  values?: Record<string, number | string | boolean | null>;
}

export interface StudyResult {
  id: string;
  len: number;
  outputs: OutputSpec[];
  lines: Record<string, Float64Array>;
  markers: Marker[];
  signals: SignalEvent[];
  geometry: Geometry;
  status: StudyStatus | null;
  /** true when the last bar was evaluated provisionally */
  provisional: boolean;
  inspect?: InspectRow[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStudyDef = StudyDef<any, any>;

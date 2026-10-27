/** Bars of empty space kept to the right of the newest bar. */
export const RIGHT_MARGIN = 3;
/** Bars shown when a chart opens with no earlier view to copy. */
export const DEFAULT_SPAN = 160;

/**
 * A chart view relative to its newest bar, so it survives a change of symbol or interval.
 * `span`: bars across the visible width (the zoom). `offset`: bars between the newest bar and the right edge
 * (positive = empty space, negative = the newest bar is scrolled off to the right).
 */
export interface View {
  span: number;
  offset: number;
}

export type AnchorMode = 'latest' | 'keep';

export const viewOf = (range: { from: number; to: number }, n: number): View => ({ span: range.to - range.from, offset: range.to - (n - 1) });

/** True while the newest bar is on screen at (or near) the right edge, i.e. the chart is following new bars. */
export const following = (v: View) => v.offset >= -1;

/**
 * Logical range for a freshly loaded series of `n` bars. Keeps the previous zoom; 'latest' puts the newest bar at the
 * right edge, 'keep' preserves the previous distance from the newest bar (clamped so some bars stay visible).
 */
export function anchoredRange(n: number, prior: View | null, mode: AnchorMode): { from: number; to: number } {
  const span = Math.max(10, prior?.span ?? DEFAULT_SPAN + RIGHT_MARGIN);
  let offset = mode === 'keep' && prior ? prior.offset : RIGHT_MARGIN;
  offset = Math.max(offset, -(n - Math.min(n, 10)));
  const to = n - 1 + offset;
  return { from: to - span, to };
}

/**
 * Hide the labels of count runs that ended before reaching `length` (a setup that reset before 9).
 *
 * A run is a stretch of bars with a non-zero count of one sign; a sign change or a count that does not rise starts a new
 * run. The run still open at the last final bar (`openFrom` − 1) stays visible, so a forming bar that breaks it only hides
 * it once that bar closes. This is display-only: the engine's columns are never rewritten, so its output for a closed bar
 * cannot change when later bars arrive (CLAUDE.md rule 3). Returns a new array; `labels` is not modified.
 */
export function dropFailedRuns(labels: Float64Array, counts: ArrayLike<number>, length: number, openFrom: number): Float64Array {
  const out = Float64Array.from(labels);
  const n = Math.min(out.length, counts.length);
  let start = -1;
  let peak = 0;
  const close = (end: number) => {
    if (start >= 0 && peak < length && end < openFrom) out.fill(NaN, start, end);
    start = -1;
  };
  for (let i = 0; i < n; i++) {
    const c = counts[i];
    if (!c) {
      close(i);
      continue;
    }
    const p = counts[i - 1];
    if (start < 0 || Math.sign(c) !== Math.sign(p) || Math.abs(c) <= Math.abs(p)) {
      close(i);
      start = i;
      peak = 0;
    }
    peak = Math.max(peak, Math.abs(c));
  }
  close(n);
  return out;
}

import { combo } from '../studies/demark/combo';
import { sequential } from '../studies/demark/sequential';
import { defaultsOf } from '../core/params';
import { computeStudies } from '../core/runner';
import type { Bar, SignalDir } from '../core/types';

/** One cell of the MTF matrix: Sequential + Combo state on one symbol/timeframe. */
export interface MatrixCell {
  label: string;
  dir: SignalDir;
  /** signed exhaustion score in [−1, 1]: + = buy-side (downtrend exhaustion), − = sell-side */
  score: number;
  detail: Record<string, number | null>;
}

export interface MatrixWeights {
  setup: number;
  setup9: number;
  countdown: number;
  cd13: number;
  combo: number;
  combo13: number;
}

export const DEFAULT_MATRIX_WEIGHTS: MatrixWeights = { setup: 0.5, setup9: 1, countdown: 1, cd13: 2, combo: 0.75, combo13: 1.5 };

const SEQ = defaultsOf(sequential);
const CMB = defaultsOf(combo);

/** A 9 or 13 counts as "fresh" for 3 bars after it completes. */
const isRecent = (v: Record<string, number | null>, k: string) => typeof v[k] === 'number' && (v[k] as number) <= 3;

/**
 * Signed exhaustion score in [−1, 1] from a cell's `detail` (+ buy-side, − sell-side). Exported so the UI can
 * re-weight cells without refetching and still score them exactly as `matrixCell` does.
 */
export function matrixScore(v: Record<string, number | null>, w: MatrixWeights = DEFAULT_MATRIX_WEIGHTS): number {
  const side = (buy: boolean) => {
    const p = buy ? 'buy' : 'sell';
    const P = buy ? 'Buy' : 'Sell';
    let s = 0;
    let tot = 0;
    const add = (wt: number, x: number) => {
      s += wt * x;
      tot += wt;
    };
    add(w.setup, Math.min(1, ((v[`${p}Setup`] as number) ?? 0) / 9));
    add(w.setup9, isRecent(v, `barsSince${P}9`) ? 1 : 0);
    add(w.countdown, ((v[`${p}Countdown`] as number) ?? 0) / 13);
    add(w.cd13, isRecent(v, `barsSince${P}13`) ? 1 : 0);
    add(w.combo, ((v[`${p}Combo`] as number) ?? 0) / 13);
    add(w.combo13, isRecent(v, `barsSince${P}Combo13`) ? 1 : 0);
    return tot > 0 ? s / tot : 0;
  };
  return side(true) - side(false);
}

/** Compute a matrix cell from raw bars (runs Sequential + Combo). */
export function matrixCell(bars: readonly Bar[], w: MatrixWeights = DEFAULT_MATRIX_WEIGHTS): MatrixCell {
  if (bars.length < 10) return { label: '—', dir: 'neutral', score: 0, detail: {} };
  const [seq, cmb] = computeStudies(
    [
      { def: sequential, cfg: SEQ },
      { def: combo, cfg: CMB },
    ],
    bars,
  );
  // Sequential and Combo both report barsSinceBuy13/barsSinceSell13; keep Combo's under its own keys
  const cv = (cmb.status?.values ?? {}) as Record<string, number | null>;
  const v: Record<string, number | null> = {
    ...(seq.status?.values ?? {}),
    buyCombo: cv.buyCombo ?? null,
    sellCombo: cv.sellCombo ?? null,
    barsSinceBuyCombo13: cv.barsSinceBuy13 ?? null,
    barsSinceSellCombo13: cv.barsSinceSell13 ?? null,
  };
  const recent = (k: string) => isRecent(v, k);
  const score = matrixScore(v, w);
  // label: most advanced state
  const parts: string[] = [];
  if (recent('barsSinceBuy13')) parts.push('B13');
  else if (recent('barsSinceSell13')) parts.push('S13');
  else if (v.buyCountdown) parts.push(`B-CD${v.buyCountdown}`);
  else if (v.sellCountdown) parts.push(`S-CD${v.sellCountdown}`);
  if (v.buySetup) parts.push(`B${v.buySetup}`);
  else if (v.sellSetup) parts.push(`S${v.sellSetup}`);
  if (recent('barsSinceBuyCombo13')) parts.push('Cb13');
  else if (recent('barsSinceSellCombo13')) parts.push('Cs13');
  else if (v.buyCombo) parts.push(`Cb${v.buyCombo}`);
  else if (v.sellCombo) parts.push(`Cs${v.sellCombo}`);
  return { label: parts.join(' ') || '·', dir: score > 0.05 ? 'bull' : score < -0.05 ? 'bear' : 'neutral', score, detail: v };
}

/** Row confluence: weighted mean of cell scores across timeframes (weights per timeframe). */
export function rowConfluence(cells: (MatrixCell | null)[], tfWeights: number[]): number {
  let s = 0;
  let t = 0;
  cells.forEach((c, k) => {
    if (!c) return;
    s += (tfWeights[k] ?? 1) * c.score;
    t += tfWeights[k] ?? 1;
  });
  return t > 0 ? (100 * s) / t : 0;
}

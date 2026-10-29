import { computeStudy, defaultsOf, sequential } from '@meridian/engine';
import { describe, expect, it } from 'vitest';
import { dropFailedRuns } from '../src/chart/labels';

const f = (a: number[]) => Float64Array.from(a);
const shown = (a: Float64Array) => Array.from(a, (v) => (Number.isFinite(v) && v !== 0 ? v : 0));

describe('dropFailedRuns (failed setups are hidden, as on reference DeMark charts)', () => {
  // counts: buy runs negative, sell runs positive, 0 = no setup; labels omit the 9 itself (drawn as a marker)
  const counts = [0, -1, -2, -3, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, -1, -2];
  const labels = counts.map((c) => (c === 0 || Math.abs(c) === 9 ? NaN : c));

  it('hides a run that reset before 9, keeps a completed run and the run still open at the last bar', () => {
    const out = dropFailedRuns(f(labels), counts, 9, counts.length);
    expect(shown(out)).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 10, 0, -1, -2]);
  });

  it('keeps a run that only the forming (provisional) bar broke, until that bar closes', () => {
    const c = [0, -1, -2, -3, 0];
    const l = c.map((v) => (v === 0 ? NaN : v));
    expect(shown(dropFailedRuns(f(l), c, 9, 4))).toEqual([0, -1, -2, -3, 0]);
    expect(shown(dropFailedRuns(f(l), c, 9, 5))).toEqual([0, 0, 0, 0, 0]);
  });

  it('splits back-to-back runs: a sign change or a restart at 1 begins a new run', () => {
    const c = [-1, -2, 1, 2, 3, 1, 2];
    expect(shown(dropFailedRuns(f(c), c, 9, c.length))).toEqual([0, 0, 0, 0, 0, 1, 2]);
  });

  it('does not change its input', () => {
    const l = f(labels);
    dropFailedRuns(l, counts, 9, counts.length);
    expect(Array.from(l)).toEqual(Array.from(f(labels)));
  });
});

describe('Sequential setup labels', () => {
  it('ask the chart to hide failed setups by default, and not when "Show failed setups" is on', () => {
    const lbl = (cfg: Record<string, unknown>) => sequential.outputs({ ...defaultsOf(sequential), ...cfg } as never).find((o) => o.id === 'setup_lbl');
    expect(lbl({})).toMatchObject({ hideFailedRuns: { count: 'setup', length: 9 } });
    expect(lbl({ showFailedSetups: true })).not.toHaveProperty('hideFailedRuns');
  });

  it('leave the engine output itself unchanged (no look-ahead: hiding happens only when drawing)', () => {
    const closes = [10, 11, 12, 13, 14, 13, 12, 11, 10, 11, 12, 13, 14, 15];
    const bars = closes.map((c, i) => ({ t: i * 86_400_000, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 }));
    const a = computeStudy(sequential, defaultsOf(sequential), bars);
    const b = computeStudy(sequential, { ...defaultsOf(sequential), showFailedSetups: true }, bars);
    expect(Array.from(a.lines.setup_lbl)).toEqual(Array.from(b.lines.setup_lbl));
  });
});

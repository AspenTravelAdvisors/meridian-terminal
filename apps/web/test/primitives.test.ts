import { getStudy, resolveConfig } from '@meridian/engine';
import { describe, expect, it } from 'vitest';
import { layoutPivotLabels, logicalX } from '../src/chart/primitives';
import { DEMARK_STACK } from '../src/state/stack';

// Lightweight Charts 5.2's time scale: integer logicals map to bar centres, anything else to 0
const chart = (spacing = 8, offset = 100) => ({
  timeScale: () => ({ logicalToCoordinate: (l: number) => (Number.isInteger(l) ? offset + l * spacing : 0) }),
});

describe('logicalX', () => {
  it('interpolates half-bar edges instead of collapsing them to 0 (TDST and risk levels vanished)', () => {
    const c = chart() as never;
    expect(logicalX(c, 10)).toBe(180);
    expect(logicalX(c, 9.5)).toBe(176);
    expect(logicalX(c, 10.5)).toBe(184);
    expect(logicalX(c, -0.5)).toBe(96);
  });

  it('returns null without a chart or for a non-finite logical', () => {
    expect(logicalX(null, 3)).toBeNull();
    expect(logicalX(chart() as never, NaN)).toBeNull();
  });
});

describe('default DeMark-style stack', () => {
  it('names real studies, and their layout inputs survive config resolution', () => {
    for (const s of DEMARK_STACK) {
      const def = getStudy(s.id);
      expect(def, s.id).toBeDefined();
      const cfg = resolveConfig(def!, s.cfg ?? {});
      for (const [k, v] of Object.entries(s.cfg ?? {})) expect(cfg[k], `${s.id}.${k}`).toEqual(v);
    }
  });
});

describe('layoutPivotLabels', () => {
  const box = (x: number, y: number, text: string) => ({ x1: x - 3.5 * text.length - 2, x2: x + 3.5 * text.length + 2, y1: y - 10, y2: y + 2 });
  const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

  it('leaves labels that do not touch where they are', () => {
    expect(layoutPivotLabels([
      { x: 100, y: 50, text: '5', dir: -1 },
      { x: 140, y: 50, text: '0', dir: -1 },
      { x: 100, y: 200, text: '2', dir: 1 },
    ])).toEqual([50, 50, 200]);
  });

  it('stacks an up-sequence and a down-sequence label on the same bar instead of overprinting (5 over 0)', () => {
    const ys = layoutPivotLabels([
      { x: 100, y: 50, text: '5', dir: -1 },
      { x: 100, y: 50, text: '0', dir: -1 },
    ]);
    expect(ys).toEqual([50, 38]);
    // troughs step downward
    expect(layoutPivotLabels([
      { x: 100, y: 200, text: 'C', dir: 1 },
      { x: 103, y: 205, text: '4', dir: 1 },
    ])).toEqual([200, 217]);
  });

  it('never leaves two labels overlapping, however tightly they cluster', () => {
    const items = Array.from({ length: 12 }, (_, k) => ({ x: 100 + (k % 4) * 3, y: 80 + (k % 3) * 4, text: k % 2 ? 'B' : '3', dir: -1 as const }));
    const ys = layoutPivotLabels(items, 32);
    const boxes = items.map((it, k) => box(it.x, ys[k], it.text));
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) expect(overlaps(boxes[a], boxes[b]), `${a}/${b}`).toBe(false);
    // each label only ever moves away from its pivot
    ys.forEach((y, k) => expect(y).toBeLessThanOrEqual(items[k].y));
  });
});

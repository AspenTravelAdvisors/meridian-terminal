import { getStudy, resolveConfig } from '@meridian/engine';
import { describe, expect, it } from 'vitest';
import { logicalX } from '../src/chart/primitives';
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

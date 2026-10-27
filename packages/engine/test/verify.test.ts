import { describe, expect, it } from 'vitest';
import { type AnyStudyDef, STUDIES, combo, defaultsOf, demarker2, differential, dwave, openPatterns, pressure, propulsion, rei, sequential, tdMa1, tdMa2 } from '../src';

/**
 * Pins every ⚠ VERIFY default from docs/INDICATORS.md (CLAUDE.md rule 1). Changing one of these values is a
 * deliberate decision: update docs/VERIFY_LOG.md in the same commit.
 */
describe('⚠ VERIFY defaults are pinned', () => {
  it('Sequential: TDST over all setup bars, CD13 low vs CD8 close, recycle at 100–200% or a 22-bar setup, whole-bar TDST cancel', () => {
    const d = defaultsOf(sequential);
    expect(d).toMatchObject({ tdstMode: 'allSetupBars', cd13Qualifier: 'low_vs_cd8_close', recycleMode: 'size', recycleFactor: 2, recycleOnLongSetup: true, recycleSetupCount: 22, cancelOnOppositeSetup: true, cancelOnTdstBreak: true, tdstCancelTest: 'trueExtreme', tdstBreakQualifier: false, cd8Qualifier: false, reactionBars: 12 });
  });

  it('Combo: same cancellation and recycling defaults as Sequential, and no intersection (Sequential only)', () => {
    const d = defaultsOf(combo) as Record<string, unknown>;
    expect(d).toMatchObject({ recycleFactor: 2, recycleOnLongSetup: true, recycleSetupCount: 22, tdstCancelTest: 'trueExtreme', reactionBars: 12 });
    expect(d).not.toHaveProperty('requireIntersection');
  });

  it('Combo: version 2 relaxes the countdown from bar 11', () => {
    expect(defaultsOf(combo).v2From).toBe(11);
  });

  it('D-Wave: 21/13/8/21/13/21/13/8/21 ladder on highs/lows, N-bar high = at or above the previous N', () => {
    const d = defaultsOf(dwave);
    expect([d.lbOrigin, d.lbW1, d.lbW2, d.lbW3, d.lbW4, d.lbW5, d.lbA, d.lbB, d.lbC]).toEqual([21, 13, 8, 21, 13, 21, 13, 8, 21]);
    expect(d).toMatchObject({ basis: 'highLow', nBarTest: 'atLeastPriorN' });
  });

  it('Propulsion: ratio 0.236, trigger P + M, target P + 2M', () => {
    const r = defaultsOf(propulsion).propulsionRules as Record<string, unknown>;
    expect(r).toMatchObject({ propRatio: 0.236, targetMult: 2, pointLevel: 2, refPrice: 'swingHigh', requireAboveA: true });
  });

  it('DeMarker II: plain low/high components, prior-close terms clamped at 0', () => {
    expect(defaultsOf(demarker2)).toMatchObject({ rangeBasis: 'plain', clampPriorClose: true });
  });

  it('REI: overlap lags 5/6 and 7/8', () => {
    const d = defaultsOf(rei);
    expect([d.lagA1, d.lagA2, d.lagB1, d.lagB2]).toEqual([5, 6, 7, 8]);
  });

  it('TD Pressure: 5-bar, volume-weighted', () => {
    expect(defaultsOf(pressure)).toMatchObject({ length: 5, useVolume: true });
  });

  it('Sequential: intersection is elective (off) and may be confirmed by any later bar', () => {
    expect(defaultsOf(sequential)).toMatchObject({ requireIntersection: false, intersectionScope: 'anyLaterBar' });
  });

  it('Differential: Anti-Differential on (down, down, up, down + up-bar low check); Reverse Differential off (unresolved)', () => {
    expect(defaultsOf(differential)).toMatchObject({ anti: true, antiPattern: 'D,D,U,D', antiUpBarLow: true, reverse: false });
  });

  it('TD Open reverses to the prior close; TD MA II has no offset by default', () => {
    expect(defaultsOf(openPatterns).openRef).toBe('priorClose');
    expect(defaultsOf(tdMa2).offsetPct).toBe(0);
  });

  it('TD MA I 5/12/4 and MA II 3/34', () => {
    expect(defaultsOf(tdMa1)).toMatchObject({ maLength: 5, lookback: 12, activeBars: 4 });
    expect(defaultsOf(tdMa2)).toMatchObject({ fast: 3, slow: 34 });
  });

  it('every study that declares VERIFY keys exposes them as config inputs', () => {
    for (const s of STUDIES as AnyStudyDef[]) {
      const d = defaultsOf(s) as Record<string, unknown>;
      for (const v of s.verify ?? []) expect(d, `${s.id}.${v.key}`).toHaveProperty(v.key);
    }
  });
});

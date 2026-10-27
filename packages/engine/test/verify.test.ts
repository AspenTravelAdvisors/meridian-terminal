import { describe, expect, it } from 'vitest';
import { type AnyStudyDef, STUDIES, combo, defaultsOf, demarker2, differential, dwave, pressure, propulsion, rei, sequential, tdMa1, tdMa2 } from '../src';

/**
 * Pins every ⚠ VERIFY default from docs/INDICATORS.md (CLAUDE.md rule 1). Changing one of these values is a
 * deliberate decision: update docs/VERIFY_LOG.md in the same commit.
 */
describe('⚠ VERIFY defaults are pinned', () => {
  it('Sequential: TDST over all setup bars, CD13 low vs CD8 close, recycle at 1.618× by size', () => {
    const d = defaultsOf(sequential);
    expect(d).toMatchObject({ tdstMode: 'allSetupBars', cd13Qualifier: 'low_vs_cd8_close', recycleMode: 'size', recycleFactor: 1.618, recycleOn18: false, cancelOnOppositeSetup: true, cancelOnTdstBreak: true, tdstCancelTest: 'close', tdstBreakQualifier: false });
  });

  it('Combo: version 2 relaxes the countdown from bar 11', () => {
    expect(defaultsOf(combo).v2From).toBe(11);
  });

  it('D-Wave: 21/13/8/21/13/21/13/8/21 lookback ladder', () => {
    const d = defaultsOf(dwave);
    expect([d.lbOrigin, d.lbW1, d.lbW2, d.lbW3, d.lbW4, d.lbW5, d.lbA, d.lbB, d.lbC]).toEqual([21, 13, 8, 21, 13, 21, 13, 8, 21]);
  });

  it('Propulsion: ratio 0.236, trigger P + M, target P + 2M', () => {
    const r = defaultsOf(propulsion).propulsionRules as Record<string, unknown>;
    expect(r).toMatchObject({ propRatio: 0.236, targetMult: 2, pointLevel: 2, refPrice: 'swingHigh', requireAboveA: true });
  });

  it('DeMarker II: all four buying/selling-pressure components enabled', () => {
    expect(defaultsOf(demarker2)).toMatchObject({ bpHighVsPriorClose: true, bpCloseVsTrueLow: true, spPriorCloseVsLow: true, spTrueHighVsClose: true });
  });

  it('REI: overlap lags 5/6 and 7/8', () => {
    const d = defaultsOf(rei);
    expect([d.lagA1, d.lagA2, d.lagB1, d.lagB2]).toEqual([5, 6, 7, 8]);
  });

  it('TD Pressure: 5-bar, volume-weighted', () => {
    expect(defaultsOf(pressure)).toMatchObject({ length: 5, useVolume: true });
  });

  it('Sequential: intersection-failure cancellation off (rule unconfirmed)', () => {
    expect(defaultsOf(sequential).cancelOnIntersectionFailure).toBe(false);
  });

  it('Differential: Anti-Differential off until its sequence is verified', () => {
    expect(defaultsOf(differential).anti).toBe(false);
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

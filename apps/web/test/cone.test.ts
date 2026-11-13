import { describe, expect, it } from 'vitest';
import { coneReading } from '../src/lib/cone';

const base = { horizon: 21, pUp: 0.68, baseUp: 0.54, dir: 1, level: 0, cases: 41, independent: 9, scored: 400, cover80: 0.79, cover50: 0.49, skill: 0.04, calls: 30, callHitRate: 0.6 };

describe('coneReading — the Forward Cone status in plain words', () => {
  it('is null until the study has a forecast', () => {
    expect(coneReading({ horizon: 21, scored: 0 })).toBeNull();
    expect(coneReading(undefined)).toBeNull();
  });

  it('states an upward lean with the share that closed higher', () => {
    const r = coneReading(base)!;
    expect(r.lean).toBe('up');
    expect(r.headline).toBe('Leans up: 68% of similar bars closed higher 21 bars later (all bars: 54%)');
  });

  it('states a downward lean with the share that closed lower', () => {
    const r = coneReading({ ...base, dir: -1, pUp: 0.3 })!;
    expect(r.lean).toBe('down');
    expect(r.headline).toBe('Leans down: 70% of similar bars closed lower 21 bars later (all bars: 46%)');
  });

  it('says so when the cases do not lean', () => {
    const r = coneReading({ ...base, dir: 0, pUp: 0.56 })!;
    expect(r.lean).toBe('none');
    expect(r.headline).toBe('No lean: 56% of similar bars closed higher 21 bars later (all bars: 54%)');
  });

  it('says the range is plain volatility when no state had enough history', () => {
    const r = coneReading({ ...base, dir: 0, level: 3, pUp: 0.54 })!;
    expect(r.headline).toBe('No similar state has enough history: this is the plain range of all bars (54% closed higher 21 bars later)');
  });

  it('withholds a verdict until 50 forecasts have been scored', () => {
    const r = coneReading({ ...base, scored: 12 })!;
    expect(r.trust).toBe('unknown');
    expect(r.verdict).toBe('Only 12 forecasts scored so far: too few to judge.');
  });

  it('trusts a range that held about 80% of the time and beat the all-bars forecast', () => {
    const r = coneReading(base)!;
    expect(r.trust).toBe('good');
    expect(r.verdict).toBe('On this chart the 80% range held 79% of the time and the matched forecast beat the all-bars one by 4.0%.');
  });

  it('calls it a volatility range when matching added nothing', () => {
    const r = coneReading({ ...base, skill: -0.01 })!;
    expect(r.trust).toBe('range');
    expect(r.verdict).toBe('On this chart the 80% range held 79% of the time, but matching on state did not beat the all-bars forecast: read it as a volatility range, not a directional call.');
  });

  it('warns when the range itself has been off', () => {
    const r = coneReading({ ...base, cover80: 0.61 })!;
    expect(r.trust).toBe('poor');
    expect(r.verdict).toBe('On this chart the 80% range held only 61% of the time: it has been too narrow here.');
    expect(coneReading({ ...base, cover80: 0.95 })!.verdict).toBe('On this chart the 80% range held 95% of the time: it has been too wide here.');
  });
});

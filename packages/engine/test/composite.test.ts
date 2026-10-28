import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Bar, computeStudy, confluence, consensus, defaultsOf, resolveConfig, sequential } from '../src';
import { arbBars, barsFromCloses } from './helpers';

/**
 * Steady decline (sequential.test.ts / demark.test.ts trace it by hand): buy setup bars 8–16, Sequential CD1 on bar 16
 * and buy 13 on bar 28, Combo 9 on bar 16 and buy 13 on bar 20. DeMarker I sits in oversold from bar 15 on; REI is
 * oversold on bars 12–13. No sell setup ever completes, so there is no TDST support and the sell score stays 0.
 */
const decline = (n = 31) => Array.from({ length: n }, (_, i) => (i <= 5 ? 10 + i : 15 - 0.5 * (i - 5)));
const mirror = (closes: number[]) => closes.map((c) => 30 - c);

const DEF = defaultsOf(confluence);
const NO_WEIGHTS = { wSetup: 0, wCountdown: 0, wCombo: 0, wDeMarker: 0, wRei: 0, wTdst: 0, wHtf: 0 };
// default weights without the higher timeframe: 1 + 2 + 1.5 + 1 + 1 + 1 = 7.5
const TOT = 7.5;

/** Per-part breakdown (0…1) on bar i, read from the status of a run that ends there. */
function partsAt(cfg: Record<string, unknown>, bars: Bar[], i: number, aux?: Record<string, Float64Array>) {
  const sliced = aux && Object.fromEntries(Object.entries(aux).map(([k, v]) => [k, v.slice(0, i + 1)]));
  const r = computeStudy(confluence, resolveConfig(confluence, cfg), bars.slice(0, i + 1), { aux: sliced });
  return r.status!.values as Record<string, number>;
}

describe('Exhaustion Confluence — hand-computed fixture', () => {
  const bars = barsFromCloses(decline());
  const r = computeStudy(confluence, DEF, bars);
  const buy = r.lines.buy;

  it('bar 8: only setup progress (1/9) counts', () => {
    expect(buy[8]).toBeCloseTo((100 * (1 / 9)) / TOT, 10);
  });

  it('bar 12: setup 5/9 plus REI in oversold', () => {
    expect(buy[12]).toBeCloseTo((100 * (5 / 9 + 1)) / TOT, 10);
    const p = partsAt({}, bars, 12);
    expect(p['buy.rei']).toBe(1);
    expect(p['buy.demarker']).toBe(0);
  });

  it('bar 16: setup 9, CD 1/13, Combo 9/13 and two bars of DeMarker oversold (2/5)', () => {
    expect(buy[16]).toBeCloseTo((100 * (1 + 2 * (1 / 13) + 1.5 * (9 / 13) + 0.4)) / TOT, 10);
  });

  it('bar 20: the Combo 13 counts in full; DeMarker is capped at 1 after 5 bars in the zone', () => {
    expect(buy[20]).toBeCloseTo((100 * (1 + 2 * (5 / 13) + 1.5 + 1)) / TOT, 10);
  });

  it('keeps a completed 13 at full credit for recentBars bars, then drops it', () => {
    // Combo 13 on bar 20, recentBars 5 → full on bars 20–24, gone on bar 25 (Combo countdown is no longer active)
    expect(partsAt({}, bars, 24)['buy.combo']).toBe(1);
    expect(partsAt({}, bars, 25)['buy.combo']).toBe(0);
    expect(partsAt({ recentBars: 10 }, bars, 25)['buy.combo']).toBe(1);
    expect(buy[25]).toBeCloseTo((100 * (1 + 2 * (10 / 13) + 0 + 1)) / TOT, 10);
  });

  it('drops DeMarker credit once the stay in oversold exceeds its 13-bar duration limit', () => {
    // oversold from bar 15: 13 bars on bar 27, 14 on bar 28
    expect(partsAt({}, bars, 27)['buy.demarker']).toBe(1);
    expect(partsAt({}, bars, 28)['buy.demarker']).toBe(0);
    // bar 28: setup + the Sequential 13
    expect(buy[28]).toBeCloseTo((100 * (1 + 2)) / TOT, 10);
  });

  it('plots buy up and sell down; nothing on the sell side in a pure decline', () => {
    for (let i = 0; i < bars.length; i++) {
      expect(buy[i]).toBeGreaterThanOrEqual(0);
      expect(r.lines.sell[i]).toBeCloseTo(0, 12);
    }
  });

  it('fires CONFLUENCE_BUY on each upward cross of the threshold', () => {
    // bar 21 = (1 + 2·6/13 + 1.5 + 1) / 7.5 ≈ 59.0; bar 22 = (1 + 2·7/13 + 1.5 + 1) / 7.5 ≈ 61.0
    expect(buy[22]).toBeCloseTo((100 * (1 + 2 * (7 / 13) + 1.5 + 1)) / TOT, 10);
    expect(r.signals.map((s) => [s.id, s.i, s.label])).toEqual([['CONFLUENCE_BUY', 22, '61']]);
    // threshold 50: bar 18 ≈ 47.1 → bar 19 = (1 + 2·4/13 + 1.5·12/13 + 1) / 7.5 ≈ 53.3 crosses;
    // the Combo credit lapses on bar 25 (≈ 47.2), bar 26 ≈ 49.2, and bar 27 = (1 + 2·12/13 + 1) / 7.5 ≈ 51.3 crosses again
    const r50 = computeStudy(confluence, resolveConfig(confluence, { threshold: 50 }), bars);
    expect(r50.signals.map((s) => [s.i, s.label])).toEqual([
      [19, '53'],
      [27, '51'],
    ]);
  });

  it('is an exact mirror on the sell side (REI excluded: its overlap test uses different lags for highs and lows)', () => {
    const noRei = resolveConfig(confluence, { wRei: 0 });
    const b = computeStudy(confluence, noRei, bars);
    const s = computeStudy(confluence, noRei, barsFromCloses(mirror(decline())));
    for (let i = 0; i < bars.length; i++) {
      expect(s.lines.sell[i]).toBeCloseTo(-b.lines.buy[i], 10);
      expect(s.lines.buy[i]).toBeCloseTo(0, 12);
    }
  });
});

describe('Exhaustion Confluence — TDST proximity', () => {
  // mirror of the decline: sell setup bars 8–16 with TDST support 15.5 (mirror of 14.5), then a pullback onto it
  const closes = mirror(decline(17)).concat([19, 17.5, 16, 15.5, 17, 19]);
  const bars = barsFromCloses(closes);
  const cfg = resolveConfig(confluence, { ...NO_WEIGHTS, wTdst: 1 });
  const r = computeStudy(confluence, cfg, bars);
  const sup = computeStudy(sequential, defaultsOf(sequential), bars).lines.tdst_sup;

  /** Wilder ATR(14): SMA of the first 14 true ranges, then RMA. */
  function atr(): number[] {
    const out: number[] = [];
    let v = NaN;
    let seed = 0;
    bars.forEach((b, i) => {
      const t = i > 0 ? Math.max(b.h, bars[i - 1].c) - Math.min(b.l, bars[i - 1].c) : b.h - b.l;
      if (i < 13) seed += t;
      else if (i === 13) v = (seed + t) / 14;
      else v += (t - v) / 14;
      out.push(v);
    });
    return out;
  }

  it('leans on the opposite (sell) setup’s TDST support', () => {
    expect(sup[16]).toBe(15.5);
    expect(sup[closes.length - 1]).toBe(15.5);
  });

  it('scores 100 with the close on the level and fades linearly to 0 at 1.5 ATR', () => {
    expect(closes[20]).toBe(15.5);
    expect(r.lines.buy[20]).toBeCloseTo(100, 10);
    const a = atr();
    let inside = 0;
    for (let i = 0; i < bars.length; i++) {
      const d = Number.isFinite(sup[i]) && a[i] > 0 ? Math.abs(closes[i] - sup[i]) / a[i] : Infinity;
      const want = d <= 1.5 ? 100 * (1 - d / 1.5) : 0;
      if (want > 0) inside++;
      expect(r.lines.buy[i]).toBeCloseTo(want, 9);
    }
    expect(inside).toBeGreaterThanOrEqual(2);
    expect(r.lines.buy[16]).toBe(0); // close 20.5 is ≈ 3 ATR away
  });

  it('a wider window raises the score off the level', () => {
    const wide = computeStudy(confluence, resolveConfig(confluence, { ...NO_WEIGHTS, wTdst: 1, tdstAtr: 5 }), bars);
    expect(wide.lines.buy[21]).toBeGreaterThan(r.lines.buy[21]);
  });
});

describe('Exhaustion Confluence — higher timeframe', () => {
  const bars = barsFromCloses(decline(12));
  // HTF columns use the Sequential sign convention: negative = buy side
  const htfSetup = Float64Array.from([NaN, -4.5, -3, 9, -9, -12, 0, NaN, -1, 2, -9, -9]);
  const htfCountdown = Float64Array.from([-13, 0, -13, 13, 0, 0, -6.5, -13, 0, 0, 0, 0]);
  const aux = { htfSetup, htfCountdown };
  const cfg = resolveConfig(confluence, { ...NO_WEIGHTS, wHtf: 1, useHtf: true });
  const r = computeStudy(confluence, cfg, bars, { aux });

  it('asks the chart for HTF columns only when enabled', () => {
    expect(confluence.needsAux?.(confluence.schema.parse({}))).toEqual([]);
    expect(confluence.needsAux?.(confluence.schema.parse({ useHtf: true }))).toEqual(['htfSetup', 'htfCountdown']);
  });

  it('takes the stronger of HTF setup/9 and HTF countdown/13 on each side', () => {
    // bar 0/7: no HTF setup value yet → 0 even with an HTF countdown; bar 5: setup beyond 9 is capped
    const wantBuy = [0, 50, 100, 0, 100, 100, 50, 0, 100 / 9, 0, 100, 100];
    const wantSell = [0, 0, 0, -100, 0, 0, 0, 0, 0, -200 / 9, 0, 0];
    wantBuy.forEach((v, i) => expect(r.lines.buy[i]).toBeCloseTo(v, 10));
    wantSell.forEach((v, i) => expect(r.lines.sell[i]).toBeCloseTo(v, 10));
  });

  it('leaves the HTF weight out of the denominator when disabled', () => {
    const b = barsFromCloses(decline());
    const zeros = { htfSetup: new Float64Array(b.length), htfCountdown: new Float64Array(b.length) };
    const on = computeStudy(confluence, resolveConfig(confluence, { useHtf: true }), b, { aux: zeros });
    const off = computeStudy(confluence, DEF, b);
    expect(off.lines.buy[8]).toBeCloseTo((100 * (1 / 9)) / TOT, 10);
    expect(on.lines.buy[8]).toBeCloseTo((100 * (1 / 9)) / (TOT + 1.5), 10);
  });
});

describe('Exhaustion Confluence — properties', () => {
  const arbCfg = fc.record({
    wSetup: fc.double({ min: 0, max: 10, noNaN: true }),
    wCountdown: fc.double({ min: 0, max: 10, noNaN: true }),
    wCombo: fc.double({ min: 0, max: 10, noNaN: true }),
    wDeMarker: fc.double({ min: 0, max: 10, noNaN: true }),
    wRei: fc.double({ min: 0, max: 10, noNaN: true }),
    wTdst: fc.double({ min: 0, max: 10, noNaN: true }),
    wHtf: fc.double({ min: 0, max: 10, noNaN: true }),
    useHtf: fc.boolean(),
  });
  const htf = (bars: Bar[]) => ({
    htfSetup: Float64Array.from(bars, (_, i) => ((i * 7) % 19) - 9),
    htfCountdown: Float64Array.from(bars, (_, i) => ((i * 5) % 27) - 13),
  });

  it('scores stay within 0…100 (buy) and −100…0 (sell) for any weights', () => {
    fc.assert(
      fc.property(arbBars(30, 120), arbCfg, (bars, c) => {
        const r = computeStudy(confluence, resolveConfig(confluence, c), bars, { aux: htf(bars) });
        for (let i = 0; i < bars.length; i++) {
          if (!(r.lines.buy[i] >= 0 && r.lines.buy[i] <= 100 + 1e-9)) return false;
          if (!(r.lines.sell[i] <= 0 && r.lines.sell[i] >= -100 - 1e-9)) return false;
        }
        return true;
      }),
      { numRuns: 60 },
    );
  });

  it('never looks ahead with the higher timeframe enabled', () => {
    fc.assert(
      fc.property(arbBars(30, 120), fc.integer({ min: 10, max: 29 }), (bars, cut) => {
        const cfg = resolveConfig(confluence, { useHtf: true });
        const full = computeStudy(confluence, cfg, bars, { aux: htf(bars) });
        const a = htf(bars);
        const pre = computeStudy(confluence, cfg, bars.slice(0, cut), {
          aux: { htfSetup: a.htfSetup.slice(0, cut), htfCountdown: a.htfCountdown.slice(0, cut) },
        });
        for (let i = 0; i < cut; i++)
          if (!Object.is(pre.lines.buy[i], full.lines.buy[i]) || !Object.is(pre.lines.sell[i], full.lines.sell[i]))
            return false;
        return true;
      }),
      { numRuns: 60 },
    );
  });
});

describe('Count Consensus — hand-computed fixture', () => {
  const bars = barsFromCloses(decline());
  const r = computeStudy(consensus, defaultsOf(consensus), bars);
  const seqCd = [-1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12, -13]; // bars 16…28

  it('steps each variant’s countdown (negative = buy) and shows ±13 only on the completion bar', () => {
    for (const k of ['seqStd', 'seqAgg']) expect(Array.from(r.lines[k].slice(16, 31))).toEqual([...seqCd, 0, 0]);
    // Combo counts setup bars 8…16 retroactively, so it shows −9 on bar 16 and completes on bar 20
    for (const k of ['comboStrict', 'comboV2'])
      expect(Array.from(r.lines[k].slice(15, 22))).toEqual([0, -9, -10, -11, -12, -13, 0]);
    for (const k of ['seqStd', 'seqAgg', 'comboStrict', 'comboV2'])
      expect(Array.from(r.lines[k].slice(0, 16)).every((v) => v === 0)).toBe(true);
  });

  it('counts variants with a 13 inside the 5-bar window', () => {
    // two Combo 13s on bar 20 (counted through bar 25), two Sequential 13s on bar 28
    expect(Array.from(r.lines.agree.slice(18, 31))).toEqual([0, 0, 2, 2, 2, 2, 2, 2, 0, 0, 2, 2, 2]);
  });

  it('needs 3 of 4 by default, so two separate pairs of 13s never fire', () => {
    expect(r.signals).toEqual([]);
    expect(r.markers).toEqual([]);
  });

  it('fires once per window when minAgree is met', () => {
    const r2 = computeStudy(consensus, resolveConfig(consensus, { minAgree: 2 }), bars);
    expect(r2.signals.map((s) => [s.id, s.i, s.label])).toEqual([
      ['CONSENSUS_BUY_13', 20, '2/4 variants'],
      ['CONSENSUS_BUY_13', 28, '2/4 variants'],
    ]);
    expect(r2.markers.map((m) => [m.i, m.text, m.pos])).toEqual([
      [20, '2/4', 'below'],
      [28, '2/4', 'below'],
    ]);
  });

  it('a wider window lets the Combo and Sequential 13s agree (4/4 on bar 28)', () => {
    const r8 = computeStudy(consensus, resolveConfig(consensus, { window: 8 }), bars);
    expect(r8.lines.agree[28]).toBe(4);
    expect(r8.signals.map((s) => [s.id, s.i, s.label])).toEqual([['CONSENSUS_BUY_13', 28, '4/4 variants']]);
  });

  it('is an exact mirror on the sell side', () => {
    const s = computeStudy(consensus, resolveConfig(consensus, { window: 8 }), barsFromCloses(mirror(decline())));
    for (const k of ['seqStd', 'seqAgg', 'comboStrict', 'comboV2', 'agree'])
      expect(Array.from(s.lines[k])).toEqual(
        Array.from(computeStudy(consensus, resolveConfig(consensus, { window: 8 }), bars).lines[k], (v) => -v || 0),
      );
    expect(s.signals.map((x) => [x.id, x.i])).toEqual([['CONSENSUS_SELL_13', 28]]);
    expect(s.markers[0].pos).toBe('above');
  });

  it('keeps every line in range on arbitrary bars', () => {
    fc.assert(
      fc.property(arbBars(30, 160), (b) => {
        const res = computeStudy(consensus, defaultsOf(consensus), b);
        for (const k of ['seqStd', 'seqAgg', 'comboStrict', 'comboV2'])
          for (const v of res.lines[k]) if (!(Number.isInteger(v) && Math.abs(v) <= 13)) return false;
        for (const v of res.lines.agree) if (!(Number.isInteger(v) && Math.abs(v) <= 4)) return false;
        return true;
      }),
      { numRuns: 60 },
    );
  });
});

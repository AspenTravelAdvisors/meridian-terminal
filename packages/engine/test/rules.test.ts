import { describe, expect, it } from 'vitest';
import { type Bar, type RuleSet, buildTestRun, computeStudy, evaluateRules, getStudy, intervalMs, replayQuery, resolveConfig, ruleIntervals, runStrategy } from '../src';
import { barsFromCloses, randomWalk } from './helpers';

const DAY = 86_400_000;
const daily = (bars: Bar[]) => ({ bars, intervalMs: DAY });
/** Weekly bars from 7 consecutive daily bars (t = first day), enough to test alignment. */
function weekly(d: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k + 7 <= d.length; k += 7) {
    const w = d.slice(k, k + 7);
    out.push({ t: w[0].t, o: w[0].o, h: Math.max(...w.map((b) => b.h)), l: Math.min(...w.map((b) => b.l)), c: w[6].c, v: w.reduce((a, b) => a + b.v, 0) });
  }
  return out;
}
const sma = (n: number) => ({ kind: 'line' as const, study: 'sma', cfg: { length: n }, output: 'ma' });
const close = { kind: 'price' as const, field: 'c' as const };

describe('combined rules', () => {
  it('parses interval lengths and lists the extra timeframes a rule needs', () => {
    expect(intervalMs('1D')).toBe(DAY);
    expect(intervalMs('4h')).toBe(4 * 3_600_000);
    expect(() => intervalMs('7x')).toThrow();
    const r: RuleSet = { trigger: 'rising', longEntry: { combine: 'all', conditions: [{ kind: 'compare', interval: '1W', left: close, op: '>', right: sma(2) }, { kind: 'compare', left: close, op: '>', right: { kind: 'value', value: 0 } }] }, longExit: { combine: 'any', conditions: [{ kind: 'compare', interval: '1M', left: close, op: '<', right: sma(2) }] } };
    expect(ruleIntervals(r, '1D')).toEqual(['1M', '1W']);
  });

  it('combines comparisons with AND / OR and fires on the rising edge', () => {
    //            0   1   2   3   4   5   6   7   8
    const b = barsFromCloses([10, 11, 12, 13, 12, 11, 12, 13, 14]);
    const above = { kind: 'compare' as const, left: close, op: '>' as const, right: { kind: 'value' as const, value: 11.5 } };
    const rising = { kind: 'compare' as const, left: close, op: 'crossesAbove' as const, right: sma(2) };
    const and = evaluateRules(daily(b), { trigger: 'rising', longEntry: { combine: 'all', conditions: [above, rising] } });
    // sma2: -, 10.5, 11.5, 12.5, 12.5, 11.5, 11.5, 12.5, 13.5 → close crosses above at 6 (12 > 11.5, prev 11 ≤ 11.5)
    expect(and.entries.map((e) => e.i)).toEqual([6]);
    const every = evaluateRules(daily(b), { trigger: 'every', longEntry: { combine: 'all', conditions: [above] } });
    expect(every.entries.map((e) => e.i)).toEqual([2, 3, 4, 6, 7, 8]);
    const edge = evaluateRules(daily(b), { trigger: 'rising', longEntry: { combine: 'all', conditions: [above] } });
    expect(edge.entries.map((e) => e.i)).toEqual([2, 6]);
    const or = evaluateRules(daily(b), { trigger: 'every', longEntry: { combine: 'any', conditions: [rising, { ...above, right: { kind: 'value', value: 13.5 } }] } });
    // close was already above the SMA at bar 1 (no SMA before it), so bar 2 is not a cross; > 13.5 only at 8
    expect(or.entries.map((e) => e.i)).toEqual([6, 8]);
    expect(and.trueBars.longEntry).toEqual([6, 1]);
  });

  it('keeps entry and exit rules separate', () => {
    const b = barsFromCloses([10, 11, 12, 13, 12, 11, 12, 13, 14]);
    const r = evaluateRules(daily(b), {
      trigger: 'rising',
      longEntry: { combine: 'all', conditions: [{ kind: 'compare', left: close, op: '>', right: { kind: 'value', value: 11.5 } }] },
      longExit: { combine: 'all', conditions: [{ kind: 'compare', left: close, op: '<', right: { kind: 'value', value: 11.5 } }] },
    });
    expect(r.entries.map((e) => [e.i, e.id])).toEqual([[2, 'RULE_LONG_ENTRY'], [6, 'RULE_LONG_ENTRY']]);
    expect(r.exits.map((e) => [e.i, e.id, e.dir])).toEqual([[0, 'RULE_LONG_EXIT', 'bull'], [1, 'RULE_LONG_EXIT', 'bull'], [5, 'RULE_LONG_EXIT', 'bull']]);
    // next-open execution: enter at 3's open, exit at 6's open
    const t = runStrategy(b, { entries: r.entries, exits: r.exits, exitAt: 'nextOpen', entryAt: 'nextOpen', exitOnOpposite: false, stop: 'none', stopPct: 0, atrMult: 0, atrLength: 14, timeStopBars: 0, takeProfitPct: 0, feesBps: 0, slippageBps: 0, allowShort: false });
    expect(t.trades[0]).toMatchObject({ entryI: 3, exitI: 6, entry: b[3].o, exit: b[6].o, reason: 'exit' });
    // the second entry (signal at 6) fills at 7's open and runs to the end
    expect(t.trades[1]).toMatchObject({ entryI: 7, reason: 'end' });
    const atClose = runStrategy(b, { entries: r.entries, exits: r.exits, exitAt: 'close', entryAt: 'close', exitOnOpposite: false, stop: 'none', stopPct: 0, atrMult: 0, atrLength: 14, timeStopBars: 0, takeProfitPct: 0, feesBps: 0, slippageBps: 0, allowShort: false });
    expect(atClose.trades[0]).toMatchObject({ entryI: 2, exitI: 5, entry: b[2].c, exit: b[5].c, reason: 'exit' });
  });

  it('matches the study signal within N bars', () => {
    const b = randomWalk(600, 3);
    const def = getStudy('td-sequential')!;
    const sig = computeStudy(def, resolveConfig(def, {}), b).signals.filter((s) => s.id === 'SEQ_BUY_SETUP_9').map((s) => s.i);
    const r = evaluateRules(daily(b), { trigger: 'every', longEntry: { combine: 'all', conditions: [{ kind: 'signal', study: 'td-sequential', signal: 'SEQ_BUY_SETUP_9', withinBars: 2 }] } });
    const want = new Set(sig.flatMap((i) => [i, i + 1, i + 2]).filter((i) => i < 600));
    expect(r.entries.map((e) => e.i)).toEqual([...want].sort((a, c) => a - c));
  });

  it('reads a higher timeframe only after its bar has closed', () => {
    const d = randomWalk(700, 9);
    const w = weekly(d);
    const rule: RuleSet = { trigger: 'every', longEntry: { combine: 'all', conditions: [{ kind: 'compare', interval: '1W', left: close, op: '>', right: sma(4) }] } };
    const a = evaluateRules(daily(d), rule, { '1W': { bars: w, intervalMs: 7 * DAY } }, '1D');
    // week k closes at w[k].t + 7 days; daily bar i closes at d[i].t + 1 day — the first daily bar that sees week k is 7k + 6
    for (const e of a.entries) {
      const k = Math.floor((e.i - 6) / 7);
      expect(k).toBeGreaterThanOrEqual(3);
    }
    // rewriting weeks that close after day 400 never changes entries up to day 400
    const cut = 400;
    const w2 = w.map((x) => (x.t + 7 * DAY > d[cut].t + DAY ? { ...x, c: x.c * 3, h: x.h * 3 } : x));
    const b = evaluateRules(daily(d), rule, { '1W': { bars: w2, intervalMs: 7 * DAY } }, '1D');
    expect(b.entries.filter((e) => e.i <= cut)).toEqual(a.entries.filter((e) => e.i <= cut));
    expect(() => evaluateRules(daily(d), rule, {}, '1D')).toThrow(/1W bars/);
  });

  it('reads displaced outputs where they are drawn and refuses ones drawn from later bars', () => {
    const b = randomWalk(300, 4);
    const def = getStudy('ichimoku')!;
    const cfg = resolveConfig(def, {});
    const r = computeStudy(def, cfg, b);
    const disp = cfg.displacement as number;
    const ev = evaluateRules(daily(b), { trigger: 'every', longEntry: { combine: 'all', conditions: [{ kind: 'compare', left: close, op: '>', right: { kind: 'line', study: 'ichimoku', output: 'senkouA' } }] } });
    const want = b.map((x, i) => (i >= disp && Number.isFinite(r.lines.senkouA[i - disp]) && x.c > r.lines.senkouA[i - disp] ? i : -1)).filter((i) => i >= 0);
    expect(ev.entries.map((e) => e.i)).toEqual(want);
    expect(() => evaluateRules(daily(b), { trigger: 'every', longEntry: { combine: 'all', conditions: [{ kind: 'compare', left: close, op: '>', right: { kind: 'line', study: 'ichimoku', output: 'chikou' } }] } })).toThrow(/later bars/);
  });
});

describe('combined rules in run records', () => {
  const d = randomWalk(1400, 21);
  const w = weekly(d);
  const rules: RuleSet = {
    trigger: 'rising',
    longEntry: { combine: 'all', conditions: [{ kind: 'signal', study: 'td-sequential', signal: 'SEQ_BUY_SETUP_9', withinBars: 0 }, { kind: 'compare', interval: '1W', left: close, op: '>', right: sma(10) }] },
    longExit: { combine: 'any', conditions: [{ kind: 'compare', left: close, op: 'crossesBelow', right: sma(20) }] },
  };
  const strat = { exitOnOpposite: false, exitAt: 'nextOpen' as const, stop: 'none' as const, stopPct: 0, atrMult: 2, atrLength: 14, timeStopBars: 0, takeProfitPct: 0, feesBps: 1, slippageBps: 1, entryAt: 'nextOpen' as const, allowShort: false };
  const spec = { symbol: 'SIM:X', interval: '1D', study: 'rules', studyConfig: {}, signals: [], horizons: [5, 20], baseline: { seed: 1, samples: 50 }, strategy: strat, rules };
  const src = { provider: 'sim', adjust: 'split', simulated: true, requestedBars: 1400 };

  it('records rule entries, rule exits and the higher-timeframe data it read', () => {
    const r = buildTestRun(d, spec, src, { aux: { '1W': w } });
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.signals.every((s) => s.id === 'RULE_LONG_ENTRY')).toBe(true);
    expect(r.strategy!.trades.some((t) => t.reason === 'exit')).toBe(true);
    expect(r.strategy!.population.ruleExits).toBe(r.strategy!.trades.filter((t) => t.reason === 'exit').length);
    expect(r.data.aux).toEqual([{ interval: '1W', bars: 200, from: '2000-01-01', to: new Date(w[199].t).toISOString().slice(0, 10) }]);
    expect(new URLSearchParams(replayQuery(r)).get('rules')).toContain('SEQ_BUY_SETUP_9');
  });

  it('hashes the higher-timeframe bars it read, and only those', () => {
    const a = buildTestRun(d, spec, src, { aux: { '1W': w } });
    // a still-forming week after the last daily bar is ignored
    const extra = [...w, { ...w[w.length - 1], t: w[w.length - 1].t + 7 * DAY }];
    expect(buildTestRun(d, spec, src, { aux: { '1W': extra } }).hashes.bars).toBe(a.hashes.bars);
    const revised = w.map((x, k) => (k === 50 ? { ...x, c: x.c + 1 } : x));
    expect(buildTestRun(d, spec, src, { aux: { '1W': revised } }).hashes.bars).not.toBe(a.hashes.bars);
    expect(() => buildTestRun(d, spec, src)).toThrow(/1W bars/);
  });
});

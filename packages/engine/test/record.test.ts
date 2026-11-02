import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, TEST_RUN_SCHEMA, type TestRunSpec, buildTestRun, canonicalJson, eventStudy, hashString, replayQuery, testRunCsv } from '../src';
import { barsFromCloses, randomWalk } from './helpers';

const src = { provider: 'sim', adjust: 'split', simulated: true, requestedBars: 1200 };
const spec = (over: Partial<TestRunSpec> = {}): TestRunSpec => ({
  symbol: 'SIM:DEMO',
  interval: '1D',
  study: 'td-sequential',
  studyConfig: {},
  signals: ['SEQ_BUY_SETUP_9', 'SEQ_SELL_SETUP_9'],
  horizons: [1, 5, 20],
  baseline: { seed: 11, samples: 200 },
  strategy: null,
  ...over,
});
const strat = { exitOnOpposite: true, stop: 'level' as const, stopPct: 5, atrMult: 2, atrLength: 14, timeStopBars: 20, takeProfitPct: 0, feesBps: 2, slippageBps: 3, entryAt: 'nextOpen' as const, allowShort: false };

describe('test-run record', () => {
  const bars = randomWalk(1200, 7);

  it('pins schema, engine version, the resolved study parameters and the data window', () => {
    const r = buildTestRun(bars, spec(), src);
    expect(r.schema).toBe(TEST_RUN_SCHEMA);
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    // every parameter, defaults included, so a later default change can't silently alter a replay
    expect(Object.keys(r.spec.studyConfig).length).toBeGreaterThan(3);
    expect(r.data).toMatchObject({ symbol: 'SIM:DEMO', interval: '1D', provider: 'sim', adjust: 'split', simulated: true, bars: 1200, from: '2000-01-01', fromT: bars[0].t, toT: bars[1199].t });
  });

  it('engine version matches the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it('is byte-identical for the same bars and spec, and its hashes move with either', () => {
    const a = buildTestRun(bars, spec({ strategy: strat }), src);
    const b = buildTestRun(bars.slice(), spec({ strategy: strat }), { ...src });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const otherSpec = buildTestRun(bars, spec({ horizons: [1, 5, 10] }), src);
    expect(otherSpec.hashes.spec).not.toBe(a.hashes.spec);
    expect(otherSpec.hashes.bars).toBe(a.hashes.bars);
    const revised = bars.map((x, i) => (i === 500 ? { ...x, c: x.c + 0.01 } : x));
    const c = buildTestRun(revised, spec({ strategy: strat }), src);
    expect(c.hashes.bars).not.toBe(a.hashes.bars);
    expect(c.hashes.spec).toBe(a.hashes.spec);
    expect(c.hashes.run).not.toBe(a.hashes.run);
  });

  it('agrees with the event study and labels its population', () => {
    const r = buildTestRun(bars, spec(), src);
    const events = r.signals.map((s) => ({ i: s.i, dir: s.dir }));
    const es = eventStudy(bars, events, [1, 5, 20], { seed: 11, baselineSamples: 200 });
    expect(r.eventStudy.horizons.map((h) => h.mean)).toEqual(es.horizons.map((h) => h.mean));
    expect(r.eventStudy.horizons.map((h) => h.baseline?.mean)).toEqual(es.horizons.map((h) => h.baseline?.mean));
    // per-event rows carry the same returns, null where the horizon runs past the data
    for (let k = 0; k < 3; k++) expect(r.eventStudy.events.map((e) => e.returns[k]).filter((x): x is number => x !== null)).toEqual(es.horizons[k].returns);
    const p = r.eventStudy.population;
    expect(p.measuredLong + p.measuredShort).toBe(r.signals.length);
    expect(p.measuredShort).toBe(r.signals.filter((s) => s.dir === 'bear').length);
    expect(r.eventStudy.entry).toBe('signal bar close');
  });

  it('records trades and per-bar equity for strategy mode, with the role of sell signals', () => {
    const r = buildTestRun(bars, spec({ strategy: strat }), src);
    const s = r.strategy!;
    expect(s.equity).toHaveLength(1200);
    expect(s.equity[0]).toMatchObject({ date: '2000-01-01', equity: 1 });
    expect(s.trades.length).toBe(s.stats.trades);
    expect(s.trades.every((t) => t.side === 'long')).toBe(true);
    expect(s.population.sellSignals).toBe('exits');
    expect(s.equity[1199].equity).toBeCloseTo(1 + s.stats.totalReturn / 100, 10);
    expect(buildTestRun(bars, spec({ strategy: { ...strat, allowShort: true } }), src).strategy!.population.sellSignals).toBe('entries');
  });

  it('accepts precomputed events (scripts) and hashes the script source', () => {
    const r = buildTestRun(barsFromCloses([10, 11, 12, 11, 10, 9, 10, 11]), spec({ study: 'script:My dip', signals: ['DIP'], horizons: [1, 2] }), { ...src, scriptHash: hashString('plot(close)') }, { events: [{ i: 2, dir: 'bear', id: 'DIP' }] });
    expect(r.signals).toEqual([{ i: 2, t: Date.UTC(2024, 0, 3), date: '2024-01-03', id: 'DIP', dir: 'bear' }]);
    expect(r.eventStudy.events[0].returns[0]).toBeCloseTo((100 * (12 - 11)) / 12, 10); // short: 12 → 11
    expect(r.data.scriptHash).toBe(hashString('plot(close)'));
  });

  it('rejects an unknown study', () => {
    expect(() => buildTestRun(bars, spec({ study: 'nope' }), src)).toThrow(/unknown study/);
  });

  it('builds a replay query pinned to the same window', () => {
    const r = buildTestRun(bars, spec({ strategy: strat }), src);
    const q = new URLSearchParams(replayQuery(r));
    expect(q.get('symbol')).toBe('SIM:DEMO');
    expect(q.get('bars')).toBe(String(r.data.bars));
    expect(q.get('to')).toBe(String(bars[1199].t + 1));
    expect(JSON.parse(q.get('strategy')!)).toEqual(strat);
    expect(JSON.parse(q.get('cfg')!)).toEqual(r.spec.studyConfig);
  });

  it('writes CSVs keyed by run hash', () => {
    const r = buildTestRun(bars, spec({ strategy: strat }), src);
    const eq = testRunCsv([r], 'equity').trim().split('\n');
    expect(eq[0]).toBe('run_hash,symbol,date,equity,buy_hold,equity_value');
    expect(eq).toHaveLength(1201);
    expect(eq[1].startsWith(`${r.hashes.run},SIM:DEMO,2000-01-01,1,1`)).toBe(true);
    const sum = testRunCsv([r], 'summary');
    expect(sum).toContain('engine_version');
    expect(sum).toContain('study_config');
    const ev = testRunCsv([r], 'events').split('\n')[0];
    expect(ev).toBe('run_hash,symbol,date,signal,direction,measured,entry_close,ret_1,ret_5,ret_20');
    expect(testRunCsv([{ ...r, spec: { ...r.spec, symbol: 'A,"B"' }, data: { ...r.data, symbol: 'A,"B"' } }], 'signals').split('\n')[1]).toContain('"A,""B"""');
  });
});

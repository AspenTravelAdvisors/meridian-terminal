import { describe, expect, it } from 'vitest';
import { analysisTitle, isPriceLevel, levelAlert, levelAlertOp, parseQuery, plainText, searchAnalyses, snapshotLevels, syncLevelAlerts, toSaved } from '../src/lib/analyst';
import { mergeDoc } from '../src/state/merge';
import type { Alert, AnalystRun, SavedAnalysis } from '../src/state/types';

const run = (over: Partial<AnalystRun> = {}): AnalystRun => ({
  id: 'r1',
  kind: 'chart',
  symbol: 'AAPL',
  interval: '1D',
  text: '',
  engine: 'rule-based',
  createdAt: 1000,
  status: 'done',
  levels: [
    { key: 'Seq tdstBuy', value: 180 },
    { key: 'Seq tdstSell', value: 200 },
  ],
  lastClose: 190,
  ...over,
});

const asAlert = (a: ReturnType<typeof levelAlert>, id: string, extra: Partial<Alert> = {}): Alert => ({ ...a, id, createdAt: 1, enabled: true, ...extra });

describe('analyst key levels', () => {
  it('takes finite numeric levels from the snapshot map', () => {
    expect(snapshotLevels({ a: 1.5, b: null, c: Number.NaN, d: undefined, e: 2 })).toEqual([
      { key: 'a', value: 1.5 },
      { key: 'e', value: 2 },
    ]);
  });

  it('treats only price-scale values named like levels as price levels', () => {
    expect(isPriceLevel('tdstResistance', 40.9, 40)).toBe(true);
    expect(isPriceLevel('sell.tdst', 41, 40)).toBe(true);
    expect(isPriceLevel('sellRisk', 41.2, undefined)).toBe(true);
    // Exhaustion Zone level counts, non-level names, off-scale values, non-numbers
    expect(isPriceLevel('buyLevels', 0, 40)).toBe(false);
    expect(isPriceLevel('sellLevels', 40, 40)).toBe(false);
    expect(isPriceLevel('setupCount', 9, 40)).toBe(false);
    expect(isPriceLevel('score', 40, 40)).toBe(false);
    expect(isPriceLevel('stopDistance', 2, 40)).toBe(false);
    expect(isPriceLevel('tdst', null, 40)).toBe(false);
    expect(isPriceLevel('tdst', Number.NaN, 40)).toBe(false);
  });

  it('points a level alert at the level from the side price is on', () => {
    expect(levelAlertOp(190, 200)).toBe('crosses_above');
    expect(levelAlertOp(190, 180)).toBe('crosses_below');
    expect(levelAlertOp(undefined, 180, 'crosses_below')).toBe('crosses_below');
    expect(levelAlertOp(180, 180, 'crosses_below')).toBe('crosses_below');
  });

  it('builds a tracked price alert from a chart briefing level', () => {
    const a = levelAlert(run(), { key: 'Seq tdstSell', value: 200 });
    expect(a.condition).toEqual({ kind: 'price', op: 'crosses_above', value: 200 });
    expect(a.name).toBe('AAPL 1D: Seq tdstSell crosses above 200.00');
    expect(a.track).toEqual({ source: 'analyst', key: 'Seq tdstSell', autoName: a.name, updatedAt: 1000 });
    expect(() => levelAlert(run({ kind: 'portfolio', symbol: undefined, interval: undefined }), { key: 'x', value: 1 })).toThrow();
  });
});

describe('syncLevelAlerts', () => {
  const base = run();
  const sell = asAlert(levelAlert(base, { key: 'Seq tdstSell', value: 200 }), 'a1');
  const buy = asAlert(levelAlert(base, { key: 'Seq tdstBuy', value: 180 }), 'a2', { name: 'My buy line' });
  const other = asAlert(levelAlert(run({ symbol: 'MSFT' }), { key: 'Seq tdstSell', value: 400 }), 'a3');
  const weekly = asAlert(levelAlert(run({ interval: '1W' }), { key: 'Seq tdstSell', value: 210 }), 'a4');
  const manual: Alert = { id: 'a5', name: 'manual', symbol: 'AAPL', interval: '1D', condition: { kind: 'price', op: 'crosses_above', value: 1 }, mode: 'once', timing: 'close', channels: { app: true, browser: false }, enabled: true, createdAt: 1 };
  const all = [sell, buy, other, weekly, manual];

  it('updates value, direction and the generated name; keeps a renamed alert name; re-arms', () => {
    const next = run({ createdAt: 2000, lastClose: 205, levels: [{ key: 'Seq tdstSell', value: 202.5 }, { key: 'Seq tdstBuy', value: 185 }] });
    const s = syncLevelAlerts(all, next);
    expect(s.updated).toBe(2);
    expect(s.stale).toBe(0);
    const p1 = s.patches.find((p) => p.id === 'a1')!.patch;
    // price is now above the sell level, so the alert waits for a cross back below it
    expect(p1.condition).toEqual({ kind: 'price', op: 'crosses_below', value: 202.5 });
    expect(p1.name).toBe('AAPL 1D: Seq tdstSell crosses below 202.50');
    expect(p1.track).toMatchObject({ autoName: p1.name, updatedAt: 2000 });
    expect(p1.rearmedAt).toBe(2000);
    expect(p1.enabled).toBeUndefined();
    const p2 = s.patches.find((p) => p.id === 'a2')!.patch;
    expect(p2.name).toBe('My buy line');
    expect(p2.condition).toEqual({ kind: 'price', op: 'crosses_below', value: 185 });
  });

  it('only touches alerts on the same symbol and interval that follow a level', () => {
    const s = syncLevelAlerts(all, run({ createdAt: 2000, levels: [{ key: 'Seq tdstSell', value: 1 }, { key: 'Seq tdstBuy', value: 2 }] }));
    expect(s.patches.map((p) => p.id).sort()).toEqual(['a1', 'a2']);
  });

  it('flags a level that left the data as stale once, keeping the last value, and clears the flag when it returns', () => {
    const s = syncLevelAlerts(all, run({ createdAt: 2000, levels: [{ key: 'Seq tdstBuy', value: 180 }] }));
    expect(s).toMatchObject({ updated: 0, stale: 1, unchanged: 1 });
    expect(s.patches).toEqual([{ id: 'a1', patch: { track: { ...sell.track, stale: true } } }]);
    const staleSell = { ...sell, track: { ...sell.track!, stale: true } };
    expect(syncLevelAlerts([staleSell], run({ createdAt: 3000, levels: [] })).patches).toEqual([]);
    const back = syncLevelAlerts([staleSell], run({ createdAt: 3000 }));
    expect(back.unchanged).toBe(1);
    expect(back.patches[0].patch.track).toMatchObject({ stale: undefined, updatedAt: 3000 });
  });

  it('does nothing for portfolio briefings and is deterministic', () => {
    expect(syncLevelAlerts(all, run({ kind: 'portfolio' })).patches).toEqual([]);
    const r = run({ createdAt: 5, levels: [{ key: 'Seq tdstSell', value: 7 }] });
    expect(JSON.stringify(syncLevelAlerts(all, r))).toBe(JSON.stringify(syncLevelAlerts(all, r)));
  });
});

describe('saved briefing search', () => {
  const mk = (id: string, over: Partial<SavedAnalysis>): SavedAnalysis => ({ ...toSaved(run({ text: '', ...over } as Partial<AnalystRun>), id, 0), ...over });
  const items: SavedAnalysis[] = [
    mk('s1', { symbol: 'AAPL', createdAt: 1, text: '### Summary\nA **buy setup 9** is perfected near the lows; TDST at 180.', tags: ['swing'] }),
    mk('s2', { symbol: 'MSFT', createdAt: 2, text: 'Sell countdown 13 completed. Timeframes conflict.', tags: ['earnings'] }),
    mk('s3', { kind: 'portfolio', symbol: undefined, interval: undefined, title: 'Portfolio — concentration', createdAt: 3, text: 'Tech weight is high.', levels: [] }),
  ];

  it('titles briefings from their chart and question', () => {
    expect(analysisTitle({ kind: 'chart', symbol: 'AAPL', interval: '1D' })).toBe('AAPL 1D — Briefing');
    expect(analysisTitle({ kind: 'portfolio', question: 'Where is risk?' })).toBe('Portfolio — Where is risk?');
    expect(analysisTitle({ kind: 'chart', symbol: 'X', interval: '1h', question: 'q'.repeat(100) }).length).toBeLessThan(90);
  });

  it('lists everything newest first for an empty query', () => {
    expect(searchAnalyses(items, '').map((h) => h.item.id)).toEqual(['s3', 's2', 's1']);
  });

  it('requires every word and ranks symbol/title matches above body matches', () => {
    expect(searchAnalyses(items, 'setup perfected').map((h) => h.item.id)).toEqual(['s1']);
    expect(searchAnalyses(items, 'setup countdown')).toEqual([]);
    expect(searchAnalyses(items, 'msft')[0].item.id).toBe('s2');
  });

  it('searches levels by name and value, and returns a plain-text snippet', () => {
    const h = searchAnalyses(items, 'tdstsell');
    expect(h.map((x) => x.item.id).sort()).toEqual(['s1', 's2']);
    expect(searchAnalyses(items, '200.00').length).toBe(2);
    const s = searchAnalyses(items, 'perfected')[0];
    expect(s.snippet).toContain('buy setup 9 is perfected');
    expect(s.snippet).not.toContain('**');
  });

  it('supports #tag, sym: and kind: filters and a symbol scope', () => {
    expect(parseQuery('#Swing sym:aapl kind:chart lows')).toEqual({ words: ['lows'], tags: ['swing'], symbol: 'aapl', kind: 'chart' });
    expect(searchAnalyses(items, '#earn').map((h) => h.item.id)).toEqual(['s2']);
    expect(searchAnalyses(items, 'sym:aapl').map((h) => h.item.id)).toEqual(['s1']);
    expect(searchAnalyses(items, 'kind:portfolio').map((h) => h.item.id)).toEqual(['s3']);
    expect(searchAnalyses(items, '', 'MSFT').map((h) => h.item.id)).toEqual(['s2']);
  });

  it('strips Markdown for plain text', () => {
    expect(plainText('## Head\n- **bold** and `code` [link](https://x.y)')).toBe('Head - bold and code link');
  });

  it('sync merge keeps saves from both devices, the newer edit winning', () => {
    const r = { state: { saved: [{ id: 's1', title: 'cloud', updatedAt: 5 }], autoSave: false, syncLevels: true } };
    const l = { state: { saved: [{ id: 's1', title: 'local', updatedAt: 9 }, { id: 's2', title: 'phone', updatedAt: 1 }], autoSave: true, syncLevels: false } };
    const m = mergeDoc('meridian.analyst', r, l).state as { saved: { id: string; title: string }[]; autoSave: boolean };
    expect(m.saved.map((x) => [x.id, x.title])).toEqual([['s1', 'local'], ['s2', 'phone']]);
    expect(m.autoSave).toBe(false);
  });
});

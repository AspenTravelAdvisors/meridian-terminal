import { describe, expect, it } from 'vitest';
import { mergeDoc, unionById } from '../src/state/merge';

describe('sync merge rules', () => {
  it('unions collections by id, cloud copy first, keeping local-only items', () => {
    expect(unionById([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], [{ id: 'b', v: 2 }, { id: 'c', v: 2 }])).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 2 }]);
  });

  it('watchlists keep symbols added on either device', () => {
    const r = { state: { activeId: 'w1', lists: [{ id: 'w1', name: 'Core', symbols: ['SPY', 'AAPL'] }] } };
    const l = { state: { activeId: 'w2', lists: [{ id: 'w1', name: 'Core', symbols: ['SPY', 'NVDA'] }, { id: 'w2', name: 'Phone', symbols: ['BTCUSDT'] }] } };
    const m = mergeDoc('meridian.watchlists', r, l).state as { activeId: string; lists: { id: string; symbols: string[] }[] };
    expect(m.activeId).toBe('w1');
    expect(m.lists.map((x) => [x.id, x.symbols])).toEqual([['w1', ['SPY', 'AAPL', 'NVDA']], ['w2', ['BTCUSDT']]]);
  });

  it('alerts never forget a firing either side saw, and a re-armed copy wins', () => {
    const r = { state: { alerts: [{ id: 'a', enabled: false, lastFiredBar: 200, lastFiredAt: 5 }], log: [{ id: 'e1', at: 5 }] } };
    const l = { state: { alerts: [{ id: 'a', enabled: true, rearmedAt: 9, lastFiredBar: 100 }], log: [{ id: 'e2', at: 7 }] } };
    const m = mergeDoc('meridian.alerts', r, l).state as { alerts: { enabled: boolean; lastFiredBar: number }[]; log: { id: string }[] };
    expect(m.alerts[0]).toMatchObject({ enabled: true, lastFiredBar: 200 });
    expect(m.log.map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('portfolio transactions from both devices survive; settings take the cloud copy', () => {
    const p = mergeDoc('meridian.portfolio', { state: { accounts: [{ id: 'x' }], txs: [{ id: 't1' }], tags: { SPY: { sector: 'r' } } } }, { state: { accounts: [{ id: 'x' }], txs: [{ id: 't2' }], tags: { QQQ: {} } } });
    expect((p.state.txs as { id: string }[]).map((t) => t.id)).toEqual(['t1', 't2']);
    expect(Object.keys(p.state.tags as object).sort()).toEqual(['QQQ', 'SPY']);
    expect(mergeDoc('meridian.settings', { state: { theme: 'light' } }, { state: { theme: 'dark' } }).state.theme).toBe('light');
  });

  it('drawings merge per symbol; scripts keep the newer edit', () => {
    const d = mergeDoc('meridian.drawings', { state: { bySymbol: { SPY: [{ id: 'd1' }] } } }, { state: { bySymbol: { SPY: [{ id: 'd2' }], QQQ: [{ id: 'd3' }] } } });
    expect(d.state.bySymbol).toEqual({ SPY: [{ id: 'd1' }, { id: 'd2' }], QQQ: [{ id: 'd3' }] });
    const s = mergeDoc('meridian.scripts', { state: { scripts: [{ id: 's', code: 'old', updatedAt: 1 }] } }, { state: { scripts: [{ id: 's', code: 'new', updatedAt: 2 }] } });
    expect((s.state.scripts as { code: string }[])[0].code).toBe('new');
  });
});

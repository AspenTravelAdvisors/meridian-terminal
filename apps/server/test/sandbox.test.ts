import { runScript } from '@meridian/engine';
import { describe, expect, it } from 'vitest';
import { runScriptIsolated } from '../src/scriptSandbox';

const bars = Array.from({ length: 300 }, (_, i) => {
  const c = 100 + 10 * Math.sin(i / 12) + i * 0.05;
  return { t: Date.UTC(2024, 0, 1) + i * 86_400_000, o: c - 0.3, h: c + 1, l: c - 1, c, v: 1000 };
});
const CROSS = `
const fast = sma(close, input('Fast', 5))
const slow = sma(close, input('Slow', 20))
plot(fast)
signal(crossover(fast, slow), { id: 'X_UP', dir: 'bull' })
signal(crossunder(fast, slow), { id: 'X_DOWN', dir: 'bear' })
`;

describe('server script sandbox (QuickJS)', () => {
  it('produces the same signals as the browser runtime', async () => {
    const iso = await runScriptIsolated(CROSS, bars, { Fast: 7 });
    const ref = runScript(CROSS, bars, { Fast: 7 });
    expect(iso.error).toBeUndefined();
    expect(iso.signals.length).toBeGreaterThan(2);
    expect(iso.signals.map((s) => `${s.i}:${s.id}`)).toEqual(ref.signals.map((s) => `${s.i}:${s.id}`));
  });

  it('has no host access', async () => {
    for (const probe of ['fetch', 'require', 'process', 'globalThis.process', 'import.meta']) {
      const r = await runScriptIsolated(`if (typeof ${probe.split('.')[0]} !== 'undefined' && ${probe}) signal([true], { id: 'LEAK' })`, bars.slice(0, 10));
      expect(r.signals.filter((s) => s.id === 'LEAK')).toEqual([]);
    }
  });

  it('stops runaway scripts at the deadline and caps memory', async () => {
    const t0 = Date.now();
    const loop = await runScriptIsolated('for (;;) {}', bars, {}, { timeoutMs: 200 });
    expect(loop.error).toMatch(/time budget/);
    expect(Date.now() - t0).toBeLessThan(3000);
    // array storage is not covered by QuickJS's own limit; the capped WebAssembly memory stops it
    const rss = process.memoryUsage().rss;
    const hog = await runScriptIsolated('const a = []; for (;;) a.push(new Array(1e5).fill(1))', bars, {}, { timeoutMs: 3000 });
    expect(hog.error).toMatch(/memory|time budget/);
    expect(process.memoryUsage().rss - rss).toBeLessThan(400 * 1024 * 1024);
    // the interpreter is reusable afterwards
    const after = await runScriptIsolated(CROSS, bars);
    expect(after.error).toBeUndefined();
    expect(after.signals.length).toBeGreaterThan(2);
  }, 30_000);
});

import fc from 'fast-check';
import type { Bar } from '../src';

/** Build bars from closes: open = prior close, high/low = body ± pad. Hand-traceable. */
export function barsFromCloses(closes: number[], pad = 0.5, t0 = Date.UTC(2024, 0, 1), step = 86_400_000): Bar[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { t: t0 + i * step, o, h: Math.max(o, c) + pad, l: Math.min(o, c) - pad, c, v: 1000 + i };
  });
}

/** Deterministic pseudo-random walk (mulberry32) — used for benchmarks and oracle comparisons. */
export function randomWalk(n: number, seed = 42, start = 100): Bar[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Bar[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    const drift = Math.sin(i / 37) * 0.002;
    c = Math.max(1, o * (1 + drift + (rnd() - 0.5) * 0.04));
    const h = Math.max(o, c) * (1 + rnd() * 0.01);
    const l = Math.min(o, c) * (1 - rnd() * 0.01);
    out.push({ t: Date.UTC(2000, 0, 1) + i * 86_400_000, o, h, l, c, v: Math.round(1000 + rnd() * 9000) });
  }
  return out;
}

/** fast-check arbitrary producing valid OHLCV bar sequences (h ≥ max(o,c), l ≤ min(o,c)). */
export const arbBars = (min = 20, max = 160) =>
  fc
    .array(
      fc.record({
        r: fc.double({ min: -0.05, max: 0.05, noNaN: true }),
        up: fc.double({ min: 0, max: 0.02, noNaN: true }),
        dn: fc.double({ min: 0, max: 0.02, noNaN: true }),
        gap: fc.double({ min: -0.01, max: 0.01, noNaN: true }),
        v: fc.integer({ min: 0, max: 100000 }),
        // occasionally repeat the previous close exactly, to exercise equality edge cases
        flat: fc.boolean(),
      }),
      { minLength: min, maxLength: max },
    )
    .map((steps) => {
      const bars: Bar[] = [];
      let c = 100;
      steps.forEach((s, i) => {
        const o = Math.max(0.5, c * (1 + s.gap));
        const nc = s.flat && i % 7 === 0 ? c : Math.max(0.5, o * (1 + s.r));
        const h = Math.max(o, nc) * (1 + s.up);
        const l = Math.min(o, nc) * (1 - s.dn);
        bars.push({ t: 1_600_000_000_000 + i * 60_000, o, h, l, c: nc, v: s.v });
        c = nc;
      });
      return bars;
    });

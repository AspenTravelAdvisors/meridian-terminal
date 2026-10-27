#!/usr/bin/env node
/**
 * Engine benchmark (CLAUDE.md rule 5: 20 studies on 50k bars < 150 ms in the worker).
 *
 * The engine is bundled and minified with esbuild, as the production worker chunk is, and run in a fresh Node process.
 * Running it under the test runner instead measures the runner's module transform (every cross-module call goes through
 * an accessor), which roughly doubled the timings reported before 0.3.0.
 *
 *   pnpm bench                              → report; fails if the median exceeds MERIDIAN_PERF_BUDGET_MS (default 200)
 *   MERIDIAN_PERF_BUDGET_MS=150 pnpm bench  → enforce the strict target (use on a quiet desktop machine)
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules/.cache/meridian-bench.mjs');
mkdirSync(dirname(out), { recursive: true });

const entry = `
import { STUDY_MAP, computeStudies, defaultsOf } from './packages/engine/src';
import { randomWalk } from './packages/engine/test/helpers';
const TWENTY = ['td-sequential', 'td-combo', 'td-dwave', 'td-propulsion', 'td-range-projection', 'td-demarker-1', 'td-demarker-2',
  'td-rei', 'td-points', 'td-lines', 'ichimoku', 'sma', 'ema', 'bollinger', 'rsi', 'macd', 'atr', 'supertrend', 'adx', 'stochastic'];
const bars = randomWalk(50_000, 99);
const reqs = TWENTY.map((id) => ({ def: STUDY_MAP[id], cfg: defaultsOf(STUDY_MAP[id]) }));
// warm up to steady state: a live worker is long-lived
for (let k = 0; k < 3; k++) computeStudies(reqs, bars);
const runs = [];
for (let k = 0; k < 9; k++) {
  const t0 = performance.now();
  computeStudies(reqs, bars);
  runs.push(performance.now() - t0);
}
runs.sort((a, b) => a - b);
console.log(JSON.stringify({ best: runs[0], median: runs[4], runs }));
`;

await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'bench-entry.ts', loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  minify: true,
  outfile: out,
  logLevel: 'warning',
});

const r = spawnSync(process.execPath, [out], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}
const { best, median, runs } = JSON.parse(r.stdout.trim().split('\n').pop());
const budget = Number(process.env.MERIDIAN_PERF_BUDGET_MS ?? 200);
console.log(`20 studies × 50k bars (bundled engine): best ${best.toFixed(1)} ms · median ${median.toFixed(1)} ms · runs ${runs.map((x) => x.toFixed(0)).join(', ')}`);
console.log(`target 150 ms: ${median < 150 ? 'met' : best < 150 ? 'met on best run, not on median' : 'not met'} · budget ${budget} ms`);
if (median >= budget) process.exit(1);

# Performance

**Target (CLAUDE.md rule 5):** 20 studies on 50,000 bars in under 150 ms in the worker, with an O(1) amortized `update(bar)`.

`pnpm bench` (`scripts/bench-engine.mjs`) runs the 10 heaviest DeMark-style studies, Ichimoku and 9 standard studies over a
50,000-bar random walk. The engine is bundled and minified with esbuild, as the shipped worker chunk is, and runs in a fresh
Node process. The bench warms up, times 9 runs, prints best and median, and fails when the median exceeds
`MERIDIAN_PERF_BUDGET_MS` (default 200 ms, which leaves headroom for shared CI machines; use 150 on a quiet desktop).

## Measurement correction (0.3.0)

The 0.1.0/0.2.0 numbers (160–175 ms and 230–260 ms) came from a Vitest benchmark. Vitest's module transform routes every
cross-module call through an accessor, which made the engine look about 1.6× slower than the code that actually ships. The
bench now measures the bundled engine instead.

## Measurements (bundled engine, build containers)

| Engine | Best | Median | Notes |
|---|---|---|---|
| 0.2.0 engine | 134–146 ms | 168–216 ms | 4-vCPU shared container, same session as the row below |
| 0.3.0 engine | 122–141 ms | 143–202 ms | the same container, runs interleaved with the row above |
| 0.3.0 engine, CPU time | 158–164 ms | — | vs 185–189 ms for 0.2.0 in an earlier same-minute comparison: about 15% less CPU work, mostly less garbage collection |

**Status:** the best runs are under 150 ms. Medians straddle the target because these shared containers vary by ±30% from
run to run. A desktop browser worker should measure clearly under it; run `MERIDIAN_PERF_BUDGET_MS=150 pnpm bench` on a
desktop machine to confirm. A normal chart (1,500 bars) recomputes in about 3 ms (the status bar shows `engine … ms`).

## Where the time goes

- **Study code** is about 80% of the run. The largest costs are Sequential (setup, countdown, TDST, risk and recycling on
  both sides every bar), TD Lines, Ichimoku (six rolling extremes per bar) and Propulsion.
- **Events:** about 144k signals and 46k markers per run (Range Projection alone emits 36k).
- **GC** fell from about 15% to about 11% of CPU samples.

## Optimizations

0.3.0:
- Signals and markers are stored **columnar** (typed arrays plus interned strings) during a run and turned back into
  objects once, when results are read. Young-generation GCs no longer copy a growing list of 190k objects.
- `Engine.load()` commits each study in one loop (`commitRange`), without the per-bar provisional bookkeeping that only
  live updates need. Output columns are allocated once at their exact size.
- `computeStudies` hands its column buffers over instead of copying them (the engine is discarded right after).
- Ring buffers and rolling extremes wrap with a compare instead of an integer modulo.
- A test checks that bulk `load()` equals bar-by-bar `update()` for every study and every field.

Earlier:
- History is pre-sized in `load()` (`reserve`). Marker objects have one stable shape.
- Each study runs in its own loop during `load()`, which keeps the hot code monomorphic and the cache warm.
- Sequential and Combo reuse step buffers. Dense count labels are stored as columns. Price-flip events are off by default.

## Next steps, if a quiet desktop still misses the target

1. Fuse Sequential's buy and sell passes into one mirrored loop.
2. Cache TD Point confirmation (shared by Lines, Points and Propulsion) instead of recomputing it in each study.
3. Emit Range Projection breaks as transitions only (a behaviour change, so it would need Brian's sign-off).

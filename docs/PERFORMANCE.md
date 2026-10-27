# Performance

**Target (CLAUDE.md rule 5):** 20 studies on 50,000 bars in under 150 ms in the worker, with an O(1) amortized `update(bar)`.

`pnpm bench` runs `packages/engine/test/perf.bench.test.ts`. It covers the 10 heaviest DeMark-style studies, Ichimoku and 9
standard studies over a 50,000-bar random walk. It warms up to steady state, takes 5 timed runs and fails above
`MERIDIAN_PERF_BUDGET_MS` (default 300 ms, which leaves headroom for shared CI machines).

## Measurements

| Environment | Best | Median | Notes |
|---|---|---|---|
| Build container A (first session) | ~160 ms | ~170 ms | after the optimizations below |
| Build container B (4 vCPU, after a worker restart) | 232–248 ms | 251–259 ms | same code; slower host |

**The 150 ms target is not yet met** on either container, though both were shared sandboxes rather than a desktop CPU. In
the browser the engine runs off the main thread, so a full reload of a 1,500-bar chart (the default history) takes
about 3 ms (the status bar shows `engine … ms`).

## Where the time goes (container B)

- **Sequential (~19% of per-study time) and Ichimoku (~13%)** are the heaviest studies (single-study timings). Sequential runs setup, countdown, TDST, risk levels
  and recycling on both sides every bar.
- **Signal events (~8% of CPU samples).** On a random walk the 20 studies emit about 160k rule events per run. Range Projection
  breaks alone account for 25k of them.
- **GC (~10% of CPU samples)** comes mostly from output columns and event objects.

## Optimizations already made

- History and output columns are pre-sized in `load()` (`reserve`), so they never regrow per bar.
- Marker objects are stamped in place. Signal events have one stable object shape.
- `load()` runs each study in its own loop, which keeps the hot code monomorphic and the cache warm.
- Per-bar allocations are removed from the runner: provisional buffers reset only after a provisional bar, and intrabar
  scratch resets only for intrabar studies.
- Sequential and Combo reuse step buffers and avoid closures in their hot paths. Dense count labels are stored as
  columns rather than one marker object per bar.
- Price-flip events are off by default (`emitFlips`).

## Next steps

1. Pool `SignalEvent` objects or store events columnar (index, id code, price) and materialize them lazily.
2. Fuse Sequential's buy and sell passes into one mirrored loop over a shared scratch struct.
3. Re-measure on representative hardware (a desktop browser worker) before deciding how far to push the above.

# Architecture

```
apps/web            React 19 + Vite UI (dockview panels, Lightweight Charts, Zustand, TanStack Query)
apps/server         Web-standard API handlers (Request → Response): market data, scan, matrix, analyst, notify
packages/engine     Pure-TS indicator + signal engine, zero DOM dependencies (Web Worker and Node)
packages/data       Provider adapters, router, sessions/holidays, resampling, chart transforms, CSV
packages/portfolio  Ledger (lots, realized gains), returns (TWR/XIRR), risk, broker CSV importers
packages/ui         Theme tokens (dark/light CSS variables) and palettes (standard + colorblind-safe)
scripts/            Vercel Build Output writer, self-host server, shared security headers
fixtures/           Golden-reference fixtures (hand-computed today; reference CSVs to come)
```

## Engine (`packages/engine`)

- **Studies are pure definitions.** A `StudyDef` has a Zod schema, `init(cfg)` returning plain structured-cloneable state, and
  `update(cfg, state, ctx, writer)`, which runs once per bar and is O(1) amortized. Optional `geometry` and `status` give the
  pivots, segments and profiles and the chips used by panels.
- **The runner owns history.** `SeriesStore` holds columnar `Float64Array`s (t/o/h/l/c/v). Each `StudyInstance` holds its output
  columns. `Engine.load()` bulk-loads closed bars and runs each study in its own tight loop. `Engine.update()` is the live path.
- **Provisional bars.** A forming bar (`final === false`) is evaluated on a `structuredClone` fork of the committed state, so
  committed state never sees an unclosed bar. Counts on it render hollow and finalize when the bar closes.
- **No look-ahead.** A property test checks every study: output at bar *i* is identical whether or not bars after *i* exist.
  Intrabar-order studies (Range Projection) are flagged and tested with realistic tick paths.
- **Determinism.** The engine has no wall clock and no unseeded randomness; ESLint enforces this. The tester's random
  baseline uses a seeded `mulberry32` generator.
- **Sell rules mirror buy rules.** They run in mirrored price space (h′ = −l, l′ = −h, c′ = −c), so both sides share one
  implementation.
- **Multi-timeframe.** `alignHTF` maps a higher-timeframe series onto the base bars using only HTF bars that have *closed*
  by each base bar's close.
- **Meridian Script** (`script/dsl.ts`) is a vectorized DSL. The browser runs it in a worker that removes network, storage
  and messaging globals and enforces a time budget. `checkScriptLookAhead` replays prefixes to detect future leaks.

## Data (`packages/data`)

- `router.ts` resolves a symbol to a provider chain (`parseSymbol`) and tries each provider in turn. It records fallbacks and
  never substitutes simulated data for a real symbol.
- `sessions.ts` derives exchange calendars from rules (the NYSE holiday rules include an Easter computation).
  `transform.ts` does session-anchored resampling, Heikin Ashi, Renko, range bars, split/dividend adjustment and live-bar
  merging.
- The wire format is `[t, o, h, l, c, v, (0 if provisional)]`, which keeps payloads compact.

## Server (`apps/server`)

- `handle(req, env, fetcher)` routes web-standard `Request`s, so the same code runs as a Vercel Node function, under
  `scripts/serve.mjs` and inside the Vite dev server.
- Routes: `GET /api/bars|search|quotes|health`, `POST /api/scan|matrix|analyst|notify`. Inputs are validated with Zod. The
  server rate-limits per client and sets CDN cache headers on market data.
- `analyst` streams Claude output (`@anthropic-ai/sdk`, adaptive thinking, server-side refusal fallback), with
  `stop_reason` handling. Without a key it uses a deterministic rule-based briefing.
- `notify` relays alert webhooks and email. Webhook URLs must be public HTTPS; private, loopback and link-local addresses
  are refused (SSRF guard).

## Web (`apps/web`)

- **Workers:** `engine.worker` holds one incremental `Engine` per chart and chooses append or full load.
  A `compute.worker` pool runs screener, matrix, tester, status and alert evaluation. `script.worker` is the sandbox.
- **State:** Zustand stores persisted to `localStorage`: workspace, layouts, settings, drawings, watchlists, alerts,
  portfolio, journal and scripts. Bar snapshots and journal images go to IndexedDB. Runtime chart state is shared with
  panels through `useUi.runtime`.
- **Charts:** `ChartPane` connects data, engine and runtime. `ChartSurface` owns the Lightweight Charts instance, the series
  primitives (text markers, levels, heat strip, drawings) and the `DrawingController`. A small bus syncs crosshair and time
  across linked panes.
- **Layout:** `dockview-react`, with the layout JSON persisted per workspace and saved layouts restoring both the grid and the
  docks.

## Vercel adaptation of the original stack

`CLAUDE.md` specifies Fastify, SQLite/Drizzle and a WebSocket fan-out. Those need a long-running server, which a Vercel
deployment doesn't have. The equivalents here are:

| Spec | Here | Why |
|---|---|---|
| Fastify + Zod | web-standard handlers + Zod in one Node function | runs unchanged on Vercel, Node and Vite |
| SQLite (Drizzle) bar cache | CDN cache headers + IndexedDB in the browser | serverless functions have no durable disk |
| SQLite user data | `localStorage` / IndexedDB, with CSV and JSON export | single-user; no accounts yet |
| WebSocket fan-out | browser → Binance WebSocket directly; polling for other markets | Vercel functions can't hold sockets |
| Alert worker/scheduler | in-app evaluator (every 30 s while open) + server relay for webhook/email | no background workers |

The Postgres-compatible schema and a server-side alert scheduler are still open for a stateful deployment target.

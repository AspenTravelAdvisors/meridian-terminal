# Architecture

```
apps/web            React 19 + Vite UI (dockview panels, Lightweight Charts, Zustand, TanStack Query)
apps/server         Web-standard API handlers (Request → Response): market data, scan, matrix, analyst, notify, accounts,
                    sync, push and the alert scheduler (Postgres via Drizzle)
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
- Routes: `GET /api/bars|search|quotes|health`, `POST /api/scan|matrix|analyst|notify`; accounts under `/api/account/*`,
  `GET|POST /api/sync`, `/api/push/*`, `GET /api/alerts/activity` and `GET|POST /api/cron/alerts`. Inputs are validated with Zod. The
  server rate-limits per client and sets CDN cache headers on market data.
- `analyst` streams Claude output (`@anthropic-ai/sdk`, adaptive thinking, server-side refusal fallback), with
  `stop_reason` handling. Without a key it uses a deterministic rule-based briefing.
- `notify` relays alert webhooks and email. Webhook URLs must be public HTTPS; private, loopback and link-local addresses
  are refused (SSRF guard).
- **Database** (`src/db`): a Drizzle schema plus matching idempotent DDL, run on cold start. With `DATABASE_URL` it uses
  Neon's HTTP driver (no transactions, so every write is a single conditional statement). Without it, off Vercel, it uses
  PGlite (real Postgres in WASM), which is also what the tests run against. Every user-owned row has `user_id` and
  cascades on account deletion.
- **Accounts** (`routes/account.ts`, `auth.ts`): WebAuthn passkeys (SimpleWebAuthn) with discoverable credentials.
  Challenges are kept in the database because serverless instances share no memory. Sessions are random tokens, and only
  their SHA-256 is stored. The cookie is HttpOnly, SameSite=Lax and `__Host-` on HTTPS. Cookie-authenticated writes reject
  a foreign `Origin`.
- **Sync** (`routes/sync.ts`): one JSON document per persisted browser store, keyed by its persist name, with a revision.
  A write carries its base revision and is applied with `UPDATE … WHERE rev = base`. A stale write returns the server copy
  and the client merges.
- **Scheduler** (`alerts.ts`, `routes/alerts.ts`): `/api/cron/alerts` takes a row lock in `server_kv` (runs closer than
  45 s apart are skipped), reads every account's alerts, drawings and scripts documents, fetches each market once and
  evaluates with `evaluateAlert` from the engine, the same function the browser uses. Firings go to `alert_events`. Per-alert
  state (`lastFiredBar`, once-mode `done`, errors) goes to `alert_state` rather than into the user's document, so the
  scheduler never writes over a document someone is editing. Delivery is Web Push (`web-push`, VAPID keys from env or
  generated once into `server_kv`), webhook and e-mail.
- **Script sandbox** (`scriptSandbox.ts`): server-side script alerts run in QuickJS compiled to WebAssembly, with a fresh
  runtime per run, no host objects, an interrupt deadline and a WebAssembly memory with a hard maximum. The QuickJS
  per-runtime limit alone misses large array storage. The script API is the same `build` function as the browser's,
  injected as source text (it is written to be self-contained for that reason).

## Web (`apps/web`)

- **Workers:** `engine.worker` holds one incremental `Engine` per chart and chooses append or full load.
  A `compute.worker` pool runs screener, matrix, tester, status and alert evaluation. `script.worker` is the sandbox.
- **State:** Zustand stores persisted to `localStorage`: workspace, layouts, settings, drawings, watchlists, alerts,
  portfolio, journal and scripts. When signed in, `state/account.ts` mirrors each store to the account. It watches for
  local changes by hashing the persisted string, pushes after 1.5 s, and pulls on focus and every 30 s. Remote documents
  are applied through `localStorage` + `persist.rehydrate()`, so each store's own partialize and migrate logic is reused.
  Conflicting edits are merged by `state/merge.ts`. Bar snapshots and journal images go to IndexedDB. Runtime chart state is shared with
  panels through `useUi.runtime`.
- **Charts:** `ChartPane` connects data, engine and runtime. `ChartSurface` owns the Lightweight Charts instance, the series
  primitives (text markers, levels, heat strip, drawings) and the `DrawingController`. A small bus syncs crosshair and time
  across linked panes.
- **Layout:** `dockview-react`, with the layout JSON persisted per workspace and saved layouts restoring both the grid and the
  docks.
- **Two shells.** `App` picks `DesktopShell` (top bar, drawing rail, dock) or `MobileShell` (full-screen chart, bottom tabs,
  panels full screen) from a media query, and sets `data-shell` on `<html>` for the `mobile:` CSS variant. Both are lazy
  chunks; the dock library lives only in the desktop chunk. Panels are shared through `components/panelRegistry.tsx`.
  `openPanel()` focuses a dock panel on desktop and switches tabs on phones.
- **Chunks.** Workspace packages plus app `state/` and `lib/` form one `core` chunk that every feature chunk depends on. Without
  that grouping, the bundler produced cross-chunk import cycles that broke module initialization order. Check with any chunk
  graph tool after changing `manualChunks`.

## Vercel adaptation of the original stack

`CLAUDE.md` specifies Fastify, SQLite/Drizzle and a WebSocket fan-out. Those need a long-running server, which a Vercel
deployment doesn't have. The equivalents here are:

| Spec | Here | Why |
|---|---|---|
| Fastify + Zod | web-standard handlers + Zod in one Node function | runs unchanged on Vercel, Node and Vite |
| SQLite (Drizzle) bar cache | CDN cache headers + IndexedDB in the browser | serverless functions have no durable disk |
| WebSocket fan-out | browser → Binance WebSocket directly; polling for other markets | Vercel functions can't hold sockets |
| SQLite user data (multi-user) | Postgres (Neon on Vercel, PGlite locally), Drizzle schema; browser storage stays the working copy | serverless functions have no durable disk |
| Alert worker/scheduler | `/api/cron/alerts`, triggered by Vercel Cron or any external scheduler, plus the in-app evaluator while signed out or while the scheduler is idle | no long-running workers |

Brian approved these adaptations on 2026-10-27.

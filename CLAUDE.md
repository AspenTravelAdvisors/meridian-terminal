# CLAUDE.md — Meridian Terminal

> Read this file first, then `docs/SPEC.md` (what to build) and `docs/INDICATORS.md` (exact study rules).
> Work in the phases defined in `docs/SPEC.md §9`. Stop at every **GATE** and show Brian a demo before continuing.

## Mission
Build **Meridian Terminal**: a TradingView-style charting workstation plus portfolio tracker whose core differentiator is a
rigorous, test-verified implementation of Tom DeMark's studies (Sequential, Combo, D-Wave, Propulsion, Range Projection,
DeMarker I & II, and more) alongside Ichimoku and a full standard indicator library.

## Stack (do not change without asking)
| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo, TypeScript strict everywhere |
| Web app | React 19 + Vite, Zustand (state), TanStack Query (server data), Tailwind + Radix primitives |
| Charts | TradingView **Lightweight Charts v5** (Apache-2.0) with custom series + series primitives for markers/levels. Keep the license attribution (NOTICE text + link to tradingview.com) visible in the status bar and phone More page; the on-chart logo is off (Brian, 2026-10-27). |
| Layout | `dockview` for dockable, resizable, persisted panels |
| Indicator engine | `packages/engine` — pure TS, zero DOM deps, runs in a Web Worker and in Node |
| API server | Fastify + Zod, WebSocket fan-out for live bars |
| DB | SQLite (Drizzle ORM) locally; schema must be Postgres-compatible |
| Tests | Vitest, fast-check (property tests), Playwright (E2E) |
| Desktop (Phase 10, optional) | Tauri wrapper |

## Vercel deployment (approved by Brian, 2026-10-27)
The deployment target is Vercel, which has no long-running server. Brian approved these three adaptations of the stack table on
2026-10-27; they are the stack now. Details are in `docs/ARCHITECTURE.md` § "Vercel adaptation":
- **API:** web-standard `Request → Response` handlers + Zod (`apps/server`) in one Node function instead of Fastify. The same
  code runs under `pnpm serve` and the Vite dev server.
- **DB:** browser storage (localStorage / IndexedDB) and CDN caching for bars and offline use. Signed-in users also sync to
  Postgres (Drizzle schema in `apps/server/src/db`): Neon on Vercel, PGlite for local dev, tests and `pnpm serve`.
- **Live bars:** direct browser WebSocket (crypto) and polling instead of a server fan-out.

Background work (alert evaluation while every tab is closed) runs in `/api/cron/alerts`, triggered by Vercel Cron or any
external scheduler. Ask Brian before changing any of this.

## Repo layout
```
apps/web            React UI
apps/server         Fastify API, data adapters, alert worker, scheduler
packages/engine     Indicator + signal engine (the crown jewel)
packages/data       Provider adapters, bar normalization, corporate actions
packages/portfolio  Lots, transactions, P&L, returns, risk math
packages/ui         Shared components, theme tokens
fixtures/           Golden-reference CSVs (see INDICATORS.md §0)
```

## Commands
```
pnpm i            pnpm dev            pnpm test         pnpm test:golden
pnpm lint         pnpm typecheck      pnpm e2e          pnpm build
```

## Non-negotiable rules
1. **Rules come from `docs/INDICATORS.md`, never from memory.** If a rule there is marked `⚠ VERIFY`, implement it exactly as written,
   expose every threshold as a config input, and add it to `docs/VERIFY_LOG.md` with the test that pins it.
2. **Engine is test-first.** Write the failing unit test + a hand-computed fixture before the implementation. Every study needs:
   unit tests, a property test (no look-ahead: output at bar *i* must not change when bars *> i* are appended), and a golden test once a reference CSV exists.
3. **No look-ahead, ever.** Live (forming) bars render provisional counts styled differently; counts finalize only on bar close.
4. **Determinism.** Same bars + same config → byte-identical output. No `Date.now()`, no randomness in the engine.
5. **Incremental performance.** Each study implements `update(bar)` in O(1) amortized. Target: 20 studies on 50k bars < 150 ms in the worker.
6. **Secrets** live in `.env` only (`.env.example` committed). Never log API keys.
7. **IP hygiene.** Do not paste text from any book into the repo or UI. Write rule descriptions in your own words. Do not download or
   reference pirated PDFs. Indicator names like "TD Sequential" are trademarks of DeMark Analytics — label them "DeMark-style" in UI
   copy and keep the product name Meridian. (Brian decides on any commercial licensing.)
8. **Mirror TradingView's layout and workflow, not its branding** — no logos, trade dress, or copied icons.
9. Small commits, conventional-commit messages, one concern per PR-sized change. Update `docs/CHANGELOG.md` at each GATE.
10. When unsure about product behavior, ask Brian one concise question; when unsure about a DeMark rule, consult INDICATORS.md, then ask.

## Definition of done (per feature)
Typecheck clean · lint clean · tests green (unit + property + golden where available) · keyboard accessible · works in dark + light
theme · documented in `docs/` · demoed at the GATE.

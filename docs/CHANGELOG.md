# Changelog

## 0.1.0 — 2026-10-27 (first run)

All of SPEC §9 was built in one pass at Brian's request ("as advanced as possible in first run"). The GATE demos were not
held phase by phase; review this release as the combined demo.

### Engine
- Incremental engine: columnar history, O(1) amortized `update`, a batch `load`, provisional bars evaluated on forked state,
  and a Rule Inspector.
- 17 DeMark-style studies, Ichimoku, 33 standard studies and 2 Meridian composites (53 total). Every ⚠ VERIFY rule is an input.
- Tests: hand-computed fixtures, an independent Sequential oracle, no-look-ahead property tests for every study, golden
  fixtures, and VERIFY default pinning (`verify.test.ts`).
- Signal tools: event study with a seeded random baseline, a strategy backtester (TD risk-level stops, fees, slippage),
  scanner, MTF matrix, and the Meridian Script DSL with a look-ahead checker.

### Data, portfolio, server
- Provider router (Yahoo, Stooq, Alpaca, Twelve Data, Binance, Coinbase, SIM) with fallbacks, plus rule-based exchange
  calendars, resampling, Heikin Ashi/Renko/range transforms and corporate-action adjustment.
- Portfolio ledger: tax lots, realized ST/LT, TWR, XIRR, drawdown, VaR, correlation and income. Broker CSV import presets
  for Schwab, Fidelity, IBKR and Robinhood.
- Web-standard API: bars, search, quotes, scan, matrix, a streaming AI analyst with a rule-based fallback, and
  alert relay with an SSRF guard.
- Vercel Build Output (static + one Node function, strict CSP) and a self-host server that sends the same headers.

### Web
- Dockable workstation with 1–8 linked charts, 9 chart types, 18 drawing tools, bar replay, a volume profile, alerts,
  watchlists, screener, matrix, tester, script editor, journal, portfolio and AI analyst panels. Includes a command palette,
  hotkeys, dark and light themes, a colorblind-safe palette, deep links and an offline service worker.
- E2E smoke suite (Playwright) runs against the production build.

### Known gaps
- Live provider endpoints are untested from the build sandbox.
- The 150 ms engine target is not met on the build containers (see `docs/PERFORMANCE.md`).
- ⚠ VERIFY rules still need checking against reference data. One inconsistency is noted in `docs/VERIFY_LOG.md`.
- Persistence is browser-only (no accounts); alerts evaluate only while the app is open.

# Changelog

## Unreleased

### Charts
- Chart elements explain themselves: hover a count, marker, level, line, cloud, wave label or the heat strip for a tooltip;
  click or tap for a card with what it means, its value and date, the study description and a settings shortcut. The engine's
  marker tooltips (TDST value, cancel reason, risk level) appear here for the first time. Toggle in Settings.
- Charts open with the newest bar at the right edge. A symbol or timeframe change keeps the zoom and either jumps to the
  newest bar (default) or keeps the position relative to it (Settings). A » button returns to the newest bar after scrolling
  back.

### Fixes
- After a symbol switch, or when cached bars were replaced by fresh ones, the chart kept the old bar positions and could open
  in the middle of history or on empty space.

## 0.2.0 — 2026-10-27

### Phones
- Dedicated mobile shell: the active chart fills the screen; Watchlist, DeMark status, Alerts and More are bottom tabs; panels
  open full screen with a back button; dialogs become full-screen sheets; drawing tools are a swipeable strip; the tab bar
  turns compact in landscape.
- Touch sizing (36 px minimum targets, 16 px inputs so iOS doesn't zoom), safe-area insets, no double-tap delay, horizontal
  scrolling for wide tables, and PNG app icons with web-app metadata for home-screen install.
- The desktop dock is lazy-loaded, so phones never download it.

### Guide
- `docs/WALKTHROUGH.md`: every feature, how to read each DeMark-style study, and six strategic playbooks, with keyboard and
  settings references. Rendered in-app as the **Guide** panel, with search and section jumps.
- The Markdown renderer now joins soft-wrapped lines and supports tables and fenced code (this also helps analyst briefings).

### Fixes
- Switching between two symbols that both had data crashed the chart: the previous symbol's results were drawn against the
  new bars. Results now reset on a series change, and the renderer ignores stale results.
- Bars finalize at the real session close (a daily NYSE bar no longer stays provisional overnight), and resampled buckets
  stay provisional until their period ends.
- Pressing Enter quickly in symbol search no longer picks the previous search's first result.
- Watchlist rows are reachable by keyboard; the shortcut list no longer shows a wrong replay binding.
- A build-time chunk cycle that could break module initialization was removed (one acyclic `core` chunk).

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

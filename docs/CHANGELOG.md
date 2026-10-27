# Changelog

## 0.3.0 — 2026-10-27 (current; review this as the combined demo)

0.3.0 contains everything from 0.1.0 and 0.2.0 plus the items below, and it is the single build to review. Brian waived the
phase-by-phase GATE demos ("as advanced as possible in first run") and asked that the current version incorporate every
feature. The full feature list is in `README.md` § Features and the user guide is `docs/WALKTHROUGH.md`.

### Accounts, sync and background alerts
- **Passkey accounts:** sign up and sign in with Face ID, Touch ID, Windows Hello or a security key, with no passwords. On
  Apple devices passkeys sync through iCloud Keychain. Includes extra passkeys per device, a one-time recovery code, sign
  out and delete account. Without `SIGNUP_CODE` only the owner's (first) account can be created.
- **Cloud sync** of watchlists, alerts and alert log, portfolio, journal notes, drawings, layouts and templates, scripts,
  study defaults, settings and the workspace. Edits on two devices are merged by id. Data survives clearing a browser's
  site data.
- **Server-side alert scheduler** (`/api/cron/alerts`): checks every account's alerts with Meridian closed, using the
  same evaluator as the browser, at most once per bar. It delivers by **Web Push** (iPhone/iPad via the Home Screen app,
  Mac, Windows, Android), webhook and e-mail. Open tabs stand down while the scheduler is running.
- **Postgres** with a Drizzle schema: Neon on Vercel (`DATABASE_URL`), embedded PGlite for dev, tests and `pnpm serve`. This
  closes the "Postgres-compatible schema" item.
- Setup guide: `docs/ACCOUNTS.md`.

### Scripts everywhere
- Meridian Script signals now work in **alerts** (browser and server), the **screener** and the **signal tester**.
  Server-side scripts run in a QuickJS WebAssembly sandbox with no network, a memory ceiling and a deadline.

### Charts and data
- **Renko / Range box size:** Chart type → Box size… sets auto (ATR length) or a fixed price amount.
- **Non-US listings** (XETRA, Frankfurt, Toronto, TSX-V, London, Euronext, SIX, Milan, Madrid, Tokyo, Hong Kong, ASX,
  NSE/BSE) get their own session hours, time zone and currency in search and on the chart. Bars finalize at the local
  close. Local holidays outside the NYSE are not modelled yet.

### Engine performance
- Columnar signal and marker buffers, a bulk commit loop and no-copy one-shot results: about 15% less CPU per run. A new
  test checks that bulk load equals bar-by-bar update for every study.
- `pnpm bench` now measures the bundled engine. The old Vitest harness inflated timings about 1.6×. On the shared build
  containers the best runs are under 150 ms and medians straddle it (`docs/PERFORMANCE.md`).

### Decisions recorded
- Brian approved the three Vercel stack adaptations (CLAUDE.md, `docs/ARCHITECTURE.md`).

### Known gaps
- On Vercel Hobby, Vercel Cron runs the scheduler once a day. Minute-by-minute background alerts need Vercel Pro
  (`ALERT_CRON_SCHEDULE="* * * * *"`) or a free external scheduler hitting `/api/cron/alerts` (`docs/ACCOUNTS.md`).
- Real iPhones/Safari, live push delivery, e-mail (needs a Resend key) and Alpaca/Twelve Data (need keys) are untested
  from the build sandbox. Passkeys are tested end to end with Chromium's virtual authenticator.
- Journal screenshots don't sync. They stay on the device that took them.
- ⚠ VERIFY rules: being checked separately (`docs/VERIFY_LOG.md`).

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

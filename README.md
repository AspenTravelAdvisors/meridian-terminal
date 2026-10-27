# Meridian Terminal

A TradingView-style charting workstation and portfolio tracker. Its core is a rigorously tested, incremental indicator
engine with **DeMark-style** exhaustion studies (Sequential, Combo, D-Wave, Propulsion, Range Projection, DeMarker I & II
and more), Ichimoku and a full standard library. It is built as a pnpm/Turborepo monorepo and deploys to Vercel as one
static app plus one Node function.

> DeMark indicator names are trademarks of DeMark Analytics. Meridian implements its own descriptions of the rules
> (see `docs/INDICATORS.md`) and labels them "DeMark-style". It is not affiliated with DeMark Analytics or TradingView.
> Charts by TradingView Lightweight Charts™ (Apache-2.0); the license attribution (notice + link to tradingview.com) is in the status bar and on the phone More page, in place of the on-chart logo. Analysis only, not investment advice.

## Features

**Charting**
- Lightweight Charts v5 renders up to 8 linked charts: symbol link groups, synced crosshair, time and interval.
- Chart types: candles, hollow candles, bars, line, area, baseline, Heikin Ashi, Renko and range bars.
- Price scales: log, percent and indexed. Comparison overlays are supported.
- 18 drawing tools: trend, ray, extended, horizontal and vertical lines, channel, fib retracement, extension and time, rectangle,
  ellipse, path, text, price label, long and short position, and measure. Drawings support magnet snapping, undo/redo,
  locking and an object tree.
- Bar replay recomputes every study bar by bar with no look-ahead. It stops at the live edge.
- Live data streams over WebSocket for crypto and polls for everything else. The forming bar is drawn as
  **provisional**: counts show hollow and finalize only on close.
- Visible-range volume profile, a confluence heat strip, snapshots, saved layouts and study templates.

**Studies: 53 in the registry**
- **DeMark-style (17):** Sequential, Combo, D-Wave, Propulsion, Range Projection, DeMarker I and II, Lines, Points,
  REI + POQ, Pressure, Differential, Open Patterns, Moving Average I and II, Trend Factor, REBO.
- **Meridian composites:** Exhaustion Confluence and Count Consensus.
- **Ichimoku** and **33 standard studies:** moving averages, Supertrend, PSAR, ADX/DMI, pivots, ZigZag, linear regression,
  VWAP, MFI, OBV, CMF, A/D, session volume profile, Bollinger, Keltner, Donchian, ATR, historical volatility, RSI,
  Stochastic, Stoch RSI, MACD, CCI, Williams %R, ROC, relative strength and correlation.
- Every input is generated from a Zod schema. Every ⚠ VERIFY rule is a visible, documented input (`docs/VERIFY_LOG.md`).
- The **Rule Inspector** shows every rule condition evaluated on the hovered bar, with the values it compared.

**Workflow panels** (dockable, resizable and persisted)
- Watchlists, symbol details, data window, DeMark-style status across D/W/M with historical signal statistics.
- Alerts on signals, price, study values, drawings or your own scripts. Alerts can fire on close or intrabar and deliver
  in-app, by Web Push to your devices, by webhook or by email.
- **Accounts (passkeys) and sync:** sign in with Face ID / Touch ID / Windows Hello (no passwords; passkeys sync through
  iCloud Keychain on Apple devices). Everything you set up follows you across devices, and a server scheduler checks
  alerts and pushes them with Meridian closed. See `docs/ACCOUNTS.md`.
- Screener, multi-timeframe exhaustion matrix and a signal tester. The tester runs event studies against a seeded
  random-entry baseline, plus a strategy mode with TD risk-level stops, fees and slippage.
- **Meridian Script:** a small vectorized DSL for your own studies. Scripts run in a locked-down worker with a time
  budget and an automatic look-ahead check, and work in alerts, the screener and the tester too.
- **Portfolio:** tax lots (FIFO, LIFO, HIFO, specific-lot), realized and unrealized P&L, TWR and XIRR, drawdown, VaR,
  correlation, income, allocation and position sizing. CSV import presets cover Schwab, Fidelity, IBKR, Robinhood and Meridian.
- **Journal:** notes pinned to bars, with optional chart snapshots stored in IndexedDB.
- **AI analyst:** Claude gets the engine's *structured* output (signals, levels, matrix and exposure, never screenshots) and
  streams a plain-English briefing. Without an API key it falls back to a deterministic rule-based summary.
- Command palette (Ctrl/⌘ K), TradingView-style hotkeys, dark and light themes, a colorblind-safe palette, and offline
  caching through a service worker.
- **Phones:** a dedicated layout with a full-screen chart, bottom tabs (Chart, Watchlist, DeMark, Alerts, More), full-screen
  panels and dialogs, touch-sized controls and an installable home-screen app. Phones never download the desktop dock.
- **Built-in guide:** `docs/WALKTHROUGH.md` covers every tool and six strategic playbooks. It's also readable and searchable
  inside the app (desktop: Panels → Guide; phone: More → Guide).

## Quick start

```bash
pnpm i
cp .env.example .env        # all keys optional
pnpm dev                    # http://localhost:5173 (API served by the Vite dev server)
```

Open `/?symbol=SIM:DEMO` for an offline, deterministic demo series. Deep links take `?symbol=…&interval=…`.

| Command | What it does |
|---|---|
| `pnpm test` | unit + property (no look-ahead) + golden tests |
| `pnpm test:golden` | golden fixtures only (`fixtures/`) |
| `pnpm bench` | engine budget: 20 studies × 50k bars (bundled engine, fresh Node process) |
| `pnpm typecheck` / `pnpm lint` | strict TypeScript / ESLint (includes an engine determinism rule) |
| `pnpm e2e` | Playwright smoke suite against the production build |
| `pnpm build && pnpm serve` | self-host: static app + API from one Node process, same CSP as Vercel |
| `pnpm build:vercel` | writes `.vercel/output` (Build Output API v3) |

## Deploying to Vercel

The repo deploys as-is. `vercel.json` sets `pnpm build:vercel`, which builds the web app and writes `.vercel/output`:
- `static/`: the Vite build, served with immutable caching for hashed assets.
- `functions/api.func`: one bundled Node 22 function that handles every `/api/*` route with streaming responses.
- `config.json`: routes, SPA fallback and security headers, including a strict CSP.

Import the repository in Vercel (framework preset "Other"), then set any environment variables you want:

| Variable | Purpose |
|---|---|
| `SITE_PASSWORD` | **required in production**: the password for the site and API (see ARCHITECTURE § Site password gate). With it unset, production is locked |
| `ANTHROPIC_API_KEY` | enables the AI analyst (otherwise a rule-based briefing) |
| `ANTHROPIC_MODEL` | analyst model, default `claude-opus-5-5` |
| `TWELVE_DATA_API_KEY` | optional equities/FX provider |
| `ALPACA_KEY_ID`, `ALPACA_SECRET` | optional US equities provider |
| `ALLOWED_ORIGINS` | comma-separated CORS allow-list for the API |
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | email delivery for alerts; only to the addresses listed in `ALERT_EMAIL_TO` |
| `DATABASE_URL` | Postgres for accounts, sync and background alerts. Set automatically by Vercel's Neon integration (Storage → Create Database → Neon). |
| `CRON_SECRET` | protects `/api/cron/alerts`; Vercel Cron sends it automatically. Also the only way past the site password gate for the scheduler: without it, background alerts can't run in production |
| `ALERT_CRON_SCHEDULE` | scheduler frequency at build time; default once a day (the Hobby limit), `* * * * *` on Pro |
| `SIGNUP_CODE` | invite code for accounts after the first (without it only the owner's account can be created) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push keys; generated and stored in the database when unset |

Account setup, background alerts and iPhone push are walked through in `docs/ACCOUNTS.md`.

Secrets are read only on the server and never logged.

## Data providers

The router tries a provider chain per symbol and reports which provider served each response.

- **Equities, ETFs, indices, futures, FX:** Yahoo, then Stooq, plus Alpaca and Twelve Data when keys are set.
- **Crypto:** Binance (REST plus a WebSocket stream), then Coinbase.
- **`SIM:*`:** deterministic simulated series for demos and tests. They are clearly badged "SIMULATED".

Real symbols **never** fall back to simulated data. If every provider fails, the chart says so and offers the demo series.
Sessions and holidays (NYSE rules including Easter, CME, FX, 24×7) drive resampling and future-bar spacing. Corporate actions
support `split`, `all` and `none` adjustment.

## Honesty notes

- Live provider endpoints are implemented against their public formats and covered by mocked tests. The sandbox that built
  this could not reach them, so verify them on a real deployment.
- ⚠ VERIFY rules are implemented exactly as `docs/INDICATORS.md` states them and are pinned by tests. They still need checking
  against reference charts before anyone relies on them. One known inconsistency is listed in `docs/VERIFY_LOG.md`.
- The performance target is documented with measured numbers in `docs/PERFORMANCE.md`.
- Background alerts run as often as something calls `/api/cron/alerts`. On Vercel Hobby that's once a day unless an external
  scheduler is added (`docs/ACCOUNTS.md`).

## Docs

- `docs/WALKTHROUGH.md`: user guide: every feature, plus strategic playbooks
- `docs/ACCOUNTS.md`: accounts, sync, background alerts and push: setup and how they work
- `docs/SPEC.md`: product spec
- `docs/INDICATORS.md`: study rules
- `docs/VERIFY_LOG.md`: uncertain rules and the tests that pin them
- `docs/ARCHITECTURE.md`: how the pieces fit together
- `docs/PERFORMANCE.md`: engine budget and measurements
- `docs/CHANGELOG.md`: changes

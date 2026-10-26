# Meridian Terminal — Product & Architecture Spec

## 1. Product summary
A browser-first (PWA, optional desktop) trading workstation that **mirrors TradingView's layout and workflow** and adds what
TradingView doesn't do well: institutional-grade DeMark-style exhaustion analysis, multi-timeframe signal matrices, signal
backtest statistics per symbol, and a portfolio tracker where every holding shows its live DeMark status.

Primary user: Brian (single user first, multi-user-ready schema). Not a broker — no order execution in v1.

---

## 2. Layout (mirror TradingView function)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR: symbol search · interval · chart type · Studies · Alerts · Replay ·  │
│          Compare · Layout grid · Undo/Redo · Snapshot · Settings              │
├──┬───────────────────────────────────────────────────────────┬───────────────┤
│D │                                                           │ RIGHT DOCK     │
│R │   CHART GRID (1 / 2 / 3 / 4 / 6 / 8 panes)                │ Watchlist      │
│A │   • main price pane + stacked study panes (resizable)     │ Symbol details │
│W │   • legend with live values per study                     │ TD Status card │
│  │   • price & time scales, log/% scale, auto-fit            │ Alerts         │
│T │   • crosshair sync, symbol/interval link groups (colors)  │ Object tree    │
│O │                                                           │ Data window    │
│O ├───────────────────────────────────────────────────────────┤ News / notes   │
│L │ BOTTOM DOCK: Portfolio · Screener · Signal Tester ·       │                │
│S │              MTF Matrix · Script Editor · Alert Log       │                │
└──┴───────────────────────────────────────────────────────────┴───────────────┘
```

**Must-have behaviors**
- Every panel docks, undocks, tabs, resizes, collapses; layouts persist per workspace and can be named, saved, and switched.
- Multi-chart grid with **link groups**: panes sharing a color sync symbol and/or interval; crosshair and date sync are global toggles.
- Chart types: candles, hollow candles, bars, line, area, baseline, Heikin Ashi, Renko and Range (computed server-side).
- Studies dialog: search, favorites, categories (DeMark, Trend, Momentum, Volatility, Volume, Ichimoku, Custom), per-study tabs for **Inputs / Style / Visibility (by timeframe)**, save as defaults, study templates.
- Drawing tools: trendline, ray, extended line, horizontal line/ray, vertical line, parallel channel, Fibonacci retracement/extension/time zones, rectangle, ellipse, path, text/note, price label, long/short position tool, measure tool. Magnet snap to OHLC. Lock, hide, clone, z-order, and per-symbol persistence.
- Keyboard shortcuts close to TradingView muscle memory (`Alt+T` trendline, `Alt+H` horizontal line, `Alt+F` Fib, `/` studies, `Ctrl+Z`, arrow keys pan, `+`/`-` zoom, type to search symbols).
- Bar Replay: pick a start date and step or autoplay at speeds; all studies recompute with no look-ahead (the engine guarantee makes this trivial).
- Themes: dark (default) and light from design tokens; colorblind-safe signal palette option.
- Snapshot: PNG export of a pane or the full grid with legend.

---

## 3. Data layer (`packages/data`)
- **Provider interface** `MarketDataProvider { searchSymbols, getBars(symbol, interval, from, to, adjust), subscribe(symbol, interval) }`.
- Ship adapters for Alpaca (US equities), Tiingo or Twelve Data (equities/ETFs/FX), Binance (crypto, free WebSocket), and a **CSV/Parquet import** adapter. Check each provider's current API docs before coding; keys go in `.env`.
- Normalize to `Bar { t: epochMs (bar open, UTC), o, h, l, c, v, final: boolean }`. Session calendars per exchange (NYSE, CME, 24/7 crypto).
- **Split/dividend adjustment** is a toggle (default: split-adjusted, not dividend-adjusted). DeMark counts are close-sensitive, so the adjustment mode is part of the engine cache key.
- Server-side resampling from base intervals (1m → 5m/15m/1h/4h; daily → weekly/monthly/quarterly) using exchange sessions.
- Local bar cache in SQLite plus in-browser IndexedDB for instant reloads. Backfill gaps lazily on scroll.

---

## 4. Indicator engine (`packages/engine`)
```ts
interface Study<Cfg, Out> {
  id: string; version: string; category: Category;
  defaults: Cfg; schema: ZodSchema<Cfg>;          // drives the Inputs tab automatically
  create(cfg: Cfg): StudyState;
  update(state, bar: Bar, i: number): Out | null; // O(1) amortized, provisional if !bar.final
  outputs: OutputSpec[];                           // lines, histograms, clouds, markers, levels, zones, labels
  signals?: SignalSpec[];                          // named events usable by alerts, screener, tester
}
```
- Runs in a **Web Worker pool** (one per visible pane) and in Node for the screener, alerts, and backtests: same code, same results.
- Outputs are typed render primitives (`line`, `histogram`, `cloud`, `marker{text,position,color}`, `level{from,to,price,label}`, `zone`), so the chart layer stays study-agnostic.
- **Multi-timeframe access**: a study may request a higher-timeframe series (`requestHTF('1W')`) with strict non-repainting alignment (HTF value is only known after the HTF bar closes).
- **Signal bus**: every study emits named signals (`SEQ_BUY_SETUP_9`, `SEQ_BUY_CD_13`, `COMBO_SELL_13`, `DWAVE_5_COMPLETE`, `PROP_UP_TRIGGER`, `RP_BREAK_HIGH`, `DEM1_OVERSOLD_EXIT`, `ICHI_TK_CROSS_ABOVE_CLOUD`, …) consumed by alerts, screener, tester, and the AI layer.

---

## 5. Study catalog
Full rules for DeMark studies and Ichimoku are in `docs/INDICATORS.md`.

**DeMark-style (required):** TD Sequential (Setup, Perfection, TDST, Countdown, Aggressive, Recycling, Risk Levels) · TD Combo (strict + v2) · TD D-Wave · TD Propulsion · TD Range Projection + Tolerance Levels · TD DeMarker I · TD DeMarker II.
**DeMark-style (extended):** TD Lines (supply/demand, qualifiers, projections) · TD Points · TD REI + TD POQ · TD Pressure · TD Differential / Reverse / Anti-Differential · TD Open, TD Clop, TD Clopwin, TD Trap · TD Camouflage · TD Moving Averages I & II · TD Trend Factor · TD Risk Levels overlay.
**Ichimoku:** full Kinko Hyo with future cloud, configurable periods (9/26/52 and crypto 20/60/120 presets), Kumo twist markers, and TK cross signals classified by cloud position.
**Standard library:** SMA, EMA, WMA, HMA, DEMA, TEMA, VWAP (session + anchored), Bollinger, Keltner, Donchian, ATR, Supertrend, Parabolic SAR, ADX/DMI, RSI, Stochastic, StochRSI, MACD, CCI, Williams %R, ROC, MFI, OBV, CMF, A/D line, Volume + MA, Volume Profile (visible range + session), Pivot Points (classic/Fib/Camarilla/Woodie), ZigZag, Linear Regression channel, Relative Strength vs benchmark, Correlation coefficient, Historical Volatility.

---

## 6. Portfolio module (`packages/portfolio`, bottom dock)
- Accounts → positions → **tax lots** (FIFO / LIFO / HIFO / specific-ID), transactions (buy, sell, dividend, split, transfer, fee, cash).
- Import: broker CSV mappers (Schwab, Fidelity, IBKR, Robinhood) plus generic CSV with a column-mapping wizard; dedupe on import.
- Metrics: market value, cost basis, unrealized/realized P&L (short/long-term), day change, allocation by asset class/sector/account, **TWR and MWR (XIRR)**, benchmark comparison, max drawdown, volatility, Sharpe, Sortino, beta, correlation matrix, 95% historical VaR.
- **Killer column — "DeMark Status":** each holding shows, for the user's chosen timeframes (default D/W/M), compact chips like `B-Setup 7`, `S-CD 12`, `Combo 13 ✓`, `TDST ↓ broken`, `D-Wave 5`. Clicking a chip opens the chart at that bar.
- Position sizing helper: risk-per-trade vs. the nearest TD Risk Level or TDST → share count.
- Equity curve chart and income (dividend) calendar.

---

## 7. Signal tools
- **Screener:** run any study signal across watchlists/universes on any timeframe server-side; columns are configurable; sort by "bars since signal".
- **MTF Matrix:** a symbols × timeframes heatmap (15m / 1h / 4h / D / W / M) of Sequential/Combo state. **Confluence score** = weighted sum of aligned exhaustion signals; weights are user-editable.
- **Signal Tester:** an event-study backtester, so "after a Daily Combo Buy 13 on this symbol, what happened?" Forward returns at N = 1/5/10/20/60 bars, hit rate, MAE/MFE, distribution histogram, and comparison to a random-entry baseline. Optional simple strategy mode (entry on signal, exit on opposite signal, TD Risk Level stop, or time stop) with equity curve and fees/slippage inputs.
- **Alerts:** on any signal, price level, drawing crossing, or study value. Evaluated server-side on bar close (or intrabar with "provisional" flag). Delivery: in-app, browser push, email, webhook. Expiry and once/every-bar modes. Full alert log.

---

## 8. Upgrades beyond TradingView
1. **Provisional vs. final counts** shown distinctly (hollow vs. solid numbers) to end the classic DeMark repaint confusion.
2. **Rule-variant toggles** (Sequential close vs. aggressive countdown, Combo strict vs. v2, TDST mode, recycle factor) with a side-by-side "variant diff" overlay.
3. **Per-symbol signal statistics** in the TD Status card (e.g., "Weekly Sequential 13s on this symbol: n, median 20-bar return").
4. **AI Chart Analyst** (Phase 10): a server-side call to the Anthropic API (model id from `.env`) that receives *structured* engine output (active signals, levels, MTF matrix, portfolio exposure), not screenshots, and returns a plain-English briefing with explicit uncertainty. A daily portfolio brief can be emailed. Label it analysis, not advice.
5. **Script Editor:** user-defined studies in a sandboxed TypeScript DSL (Monaco editor, executed in a locked-down Worker with a time/memory budget) using the same `Study` interface.
6. **Journal:** attach notes and screenshots to bars/trades, then review them against signals.
7. **Offline-first PWA** with cached bars and layouts.

---

## 9. Build phases (stop at each GATE)
| # | Phase | Key deliverables | GATE demo |
|---|---|---|---|
| 0 | Scaffold | Monorepo, CI (lint/typecheck/test), env handling, theme tokens | `pnpm dev` shows empty docked shell |
| 1 | Data | Provider interface, 2 adapters + CSV, cache, resampling, adjustment toggle | Bars load, scroll-back backfill works |
| 2 | Chart shell | Lightweight Charts panes, grid layouts, link groups, top bar, drawing tools v1, persistence | TradingView-like workflow on real data |
| 3 | Engine core + Sequential | Study interface, worker pool, render primitives, **TD Sequential complete**, golden harness | Sequential matches reference CSV |
| 4 | Combo + Range Projection + DeMarker I/II | Required studies + Tolerance Levels | All required oscillators green on golden tests |
| 5 | D-Wave + Propulsion + TD Lines/Points | Wave labeling, shift rules, propulsion levels | Wave counts reviewed by Brian on 3 symbols |
| 6 | Ichimoku + standard library + extended DeMark | §5 catalog complete, studies dialog with auto-generated Inputs | Studies dialog demo |
| 7 | Portfolio | Lots, imports, metrics, DeMark Status column, sizing helper | Brian's CSV imported end-to-end |
| 8 | Screener, MTF Matrix, Alerts | Server-side scans, confluence score, delivery channels | Alert fires on live data |
| 9 | Signal Tester + Bar Replay | Event studies, strategy mode, replay | Stats on 5 symbols |
| 10 | AI Analyst, Script Editor, Journal, PWA/Tauri | §8 upgrades | Final review |

---

## 10. Quality bar
- Lighthouse performance ≥ 90 on the chart page; 60 fps pan/zoom with 8 panes × 5 studies.
- Engine coverage ≥ 95% lines; every `⚠ VERIFY` item has a pinned test and a `VERIFY_LOG.md` entry.
- Accessibility: all dialogs keyboard-navigable, signals never conveyed by color alone (markers carry text).
- A footer disclaimer on analytics views: informational tool, not investment advice.

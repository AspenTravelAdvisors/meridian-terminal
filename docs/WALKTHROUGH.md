# Meridian Terminal — Walkthrough

This guide covers every part of Meridian: what each tool does, how to read it, and how to combine the tools into a
repeatable way of working. You can read it here or in the app (desktop: **Panels → Guide**; phone: **More → Guide**).

> Meridian is an analysis tool, not investment advice. Its DeMark-style studies describe *exhaustion*: how stretched a move
> is. They are probabilistic, they are wrong often, and they never tell you what price will do next. Every strategy idea below
> is a way to organise evidence. Test it yourself before you rely on it.

A few honesty notes before you start:
- **"DeMark-style".** The studies are Meridian's own implementations of publicly described rules. They aren't licensed from
  or endorsed by DeMark Analytics. Rules marked **⚠ verify** in the Studies dialog are implemented exactly as written in Meridian's
  spec, but nobody has checked them against reference charts yet. Treat their output as provisional.
- **Simulated data is labelled.** Symbols starting with `SIM:` are generated series for practice and demos, badged
  **SIMULATED**. A real symbol never silently falls back to simulated prices.
- **Your data stays in your browser unless you sign in.** Without an account, watchlists, drawings, alerts, portfolio and
  journal live only in this browser's storage. With an account (person icon in the top bar, or More → Account) they sync to
  your other devices, and alerts run on the server with Meridian closed. See [Account and sync](#account-sync-and-background-alerts).

---

## Quick start (five minutes)

1. **Open a market.** Click the symbol box (top left) or just start typing a ticker: `SPY`, `AAPL`, `BINANCE:BTCUSDT`,
   `EURUSD=X`, `ES=F`. To practise on data that never changes, use `SIM:DEMO`.
2. **Pick a timeframe** from the toolbar (`1m` … `M`; the arrow menu has `30m` and `3M`).
3. **Read the default studies.** New charts open with the **DeMark-style stack**: Sequential (with TDST and risk levels),
   Combo, TD Lines, DeMarker I and REI. `docs/STRATEGY.md` explains how the studies work together. The small numbers above and
   below the bars are setup counts (1–9). The boxed **13** is a completed countdown. To put the stack on an existing chart, use
   **Studies → Templates → DeMark-style stack**.
4. **Check the DeMark Status panel** (right side; on phones, the **DeMark** tab). It summarises the live count on the daily,
   weekly and monthly charts and shows how past signals on this symbol played out.
5. **Hover (or tap) a bar with the Rule Inspector open** to see exactly which rule conditions passed on that bar.
6. **Add an alert** (Alert button / Alerts tab) for a signal you care about, such as *Seq BUY SETUP 9*, so you don't have to
   watch the screen.

Deep links work too: `/?symbol=BINANCE:ETHUSDT&interval=4h` opens straight to that chart.

---

## The screen

### Desktop
- **Top bar:** symbol, compare (**+**), timeframes, chart type and price scale, Studies, Alert, Replay, chart grid and
  saved layouts, Panels menu, undo/redo, snapshot, command palette, shortcuts, theme and settings.
- **Left rail:** drawing tools, magnet, hide-all and remove-all drawings.
- **Centre:** the chart grid (1 to 8 charts).
- **Docked panels:** drag any panel tab to rearrange; drag the edges to resize. The layout is saved automatically. Close a
  panel with its ×, and reopen it from **Panels**.
- **Status bar:** data source (and fallbacks), bar count, engine time, last update, and the chart-library attribution.

### Phone
- The chart fills the screen. Pinch to zoom, drag to pan, and tap a bar to see its values.
- **Top bar:** symbol · timeframe · studies (*f*) · drawing tools (pencil) · **⋮** for chart type, price scale, compare, replay,
  volume profile, snapshot, undo/redo, theme and settings.
- **Bottom tabs:** Chart, Watchlist, DeMark, Alerts, and **More** (every other tool). Picking a symbol anywhere, whether in a
  watchlist, screener row or status row, takes you back to the chart.
- Dialogs open full screen. Add Meridian to your home screen (Share → *Add to Home Screen* on iOS, *Install app* on Android)
  and it runs like an app.

---

## Charts

### Symbols and data sources
| You type | Data comes from |
|---|---|
| `AAPL`, `SPY`, `^GSPC`, `ES=F`, `EURUSD=X` | Yahoo, with Stooq as a fallback (Alpaca / Twelve Data if the server has keys) |
| `BINANCE:BTCUSDT` | Binance, with a live WebSocket stream; Coinbase as a fallback |
| `SIM:DEMO`, `SIM:TREND`, `SIM:CHOP` | Simulated series for practice (always badged) |
| `SAP.DE`, `RY.TO`, `VOD.L`, `7203.T` | Yahoo, on the listing's own exchange hours, time zone and currency |

The **Symbol** panel shows the exchange, session calendar, time zone and which provider actually served the data.

### Timeframes, sessions and the forming bar
Bars follow each market's real session: NYSE hours and holidays, CME's overnight session, FX's 24×5 week, and crypto 24×7.
The **last bar is "forming"** until its session or period actually closes. A daily stock bar closes at 16:00 New York time;
a weekly bar closes at the Friday close.

While a bar is forming, every study evaluates it **provisionally**. Its counts are drawn hollow and tagged `PROV` in the legend,
and they can still change or disappear. **Nothing is final until the bar closes.** This is the most important habit in
Meridian: never act on a provisional 9 or 13 as if it were complete.

### Chart types and scales
- **Candles, hollow candles, bars, line, area, baseline.**
- **Heikin Ashi** smooths the candles for *display*. Studies still run on the real prices underneath.
- **Renko** and **Range** bars replace time with price movement, and studies run on the bricks. By default the box size is
  set from recent volatility (average true range, 14 bars). **Chart type → Box size…** changes the ATR length or sets a
  fixed size in price units.
- **Scales:** regular, logarithmic (use it for long histories), percent, and indexed to 100 (use it to compare symbols).
- **Adjustment:** split-adjusted (default), split + dividend, or unadjusted.
- **Compare (+):** overlay up to five other symbols.
- **Visible-range volume profile:** volume by price for whatever is on screen.

### Reading what's on the chart
- **Hover** any count, marker, level, line, cloud, wave label or the heat strip for a one-line tooltip. **Click** (or **tap** on
  a phone) to open a card that says what the element means, its value and bar date, and the study's description, with a
  shortcut to the study's settings. `Esc`, the ×, or clicking empty chart closes it.
- Charts open with the **newest bar at the right edge**. Changing the symbol or timeframe keeps your zoom; by default it jumps
  back to the newest bar (Settings can keep your position instead). When you scroll back in history, a **»** button at the
  bottom right returns to the newest bar.

### Multiple charts, link groups and layouts
- **Grid** (top bar): 1, 2, 3, 4, 6 or 8 charts. New panes copy the active chart's studies at other timeframes.
- **Link groups:** click the small dot in a chart's top-right corner to cycle colours. Charts with the same colour share their
  symbol (and their timeframe, if *Link groups also sync interval* is on). **Crosshair sync** and **date-range sync** are in
  the grid menu.
- **Saved layouts** store the grid, every chart's symbol, timeframe and studies, and the panel arrangement. Save one per
  routine, for example "Morning top-down" or "Crypto intraday".
- `Alt 1…8` focuses a chart. `←`/`→` scroll and `+`/`−` zoom.

---

## Studies: adding and configuring

Press `/` or click **Studies**. Browse by category, search, star favourites, or open **Scripts** (your own) and
**Templates** (saved sets of studies).

Click the gear next to a study's name in the chart legend to open its settings:
- **Inputs** are generated from the study's rules. A **⚠** badge marks rules still awaiting verification. **Presets** apply
  common variants, such as the crypto Ichimoku periods or the 70/30 zones for DeMarker.
- **Style:** colours and widths for each output.
- **Visibility:** show the study only on certain timeframe buckets (minutes, hours, days, weeks, months).
- **Save as default** applies these inputs to every new instance; **Defaults** resets them.

The **DeMark-style stack** template is built in (see `docs/STRATEGY.md`).

Template workflow: set up a chart the way you like, then **Studies → Templates → Save active chart's studies as template**.
Apply it to any chart in one click.

---

## DeMark-style studies — what each one tells you

All of them share two ideas. **True high/low** includes the previous close, so gaps count. And **every buy rule has a mirrored
sell rule.**

### Sequential — setup, TDST, countdown
**Price flip.** Before a buy setup can begin, the closes must "flip": the prior close was above the close five bars before it,
and the current close drops below the close four bars back. (The sell flip mirrors this.)

**Setup (1–9).** From the flip, count consecutive bars that close below the close four bars earlier. Any bar that fails resets
the count. **Setup 9** (`Seq BUY SETUP 9`) means the decline has been persistent. Read it as *the move is mature*, not *the
move is over*.

**Perfection.** A buy 9 is *perfected* when the low of bar 8 or 9 undercuts the lows of bars 6 and 7. An unperfected 9 is
drawn differently and can perfect later. A perfected 9 shows the sellers actually pushed into new lows at the end.

**TDST levels.** A completed buy setup draws **TDST resistance** at the highest true high of its nine bars. A completed sell
setup draws **TDST support** at its lowest true low. Each level is drawn from the completed setup until the next same-direction
setup replaces it, and the active ones are tagged on the price scale. These levels are the "trend test": a close back above TDST resistance after
a buy setup says buyers have retaken the whole setup range. Breaks fire `TDST RES BREAK` / `TDST SUP BREAK`.

**Countdown (1–13).** After a 9, Meridian starts counting bars, not necessarily consecutive, that close at or below the low
two bars earlier. The **13th** count also has to undercut the close of countdown bar 8. If it doesn't, you see a **`+`** and
the 13 is deferred until a later bar qualifies. **`Seq BUY CD 13`** marks a longer-duration exhaustion than a setup 9. A
reaction is expected within about **12 bars** of the 13 (the status chip stays up for that window); if none comes, the trend
is likely to continue. Two elective inputs tighten the count: **8 vs 5** (bar 8 must also reach the close of bar 5, else `+`)
and **Intersection** (the countdown waits until a bar's high gets back to the low of a setup bar three or more bars earlier,
so a runaway setup doesn't start counting straight away).

**Cancellation and recycling.** A countdown in progress is cancelled when an opposite setup completes, or when a whole bar
clears the setup's TDST level (for a buy countdown: the true low is above TDST resistance). Both are switchable, and a
close-only TDST test is available. A countdown **recycles** (restarts, shown as `R`) when a later same-direction setup is
100–200% the size of the one that started it, or when a later setup runs on to 22 bars. These rules exist so a count doesn't
run on after the trend underneath has changed.

**Risk levels.** For each completed setup and countdown, Meridian draws a dashed **risk level** at the extreme bar's true low
minus its true range (mirrored for sells). It is a natural "the idea was wrong" line. `SEQ RISK BREACH` fires if price
closes through it.

Useful inputs: aggressive countdown (uses lows instead of closes, so it counts faster and noisier), setup extension (10+),
show failed setups (keeps the numbers of setups that reset before 9; off by default), TDST mode, and the countdown-13
qualifier.

### Combo
Same setup as Sequential, but the countdown begins on **setup bar 1**, and each counted bar must meet stricter tests: a close
at or below the low two bars back, a lower low and a lower close than the prior bar, and a close below the previous counted
bar's close. **Version 2** relaxes the rules from count 11 on. Cancellation, recycling and the 12-bar window work as in Sequential
(Intersection and 8 vs 5 are Sequential-only). Combo often finishes at a different time than Sequential. When both show 13
near the same place, the two methods agree.

### D-Wave
A mechanical, Elliott-style wave labeller built from N-bar highs and lows (default ladder 21/13/8; wave 1 is a high at or
above the previous 13 highs). It labels waves 0–5 and A–C, shifts waves when price forces it (for example, wave 2 moves right
if wave 4 undercuts it), and locks wave C when price trades below wave A's low. A **`+`** marks where a wave was first
recognised before it shifted right. A close-based preset is available. Use it to see **where in a larger advance or decline** you are. A setup 9 during wave 5
reads very differently from one during wave 3. The optional Fibonacci guides show the "ideal" retracement and extension zones.

### Propulsion ⚠
From a swing low → swing high, momentum *M* is a fraction of the range (default 23.6%). A pullback that gives back at least
*M* without breaking the swing low sets a **trigger** (pullback + M) and a **target** (pullback + 2M). A close through the
trigger suggests the trend is resuming. Lowest-confidence study in the set. Verify it before you trust it.

### Range Projection and REBO
**Range Projection** uses the previous bar's open, true high, true low and close to project the current bar's likely **high
and low**. **Tolerance levels** sit a fraction of the prior true range above and below today's open when it opens inside the
projection; when it opens outside, **buffer levels** take their place, and clearing the buffer in the direction of the open
(`RP BUFFER UP/DOWN`) suggests the bar resolves outside the projection. If price reaches the projected high *before* the
downside tolerance, that's read as "expect a close above the projection" (and mirrored). Because "which came first" depends on
the order of ticks inside the bar, this study is honest about history: past bars use a fixed convention, and only live bars
use real tick order.

**REBO** (range expansion breakout) draws levels at 23.6%, 61.8% and 100% of the prior range from the open (or the prior
close), biased by the prior bar's direction. 23.6% is a low-risk entry area and 61.8% a likely exhaustion area, though price
often runs past it. The range can be true or chart range, averaged over several bars. Use these as intraday reference levels.

### DeMarker I and II
Oscillators (0–100) of how much recent bars pushed to new highs vs. new lows (I) or of buying vs. selling pressure built from
the bar's high and close against the prior close and its own low (II: buying = high − prior close plus close − low; selling =
prior close − low plus high − close). Zones default to 60/40. **Duration matters:** a short visit to an extreme that
ends is a classic reversal cue (`DEM1 OS EXIT`). A long stay (more than 13 bars by default) is flagged as a *trend*, and
reversal signals are suppressed. The **qualified** variants require the exit bar to also beat the prior bars' closes.

### REI and POQ
**REI** (range expansion index, ±100) measures range expansion only when bars overlap. That filters out runaway gaps. **POQ**
is a qualified entry after REI has stayed oversold (or overbought) for six or more bars and then shows a specific
open-and-break pattern. Good for timing *after* exhaustion is already visible elsewhere.

### Pressure ⚠
Volume-weighted buying vs. selling pressure (0–100) with DeMarker-style zones. Use it to check whether volume confirms a count.

### Differential family
Two-bar patterns that compare buying pressure (close − true low) and selling pressure (true high − close) against the closes.
**Differential** shows pressure diverging from two lower (or higher) closes, which hints at exhaustion. **Reverse
Differential** is meant to show continuation. ⚠ As written in Meridian's spec, Reverse Differential Up uses the same
conditions as Differential Down, so it is **off by default** until its exact rule is confirmed. **Anti-Differential** marks a
low that forms without two straight down closes: down, down, up, then down, where the up bar dipped below the bar before it.
`ANTIDIFF UP CONFIRM` fires if the next bar trades above the signal bar's high or closes above its close (mirror for highs).

### Open-based patterns
**TD Open, Trap, Clop, Clopwin, Camouflage.** Each compares today's open with yesterday's range or open/close, then waits for
price to trade through a reference level (TD Open: an open beyond yesterday's range that reverses back to yesterday's
close). They trigger *during* the bar (provisional) and finalize at the close. They are short-term entry-timing tools.

### Points, Lines and Trend Factor
- **TD Points** are swing highs and lows of a chosen level (a high with *n* lower highs on each side). They confirm *n* bars
  later, so a point is provisional until then.
- **TD Lines** connect the two most recent descending point highs (supply) or ascending point lows (demand). A **qualified
  breakout** must pass at least one of three tests; the projection target is printed on the chart.
- **Trend Factor** draws levels every 5.56% from a pivot (11.1% and 22.2% are emphasised). The automatic pivot is the latest
  swing high once price has rallied 5.56% from the prior low (or the swing low after a 5.56% decline). It uses the bar's high
  if that bar closed up, otherwise its close (mirrored for lows). These are quick reference grids for targets and stops.
- Point levels go up to 21 for both Points and Lines.

### Moving Averages I and II ⚠
**MA I** appears only after a strong thrust (a low above the highest high of the prior 12 bars) and stays for a few bars. Its
presence says momentum is unusually strong. A close through the opposite MA I line counts as a breakout only once the next
bar opens beyond that close and then trades beyond its own open (`TDMA1 UP/DN BREAKOUT`). **MA II** plots a short (3) and long
(34) moving average on the price chart: bullish while the short is above the long, with an optional percent offset.

### Meridian composites
Both are under **Studies → Meridian** and each adds a pane. Neither is in the default stack.

**Exhaustion Confluence** answers "how stretched is this move?" with one 0–100 score per side. Green bars above zero are the
**buy** score (a decline is stretched), red bars below zero the **sell** score (a rally is stretched). The dashed lines are the
threshold (60). Crossing it fires `CONFLUENCE_BUY` / `CONFLUENCE_SELL`; a score of 25 or more also shows a status chip.

The score is a weighted average of seven parts, each worth 0 to 1 (weights are editable under Inputs → Weights):

| Part | Weight | Full credit when |
|---|---|---|
| Sequential setup | 1 | the setup reaches 9 (a completed 9 or 13 stays at full credit for 5 bars) |
| Sequential countdown | 2 | the countdown reaches 13 |
| Combo countdown | 1.5 | the Combo countdown reaches 13 |
| DeMarker I | 1 | 5 bars in the zone. Credit drops to 0 once the stay passes the duration limit (13 bars) |
| REI | 1 | REI is in its zone |
| TDST proximity | 1 | the close is on the opposite setup's TDST level, fading to 0 at 1.5 ATR away |
| Higher timeframe | 1.5 | the next timeframe's setup is at 9 or its countdown at 13. Off by default: turn on *Use higher timeframe* |

With the higher timeframe off the weights add up to 7.5, so a fresh Sequential 13 alone scores about 27. Reaching 60 takes
several parts at once. Hover a bar (or use the Rule Inspector) to see which parts contributed. The score is context, not an
entry: wait for the trigger and use the risk level, as in `STRATEGY.md`.

**Count Consensus** answers "does this 13 depend on which rules I use?" It runs four variants side by side: Sequential
standard (blue), Sequential aggressive (purple), Combo strict (orange) and Combo v2 (teal). Each line steps through its
countdown, sell countdowns up toward +13 and buy countdowns down toward −13. The histogram counts how many variants finished a
13 within the last 5 bars. When at least 3 of 4 agree, a boxed `3/4` or `4/4` marker appears and `CONSENSUS_BUY_13` /
`CONSENSUS_SELL_13` fires. A 4/4 signal holds whichever rule set you prefer. One that only one variant produces is fragile.
Widening the window lets Combo (which often finishes earlier) and Sequential (later) agree on the same move.

**Signal heat strip** (Settings): a strip along the bottom of the price pane showing which DeMark-style events fired on each
bar. Click or hover a cell for the detail.

---

## Ichimoku and the standard library

**Ichimoku** (9/26/52, crypto preset 20/60/120/30): Tenkan and Kijun are range midpoints. The cloud is plotted 26 bars into
the **future** using real future session times. Chikou is plotted 26 bars back and is never used for current-bar signals.
Signals classify TK crosses as strong/neutral/weak by cloud position, and flag cloud breaks, Kumo twists, Chikou crosses and a
flat Kijun ("magnet"). Optional time-theory marks are drawn at 9/17/26/33/42/65/76 bars from a pivot.

**Standard library (33):** SMA/EMA/WMA/HMA/DEMA/TEMA, VWAP, Supertrend, Parabolic SAR, ADX/DMI, pivot points, ZigZag, linear
regression channel, Bollinger, Keltner, Donchian, ATR, historical volatility, RSI, Stochastic, Stoch RSI, MACD, CCI,
Williams %R, ROC, MFI, OBV, Chaikin Money Flow, A/D line, Volume, session volume profile, relative strength vs. a benchmark,
and correlation.

How they complement the DeMark-style set: use a **trend filter** (200-period MA, Supertrend, ADX, or the Ichimoku cloud) to
decide *which direction of exhaustion matters*. Use **volatility** (ATR, Bollinger width) to size stops. Use **volume** (OBV,
CMF, the profile) to check whether a move had participation.

---

## Drawing tools

18 tools: trend line, ray, extended line, horizontal line and ray, vertical line, parallel channel, Fibonacci retracement,
extension and time zones, rectangle, ellipse, freehand path, text, price label, long and short position, and measure.

- Pick a tool (left rail, or the pencil on phones), then click/tap the chart. Two-point tools take two clicks.
  **Path** keeps adding points until you press `Enter`.
- **Magnet** (weak/strong) snaps points to the bar's open, high, low or close.
- Click a drawing to select it. Drag its handles, press `Delete` to remove it, `Ctrl/⌘ Z` to undo. Double-click a text or label
  drawing to edit it.
- **Long/short position** shows entry, stop, target and the reward-to-risk ratio. Set the stop on a TD risk level to make the
  plan concrete.
- Drawings belong to the **symbol**, so they appear on every chart and timeframe of that symbol. Manage them in the
  **Object Tree**.
- Price-crossing alerts can be attached to a drawing (Alerts → Drawing).

---

## Inspecting: Rule Inspector, Data Window, Object Tree

- **Rule Inspector.** Hover or tap any bar. For every DeMark-style study on the chart it lists each rule condition, whether it
  passed, and the exact values compared (for example `C=39.61 vs 39.31 · count 1`). Use it to learn the rules, to settle "why
  is there no 9 here?", and to check counts against another platform.
- **Data Window.** Every study output at the crosshair bar.
- **Object Tree.** Studies and drawings on the chart: show or hide, change colour, line style or text, clone, bring forward
  or send backward, and delete. Studies open their settings from here too.

---

## Watchlists and the DeMark Status panel

**Watchlists:** create several lists (Core, crypto, sector ETFs and so on), add symbols with **+**, and reorder them.
Each row shows last price, change, and the current daily DeMark-style chip (for example `S-CD6` = sell countdown at 6). Click a
row to load it.

**DeMark Status** (for the active symbol):
- One row each for **D / W / M**, with the live chips: setup count, countdown count, Combo count, TDST broken or intact. On the
  right it shows the most recent 9/13 and how many bars ago it fired. Tap a row to open that timeframe.
- **Active chart levels:** TDST resistance and support, setup risk levels, and current counts.
- **Signal statistics:** how this symbol behaved in the 20 bars after each past buy/sell 9 and 13: sample size, median
  return, hit rate, and **edge** (the average minus a random-entry baseline). Sell signals are measured as shorts.

The statistics are the reality check. If a symbol's past sell 9s were followed by *further* gains most of the time, a new
sell 9 on that symbol deserves little weight.

---

## Screener and MTF Matrix

**Screener.** Pick a universe (US mega caps, sector ETFs, index ETFs, crypto majors, futures and FX, simulated, or any of your
watchlists), a timeframe, the studies to evaluate, and how recent a signal must be ("within N bars"). Optionally keep only rows
with specific signals. Scans run on the server with the same engine as the chart. Sort by signal recency, symbol or change, and click a row to
chart it.

**MTF Matrix.** Rows are symbols; columns are timeframes (15m to 1M). Each cell summarises the Sequential and Combo state as a
signed score: **+** means buy-side exhaustion (a decline is getting stretched), **−** means sell-side. **Confluence** is the
weighted average across the row. **Weights** lets you weight setups, fresh 9s, countdowns, fresh Sequential 13s
(`cd13`), Combo countdowns and fresh Combo 13s (`combo13`), and give higher timeframes more say. A 9 or 13 counts as fresh for
3 bars.

Reading it: a strong row reading (for example +60 with weekly and monthly both positive) means the stretch shows on several
timeframes. Mixed signs mean the timeframes disagree, which is useful too: it often means a short-term counter-move inside a
larger trend.

---

## Signal Tester

**Event study** (default): choose symbols (the active chart, a universe or a watchlist), a timeframe, a study and its signals,
and horizons (for example `1,5,10,20,60` bars). For each horizon you get the number of events, mean and median return, hit
rate, the worst (MAE) and best (MFE) excursions, the 10th/90th percentiles, a **random-entry baseline** (same symbols, same
horizons, seeded and reproducible), and **edge** (mean minus baseline). The histogram shows the full distribution.

**Strategy mode:** turn signals into trades. Options:
- Enter at the next bar's open or at the signal bar's close.
- Stop at the **TD risk level**, a percentage, an ATR multiple, or none.
- Time stop, take-profit, exit on the opposite signal, and allowing shorts.
- Fees and slippage in basis points per side.

You get an equity curve, drawdown and a trade list.

How to use it well:
- **Look at *n* first.** Fewer than about 30 events is an anecdote. Pool symbols to get more.
- **Compare against the baseline, not zero.** In a rising market every buy signal "works". Edge is what the signal adds.
- **Check the median and MAE, not just the mean.** One huge winner can carry the mean. MAE tells you how much heat you would
  have taken.
- **Don't tune until it looks good.** If you try 20 variations, one will look great by chance. Decide the rule first, test it
  once, then confirm it on different symbols or a different period.
- Everything here is in-sample history with costs you chose. It describes the past. It doesn't promise the future.

---

## Alerts

Create alerts from the **Alerts** panel (or the Alert button). Conditions:
- **Signal**: any signal from any study on the chart, for example *Seq BUY CD 13* or *DEM1 OS EXIT QUALIFIED*.
- **Price**: crosses above or below, is above, is below.
- **Study value**: a study output crosses a value, for example DeMarker I crossing 40.
- **Drawing**: price crosses one of your drawn lines.
- **Script**: a `signal()` from one of your saved Meridian Scripts.

Options:
- **Once** or **every bar**.
- Evaluate on **bar close (final)** or **intrabar**. Intrabar alerts are faster but can fire on a count that later disappears.
- Expiry date.
- Delivery: in-app toast, **Notify my devices** (a browser notification; push to every device you turned on when signed in),
  webhook URL, or e-mail (if the server is configured).

Every firing is recorded in the **Alert Log** with the bar, the message, whether it was provisional, and where it was delivered.

**Where alerts run.** Signed out, alerts are checked **in your browser while Meridian is open** (every 30 seconds) and stop
when you close the tab. Signed in, the **server** checks them and pushes to your devices **with Meridian closed**, as often
as its scheduler runs. The line under the Create button tells you which is happening. The server and your browser share one
record of what fired, so an alert never fires twice for the same bar. Setup for minute-by-minute server checks is in
**Account → Background alerts** and `docs/ACCOUNTS.md`.

A good set to start with: *Seq SETUP 9* (both sides) on the daily chart of your watchlist names, *CD 13* on the weekly chart,
and *TDST break* on anything you hold.

---

## Bar replay — practice without hindsight

**Replay** (top bar or ⋮ menu) → click a bar to start there. Everything after that bar disappears, and studies recompute bar by
bar exactly as they would have live. Step with the buttons or `Shift ←/→`, or play at 1–25×. Replay stops at the live edge.

Use it to rehearse a playbook: stop at a setup 9 and write down (in the Journal) what you would do and where your
invalidation is, then step forward and grade yourself. Ten replays teach more than a hundred static charts, because you can't
see the answer.

---

## Meridian Script — your own studies

**More → Script Editor** (desktop: the Script Editor panel). It's a small JavaScript-like language with series built in
(`open high low close volume hl2 hlc3 time`) and functions: `sma ema rma wma highest lowest stdev change atr tr rsi
crossover crossunder nz series map2`, plus `input()`, `plot()`, `hline()`, `signal()` and `meta()`.

```
meta({ name: 'EMA ribbon', overlay: true })
const fast = ema(close, input('Fast', 8, { min: 2, max: 100 }))
const slow = ema(close, input('Slow', 21, { min: 5, max: 300 }))
plot(fast, { title: 'Fast', color: '#29b6f6' })
plot(slow, { title: 'Slow', color: '#ff9800' })
signal(crossover(fast, slow), { id: 'RIBBON_UP', dir: 'bull', text: '▲' })
```

- **Run** executes it on the active chart in a locked-down worker: no network, no storage, and a 3-second time limit.
- Every run also performs a **look-ahead check**: it replays shorter histories and warns if any value changes when future
  bars are added. A script that "peeks" will be flagged.
- **Save**, then **Add to chart**. The chart re-runs the script whenever you save, and its signals are drawn as markers.
- Saved scripts also work in **Alerts** (condition *Script*), the **Screener** (toggle it under *Scripts*; the scan then runs
  in your browser) and the **Signal Tester** (pick it under *My scripts*). Server-side alerts run scripts in an isolated
  interpreter with no network access.

---

## Portfolio

- **Accounts:** one or more, each with a lot method (FIFO, LIFO, HIFO, or specific lot).
- **Transactions:** buys, sells, dividends, cash in and out, fees and splits, entered by hand or **imported**. CSV presets
  detect Schwab, Fidelity, IBKR (Flex), Robinhood and Meridian exports; anything else can be mapped column by column.
  Duplicates are detected on re-import. **Load sample portfolio** gives you something to explore.
- **Holdings:** quantity, cost, last price, value, unrealized and day P&L, weight, and each position's **DeMark-style status on
  D / W / M**. That last column is the bridge between your holdings and the charts.
- **Performance:** time-weighted return (TWR) and money-weighted return (XIRR), max drawdown, volatility, Sharpe, Sortino,
  beta vs. SPY, 95% one-day historical VaR, the equity curve and a correlation matrix.
- **Income:** dividends and interest by month.
- **Position sizing:** equity × risk-per-trade ÷ (entry − stop), capped at a maximum position size. The stop defaults to the
  nearest TD level below the entry (or −5%). This is how you turn a risk level into a share count.

---

## Journal

Write notes pinned to a bar (the crosshair bar or the last bar) with tags and an optional chart snapshot. Notes appear as
markers on the chart. Each note lists the signals that fired within ±3 bars of it on the current chart, so a review shows
what the indicators said at the time. Filter by symbol or text, and tick **reviewed** when you've graded a note.

---

## AI analyst

**More → AI Analyst** (desktop: AI Analyst panel). Choose **Chart** or **Portfolio** and press **Brief me**, or ask a specific
question. Meridian sends the engine's structured output: active chips, recent signals and how many bars ago they fired, TDST and
risk levels, recent returns, the multi-timeframe matrix and, for portfolios, positions and weights. It never sends a screenshot.

- The briefing is told to use only numbers from that data, to state uncertainty, to flag simulated data, and to end with
  *analysis only*. Still check every number against the chart.
- Without a server API key you get a deterministic, rule-based summary of the same data instead.

---

## Strategic playbooks

These are **frameworks for organising evidence**, not trading rules. Each ends with how to check it in the tester.

### 1. Exhaustion reversal (counter-trend)
*Idea:* a stretched move that also loses momentum is more likely to pause or reverse.
1. **Context first.** Open the MTF Matrix or the DeMark Status panel. A daily buy setup matters more when the weekly is also
   stretched the same way, and less when the monthly trend is strongly the other way.
2. **The count.** A *perfected* buy 9 is the first sign. A buy 13 (Sequential or Combo, ideally both nearby) is stronger.
   Ignore anything still marked `PROV`.
3. **Confirmation.** Look for DeMarker I/II leaving oversold *after a short stay* (a long stay is a trend, and is suppressed),
   REI oversold followed by a POQ, or a Differential pattern on the low.
4. **Invalidation.** The setup or countdown **risk level** is the line where the idea is wrong. Size with Portfolio → Position
   sizing using that stop.
5. **What would cancel it:** a bar that clears TDST in the trend's direction, or a fresh same-direction setup that recycles
   the countdown.
*Test it:* Signal Tester → Sequential → *Seq BUY CD 13* across a universe. Compare the edge and MAE against *Seq BUY SETUP 9*
alone.

### 2. Trend continuation (with the trend)
*Idea:* when exhaustion signals **fail**, the trend is strong.
1. In an uptrend, a **sell setup that can't hold** (price closes above the sell setup's TDST, or a sell countdown gets
   cancelled) is a continuation cue.
2. A **TDST break** in the trend's direction (`TDST RES BREAK` after a buy setup) says buyers retook the whole setup range.
3. Look for a **Propulsion trigger** ⚠ or a qualified **TD Line** breakout to time re-entry after a pullback.
4. Trend filters keep you honest: price above a rising 200-period MA or the Ichimoku cloud, and ADX rising.
*Test it:* event study on `TDST RES BREAK` with horizons 5–60, and compare it with the baseline on the same universe.

### 3. Intraday timing with projections
1. Before the session, note **Range Projection**'s projected high and low and the **REBO** levels.
2. Watch which tolerance level gets touched first. That ordering is the study's read on the day.
3. Use the open patterns (**Trap**, **Clop**, **Open**) as triggers near those levels.
4. These are provisional until the close by design. Judge them at the close, not mid-bar.

### 4. Top-down routine (a five-minute daily scan)
1. **MTF Matrix** on your watchlist → sort by confluence → note the 3–5 most stretched names.
2. **Screener** on the daily chart, filtered to *SETUP 9 / CD 13 within 3 bars*.
3. For each candidate, open a **2-chart layout** (weekly + daily, linked) and check the DeMark Status statistics for that symbol.
4. Create **alerts** for the next decisive event, such as the 13 completing or a TDST break, instead of watching.
5. Write one **journal** line per idea with its invalidation level.

### 5. Portfolio risk review (weekly)
1. Portfolio → Holdings → **DeMark status** column. Flag positions showing **sell-side** exhaustion on W or M against a long
   position.
2. Performance → **correlation** and **VaR**. Find concentration you didn't intend.
3. Use the **AI analyst** in Portfolio mode for a plain-English summary, then verify its claims.
4. For trims and adds, use **Position sizing** with TD risk levels as stops, so each position risks a similar amount.

### 6. The research loop
**Hypothesis → Tester → Replay → Alerts → Journal → review.** Write the rule down, test it once across many symbols, practise
it in replay, automate the watching with alerts, journal every live instance, and review monthly.

### Mistakes to avoid
- Treating a **9 as a reversal call**. It's a maturity marker; many trends run through several 9s.
- Acting on **provisional** counts mid-bar.
- Ignoring **perfection**, **TDST** and **cancellation**. They are half of what makes the count meaningful.
- Fighting a **long-duration** oscillator reading (DeMarker in the zone for weeks). That's a trend, and Meridian suppresses the
  signal for a reason.
- **Overfitting** the tester, or trusting a 12-event sample.
- Forgetting a chart is **simulated**.

---

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Start typing | Symbol search |
| `/` | Studies dialog |
| `Ctrl/⌘ K` | Command palette (every action, searchable) |
| `Alt T / H / V / F / R / M` | Trend line / horizontal / vertical / Fibonacci / rectangle / measure |
| `Esc` | Cancel the tool or deselect |
| `Delete` / `Backspace` | Delete the selected drawing |
| `Enter` | Finish a path drawing |
| `Ctrl/⌘ Z` · `Ctrl/⌘ Y` | Undo · redo drawings |
| `←` / `→` · `+` / `−` | Scroll · zoom |
| `Shift ←` / `Shift →` | Replay: step back / forward |
| `Alt S` | Snapshot the active chart |
| `Alt 1…8` | Focus chart pane N |
| `?` | Shortcut help |

---

## Account, sync and background alerts

Open the **person icon** in the top bar (phone: **More → Account**).

- **Create account with a passkey.** Pick a username and confirm with Face ID, Touch ID or Windows Hello. There's no
  password. On Apple devices the passkey syncs through iCloud Keychain, so your Mac signs in with the passkey made on your
  iPhone. **Save the recovery code** shown once. It signs you in if you lose every device.
- **Sync** starts at once. This device's data is merged into the account, edits upload a moment later, and other devices'
  edits arrive when you switch back to the app (and every 30 seconds). The dot on the person icon is green when synced.
- **Notifications on your devices → Turn on for this device**, then **Send a test**. On iPhone/iPad, add Meridian to the
  Home Screen first (Share → Add to Home Screen) and turn notifications on from the installed app.
- **Background alerts** shows when the server last checked your alerts. "Running" means alerts arrive with every tab
  closed. If it isn't running every minute, the panel shows the one-time setup.
- **Passkeys:** rename, remove, or add one for a device outside iCloud. **Sign out** keeps this device's data.
  **Delete account** removes the cloud copy.

---

## Settings

- **Theme:** dark, light, or follow the system. **Signal palette:** standard, or colourblind-safe (Okabe–Ito). Every signal
  also carries a text label.
- **Time zone:** the exchange's, UTC, or your local time.
- **Legend values**, **signal heat strip**, and **hollow provisional counts** (keep this on).
- **Explain chart elements on hover / tap**, and whether a symbol or timeframe change **jumps to the newest bar** or **keeps
  your position** relative to it.
- **Live updates:** streaming for crypto, polling for other markets while they're open.
- **Default adjustment** for new charts, the **magnet** strength, and **confirm destructive actions**.

---

## Data, privacy and limits

- Market data comes from public endpoints through Meridian's server. Every response says which provider served it, and the
  status bar shows any fallbacks.
- Real symbols never fall back to simulated data. If every provider fails, the chart says so and offers the demo series.
- Signed out, your settings, layouts, drawings, watchlists, alerts, scripts, journal and portfolio are stored **only in this
  browser**, and clearing site data deletes them. Signed in, they are also kept in your account and restored when you sign
  in again. Journal screenshots stay on the device that took them.
- Signed out, alerts only run while the app is open.
- Study rules marked ⚠ are unverified. The full list, with the test that pins each default, is in `docs/VERIFY_LOG.md`.

---

## Glossary

- **Bar close / final:** the moment a bar's period ends. Only then are counts permanent.
- **Provisional (PROV):** a value computed on the forming bar. It can still change.
- **True high / low / range:** high/low extended to the prior close if there was a gap; the range between them.
- **Price flip:** the close pattern that starts a setup.
- **Setup 9 / Countdown 13:** consecutive and non-consecutive exhaustion counts.
- **Perfection:** the late-setup bars undercut (or exceed) the earlier ones, which completes the setup's shape.
- **TDST:** the level from a completed setup's extreme. A close beyond it challenges the setup.
- **Risk level:** a setup or countdown's "idea is wrong" line.
- **Recycling:** restarting a countdown from a newer, comparable setup.
- **Confluence:** agreement of exhaustion readings across studies or timeframes.
- **Edge:** a signal's average outcome minus a random-entry baseline.
- **MAE / MFE:** the worst and best move during a trade or horizon.

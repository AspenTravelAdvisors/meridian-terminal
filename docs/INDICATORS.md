# INDICATORS.md — Engine Rule Specifications

**Conventions.** Bars are indexed `i`; `C[i-4]` is the close four bars earlier. Each rule below is written in our own words.
Confidence tags: **[HIGH]** widely documented and consistent · **[MED]** documented, minor variant differences · **⚠ VERIFY** sources
disagree or details are uncertain. Every ⚠ VERIFY parameter must be a config input, defaulting as written here, and logged in `VERIFY_LOG.md`.

- **True High** `TH[i] = max(H[i], C[i-1])` · **True Low** `TL[i] = min(L[i], C[i-1])` · **True Range** `TR = TH − TL`
- All "buy" rules have mirrored "sell" rules (swap highs/lows, inequalities, and up/down). Only buy is written out unless the mirror is non-obvious.

---

## §0. Golden-reference verification (do this first)
1. Create `fixtures/<study>/<symbol>_<interval>.csv` with columns `t,o,h,l,c,v` plus expected outputs (e.g. `setup,countdown,tdst_res,tdst_sup`).
2. Brian will export reference values from a platform with licensed DeMark studies (Bloomberg DeMark, or another vendor's verified implementation) and/or hand-check counts against his copy of Jason Perl's *DeMark Indicators*.
3. `pnpm test:golden` must match bar-for-bar. Any mismatch → write a `VERIFY_LOG.md` entry (bar, expected, actual, suspected rule) and ask before changing defaults.
4. Ship a **"Rule Inspector"** dev panel: hover a bar to see which conditions passed or failed for every active DeMark study. This is how disagreements get resolved quickly.

---

## §1. TD Sequential

### 1.1 Price Flip [HIGH]
- **Bearish flip** (arms a Buy Setup) at bar `i`: `C[i-1] > C[i-5]` and `C[i] < C[i-4]`.
- **Bullish flip** (arms a Sell Setup) at bar `i`: `C[i-1] < C[i-5]` and `C[i] > C[i-4]`.

### 1.2 Setup [HIGH]
- **Buy Setup:** starting at the bearish-flip bar (bar 1), nine *consecutive* bars each with `C[i] < C[i-4]`. Any bar failing the condition resets the count to 0.
- Display counts 1–9; optional **setup extension** shows 10+ while the condition persists (config `showSetupExtension`, default on, small font).
- Signal `SEQ_BUY_SETUP_9` on bar 9 close.

### 1.3 Perfection [HIGH]
- A Buy Setup is **perfected** if `L[8] ≤ min(L[6], L[7])` or `L[9] ≤ min(L[6], L[7])` (setup-bar numbering).
- If not perfected at 9, it stays "unperfected" until a later bar's low satisfies the condition (deferred perfection), unless a new setup or flip intervenes. Render unperfected 9s with a distinct style. Signal `SEQ_BUY_SETUP_PERFECTED`.

### 1.4 TDST levels ⚠ VERIFY
- After a completed **Buy Setup**: **TDST Resistance** = the highest True High of setup bars 1–9.
- After a completed **Sell Setup**: **TDST Support** = the lowest True Low of setup bars 1–9.
- Config `tdstMode: 'allSetupBars' | 'bar1TrueExtreme'` (default `allSetupBars`). Some sources define it from setup bar 1's true extreme only.
- A level persists until replaced by the next same-direction setup. Draw it as a horizontal level extending right.
- Signals: `TDST_RES_BREAK` (close above), `TDST_SUP_BREAK` (close below). Optional qualifier: the break bar's open or prior close is also beyond the level.

### 1.5 Countdown [HIGH core, ⚠ VERIFY bar-13 qualifier]
- Starts on **Buy Setup bar 9** (bar 9 itself can be Countdown 1). The count is *non-consecutive*.
- A bar counts if `C[i] ≤ L[i-2]`.
- **Bar-13 qualifier:** the 13th qualifying bar also needs `L[13] ≤ C[CD8]` (the close of Countdown bar 8). If it fails, show `+` and keep checking later qualifying bars until both conditions hold.
  - ⚠ Some secondary sources state this as a *close* test against bar 8 instead. Config `cd13Qualifier: 'low_vs_cd8_close' | 'close_vs_cd8_close' | 'none'`, default `low_vs_cd8_close`.
- **Aggressive Countdown** option: count bars where `L[i] ≤ L[i-2]` (config `countdownMode: 'standard' | 'aggressive'`).
- Signal `SEQ_BUY_CD_13`.

### 1.6 Cancellation ⚠ VERIFY
A Buy Countdown in progress is cancelled when any enabled condition fires:
- (a) a **Sell Setup** completes (default on);
- (b) price closes above **TDST Resistance** of the setup that started the countdown (default on; config `cancelOnTdstBreak`, choose close vs. true-low test);
- (c) optional "intersection-failure" rule (default off).

### 1.7 Recycling ⚠ VERIFY
If a new same-direction setup completes while a countdown is active, compare setup sizes (`size = max TH − min TL` over setup bars):
- If `newSize ≥ oldSize` and `newSize ≤ recycleFactor × oldSize` → **recycle**: restart the countdown from the new setup (default `recycleFactor = 1.618`).
- Otherwise keep the original countdown. Config `recycleMode: 'size' | 'never' | 'always'`. Optional "setup reaches 18 bars → recycle" toggle.

### 1.8 Risk levels [MED]
- **Setup buy risk:** find the bar with the lowest True Low among setup bars, then `risk = TL − TR` of that bar.
- **Countdown buy risk:** same calculation over *all* bars from countdown bar 1 through 13, numbered or not.
- Sell: highest True High `+ TR` of that bar. Draw as dashed levels; signal `SEQ_RISK_BREACH` (break qualifiers configurable: close beyond level, prior close not beyond, next open beyond).

---

## §2. TD Combo [MED, ⚠ VERIFY version 2]
- Uses **the same Setup** as Sequential (§1.1–1.4).
- Countdown begins on **Setup bar 1**, not bar 9.
- A **Buy Combo Countdown** bar must satisfy all of:
  1. `C[i] ≤ L[i-2]`
  2. `L[i] < L[i-1]`
  3. `C[i] < C[i-1]`
  4. `C[i] <` close of the previous Combo countdown bar (first countdown bar: skip this test)
- **Version 2 (less strict)**, config `comboVersion: 'strict' | 'v2'`: from countdown 11 onward, a bar only needs a close below the previous countdown bar's close.
- Cancellation and recycling: reuse the §1.6/§1.7 machinery with independent config.
- Signals `COMBO_BUY_13`, `COMBO_SELL_13`. Render Combo numbers in a different color/position than Sequential so both can show at once.

---

## §3. TD D-Wave [MED, ⚠ VERIFY lookbacks]
A mechanical Elliott-style labeler built on **N-bar high/low closes**. An "N-bar high close" is a close greater than the previous `N−1` closes.

**Up-sequence (defaults, all configurable):**
| Event | Trigger |
|---|---|
| Origin (wave 0) | 21-bar low close |
| Wave 1 begins | 13-bar high close after the origin |
| Wave 2 begins (wave 1 peak locked at highest close since 1 began) | 8-bar low close |
| Wave 3 begins | 21-bar high close |
| Wave 4 begins | 13-bar low close |
| Wave 5 begins | 21-bar high close |
| Wave A begins | 13-bar low close |
| Wave B begins | 8-bar high close |
| Wave C begins | 21-bar low close |
| Wave C locked | close below Wave A's low close |

**Qualifiers and shift rules**
- Wave 3's peak close must exceed Wave 1's peak close, and Wave 5's must exceed Wave 3's. If not, the wave is not confirmed.
- If a Wave 2 pullback is too shallow to trigger and price makes a new high close, **Wave 1 shifts right** to the new high.
- If Wave 4's low close undercuts Wave 2's low close, **Wave 2 shifts right** to where Wave 4 was (and the count re-evaluates).
- Once Wave C breaks Wave A's low close, Wave 5 is locked permanently.
- Down-sequence mirrors everything.
- ⚠ An alternate preset from some vendors uses highs/lows instead of closes with an 8/5/13/8/21/13/8/21 lookback ladder. Ship it as preset `"Alt (H/L)"`; default preset `"Close-based 21/13/8"`.
- Optional **Fibonacci guides**: ideal Wave 2 retrace 61.8% of Wave 1; Wave 3 and 5 projections (1.618×, 2.618×) drawn as faint levels.
- Outputs: wave labels at locked pivots (provisional labels hollow), connecting polyline, signals `DWAVE_3_START`, `DWAVE_5_START`, `DWAVE_5_COMPLETE`, `DWAVE_C_LOCKED`.

---

## §4. TD Propulsion [⚠ VERIFY — lowest confidence, transcribe from Brian's source before finalizing]
Purpose: after a swing forms, project a **momentum trigger** and an **exhaustion target** from a pullback.

**Up (bullish) construction, provisional:**
1. Identify a swing low `A` and the subsequent swing high `B` using TD Points (§6.1, level configurable, default 2).
2. Momentum `M = (B − A) × propRatio` (default `propRatio = 0.236`; Bloomberg-style preset `0.25`).
3. A valid pullback low `P` must retrace at least `M` from `B` (`P ≤ B − M`) and must stay above `A`.
4. **Propulsion Up (trigger)** = `P + M`. **Propulsion Up Target (exhaustion)** = `P + 2M` (configurable multiplier).
5. Option `refPrice: 'swingHigh' | 'closeOfHighBar'` for computing `M` (some practitioners use the high bar's close).

Down mirrors: swing high → swing low → bounce high `P'`; trigger `P' − M`, target `P' − 2M`.

Signals `PROP_UP_TRIGGER` (close above trigger), `PROP_UP_TARGET_HIT`, and the down equivalents. Keep the whole module behind
a `propulsionRules` config object so Brian can swap in book-verified definitions without code changes.

---

## §5. TD Range Projection + Tolerance Levels [HIGH formula, MED tolerance]
For the **previous** bar (H, L, O, C):
- If `C < O`: `X = H + 2L + C`
- If `C > O`: `X = 2H + L + C`
- If `C = O`: `X = H + L + 2C`
- **Projected High** `= X/2 − L` · **Projected Low** `= X/2 − H`
- ⚠ Variant toggle: compare `C` vs. *prior close* instead of `O` (`rpBasis: 'open' | 'priorClose'`).
- Render as a box or two short lines spanning the current bar (and the next bar on the right edge).

**Tolerance levels** (for the current bar): `UpTol = O_today + k × TR_prev`, `DnTol = O_today − k × TR_prev` with `k = 0.15` default.
Classification for the current bar (signal `RP_*`): if price touches the Projected High before `DnTol`, expect a close above the
projected high; mirror for the low. Implement as a provisional intrabar state finalized on close.

Also add **TD REBO** (Range Expansion Breakout) as a sibling study: levels = `O + 0.382/0.618/1.0 × TR_prev` and the mirrors, with direction bias from whether the prior close was up or down. All ratios configurable.

---

## §6. Supporting DeMark-style studies

### 6.1 TD Points [HIGH]
Level-`n` TD Point High: `H[i]` greater than the highs of the `n` bars on each side. TD Point Low mirrors. They confirm only `n` bars later, so they are marked provisional until then.

### 6.2 TD Lines [MED, ⚠ VERIFY qualifiers]
- **Supply line:** connect the most recent TD Point High to the most recent prior TD Point High that is *higher* (a descending line). **Demand line:** most recent TD Point Low to a prior *lower* one (ascending). Level selectable (1–5).
- **Upside breakout qualifiers** (each toggleable): (Q1) the close before the break bar is below the close two bars before it; (Q2) the break bar opens above the line and trades a tick above it; (Q3) the prior bar's `C − TL` (buying pressure) projected forward exceeds the line value. A breakout passing ≥ 1 enabled qualifier is "qualified".
- **Projection target:** the distance from the line to the lowest low between the two anchor points, added to the line value at breakout.

### 6.3 TD DeMarker I [MED] *(required)*
```
DeMax[i] = H[i] − H[i-1] if H[i] > H[i-1] else 0
DeMin[i] = L[i-1] − L[i] if L[i] < L[i-1] else 0
DeM1 = Σ_n DeMax / (Σ_n DeMax + Σ_n DeMin)      default n = 13, output 0–100
```
- Zones: overbought ≥ 60, oversold ≤ 40 (configurable; 70/30 preset).
- **Duration analysis:** count consecutive bars in a zone. If > 13 bars (configurable), flag "extreme / trend" and suppress reversal signals.
- Signals: `DEM1_OB_EXIT` and `DEM1_OS_EXIT`, plus optional DeMark-style qualified entry: exit from oversold where the close is above the prior one or two bars' close/high.

### 6.4 TD DeMarker II ⚠ VERIFY *(required)*
```
BP[i] = max(0, H[i] − C[i-1]) + (C[i] − TL[i])
SP[i] = max(0, C[i-1] − L[i]) + (TH[i] − C[i])
DeM2 = Σ_n BP / (Σ_n BP + Σ_n SP) × 100         default n = 8
```
Same zone and duration logic as DeMarker I. Exact component definitions must be confirmed against Brian's source; keep each component behind a config switch.

### 6.5 TD REI + TD POQ [MED]
- For each bar: `X = (H − H[i-2]) + (L − L[i-2])`, counted only when the **price-overlap condition** holds (`H ≥ L[i-5] or H ≥ L[i-6]`, and `L ≤ H[i-7] or L ≤ H[i-8]`); otherwise 0. ⚠ Exact lags must be verified.
- `REI = Σ_5 X / Σ_5 (|H − H[i-2]| + |L − L[i-2]|) × 100`, range ±100, zones ±40 (configurable).
- **TD POQ** buy qualifier after REI has been oversold for ≥ 6 bars: the close is above the prior close, the next open is at or below the prior two highs, then price trades above the higher of the prior two highs. Mirror for sells.

### 6.6 TD Pressure ⚠ VERIFY
Volume-weighted buying vs. selling pressure ratio over `n = 5`: per bar `(C − O) / (TH − TL) × V`, normalized 0–100. Duration zones as in DeMarker.

### 6.7 TD Differential family [MED]
- `BP = C − TL`, `SP = TH − C`.
- **Differential Up:** two consecutive lower closes, current BP > prior BP, and current SP < prior SP. Down mirrors.
- **Reverse Differential Up** (continuation): two consecutive higher closes, current BP < prior BP, and current SP > prior SP. Mirror for down.
- **Anti-Differential:** a five-bar close pattern (down, up, down, down/up) per the reference. ⚠ VERIFY the exact sequence and keep it disabled by default until verified.

### 6.8 Open-based patterns [MED]
- **TD Open buy:** the open is below the prior low, then price trades above the prior low.
- **TD Trap buy:** the open is inside the prior bar's range, then price breaks above the prior high.
- **TD Clop buy:** the open is below both the prior open and prior close, then price rallies above both.
- **TD Clopwin buy:** the open and close are both within the prior bar's open–close range, and the close is above the prior close.
- **TD Camouflage buy:** the close is below the prior close but above the open, and the low is below the true low two bars earlier.
- Sell versions mirror. All are intrabar-triggered (provisional) and finalize on close.

### 6.9 TD Moving Averages ⚠ VERIFY
- **TD MA I:** a 5-bar SMA of lows that is plotted only after a low exceeds the highest high of the prior 12 bars and stays active for 4 bars, extending while the condition re-triggers. Mirror with highs.
- **TD MA II:** a 3-bar ROC vs. a 34-bar ROC regime filter. Periods are configurable.

### 6.10 TD Trend Factor [MED]
From a pivot price `P`, plot levels at `P × (1 ± k × 0.0556)` for `k = 1..4` (5.56% steps; 11.1% and 22.2% are emphasized). The pivot is selected by the user or auto-selected from the most recent TD Point level 3.

---

## §7. Ichimoku Kinko Hyo [HIGH]
Defaults `tenkan=9, kijun=26, senkouB=52, displacement=26`; presets for crypto (20/60/120/30) and custom values.
```
Tenkan  = (HH_9 + LL_9) / 2
Kijun   = (HH_26 + LL_26) / 2
SenkouA = (Tenkan + Kijun) / 2         plotted displacement bars FORWARD
SenkouB = (HH_52 + LL_52) / 2          plotted displacement bars FORWARD
Chikou  = C                            plotted displacement bars BACK
```
- Render the cloud as a filled area between A and B, with color by `A > B`. Extend into **future whitespace bars** (append future timestamps from the session calendar).
- Chikou is plotted back in time and is never used for signals on the current bar, which avoids look-ahead.
- Signals: TK cross classified **strong / neutral / weak** by position relative to the cloud, price-cloud breakout, Kumo twist (future), Chikou cross of price, and flat-Kijun "magnet" detection.
- Optional **Ichimoku time theory** markers (9, 17, 26, 33, 42, 65, 76 bars from a selected pivot).

---

## §8. Composite & meta studies (Meridian originals)
- **Exhaustion Confluence:** a weighted score combining Sequential/Combo state, DeMarker zone duration, REI, TDST proximity, and HTF alignment. Weights and output come with a breakdown tooltip.
- **Signal Heat Strip:** a one-pixel-tall strip under price showing which DeMark events fired on each bar (hover for detail).
- **Count Consensus:** shows where Sequential standard, aggressive, and Combo strict/v2 agree or disagree, to visualize rule sensitivity.

Every study in this file must appear in the Studies dialog with Inputs generated from its Zod schema and documented ⚠ VERIFY knobs.

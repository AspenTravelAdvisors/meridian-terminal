# VERIFY_LOG.md
Track every ⚠ VERIFY rule: what was implemented, the pinned test, and how it was resolved.

Every row below is a config input in the study's schema (shown in the Studies dialog with a ⚠ marker) and defaults exactly as
`docs/INDICATORS.md` describes it. The defaults are pinned by `packages/engine/test/verify.test.ts`; behaviour is pinned by the
tests listed per row. "open" = implemented as written, still to be checked against Brian's reference charts/data.
**fixed** = changed on 2026-10-27 to match Symbolik (notes 4–5); the previous behaviour is kept as a config option where one
existed.

| Date | Study | Rule / parameter | Default implemented | Pinned test | Reference checked | Status |
|---|---|---|---|---|---|---|
| 2026-10-27 | DeMark-style Sequential | TDST mode (`tdstMode`) | `allSetupBars` (highest true high / lowest true low of setup bars 1–9); `bar1TrueExtreme` option | `sequential.test.ts` › sets TDST resistance…(14.5); `demark.test.ts` › bar1TrueExtreme TDST uses only setup bar 1 | Symbolik help ¹ ² | **confirmed** — TDST is the highest true high / lowest true low of the whole completed setup |
| 2026-10-27 | DeMark-style Sequential | TDST break qualifier (`tdstBreakQualifier`) | off | `verify.test.ts` | Symbolik descriptions ² | open — reference marks TDST qualified/disqualified when breakout qualifiers are on; exact qualifier not given |
| 2026-10-27 | DeMark-style Sequential | CD13 qualifier (`cd13Qualifier`) | `low_vs_cd8_close` (bar 13 low ≤ close of CD bar 8, else deferred "+") | `sequential.test.ts` › defers bar 13 with "+"… | Symbolik help ¹ ² | **confirmed** — buy 13 low ≤ CD8 close (sell: high ≥), "+" on deferral |
| 2026-10-27 | DeMark-style Sequential / Combo | Cancellation (`cancelOnOppositeSetup`, `cancelOnTdstBreak`, `tdstCancelTest`) | on / on / **`trueExtreme`** (buy: true low above TDST resistance) | `symbolik.test.ts` › TDST cancellation uses the whole bar; Sequential oracle | Symbolik help ¹ ² | **fixed** — was `close`; `close` stays an option |
| 2026-10-27 | DeMark-style Sequential | Intersection (`requireIntersection`, `intersectionScope`) | off / `anyLaterBar` — when on, *postpones* the countdown start until a bar's high reaches the low of a setup bar ≥ 3 bars earlier | `symbolik.test.ts` › elective intersection postpones the countdown start | Symbolik help ¹ ² | **fixed** — replaces `cancelOnIntersectionFailure` (which blocked the countdown and tested bars 8–9 vs 1–3 only). Removed from Combo (Sequential-only per reference). Extension bars count as setup bars while waiting (reference chart, note 6). ⚠ open: whether non-setup bars may confirm (`intersectionScope`) |
| 2026-10-27 | DeMark-style Sequential / Combo | Recycling (`recycleFactor`, `recycleMode`, `recycleOnLongSetup`, `recycleSetupCount`) | **2.0** (100–200%), `size`, **on**, **22** | `symbolik.test.ts` › Recycling…; Sequential oracle | Symbolik help ¹ ² | **fixed** — was 1.618 and an off-by-default 18-bar toggle; the long-setup rule only applies to a *later* setup |
| 2026-10-27 | DeMark-style Sequential / Combo | Perfection test | buy: bar 8 or 9 low **<** min(bar 6, bar 7 low) | `symbolik.test.ts` › a tie with bars 6–7 does not perfect the 9 | Symbolik descriptions ² | **fixed** — was ≤ |
| 2026-10-27 | DeMark-style Sequential | 8-vs-5 deferral (`cd8Qualifier`) | off (elective): would-be 8 needs low ≤ CD5 close, else "+" | `symbolik.test.ts` › elective 8-vs-5 deferral | Symbolik help ¹ ² | **added** |
| 2026-10-27 | DeMark-style Sequential / Combo | 12-bar rule (`reactionBars`) | 12 — the 13 status chip stays up for 12 bars | `symbolik.test.ts` › 12-bar reaction window | Symbolik help ¹ ² | **added** |
| 2026-10-27 | DeMark-style Combo | Version 2 threshold (`v2From`) | bar 11+ (only a lower close than the previous countdown bar) | `demark.test.ts` › v2 relaxes the rules from countdown 11 | Symbolik descriptions ² | **confirmed** — v1 keeps the same rules throughout (our `strict`); v2 relaxes bars 11–13; the default v2 variant compares closes |
| 2026-10-27 | DeMark-style D-Wave | Basis / N-bar test (`basis`, `nBarTest`) | **`highLow`** / **`atLeastPriorN`** (wave 1 = a high at or above the previous 13 highs) | `demark.test.ts` › an N-bar high is a high at or above…; `verify.test.ts` | Symbolik descriptions ² | **fixed** — was closes, strictly above N − 1. "Close-based 21/13/8" kept as a preset |
| 2026-10-27 | DeMark-style D-Wave | Lookback ladder (`lbOrigin…lbC`) | 21/13/8/21/13/21/13/8/21 | `verify.test.ts` › D-Wave ladder | Symbolik descriptions ² | wave 1 = 13 **confirmed**; the rest open (reference only says the later waves use Fibonacci lookbacks) |
| 2026-10-27 | DeMark-style D-Wave | "+" first-recognition mark | drawn where a wave was first recognised when its end later shifts right | `demark.test.ts` › shifts wave 2 right… | Symbolik descriptions ² | **added** |
| 2026-10-27 | DeMark-style Propulsion | Ratio / construction (`propulsionRules`) | 0.236 ratio, trigger P + M, target P + 2M, level-2 points, swing-high reference, pullback above A | `verify.test.ts`; `demark.test.ts` › projects trigger P + M and target P + 2M | Symbolik descriptions ² | open — reference names a Momentum level and an Exhaustion level (matches our trigger/target), but gives no formula |
| 2026-10-27 | DeMark-style Lines | Breakout qualifiers Q1–Q3 (`useQ1..3`) | all on | `demark.test.ts` › draws a supply line…flags a break | Symbolik descriptions ² | open — reference adds a third **Cancelled** line state; qualifier and cancel rules not given |
| 2026-10-27 | DeMark-style DeMarker II | Components (`rangeBasis`, `clampPriorClose`) | **`plain`** (C − L, H − C) / clamp on | `demark.test.ts` › uses the plain low and high…; `verify.test.ts` | Symbolik descriptions ² | **fixed** — was true low / true high (four on/off switches replaced). ⚠ open: the reference does not mention the clamp; kept because it holds the 0–100 range through gaps |
| 2026-10-27 | DeMark-style REI | Overlap lags (`lagA1/A2/B1/B2`) | 5/6 and 7/8 | `verify.test.ts` › REI lags; `demark.test.ts` › is bounded to ±100 | Symbolik descriptions ² | open — no lags given; 6-bar duration rule consistent with our POQ |
| 2026-10-27 | DeMark-style Pressure | Length / volume weighting | 5 bars, volume-weighted | `verify.test.ts` › TD Pressure | Symbolik descriptions ² | open — reference describes cumulative, ROC and ratio forms using price and/or volume; no formula |
| 2026-10-27 | DeMark-style Differential | Reverse Differential (`reverse`) | **off** | `verify.test.ts` | Symbolik help ¹ ² | **issue** — see note 1; turned off by default because it duplicates Differential Down. The reference gives no conditions that separate them |
| 2026-10-27 | DeMark-style Differential | Anti-Differential (`anti`, `antiPattern`, `antiUpBarLow`) | **on**, **`D,D,U,D`**, on; follow-through signal on the next bar | `symbolik.test.ts` › Anti-Differential… | Symbolik descriptions ² | **fixed** — was off with `D,U,D,U`. Sell mirrored (the reference's sell wording has a typo) |
| 2026-10-27 | DeMark-style MA I | Lengths (`maLength`, `lookback`, `activeBars`) + breakout | 5 / 12 / 4; breakout confirmed by next open beyond the close, then a move beyond that open | `symbolik.test.ts` › TD MA I…; `verify.test.ts` › TD MA | Symbolik descriptions ² | breakout rule **added**; construction still open |
| 2026-10-27 | DeMark-style MA II | Construction (`fast`, `slow`, `offsetPct`) | short 3 / long 34 SMA of the close on the price chart, offset 0 | `symbolik.test.ts` › TD MA II…; `verify.test.ts` | Symbolik descriptions ² | **fixed** — was a 3- vs 34-bar ROC filter in its own pane. Lengths open (not given) |
| 2026-10-27 | DeMark-style Range Projection | Comparison basis (`rpBasis`) | `open` (C vs O); `priorClose` option | `demark.test.ts` › C = O…priorClose basis | Symbolik descriptions ² | **confirmed** |
| 2026-10-27 | DeMark-style Range Projection | Prices / buffer (`rpPrices`, `bufferK`) | **`true`** high/low; buffer 0.15 × prior TR when the open is outside the projection | `symbolik.test.ts` › Range Projection… | Symbolik descriptions ² | **fixed** — was plain H/L, no buffer. ⚠ open: buffer size not given (defaults to the tolerance's 0.15) |
| 2026-10-27 | DeMark-style Open Patterns | TD Open reference level (`openRef`) | **`priorClose`**: open below prior low, then trades up to the prior close | `symbolik.test.ts` › TD Open… | Symbolik descriptions ² | **fixed** — was prior low (kept as an option) |
| 2026-10-27 | DeMark-style Open Patterns | Camouflage | close < prior close, close > open, low < true low 2 bars back | — | Symbolik descriptions ² | open — **ambiguous**: the reference's Camouflage example matches the first two tests, and its *Reverse* Camouflage lists the same three comparisons without directions. Unchanged |
| 2026-10-27 | DeMark-style REBO | Ratios / base / range (`r1`, `r2`, `r3`, `base`, `rangeType`, `avgBars`) | **0.236** / 0.618 / 1.0 × prior true range from the open, 1 bar | `symbolik.test.ts` › REBO… | Symbolik descriptions ² | **fixed** — r1 was 0.382; base, range type and averaging added |
| 2026-10-27 | DeMark-style Trend Factor | Auto pivot (`pivotMode`) | **`auto`**: 5.56% swing tracking; high if the peak bar closed up, else its close (mirror for lows) | `symbolik.test.ts` › Trend Factor… | Symbolik descriptions ² | **fixed** — was the latest level-3 TD Point (kept as `point`). Level spacing unchanged (linear 5.56% steps; the reference does not list its ratios) |
| 2026-10-27 | DeMark-style Points / Lines | Max level (`level`) | 1–21 | `symbolik.test.ts` › Points and Lines accept levels up to 21 | Symbolik descriptions ² | **fixed** — was 10 / 5 |

## Notes

1. **Reverse Differential Up ≡ Differential Down as written.** INDICATORS §6.7 gives Reverse Differential Up the same two-bar
   conditions as Differential Down (two lower closes with buying pressure rising and selling pressure falling), so as written the
   two patterns always fire together with opposite labels. Still implemented verbatim behind the `reverse` toggle, now off by
   default; needs the correct conditions from the reference before it is trusted.
2. **Intrabar order (Range Projection).** Range Projection's "which level was touched first" outcome depends on tick order inside
   the bar. History only has OHLC, so historical bars use a documented convention while live bars use real tick order. The
   study is flagged `intrabar: true` and the no-look-ahead property test feeds it monotonic tick paths.
3. **Golden data.** `fixtures/` holds hand-computed fixtures (`HAND-*`) for Sequential, Combo and DeMarker I. They are verified
   bar-for-bar by `pnpm test:golden` (unchanged by the 2026-10-27 fixes), and Sequential is additionally cross-checked against
   an independently written oracle on random data (updated to the Symbolik cancellation and recycling rules).
   Reference-platform CSVs (INDICATORS §0) are still needed to close the remaining open rows.
4. **Symbolik check (2026-10-27).** ¹ Symbolik is DeMark Analytics' own platform. Its public help centre
   (help.symbolik.com: "DeMARK Sequential Indicator" and "The DeMARK Indicator List") was read on 2026-10-27; rule
   summaries above are in our own words.
5. **Symbolik "DeMARK Indicator Descriptions" (2026-10-27).** ² Subscriber article (help.symbolik.com, article 360040907874),
   pasted into the session by the user; summarised above in our own words, nothing copied. Its chart images were not
   received, so no bar-by-bar comparison has been made yet. It also gives rules for studies we don't ship yet (Alignment,
   Channels 1–3, Directional, Flip-Flop, Exit 1, In Range, Point Reversal, LV, Double Point, Gap/Lap); see that article if any
   are added.
6. **Reference-chart check (2026-10-27).** Brian supplied screenshots of Symbolik's charts. They are kept outside the repo
   because the material is copyrighted. Expected counts were read off the screenshots and run against public OHLC for the
   same bars (Yahoo `^GSPC`/`QQQ`/`NVDA` daily, Coinbase `BTC-USD` daily). They live as local, git-ignored `REF-*` fixtures
   (8 files; see `fixtures/README.md`). The vendor's feed may differ slightly. BTC 2017 was charted on Kraken, so only its
   first eight Combo counts are compared.
   - **Pass bar for bar with the current defaults:** 13 setup 9s (SPX 2011 and 2018, QQQ 2010, NVDA 2024, BTC 2018) and 10
     TDST levels. Sequential: two QQQ 2010 countdowns 1–13 (13s on 06-30 and 08-24). Combo: BTC 2018 1–13 (13 on 12-14),
     SPX 2011 1–12, and the BTC 2017 recycled count. This confirms the whole-bar TDST cancel (SPX 2011-07-07 closed above
     1345.20 while its true low stayed below, and the count went on) and the 200 % recycle window (BTC 2017).
   - **Intersection extension bars:** NVDA 2024 sell setup 9 = 05-24, countdown 1 = 06-04. The intersecting bar is 05-31,
     whose low reaches the high of 05-28 (setup bar 10). Bars 1–9 alone never intersect, so the test now includes the
     setup run's extension bars (`symbolik.test.ts` › setup extension bars…).
   - **Still open, not changed:**
     - (a) NVDA: after "+" on 07-10 the vendor prints 13 on 07-11, whose close (127.40) is below the high two bars
       earlier (133.82). Only the 13-vs-8 test passes there.
     - (b) SPX 2011-10-04 Combo 13 (close 1123.95 above the prior close and the prior countdown close): neither `strict`
       nor `v2` produces it.
     - (c) SPX 2018: an arrow on 04-02 for the 03-27 buy setup, despite a flip on 03-29 (deferred perfection survives a
       flip).
     - (d) Display: the vendor hides failed setups and counts past 9, removes cancelled or recycled countdown numbers, and
       draws a Combo countdown risk level (≈ 1024 on SPX 2011 = 1074.77 − true range 50.35).
     The fixtures leave these cells blank.

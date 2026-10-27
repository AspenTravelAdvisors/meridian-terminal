# VERIFY_LOG.md
Track every ⚠ VERIFY rule: what was implemented, the pinned test, and how it was resolved.

Every row below is a config input in the study's schema (shown in the Studies dialog with a ⚠ marker) and defaults exactly as
`docs/INDICATORS.md` describes it. The defaults are pinned by `packages/engine/test/verify.test.ts`; behaviour is pinned by the
tests listed per row. "open" = implemented as written, still to be checked against Brian's reference charts/data.

| Date | Study | Rule / parameter | Default implemented | Pinned test | Reference checked | Status |
|---|---|---|---|---|---|---|
| 2026-10-27 | DeMark-style Sequential | TDST mode (`tdstMode`) | `allSetupBars` (highest true high / lowest true low of setup bars 1–9); `bar1TrueExtreme` option | `sequential.test.ts` › sets TDST resistance…(14.5); `demark.test.ts` › bar1TrueExtreme TDST uses only setup bar 1 | Symbolik help ¹ ² | **confirmed** — TDST is the highest true high / lowest true low of the whole completed setup (our `allSetupBars` default) |
| 2026-10-27 | DeMark-style Sequential | TDST break qualifier (`tdstBreakQualifier`) | off | `verify.test.ts` | Symbolik descriptions ² | open — reference marks TDST qualified/disqualified when breakout qualifiers are on; exact qualifier not given |
| 2026-10-27 | DeMark-style Sequential | CD13 qualifier (`cd13Qualifier`) | `low_vs_cd8_close` (bar 13 low ≤ close of CD bar 8, else deferred "+") | `sequential.test.ts` › defers bar 13 with "+"… | Symbolik help ¹ | **confirmed** — buy 13 low ≤ CD8 close (sell: high ≥), "+" on deferral |
| 2026-10-27 | DeMark-style Sequential | Cancellation (`cancelOnOppositeSetup`, `cancelOnTdstBreak`, `tdstCancelTest`) | on / on / `close` | `sequential.test.ts` › cancels the buy countdown when price closes above TDST resistance | Symbolik help ¹ ² | **mismatch** — opposite-setup cancel confirmed; TDST cancel uses the whole bar (buy: true low above TDST resistance), i.e. our `trueExtreme`, not `close`. Same rule for Combo. Default change awaiting Brian |
| 2026-10-27 | DeMark-style Sequential | Intersection-failure cancel (`cancelOnIntersectionFailure`) | **off** — INDICATORS §1.6(c) does not state the exact overlap test | `verify.test.ts` › intersection-failure cancellation off | Symbolik help ¹ ² | **mismatch** — reference: an elective rule that *postpones* the countdown start until a later setup bar overlaps any setup bar three or more bars earlier. Ours blocks the whole countdown and only tests bars 8–9 against bars 1–3. Needs a rewrite (awaiting Brian) |
| 2026-10-27 | DeMark-style Sequential | Recycle factor / mode (`recycleFactor`, `recycleMode`, `recycleOn18`) | 1.618, `size`, off | `verify.test.ts`; `sequential.test.ts` › exposes every ⚠ VERIFY knob | Symbolik help ¹ ² | **mismatch** — reference recycles at 100–200% of the prior setup size (factor 2.0, not 1.618) or when the new setup reaches 22 (we hard-code 18). Same rule for Combo. Awaiting Brian |
| 2026-10-27 | DeMark-style Combo | Version 2 threshold (`v2From`) | bar 11+ (only a lower close than the previous countdown bar) | `demark.test.ts` › v2 relaxes the rules from countdown 11 | Symbolik descriptions ² | **confirmed** — v1 keeps the same rules throughout (our `strict`); v2 relaxes bars 11–13 to only beat the previous countdown bar; the default v2 variant compares closes, as we do |
| 2026-10-27 | DeMark-style D-Wave | Lookback ladder (`lbOrigin…lbC`) | 21/13/8/21/13/21/13/8/21 | `verify.test.ts` › D-Wave ladder; `demark.test.ts` › labels a clean five-wave advance | Symbolik descriptions ² | **mismatch** — reference builds waves from N-bar *highs/lows* (wave 1 = a high at or above the prior 13 highs). Our default uses closes; our H/L preset uses 8 for wave 1. Also: "at or above" vs our strict "greater than", and a "+" marks where a wave was first recognised before it shifted right. Awaiting Brian |
| 2026-10-27 | DeMark-style Propulsion | Ratio / construction (`propulsionRules`) | 0.236 ratio, trigger P + M, target P + 2M, level-2 points, swing-high reference, pullback above A | `verify.test.ts`; `demark.test.ts` › projects trigger P + M and target P + 2M | Symbolik descriptions ² | open — reference names a Momentum level and an Exhaustion level (matches our trigger/target), but gives no formula |
| 2026-10-27 | DeMark-style Lines | Breakout qualifiers Q1–Q3 (`useQ1..3`) | all on | `demark.test.ts` › draws a supply line…flags a break | Symbolik descriptions ² | open — reference adds a third **Cancelled** line state (we have qualified/disqualified only); qualifier and cancel rules not given |
| 2026-10-27 | DeMark-style DeMarker II | BP/SP components (4 switches) | all on, per INDICATORS §6.4 | `verify.test.ts`; `demark.test.ts` › every component switch is honoured | Symbolik descriptions ² | **mismatch** — reference uses the bar's plain low and high (BP: H − prior C plus C − L; SP: prior C − L plus H − C), not true low/high, and states no max(0, …) clamp. Our switches can only turn components off, not swap to plain H/L. It also calls SP "the denominator", which leaves the ratio form ambiguous. Awaiting Brian |
| 2026-10-27 | DeMark-style REI | Overlap lags (`lagA1/A2/B1/B2`) | 5/6 and 7/8 | `verify.test.ts` › REI lags; `demark.test.ts` › is bounded to ±100 | Symbolik descriptions ² | open — no lags given; 6-bar duration rule consistent with our POQ |
| 2026-10-27 | DeMark-style Pressure | Length / volume weighting | 5 bars, volume-weighted | `verify.test.ts` › TD Pressure | Symbolik descriptions ² | open — reference describes cumulative, ROC and ratio forms using price and/or volume; no formula |
| 2026-10-27 | DeMark-style Differential | Reverse Differential (`reverse`) | on, **implemented as written** | `verify.test.ts` | Symbolik help ¹ ² | **issue** — see note 1; reference describes it as comparing pressures over two consecutive same-direction closes, but gives no conditions that separate it from Differential |
| 2026-10-27 | DeMark-style Differential | Anti-Differential (`anti`) | off (sequence unverified) | `verify.test.ts` | Symbolik descriptions ² | **mismatch** — reference buy: two down closes, then an up close, then a down close (current bar), with the up-close bar's low below the bar before it; confirmed by the next bar trading above the down bar's high or closing above its close. Our default `antiPattern` is `D,U,D,U`. Its sell wording has an evident typo, so mirror assumed. Awaiting Brian |
| 2026-10-27 | DeMark-style MA I / MA II | Lengths (`maLength`, `lookback`, `activeBars`; `fast`, `slow`) | 5 / 12 / 4; 3 / 34 | `verify.test.ts` › TD MA | Symbolik descriptions ² | open — MA I: reference gives a breakout rule (close beyond MA, next open beyond that close, then trades beyond that open), not the construction. MA II: described as short vs long moving average with optional % offset; our ROC-based filter is neither confirmed nor ruled out |
| 2026-10-27 | DeMark-style Range Projection | Comparison basis (`rpBasis`) | `open` (C vs O); `priorClose` option | `demark.test.ts` › C = O…priorClose basis | Symbolik descriptions ² | **partly** — close-vs-open basis confirmed; **mismatch**: reference uses *true* high/low in both X and the subtraction (we use plain H/L). It also adds a Buffer level for opens outside the projection. Awaiting Brian |
| 2026-10-27 | DeMark-style Sequential / Combo | Perfection test | buy: bar 8 or 9 low ≤ min(bar 6, bar 7 low) | `sequential.test.ts` | Symbolik descriptions ² | **mismatch (minor)** — reference says "less than" (strict) |
| 2026-10-27 | DeMark-style Sequential | 8-vs-5 deferral | not implemented | — | Symbolik help ¹ ² | new — elective: a qualifying bar 8 is shown "+" and deferred unless it passes an 8-vs-5 test (mirror of 13-vs-8) |
| 2026-10-27 | DeMark-style Open Patterns | TD Open reference level | buy: open below prior low, then trades above prior **low** | — | Symbolik descriptions ² | **mismatch** — reference: open outside the prior range, then reverses to touch the prior **close**. Awaiting Brian |
| 2026-10-27 | DeMark-style Open Patterns | Camouflage | close < prior close, close > open, low < true low 2 bars back | — | Symbolik descriptions ² | **likely mislabelled** — these comparisons match the reference's *Reverse* Camouflage; its plain Camouflage has no rule given |
| 2026-10-27 | DeMark-style REBO | Ratios / base | 0.382 / 0.618 / 1.0 × prior TR from the open | — | Symbolik descriptions ² | **mismatch** — reference highlights 0.236 (entry) and 0.618 (exhaustion); base can be open or prior close; range can be chart or true, averaged over 1+ bars |
| 2026-10-27 | DeMark-style Trend Factor | Auto pivot | latest level-3 TD Point | — | Symbolik descriptions ² | **mismatch** — reference picks the pivot after a 5.56% move from the prior swing (high vs close chosen by the peak bar's close); levels step by 5.56% / 94.44% |
| 2026-10-27 | DeMark-style Points | Max level | Lines use levels 1–5 | — | Symbolik descriptions ² | note — reference allows Point levels up to 21 |

## Notes

1. **Reverse Differential Up ≡ Differential Down as written.** INDICATORS §6.7 gives Reverse Differential Up the same two-bar
   conditions as Differential Down (two lower closes with buying pressure rising and selling pressure falling), so as written the
   two patterns always fire together with opposite labels. Implemented verbatim behind the `reverse` toggle so nothing is
   invented; needs the correct conditions from the reference before it is trusted.
2. **Intrabar order (Range Projection).** Range Projection's "which level was touched first" outcome depends on tick order inside
   the bar. History only has OHLC, so historical bars use a documented convention while live bars use real tick order. The
   study is flagged `intrabar: true` and the no-look-ahead property test feeds it monotonic tick paths.
3. **Golden data.** `fixtures/` holds hand-computed fixtures (`HAND-*`) for Sequential, Combo and DeMarker I. They are verified
   bar-for-bar by `pnpm test:golden`, and Sequential is additionally cross-checked against an independently written oracle on
   random data. Reference-platform CSVs (INDICATORS §0) are still needed to close the rows above.
4. **Symbolik check (2026-10-27).** ¹ Symbolik is DeMark Analytics' own platform. Its public help centre
   (help.symbolik.com: "DeMARK Sequential Indicator" and "The DeMARK Indicator List") was read on 2026-10-27; rule
   summaries above are in our own words. Only Sequential has rule-level detail in public. Per-study tutorials for Combo,
   D-Wave, Propulsion, Lines, DeMarker II, REI, Pressure, Differential and MA are for subscribers only, so those rows stay open.
   Items the reference mentions that INDICATORS.md does not cover yet (not implemented, no defaults changed):
   - a **12-bar rule**: a 13 that gets no reaction within 12 bars is considered failed;
   - an adjustable **termination count** (we already expose `countdownLength`);
   - an "R" in place of the 13 on a recycle (we already draw this).
5. **Symbolik "DeMARK Indicator Descriptions" (2026-10-27).** ² Subscriber article (help.symbolik.com, article 360040907874),
   pasted into the session by the user; summarised above in our own words, nothing copied. It also gives rules for studies
   we don't ship yet (Alignment, Channels 1–3, Directional, Flip-Flop, Exit 1, In Range, Point Reversal, LV, Double Point,
   Gap/Lap); see that article if any are added. The 12-bar rule also applies to Combo.

# VERIFY_LOG.md
Track every ⚠ VERIFY rule: what was implemented, the pinned test, and how it was resolved.

Every row below is a config input in the study's schema (shown in the Studies dialog with a ⚠ marker) and defaults exactly as
`docs/INDICATORS.md` describes it. The defaults are pinned by `packages/engine/test/verify.test.ts`; behaviour is pinned by the
tests listed per row. "open" = implemented as written, still to be checked against Brian's reference charts/data.

| Date | Study | Rule / parameter | Default implemented | Pinned test | Reference checked | Status |
|---|---|---|---|---|---|---|
| 2026-10-27 | DeMark-style Sequential | TDST mode (`tdstMode`) | `allSetupBars` (highest true high / lowest true low of setup bars 1–9); `bar1TrueExtreme` option | `sequential.test.ts` › sets TDST resistance…(14.5); `demark.test.ts` › bar1TrueExtreme TDST uses only setup bar 1 | Symbolik charts, note 4 | **matches** (10/10 levels) |
| 2026-10-27 | DeMark-style Sequential | TDST break qualifier (`tdstBreakQualifier`) | off | `verify.test.ts` | — | open |
| 2026-10-27 | DeMark-style Sequential | CD13 qualifier (`cd13Qualifier`) | `low_vs_cd8_close` (bar 13 low ≤ close of CD bar 8, else deferred "+") | `sequential.test.ts` › defers bar 13 with "+"… | Symbolik charts, note 4 (D) | **issue**: the 13 that follows a "+" may not need the close test |
| 2026-10-27 | DeMark-style Sequential | Cancellation (`cancelOnOppositeSetup`, `cancelOnTdstBreak`, `tdstCancelTest`) | on / on / **`trueExtreme`** (was `close`, changed 2026-10-27 with Brian's OK) | `sequential.test.ts` › cancels…whole bar trades above TDST; keeps the countdown when only the close is above TDST; `verify.test.ts` | Symbolik charts, note 4 (A); `REF-SPX-2011_1D` (Combo) | **resolved** |
| 2026-10-27 | DeMark-style Sequential | Intersection (`intersectionMode`; was `cancelOnIntersectionFailure`) | `off` (elective); `postpone` / `cancel` modes. Overlap test: bar range vs a setup-run bar ≥ 3 bars earlier (INDICATORS §1.6(c)) | `sequential.test.ts` › intersection (off / postpone / cancel); `verify.test.ts` | Symbolik charts, note 4 (C); `REF-NVDA_1D` (postpone) | **resolved** for postpone; open: can the confirming bar itself count |
| 2026-10-27 | DeMark-style Sequential | Recycle factor / mode (`recycleFactor`, `recycleMode`, `recycleOnLongSetup`, `recycleSetupCount`; was `recycleOn18`) | **2.0**, `size`, **on at 22** (were 1.618 / off at 18, changed 2026-10-27 with Brian's OK) | `verify.test.ts`; `sequential.test.ts` › size recycle window 1×–2×; recycles when the same setup run reaches 22 | Symbolik charts, note 4 (B); `REF-BTCUSD-2017_1D` (Combo) | **resolved** for the factor; open: where the long-setup restart begins (kept: on the 22nd bar) |
| 2026-10-27 | DeMark-style Combo | Version 2 threshold (`v2From`) | bar 11+ (only a lower close than the previous countdown bar) | `demark.test.ts` › v2 relaxes the rules from countdown 11 | Symbolik charts, note 4 (E) | **issue**: one reference 13 that neither `strict` nor `v2` produces |
| 2026-10-27 | DeMark-style D-Wave | Lookback ladder (`lbOrigin…lbC`) | 21/13/8/21/13/21/13/8/21 | `verify.test.ts` › D-Wave ladder; `demark.test.ts` › labels a clean five-wave advance | — | open |
| 2026-10-27 | DeMark-style Propulsion | Ratio / construction (`propulsionRules`) | 0.236 ratio, trigger P + M, target P + 2M, level-2 points, swing-high reference, pullback above A | `verify.test.ts`; `demark.test.ts` › projects trigger P + M and target P + 2M | — | open — lowest confidence; transcribe from Brian's source |
| 2026-10-27 | DeMark-style Lines | Breakout qualifiers Q1–Q3 (`useQ1..3`) | all on | `demark.test.ts` › draws a supply line…flags a break | — | open |
| 2026-10-27 | DeMark-style DeMarker II | BP/SP components (4 switches) | all on, per INDICATORS §6.4 | `verify.test.ts`; `demark.test.ts` › every component switch is honoured | — | open |
| 2026-10-27 | DeMark-style REI | Overlap lags (`lagA1/A2/B1/B2`) | 5/6 and 7/8 | `verify.test.ts` › REI lags; `demark.test.ts` › is bounded to ±100 | — | open |
| 2026-10-27 | DeMark-style Pressure | Length / volume weighting | 5 bars, volume-weighted | `verify.test.ts` › TD Pressure | — | open |
| 2026-10-27 | DeMark-style Differential | Reverse Differential (`reverse`) | on, **implemented as written** | `verify.test.ts` | — | **issue** — see note 1 |
| 2026-10-27 | DeMark-style Differential | Anti-Differential (`anti`) | off (sequence unverified) | `verify.test.ts` | — | open |
| 2026-10-27 | DeMark-style MA I / MA II | Lengths (`maLength`, `lookback`, `activeBars`; `fast`, `slow`) | 5 / 12 / 4; 3 / 34 | `verify.test.ts` › TD MA | — | open |
| 2026-10-27 | DeMark-style Range Projection | Comparison basis (`rpBasis`) | `open` (C vs O); `priorClose` option | `demark.test.ts` › C = O…priorClose basis | — | open |

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
4. **Reference-chart check, 2026-10-27.** Brian supplied screenshots of a vendor platform with licensed DeMark studies (Symbolik
   help-centre charts; kept outside the repo). Expected counts were read off the screenshots and compared with the engine run on
   public OHLC for the same bars (Yahoo `^GSPC`/`QQQ`/`NVDA` daily, Coinbase `BTC-USD` daily). The vendor's feed may differ slightly.
   BTC 2017 was charted on Kraken, so only its first eight Combo counts are comparable.

   **Matches, bar for bar:**
   - Setup 9s and perfection at 9 on 13 setups (SPX 2011, SPX 2018, QQQ 2010, NVDA 2024, BTC 2018).
   - TDST levels 1286.12, 1279.21, 1312.62, 1345.20, 1331.94, 1134.95, 47.85, 47.68, 43.46 and 88.93.
   - Sequential countdown QQQ 2010: two full 1–13 runs (13s on 2010-06-30 and 2010-08-24) and countdown risk levels 41.61 / 40.58.
   - Combo BTC 2018: 1–13, with the 13 on 2018-12-14.

   **Mismatches (no defaults changed, awaiting Brian):**
   - (A) *TDST cancel test.* SPX 2011-07-07 closed at 1353.22, above the buy-side TDST of 1345.20. Its true low (1339.22) did not
     clear the level. The vendor keeps the Combo buy countdown alive: 8, 9, 10, 11 on 2011-08-02/04/05/08 and 12 on 2011-10-03.
     Our `close` test cancels it. With `tdstCancelTest: 'trueExtreme'`, counts 1–12 match exactly. The vendor's NVDA chart also
     stops its qualified TDST line on 2024-05-23, the first bar whose whole range is above the level.
   - (B) *Recycle window.* The vendor's documentation gives 100–200 % of the prior setup's size. It also says an overlapping
     setup that runs to 22 recycles. With `recycleFactor: 2`, the BTC 2017 recycled Combo count (1–8 on 11-25, 11-26, 11-27,
     11-28, 12-02, 12-03, 12-06, 12-07) matches. With 1.618 it does not recycle and the numbering is off by four.
   - (C) *Intersection.* On NVDA 2024 the vendor starts the sell countdown on 2024-06-04, after an intersection-confirm marker
     on 2024-05-31. We start it on setup bar 9 (2024-05-24). The qualifying bars are identical, but our numbers run three ahead.
     Rule as observed: countdown is *deferred* until a bar's range overlaps a setup bar three or more bars earlier. It is not
     cancelled. Our `cancelOnIntersectionFailure` blocks the countdown instead, so a postpone mode is needed.
   - (D) *Bar 13 after "+".* NVDA: CD8 = 2024-06-18 (close 135.58), 12 = 07-09, "+" = 07-10 (high 135.10 < 135.58), then 13 on
     07-11. On 07-11 the high of 136.15 passes the 13-vs-8 test, but the close of 127.40 is below the high two bars earlier (133.82).
     So the vendor appears not to re-apply the countdown close test to the deferred 13. Single example, to be confirmed.
   - (E) *Combo 13.* SPX: vendor 12 = 2011-10-03 (close 1099.23) and 13 = 2011-10-04 (close 1123.95, low 1074.77). That close is
     above both the prior close and the prior countdown close, so neither `strict` nor `v2` produces this 13. The vendor's Combo
     version setting is unknown. A low-based comparison on the final bar would fit.
   - (F) *Deferred perfection.* SPX 2018 buy setup 9 = 2018-03-27, not perfected at 9. The vendor arrow is on 2018-04-02 (low
     2553.80 < bar-7 low 2585.89), even though a bullish flip printed on 2018-03-29. INDICATORS §1.3 cancels pending perfection
     on any flip, so we never emit it.
   - (G) *Display.* The vendor erases setups that fail before 9 and does not show counts past 9. It also removes the numbers of
     cancelled or recycled countdowns and draws a Combo countdown risk level (SPX 2011: about 1024, which matches 1074.77 minus that
     bar's true range of 50.35). We draw all of these numbers and Combo has no risk output.

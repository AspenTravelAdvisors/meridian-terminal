# VERIFY_LOG.md
Track every ⚠ VERIFY rule: what was implemented, the pinned test, and how it was resolved.

Every row below is a config input in the study's schema (shown in the Studies dialog with a ⚠ marker) and defaults exactly as
`docs/INDICATORS.md` describes it. The defaults are pinned by `packages/engine/test/verify.test.ts`; behaviour is pinned by the
tests listed per row. "open" = implemented as written, still to be checked against Brian's reference charts/data.

| Date | Study | Rule / parameter | Default implemented | Pinned test | Reference checked | Status |
|---|---|---|---|---|---|---|
| 2026-10-27 | DeMark-style Sequential | TDST mode (`tdstMode`) | `allSetupBars` (highest true high / lowest true low of setup bars 1–9); `bar1TrueExtreme` option | `sequential.test.ts` › sets TDST resistance…(14.5); `demark.test.ts` › bar1TrueExtreme TDST uses only setup bar 1 | Symbolik help ¹ | **partly supported** — reference builds TDST from the setup's true extremes; does not rule the bar-1 option in or out |
| 2026-10-27 | DeMark-style Sequential | TDST break qualifier (`tdstBreakQualifier`) | off | `verify.test.ts` | — | open |
| 2026-10-27 | DeMark-style Sequential | CD13 qualifier (`cd13Qualifier`) | `low_vs_cd8_close` (bar 13 low ≤ close of CD bar 8, else deferred "+") | `sequential.test.ts` › defers bar 13 with "+"… | Symbolik help ¹ | **confirmed** — buy 13 low ≤ CD8 close (sell: high ≥), "+" on deferral |
| 2026-10-27 | DeMark-style Sequential | Cancellation (`cancelOnOppositeSetup`, `cancelOnTdstBreak`, `tdstCancelTest`) | on / on / `close` | `sequential.test.ts` › cancels the buy countdown when price closes above TDST resistance | Symbolik help ¹ | **mismatch** — opposite-setup cancel confirmed; TDST cancel uses the whole bar (buy: true low above TDST resistance), i.e. our `trueExtreme`, not `close`. Default change awaiting Brian |
| 2026-10-27 | DeMark-style Sequential | Intersection-failure cancel (`cancelOnIntersectionFailure`) | **off** — INDICATORS §1.6(c) does not state the exact overlap test | `verify.test.ts` › intersection-failure cancellation off | Symbolik help ¹ | open — reference treats intersection as a gate on countdown start (as our code does) but gives no test |
| 2026-10-27 | DeMark-style Sequential | Recycle factor / mode (`recycleFactor`, `recycleMode`, `recycleOn18`) | 1.618, `size`, off | `verify.test.ts`; `sequential.test.ts` › exposes every ⚠ VERIFY knob | Symbolik help ¹ | **mismatch** — reference recycles at 100–200% of the prior setup size (factor 2.0, not 1.618) or when the new setup reaches 22 (we hard-code 18). Awaiting Brian |
| 2026-10-27 | DeMark-style Combo | Version 2 threshold (`v2From`) | bar 11+ (only a lower close than the previous countdown bar) | `demark.test.ts` › v2 relaxes the rules from countdown 11 | — | open |
| 2026-10-27 | DeMark-style D-Wave | Lookback ladder (`lbOrigin…lbC`) | 21/13/8/21/13/21/13/8/21 | `verify.test.ts` › D-Wave ladder; `demark.test.ts` › labels a clean five-wave advance | — | open |
| 2026-10-27 | DeMark-style Propulsion | Ratio / construction (`propulsionRules`) | 0.236 ratio, trigger P + M, target P + 2M, level-2 points, swing-high reference, pullback above A | `verify.test.ts`; `demark.test.ts` › projects trigger P + M and target P + 2M | — | open — lowest confidence; transcribe from Brian's source |
| 2026-10-27 | DeMark-style Lines | Breakout qualifiers Q1–Q3 (`useQ1..3`) | all on | `demark.test.ts` › draws a supply line…flags a break | — | open |
| 2026-10-27 | DeMark-style DeMarker II | BP/SP components (4 switches) | all on, per INDICATORS §6.4 | `verify.test.ts`; `demark.test.ts` › every component switch is honoured | — | open |
| 2026-10-27 | DeMark-style REI | Overlap lags (`lagA1/A2/B1/B2`) | 5/6 and 7/8 | `verify.test.ts` › REI lags; `demark.test.ts` › is bounded to ±100 | — | open |
| 2026-10-27 | DeMark-style Pressure | Length / volume weighting | 5 bars, volume-weighted | `verify.test.ts` › TD Pressure | — | open |
| 2026-10-27 | DeMark-style Differential | Reverse Differential (`reverse`) | on, **implemented as written** | `verify.test.ts` | Symbolik help ¹ | **issue** — see note 1; reference describes it as a breakout/continuation signal, so it cannot be Differential Down |
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
4. **Symbolik check (2026-10-27).** ¹ Symbolik is DeMark Analytics' own platform. Its public help centre
   (help.symbolik.com: "DeMARK Sequential Indicator" and "The DeMARK Indicator List") was read on 2026-10-27; rule
   summaries above are in our own words. Only Sequential has rule-level detail in public. Per-study tutorials for Combo,
   D-Wave, Propulsion, Lines, DeMarker II, REI, Pressure, Differential and MA are for subscribers only, so those rows stay open.
   Items the reference mentions that INDICATORS.md does not cover yet (not implemented, no defaults changed):
   - an optional **8-vs-5 deferral** on countdown bar 8, a lighter version of the 13-vs-8 test;
   - a **12-bar rule**: a 13 that gets no reaction within 12 bars is considered failed;
   - an adjustable **termination count** (we already expose `countdownLength`);
   - an "R" in place of the 13 on a recycle (we already draw this).

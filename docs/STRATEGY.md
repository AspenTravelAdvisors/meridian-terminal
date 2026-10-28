# STRATEGY.md — How Meridian layers the DeMark-style studies

Brian's working method for the DeMark-style toolkit, written down 2026-10-28 so the product's defaults follow it. The rule details
live in `INDICATORS.md`; this file says **which studies to combine and in what order**. All wording is ours; nothing is quoted
from a book.

## The idea
Most indicators follow a trend. The DeMark-style studies try to measure when a trend is **exhausted**, using objective counts. No
single study is a trade on its own. The edge comes from **stacking** studies so that each one answers a different question.

## One study per role

| Role | Meridian study | What it answers | Where to see it |
|---|---|---|---|
| Primary signal | DeMark-style **Sequential** | Has the move run long enough to be mature (setup 9) or exhausted (countdown 13)? | Counts on the chart |
| Cross-check | DeMark-style **Combo** (version 2) | Does a stricter, earlier-starting countdown agree? | Combo counts (a separate colour/row) |
| Trend filter | **TDST** levels (part of Sequential) | Is a 9 just a pause, or has the trend actually turned? | Solid red/green `TDST` lines with price-scale tags |
| Oscillator confirmation | DeMark-style **DeMarker I** and **REI** | Is the overbought/oversold reading *mild* or *extreme*? | Lower panes and their zone-exit signals |
| Trigger | **Price flip** (setup bar 1), qualified DeMark-style **TD Lines** break | When do I act? | `1` counts; `⇡` = qualified line break, `↑` = unqualified |
| Risk | Setup and countdown **risk levels** (part of Sequential) | Where is the idea wrong? | Dashed `Risk` / `CD risk` lines with price-scale tags |

## Why these combinations
1. **Sequential + TDST: context beats signals.** A 9 that cannot close beyond the opposite TDST level is usually only a pause. If
   price closes through TDST, the trend can carry on into a full 13. The 9 is never a reversal call on its own.
2. **Perfection and qualification.** Meridian already enforces both (`INDICATORS.md` §1.3 and §1.5). An unperfected 9 is drawn
   differently. A 13 that fails the bar-8 qualifier shows `+` and waits. These filters remove many weak signals.
3. **Duration beats level.** An oscillator that stays in a zone for **6 or more bars** shows a strong trend, so don't fade it. A
   **mild** stay of 5 bars or fewer supports a Sequential or Combo reversal. An overbought reading is not a sell signal by itself.
4. **Timeframe confluence** is the biggest multiplier, e.g. a weekly 13 together with a daily 9 at a TDST level.
5. **Sequential and Combo agreeing.** Combo often completes earlier and Sequential later. Two 13s near the same price make
   exhaustion well confirmed.

## The checklist (in Meridian)
1. **Higher timeframe:** read the D / W / M rows of the **DeMark Status** panel (phone: **DeMark** tab) or the **MTF Matrix**.
2. **Context:** where is price relative to the active TDST levels? (`TDST ↑/↓ broken` chips; tags on the price scale.)
3. **Confirmation:** a DeMarker I / REI zone exit **within** the duration limit, not the `… EXTREME` signal.
4. **Trigger:** a price flip in the new direction, or a qualified (`⇡`) TD Line break.
5. **Risk:** stop at the risk level. Never move it wider.

The **Exhaustion Confluence** study scores steps 1–3 automatically (Sequential/Combo state, DeMarker duration, REI, TDST proximity
and higher-timeframe alignment). It is not in the default stack, because it adds a pane. Add it from Studies → Meridian. How to
read it, and its companion **Count Consensus**, is in `WALKTHROUGH.md` § Meridian composites.

## The default layout
New charts open with this stack (`apps/web/src/state/stack.ts`). Any chart can switch to it with **Studies → Templates →
DeMark-style stack → Apply**. Inputs that differ from the study defaults:

| Study | Input | Value | Why |
|---|---|---|---|
| Combo | `comboVersion` | `v2` | Matches Brian's reference workspace ("Combo (2)") |
| TD Lines | `level` / `showTargets` | `3` / off | Level-1 lines and their targets cluttered intraday charts |
| DeMarker I, REI | `maxDuration` | `5` | Signals the 6th bar in a zone as extreme; 5 or fewer counts as mild |

The study defaults in `INDICATORS.md` are unchanged. For example, DeMarker's default duration limit is still 13. The stack only
sets inputs on its own instances.

## Caveats
- The studies are **counter-trend by design**. They fail worst in parabolic moves, which is why the duration filter matters.
- Vendor implementations (Bloomberg, Symbolik) differ in some settings. `VERIFY_LOG.md` records which variant Meridian uses and why.
- Few independent backtests exist. Use the **Signal Tester** on your own symbols, and treat the stack as a framework for judgment,
  not a black box. Analysis, not investment advice.

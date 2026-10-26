import type { AnyStudyDef, Category } from './core/types';
import { confluence, consensus } from './studies/composite';
import { combo } from './studies/demark/combo';
import { dwave } from './studies/demark/dwave';
import { tdLines } from './studies/demark/lines';
import { demarker1, demarker2, pressure, rei } from './studies/demark/oscillators';
import { differential, openPatterns, tdMa1, tdMa2 } from './studies/demark/patterns';
import { tdPoints, trendFactor } from './studies/demark/points';
import { propulsion } from './studies/demark/propulsion';
import { rangeProjection, rebo } from './studies/demark/range';
import { sequential } from './studies/demark/sequential';
import { ichimoku } from './studies/ichimoku';
import { dema, ema, hma, sma, tema, vwap, wma } from './studies/std/ma';
import { cci, macd, mfi, roc, rsi, stochastic, stochRsi, williamsR } from './studies/std/momentum';
import { correlation, linreg, pivotPoints, relativeStrength, zigzag } from './studies/std/structure';
import { adx, atr, bollinger, donchian, historicalVolatility, keltner, psar, supertrend } from './studies/std/volatility';
import { adLine, cmf, obv, sessionVolumeProfile, volume } from './studies/std/volume';

/** Every study, in Studies-dialog order. */
export const STUDIES: AnyStudyDef[] = [
  // DeMark-style (required)
  sequential,
  combo,
  dwave,
  propulsion,
  rangeProjection,
  demarker1,
  demarker2,
  // DeMark-style (extended)
  tdLines,
  tdPoints,
  rei,
  pressure,
  differential,
  openPatterns,
  tdMa1,
  tdMa2,
  trendFactor,
  rebo,
  // Meridian composites
  confluence,
  consensus,
  // Ichimoku
  ichimoku,
  // Standard library
  sma,
  ema,
  wma,
  hma,
  dema,
  tema,
  vwap,
  bollinger,
  keltner,
  donchian,
  atr,
  supertrend,
  psar,
  adx,
  rsi,
  stochastic,
  stochRsi,
  macd,
  cci,
  williamsR,
  roc,
  mfi,
  obv,
  cmf,
  adLine,
  volume,
  sessionVolumeProfile,
  pivotPoints,
  zigzag,
  linreg,
  relativeStrength,
  correlation,
  historicalVolatility,
];

export const STUDY_MAP: Record<string, AnyStudyDef> = Object.fromEntries(STUDIES.map((s) => [s.id, s]));

export const CATEGORIES: Category[] = ['DeMark', 'Meridian', 'Ichimoku', 'Trend', 'Momentum', 'Volatility', 'Volume', 'Custom'];

export function getStudy(id: string): AnyStudyDef | undefined {
  return STUDY_MAP[id];
}

/** All signal ids declared by all studies (for alerts, screener and tester pickers). */
export function allSignals(): { study: string; id: string; dir: string; description: string }[] {
  return STUDIES.flatMap((s) => (s.signals ?? []).map((g) => ({ study: s.id, ...g })));
}

import { type StudyResult, getStudy } from '@meridian/engine';
import type { StudyInstanceCfg } from '../state/types';
import type { ChartHit } from './primitives';

/** What a chart element is, in plain words, for the hover tooltip and the tap/click card. */
export interface Explanation {
  title: string;
  /** full study name (or "Journal note", "Signal heat strip") */
  source?: string;
  /** what the element represents */
  meaning?: string;
  /** element-specific detail from the engine (TDST value, cancel reason, note body) */
  detail?: string;
  value?: number;
  /** format `value` as volume rather than price */
  volume?: boolean;
  /** the study's own one-line description */
  about?: string;
  /** heat strip: every signal that fired on the bar */
  items?: { text: string; dir: string }[];
  uid?: string;
  provisional?: boolean;
  color: string;
}

export interface ExplainCtx {
  cfgs: StudyInstanceCfg[];
  results: Map<string, StudyResult>;
  scriptPlots: { uid: string; name: string; plots: { title: string }[] }[];
}

type Cfg = Record<string, unknown>;
type Side = 'buy' | 'sell';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (cfg: Cfg, k: string, d: number) => (typeof cfg[k] === 'number' ? (cfg[k] as number) : d);

// Plain-language meanings keyed `studyId:outputId`. Written for this app; exact rules live in docs/INDICATORS.md.
const OUTPUTS: Record<string, string> = {
  'td-sequential:tdst_res':
    'TDST resistance, drawn from the last completed buy setup. A close above it suggests sellers have lost control, and by default it cancels a buy countdown in progress.',
  'td-sequential:tdst_sup':
    'TDST support, drawn from the last completed sell setup. A close below it suggests buyers have lost control, and by default it cancels a sell countdown in progress.',
  'td-sequential:risk_buy':
    'Buy setup risk: the setup bar with the lowest true low, minus that bar’s true range. A common stop reference for a long taken off the setup.',
  'td-sequential:risk_sell':
    'Sell setup risk: the setup bar with the highest true high, plus that bar’s true range. A common stop reference for a short taken off the setup.',
  'td-sequential:cdrisk_buy':
    'Buy countdown risk: same idea as setup risk, measured over every bar from countdown bar 1 to 13.',
  'td-sequential:cdrisk_sell':
    'Sell countdown risk: same idea as setup risk, measured over every bar from countdown bar 1 to 13.',
  'meridian-zone:buy_zone':
    'Buy exhaustion zone: the price band below the close where the most support levels cluster (TDST, risk levels, Ichimoku cloud and Kijun, TD Lines and Propulsion targets). Where a decline is most likely to stall, not a forecast that it will.',
  'meridian-zone:sell_zone':
    'Sell exhaustion zone: the price band above the close where the most resistance levels cluster. Where a rally is most likely to stall, not a forecast that it will.',
  'meridian-zone:buy_hi': 'Top of the buy exhaustion zone.',
  'meridian-zone:buy_lo':
    'Bottom of the buy exhaustion zone. A close well below it means every clustered support gave way.',
  'meridian-zone:sell_hi':
    'Top of the sell exhaustion zone. A close well above it means every clustered resistance gave way.',
  'meridian-zone:sell_lo': 'Bottom of the sell exhaustion zone.',
  'td-propulsion:up_trigger':
    'Upside propulsion trigger: pullback low plus the swing’s momentum. A close above it suggests the advance is resuming.',
  'td-propulsion:up_target': 'Upside propulsion target: where the resumed advance is projected to tire.',
  'td-propulsion:dn_trigger':
    'Downside propulsion trigger: bounce high minus the swing’s momentum. A close below it suggests the decline is resuming.',
  'td-propulsion:dn_target': 'Downside propulsion target: where the resumed decline is projected to tire.',
  'td-range-projection:rp_high':
    'Projected high for this bar, computed from the previous bar’s high, low, open and close.',
  'td-range-projection:rp_low':
    'Projected low for this bar, computed from the previous bar’s high, low, open and close.',
  'td-range-projection:up_tol':
    'Upside tolerance: open plus a fraction of the prior true range. Reaching it before the projected low favours a close above the projected high.',
  'td-range-projection:dn_tol':
    'Downside tolerance: open minus a fraction of the prior true range. Reaching it before the projected high favours a close below the projected low.',
  'td-lines:supply_target':
    'Upside target after a supply-line breakout: the line-to-low distance added to the breakout price.',
  'td-lines:demand_target':
    'Downside target after a demand-line breakdown: the line-to-high distance subtracted from the breakdown price.',
  'td-points:last_high': 'Most recent confirmed point high: a high above the highs of the bars on each side.',
  'td-points:last_low': 'Most recent confirmed point low: a low below the lows of the bars on each side.',
  'td-demarker-1:dem1':
    'Compares upside high-to-high moves with downside low-to-low moves. High readings are overbought, low are oversold; long stays in a zone signal trend, not reversal.',
  'td-demarker-2:dem2':
    'Buying pressure versus selling pressure from prior-close and true-range components. Same zone and duration reading as DeMarker I.',
  'td-rei:rei':
    'Range expansion, counted only when price overlaps earlier bars. Extended oversold readings set up POQ buys; overbought, POQ sells.',
  'td-pressure:pressure': 'Volume-weighted buying versus selling pressure (0–100).',
  'td-ma-1:ma_up':
    'Short average of lows, switched on after a strong upside thrust. Acts as trailing support while it is drawn.',
  'td-ma-1:ma_dn':
    'Short average of highs, switched on after a strong downside thrust. Acts as trailing resistance while it is drawn.',
  'td-trend-factor:pivot': 'Pivot price the Trend Factor steps are measured from.',
  'td-rebo:bias': 'Breakout bias from whether the prior close was up or down.',
  'ichimoku:tenkan': 'Conversion line: midpoint of the last 9 bars’ range. Fast trend gauge.',
  'ichimoku:kijun':
    'Base line: midpoint of the last 26 bars’ range. Slower trend gauge and a common price magnet when flat.',
  'ichimoku:senkouA': 'Leading span A: average of conversion and base lines, plotted forward. One edge of the cloud.',
  'ichimoku:senkouB':
    'Leading span B: midpoint of the last 52 bars’ range, plotted forward. The other edge of the cloud.',
  'ichimoku:kumo':
    'The cloud between the two leading spans. Price above it is bullish, below bearish, inside it undecided; a thicker cloud is stronger support or resistance.',
  'ichimoku:chikou': 'Lagging span: today’s close plotted back in time. Above past price is bullish, below bearish.',
  'bollinger:basis': 'Middle band: moving average of the close.',
  'bollinger:upper':
    'Upper band: middle band plus a multiple of standard deviation. Touches show strength; a squeeze between bands often precedes expansion.',
  'bollinger:lower': 'Lower band: middle band minus a multiple of standard deviation.',
  'bollinger:fill': 'Area between the bands. Its width tracks volatility.',
  'keltner:mid': 'Channel middle: moving average of price.',
  'keltner:upper': 'Upper channel: middle plus a multiple of ATR.',
  'keltner:lower': 'Lower channel: middle minus a multiple of ATR.',
  'donchian:upper': 'Highest high of the lookback window. A close above it is a breakout.',
  'donchian:lower': 'Lowest low of the lookback window. A close below it is a breakdown.',
  'donchian:mid': 'Midpoint of the channel.',
  'vwap:vwap': 'Volume-weighted average price for the session: the average price paid per share.',
  'supertrend:up': 'Trailing stop under price while the trend is up. A close below it flips the trend down.',
  'supertrend:down': 'Trailing stop above price while the trend is down. A close above it flips the trend up.',
  'psar:sar':
    'Parabolic stop-and-reverse: a trailing stop that accelerates with the trend and flips sides when price crosses it.',
  'adx:adx': 'Trend strength regardless of direction. Rising above the threshold means a trend is in force.',
  'adx:pdi': 'Upward directional movement. Above −DI favours the long side.',
  'adx:ndi': 'Downward directional movement. Above +DI favours the short side.',
  'rsi:rsi': 'Relative strength of recent gains versus losses (0–100). High readings are overbought, low are oversold.',
  'stochastic:k': 'Where the close sits in the recent high-low range (0–100).',
  'stochastic:d': 'Signal line: a smoothed %K. Crosses of %K over %D are the usual trigger.',
  'stoch-rsi:k': 'Stochastic of RSI: where RSI sits in its own recent range.',
  'stoch-rsi:d': 'Signal line: a smoothed %K.',
  'macd:macd': 'Fast EMA minus slow EMA. Above zero the short-term trend leads the long-term one.',
  'macd:signal': 'EMA of the MACD line. MACD crossing it is the classic trigger.',
  'macd:hist': 'MACD minus its signal line. Growing bars show strengthening momentum; shrinking bars show it fading.',
  'cci:cci': 'How far the typical price is from its average, scaled by typical deviation.',
  'williams-r:wr': 'Close relative to the recent high (0 to −100). Near 0 is overbought, near −100 oversold.',
  'roc:roc': 'Percent change over the lookback.',
  'mfi:mfi': 'Volume-weighted RSI of typical price (0–100).',
  'obv:obv': 'Running total of volume, added on up closes and subtracted on down closes.',
  'cmf:cmf': 'Volume-weighted accumulation (above zero) or distribution (below zero) over the window.',
  'ad-line:ad': 'Cumulative accumulation/distribution: volume weighted by where each close sits in its bar.',
  'volume:vol': 'Shares or contracts traded in the bar. Green when the bar closed up, red when down.',
  'volume:ma': 'Moving average of volume. Bars well above it show unusual participation.',
  'volume-profile-session:poc':
    'Developing point of control: the price with the most volume traded so far this session.',
  'linreg:end': 'Least-squares line end-point over the window: a smoothed fair value that does not repaint.',
  'relative-strength:rs': 'Price relative to the benchmark, rebased to 100. Rising means outperforming.',
  'correlation:corr': 'Rolling correlation with the comparison symbol (−1 to +1).',
  'hv:hv': 'Historical volatility: annualized standard deviation of returns.',
  'atr:atr': 'Average true range: typical bar size including gaps. Useful for stops and position sizing.',
};

const MA_LINE =
  'Moving average of the close. Price above a rising average is a basic uptrend read; crosses of two averages are a common trigger.';
const PIVOTS =
  'Floor-trader pivot level from the prior period’s high, low and close. P is the central pivot; R levels are resistance above it, S levels support below.';

function setupCount(cfg: Cfg, side: Side, n: number): Pick<Explanation, 'title' | 'meaning'> {
  const len = num(cfg, 'setupLength', 9);
  const lb = num(cfg, 'setupLookback', 4);
  const cmp = side === 'sell' ? 'above' : 'below';
  if (n > len)
    return {
      title: `${cap(side)} setup extension · ${n}`,
      meaning: `The setup already completed at ${len}; closes keep landing ${cmp} the close ${lb} bars earlier, so the move is still extending.`,
    };
  return {
    title: `${cap(side)} setup · bar ${n} of ${len}`,
    meaning: `This close is ${cmp} the close ${lb} bars earlier — ${n} bar${n === 1 ? '' : 's'} in a row. ${len} in a row completes a ${side} setup, a sign the ${side === 'sell' ? 'advance' : 'decline'} may be tiring. Any bar that breaks the streak resets the count.`,
  };
}

function countdownCount(cfg: Cfg, side: Side, n: number): Pick<Explanation, 'title' | 'meaning'> {
  const len = num(cfg, 'countdownLength', 13);
  const aggressive = cfg.countdownMode === 'aggressive';
  const what = aggressive ? (side === 'sell' ? 'high' : 'low') : 'close';
  const ref = side === 'sell' ? 'at or above the high' : 'at or below the low';
  return {
    title: `${cap(side)} countdown · bar ${n} of ${len}`,
    meaning: `Countdown starts after a completed ${side} setup. Bars count when their ${what} is ${ref} two bars earlier; they need not be consecutive. Bar ${len} marks potential exhaustion of the ${side === 'sell' ? 'advance' : 'decline'}.`,
  };
}

function sideOf(h: ChartHit): Side {
  return h.pos === 'above' ? 'sell' : 'buy';
}

function markerMeaning(studyId: string, cfg: Cfg, h: ChartHit): Pick<Explanation, 'title' | 'meaning'> | null {
  const t = h.text ?? '';
  const side = sideOf(h);
  if (studyId === 'td-sequential') {
    if (t === String(num(cfg, 'setupLength', 9)))
      return {
        title: `${cap(side)} setup complete`,
        meaning: `The full setup printed. Solid means perfected: bar 8 or 9 reached ${side === 'sell' ? 'above the highs' : 'below the lows'} of bars 6 and 7. Hollow means not yet perfected; a later bar can still perfect it. Completion also draws a new TDST level and can start a countdown.`,
      };
    if (t === String(num(cfg, 'countdownLength', 13)))
      return {
        title: `${cap(side)} countdown complete`,
        meaning: `The countdown reached its final bar and passed the bar-13 qualifier — the study’s main exhaustion signal. It is read as a sign the ${side === 'sell' ? 'advance' : 'decline'} may stall or reverse here.`,
      };
    if (t === 'P')
      return {
        title: 'Deferred perfection',
        meaning:
          'An earlier unperfected setup became perfected on this bar, because price finally reached beyond the extremes of setup bars 6 and 7.',
      };
    if (t === '×')
      return {
        title: 'Countdown cancelled',
        meaning: 'A running countdown was abandoned on this bar. The detail line says which rule cancelled it.',
      };
    if (t === 'R')
      return {
        title: 'Countdown recycled',
        meaning:
          'A new same-direction setup completed while a countdown was running, and was similar enough in size that the countdown restarted from it.',
      };
    if (t === '+')
      return {
        title: 'Bar 13 deferred',
        meaning:
          'This bar would have been the last countdown bar but failed the bar-13 qualifier, so counting continues until a later bar qualifies.',
      };
  }
  if (studyId === 'td-combo') {
    const n = Number(t);
    const len = num(cfg, 'countdownLength', 13);
    if (Number.isFinite(n))
      return {
        title: n >= len ? `Combo ${side} countdown complete` : `Combo ${side} countdown · bar ${n} of ${len}`,
        meaning:
          'Combo counts from setup bar 1 and asks more of each bar than Sequential: a lower close and low than the prior bar, at or beyond the extreme two bars back, and beyond the previous countdown close. Its 13 is an exhaustion signal.',
      };
  }
  if (studyId === 'td-lines')
    return {
      title: `${h.tip ? cap(h.tip) : 'Line break'}`,
      meaning:
        'Price closed through the TD line. A double arrow means the break passed at least one enabled qualifier; a single arrow is unqualified and less reliable.',
    };
  if (studyId === 'td-points')
    return {
      title: h.tip ?? 'Point',
      meaning: 'A swing extreme that stands out from the bars on each side. These anchor TD Lines and Propulsion.',
    };
  if (studyId === 'td-propulsion')
    return t === 'P'
      ? {
          title: 'Propulsion trigger',
          meaning: 'Price closed through the propulsion trigger, suggesting the prior swing is resuming.',
        }
      : { title: 'Propulsion target hit', meaning: 'The resumed move reached its exhaustion target.' };
  if (studyId === 'td-rei')
    return {
      title: h.tip ?? 'POQ',
      meaning:
        'After a sustained REI extreme, price confirmed a turn by trading through the prior bars. An entry trigger rather than a forecast.',
    };
  if (studyId === 'td-differential') {
    const kind = t === 'RD' ? 'Reverse Differential' : t === 'AD' ? 'Anti-Differential' : 'Differential';
    const m =
      t === 'RD'
        ? 'Two closes in the trend’s direction while pressure quietly shifts against it — a continuation pattern.'
        : t === 'AD'
          ? 'A short close-pattern hinting at a turn. Disabled by default until its definition is verified.'
          : 'Two closes against the move while buying and selling pressure shift toward a reversal — a short-term turn pattern.';
    return { title: `${kind} ${side === 'buy' ? 'buy' : 'sell'}`, meaning: m };
  }
  if (studyId === 'td-open-patterns')
    return {
      title: h.tip ? cap(h.tip) : 'Open pattern',
      meaning:
        'An opening-gap pattern: price opened beyond the prior bar and then reversed through a reference level within the bar.',
    };
  if (studyId === 'ichimoku')
    return {
      title: h.tip ? cap(h.tip) : 'TK cross',
      meaning:
        'The conversion line crossed the base line. Strong when it happens on the trend side of the cloud, weak against it.',
    };
  if (studyId === 'meridian-zone')
    return {
      title: h.tip ?? 'Into the zone',
      meaning:
        'Price traded into the exhaustion zone drawn on the previous bar. Context, not an entry: wait for a trigger such as a price flip or a qualified TD Line break.',
    };
  if (studyId === 'meridian-consensus')
    return {
      title: h.tip ?? 'Count consensus',
      meaning:
        'How many of the four Sequential/Combo rule variants finished a 13 near this bar. More agreement means the signal is less sensitive to rule choices.',
    };
  return null;
}

function outputMeaning(studyId: string, outId: string | undefined): string | undefined {
  if (!outId) return undefined;
  const k = `${studyId}:${outId}`;
  if (OUTPUTS[k]) return OUTPUTS[k];
  if (['sma', 'ema', 'wma', 'hma', 'dema', 'tema'].includes(studyId)) return MA_LINE;
  if (studyId === 'pivot-points') return PIVOTS;
  if (studyId === 'td-trend-factor')
    return 'Trend Factor step: a fixed percentage above or below the pivot. Price often pauses at these steps; the 11.1% and 22.2% steps matter most.';
  if (studyId === 'td-rebo')
    return 'Range-expansion breakout level: the open plus or minus a ratio of the prior true range. A close beyond the outer level confirms a breakout.';
  if (studyId === 'vwap')
    return 'Standard-deviation band around VWAP. Price stretched to an outer band is extended from the session’s average.';
  return undefined;
}

/** Turn a hit into words. Unknown elements fall back to the output title and the study description. */
export function explain(h: ChartHit, ctx: ExplainCtx): Explanation {
  if (h.kind === 'note') return { title: 'Journal note', source: 'Journal', detail: h.tip, color: h.color };
  if (h.kind === 'heat') {
    const items: Explanation['items'] = [];
    for (const c of ctx.cfgs) {
      const r = ctx.results.get(c.uid);
      const def = getStudy(c.id);
      for (const s of r?.signals ?? [])
        if (s.i === h.i)
          items.push({
            text: `${def?.shortName ?? c.id}: ${def?.signals?.find((x) => x.id === s.id)?.description ?? s.id}${s.label ? ` (${s.label})` : ''}`,
            dir: s.dir,
          });
    }
    return {
      title: 'Signals on this bar',
      source: 'Signal heat strip',
      meaning:
        'Each tick under price stacks the study signals that fired on that bar: green bullish, red bearish, grey neutral.',
      items,
      color: h.color,
    };
  }
  const cfg = ctx.cfgs.find((c) => c.uid === h.src);
  if (cfg?.id === 'script') {
    const sp = ctx.scriptPlots.find((x) => x.uid === h.src);
    const k = h.out?.startsWith('p') ? Number(h.out.slice(1)) : NaN;
    return {
      title: sp?.plots[k]?.title || h.tip || h.text || 'Script output',
      source: sp?.name ?? 'Script',
      meaning: 'Plotted by your Meridian Script.',
      value: h.value,
      uid: h.src,
      color: h.color,
    };
  }
  const def = cfg ? getStudy(cfg.id) : undefined;
  const c = (cfg?.cfg ?? {}) as Cfg;
  const out =
    def && cfg ? (ctx.results.get(cfg.uid)?.outputs ?? def.outputs(c)).find((o) => o.id === h.out) : undefined;
  const base: Explanation = {
    title: out?.title ?? h.text ?? def?.shortName ?? 'Chart element',
    source: def?.name,
    about: def?.description,
    uid: h.src,
    provisional: h.provisional,
    color: h.color,
    value: h.value,
  };
  if (!def || !cfg) return base;

  if (h.kind === 'count' && h.value !== undefined) {
    const side: Side = h.value > 0 ? 'sell' : 'buy';
    const n = Math.abs(h.value);
    return { ...base, value: undefined, ...(h.out === 'cd_lbl' ? countdownCount(c, side, n) : setupCount(c, side, n)) };
  }
  if (h.kind === 'marker') {
    const m = markerMeaning(cfg.id, c, h);
    return {
      ...base,
      value: undefined,
      title: m?.title ?? (h.tip ? cap(h.tip) : `${def.shortName} marker “${h.text}”`),
      meaning: m?.meaning,
      detail: h.tip,
    };
  }
  if (h.kind === 'pivot') {
    const isZz = cfg.id === 'zigzag';
    return {
      ...base,
      title: isZz ? 'ZigZag swing point' : `Wave ${h.text}`,
      meaning: isZz
        ? 'A swing high or low that reversed by at least the deviation %. The newest leg stays provisional until price reverses enough.'
        : 'A wave pivot from the mechanical wave count. Filled dots are locked; hollow ones can still shift as price develops.',
    };
  }
  if (h.kind === 'segment') {
    const meaning =
      cfg.id === 'td-lines'
        ? `${h.text === 'Demand' ? 'Demand line: joins the latest point low to an earlier, lower one. A close below it is a breakdown.' : 'Supply line: joins the latest point high to an earlier, higher one. A close above it is a breakout.'}`
        : cfg.id === 'td-dwave'
          ? 'Fibonacci guide for the wave count: an ideal retracement or projection target.'
          : cfg.id === 'meridian-zone'
            ? 'Current exhaustion zone: the band where the most support (buy zone) or resistance (sell zone) levels cluster, drawn from the bar it formed. The number is how many levels are in it; the Data Window and status card list them.'
            : cfg.id === 'td-range-projection'
              ? 'Projected range for the next bar, from the current bar’s prices.'
              : cfg.id === 'linreg'
                ? 'Regression channel: the fitted line with standard-error bands.'
                : undefined;
    return { ...base, title: h.text || base.title, meaning };
  }
  if (h.kind === 'time' && cfg.id === 'meridian-window')
    return {
      ...base,
      value: undefined,
      title: `Projected ${h.text}`,
      meaning: h.text?.endsWith('earliest')
        ? 'The soonest bar this count can complete, if every bar from here qualifies. It cannot come sooner.'
        : h.text?.endsWith('est.')
          ? 'Where this count completes if it keeps qualifying at the pace it has so far. An estimate: the count can also be cancelled or recycled first.'
          : 'Where this count completes if it keeps going: every bar so far has qualified, so the earliest bar and the estimate coincide. The count can still be cancelled first.',
    };
  if (h.kind === 'time')
    return {
      ...base,
      value: undefined,
      title: `Time count ${h.text}`,
      meaning:
        'A Fibonacci-style bar count from the chosen pivot. Turns often cluster near these bars; it may lie in the future.',
    };
  if (h.kind === 'cloud')
    return {
      ...base,
      value: undefined,
      title: out?.title ?? 'Cloud',
      meaning: outputMeaning(cfg.id, h.out),
      detail:
        h.value === undefined
          ? undefined
          : h.value >= 0
            ? 'Bullish cloud (span A above span B)'
            : 'Bearish cloud (span B above span A)',
    };
  return { ...base, meaning: outputMeaning(cfg.id, h.out), volume: cfg.id === 'volume' && h.out === 'vol' };
}

/**
 * Built-in calendar of landmark, market-moving events. Free, offline and deterministic. Every description is written
 * for Meridian in our own words. Dates are the first session that reacted: for a weekend or after-hours event that is
 * the next trading day for US equities, and the UTC calendar day for crypto.
 *
 * Weights: 1 notable, 2 major, 3 landmark. Keep entries to events whose effect on prices is well documented; company
 * news for US stocks comes from SEC filings instead (news.ts), so company entries here are limited to crypto coins and
 * the few equity events no filing describes.
 */

export type Sector = 'banks' | 'energy' | 'semis' | 'tech' | 'crypto' | 'airlines' | 'biotech' | 'autos' | 'retail' | 'gold' | 'bonds';

export interface CalendarEvent {
  /** YYYY-MM-DD, or a full ISO time when the minute is known */
  d: string;
  scope: 'market' | 'industry' | 'ticker';
  w: 1 | 2 | 3;
  h: string;
  /** industry events: the sectors hit */
  sectors?: Sector[];
  /** ticker events: plain tickers or crypto bases (BTC, ETH) */
  tickers?: string[];
  /** market events that also moved crypto */
  crypto?: boolean;
}

export const NEWS_CALENDAR: CalendarEvent[] = [
  // ── Market-wide ─────────────────────────────────────────────────────────────
  { d: '1987-10-19', scope: 'market', w: 3, h: 'Black Monday: US stocks lose more than a fifth of their value in one session.' },
  { d: '1998-08-17', scope: 'market', w: 2, h: 'Russia devalues the ruble and defaults on its domestic debt.' },
  { d: '1998-09-23', scope: 'market', w: 2, h: 'The New York Fed organises a bank rescue of the hedge fund LTCM.' },
  { d: '2001-09-17', scope: 'market', w: 3, h: 'US stock markets reopen after the September 11 attacks.' },
  { d: '2007-02-27', scope: 'market', w: 2, h: 'Shanghai stocks plunge about 9%, setting off a global sell-off.' },
  { d: '2007-08-09', scope: 'market', w: 2, h: 'BNP Paribas freezes funds exposed to US subprime loans; credit markets seize up.' },
  { d: '2008-03-17', scope: 'market', w: 2, h: 'JPMorgan agrees to buy Bear Stearns in a Fed-backed rescue.' },
  { d: '2008-09-15', scope: 'market', w: 3, h: 'Lehman Brothers files for bankruptcy; Merrill Lynch sells itself to Bank of America.' },
  { d: '2008-09-29', scope: 'market', w: 3, h: 'The House rejects the first bank-rescue bill (TARP); the S&P 500 falls almost 9%.' },
  { d: '2008-10-13', scope: 'market', w: 2, h: 'Governments pledge to recapitalise banks; the S&P 500 jumps more than 11%.' },
  { d: '2008-11-25', scope: 'market', w: 2, h: 'The Fed announces large purchases of mortgage-backed securities (QE1 begins).' },
  { d: '2009-03-18', scope: 'market', w: 2, h: 'The Fed expands QE1 to long-term Treasuries.' },
  { d: '2010-05-06', scope: 'market', w: 3, h: 'Flash Crash: US stocks drop about 9% within minutes, then recover most of it.' },
  { d: '2011-08-08', scope: 'market', w: 3, h: 'First session after S&P downgrades the US credit rating; the S&P 500 falls almost 7%.' },
  { d: '2012-07-26', scope: 'market', w: 2, h: 'The ECB president pledges to do whatever is needed to save the euro.' },
  { d: '2013-05-22', scope: 'market', w: 2, h: 'Fed chair Bernanke signals bond buying may slow (the taper tantrum).' },
  { d: '2015-08-11', scope: 'market', w: 1, h: 'China devalues the yuan.' },
  { d: '2015-08-24', scope: 'market', w: 3, h: 'Global sell-off on China growth fears; the Dow drops about 1,000 points at the open.' },
  { d: '2015-12-16', scope: 'market', w: 2, h: 'The Fed raises rates for the first time since 2006.' },
  { d: '2016-06-24', scope: 'market', w: 3, h: 'The UK votes to leave the European Union (Brexit).' },
  { d: '2016-11-09', scope: 'market', w: 2, h: 'Donald Trump wins the US presidential election.' },
  { d: '2018-02-05', scope: 'market', w: 3, h: 'Volatility spike: the Dow falls about 1,175 points and short-volatility products collapse.' },
  { d: '2019-01-04', scope: 'market', w: 2, h: 'Fed chair Powell signals patience on rate hikes; stocks rally.' },
  { d: '2019-08-05', scope: 'market', w: 2, h: 'China lets the yuan weaken past 7 per dollar as the trade war escalates.' },
  { d: '2020-02-24', scope: 'market', w: 3, h: 'COVID-19 spreads outside China; global stocks start to slide.', crypto: true },
  { d: '2020-03-09', scope: 'market', w: 3, h: 'Oil price war and COVID-19 fears trigger the first market-wide trading halt since 1997.', crypto: true },
  { d: '2020-03-12', scope: 'market', w: 3, h: 'US suspends travel from Europe; stocks fall about 9.5% and crypto crashes.', crypto: true },
  { d: '2020-03-16', scope: 'market', w: 3, h: 'The Fed cuts rates to zero in an emergency Sunday move; the S&P 500 falls about 12%.', crypto: true },
  { d: '2020-03-23', scope: 'market', w: 3, h: 'The Fed pledges unlimited bond buying; the COVID-19 bear market bottoms.', crypto: true },
  { d: '2020-11-09', scope: 'market', w: 3, h: 'Pfizer and BioNTech report a COVID-19 vaccine about 90% effective.' },
  { d: '2022-02-24', scope: 'market', w: 3, h: 'Russia invades Ukraine.', crypto: true },
  { d: '2022-03-16', scope: 'market', w: 2, h: 'The Fed raises rates for the first time since 2018, starting its hiking cycle.' },
  { d: '2022-06-13', scope: 'market', w: 2, h: 'A hot inflation report drives the S&P 500 into a bear market.', crypto: true },
  { d: '2022-08-26', scope: 'market', w: 2, h: 'Powell’s Jackson Hole speech vows to keep fighting inflation; stocks drop.' },
  { d: '2022-09-13', scope: 'market', w: 2, h: 'Hotter-than-expected inflation; the S&P 500 falls more than 4%.' },
  { d: '2022-11-10', scope: 'market', w: 3, h: 'Cooler-than-expected inflation; the S&P 500 jumps about 5.5%.', crypto: true },
  { d: '2023-03-13', scope: 'market', w: 2, h: 'US guarantees all deposits at the failed SVB and Signature banks.' },
  { d: '2024-08-05', scope: 'market', w: 3, h: 'Yen carry-trade unwind: Japan’s Nikkei falls 12% and volatility spikes worldwide.', crypto: true },
  { d: '2024-09-18', scope: 'market', w: 2, h: 'The Fed cuts rates by half a point, its first cut since 2020.' },
  { d: '2024-11-06', scope: 'market', w: 3, h: 'Donald Trump wins the US presidential election.', crypto: true },
  { d: '2025-04-03', scope: 'market', w: 3, h: 'Sweeping US tariffs announced; the S&P 500 has its worst day since 2020.', crypto: true },
  { d: '2025-04-09', scope: 'market', w: 3, h: 'The US pauses most new tariffs for 90 days; the S&P 500 rises about 9.5%.', crypto: true },

  // ── Industry ────────────────────────────────────────────────────────────────
  { d: '2001-09-17', scope: 'industry', w: 3, sectors: ['airlines'], h: 'Airlines reopen to trading after the September 11 attacks.' },
  { d: '2008-03-17', scope: 'industry', w: 3, sectors: ['banks'], h: 'Bear Stearns rescued by JPMorgan with Fed backing.' },
  { d: '2008-09-15', scope: 'industry', w: 3, sectors: ['banks'], h: 'Lehman Brothers fails.' },
  { d: '2014-11-28', scope: 'industry', w: 3, sectors: ['energy'], h: 'OPEC decides not to cut output; oil prices plunge.' },
  { d: '2016-11-30', scope: 'industry', w: 2, sectors: ['energy'], h: 'OPEC agrees to its first production cut since 2008.' },
  { d: '2020-03-09', scope: 'industry', w: 3, sectors: ['energy'], h: 'Saudi–Russia price war: oil has its worst day since 1991.' },
  { d: '2020-04-20', scope: 'industry', w: 3, sectors: ['energy'], h: 'US crude futures settle below zero for the first time.' },
  { d: '2022-03-08', scope: 'industry', w: 2, sectors: ['energy'], h: 'The US bans Russian oil imports; crude nears its 2008 high.' },
  { d: '2022-10-07', scope: 'industry', w: 2, sectors: ['semis'], h: 'The US imposes sweeping export controls on advanced chips to China.' },
  { d: '2023-03-09', scope: 'industry', w: 3, sectors: ['banks'], h: 'SVB’s emergency capital raise and Silvergate’s wind-down set off a bank sell-off.' },
  { d: '2023-03-10', scope: 'industry', w: 3, sectors: ['banks'], h: 'Regulators close Silicon Valley Bank.' },
  { d: '2023-03-13', scope: 'industry', w: 3, sectors: ['banks'], h: 'Signature Bank closed; regional bank stocks crash despite the deposit guarantee.' },
  { d: '2023-03-20', scope: 'industry', w: 2, sectors: ['banks'], h: 'UBS agrees to take over Credit Suisse.' },
  { d: '2023-05-01', scope: 'industry', w: 2, sectors: ['banks'], h: 'Regulators seize First Republic; JPMorgan buys it.' },
  { d: '2023-05-25', scope: 'industry', w: 3, sectors: ['semis', 'tech'], h: 'Nvidia’s record revenue forecast sets off an AI-chip rally.' },
  { d: '2025-01-27', scope: 'industry', w: 3, sectors: ['semis', 'tech'], h: 'DeepSeek’s low-cost AI model triggers a sell-off in AI chip stocks.' },

  // ── Crypto-wide ─────────────────────────────────────────────────────────────
  { d: '2014-02-25', scope: 'industry', w: 2, sectors: ['crypto'], h: 'Mt. Gox halts withdrawals and goes offline.' },
  { d: '2017-12-18', scope: 'industry', w: 2, sectors: ['crypto'], h: 'CME bitcoin futures begin trading near the bitcoin price peak.' },
  { d: '2021-05-19', scope: 'industry', w: 3, sectors: ['crypto'], h: 'Crypto crash after China restates its ban on crypto services.' },
  { d: '2022-05-09', scope: 'industry', w: 3, sectors: ['crypto'], h: 'TerraUSD loses its dollar peg and LUNA collapses.' },
  { d: '2022-06-13', scope: 'industry', w: 2, sectors: ['crypto'], h: 'Celsius freezes withdrawals; crypto lenders unravel.' },
  { d: '2022-11-08', scope: 'industry', w: 3, sectors: ['crypto'], h: 'FTX liquidity crisis: Binance offers to buy FTX, then walks away the next day.' },
  { d: '2022-11-11', scope: 'industry', w: 2, sectors: ['crypto'], h: 'FTX files for bankruptcy.' },
  { d: '2023-06-15', scope: 'industry', w: 2, sectors: ['crypto'], h: 'BlackRock files for a spot bitcoin ETF.' },
  { d: '2024-01-11', scope: 'industry', w: 3, sectors: ['crypto'], h: 'US spot bitcoin ETFs begin trading after SEC approval.' },
  { d: '2025-10-10', scope: 'industry', w: 3, sectors: ['crypto'], h: 'Record crypto liquidations after new US–China tariff threats.' },

  // ── Single coins and stocks ─────────────────────────────────────────────────
  { d: '2012-11-28', scope: 'ticker', w: 1, tickers: ['BTC'], h: 'First bitcoin halving.' },
  { d: '2016-06-17', scope: 'ticker', w: 2, tickers: ['ETH'], h: 'The DAO hack drains millions of ether.' },
  { d: '2016-07-09', scope: 'ticker', w: 1, tickers: ['BTC'], h: 'Second bitcoin halving.' },
  { d: '2020-05-11', scope: 'ticker', w: 1, tickers: ['BTC'], h: 'Third bitcoin halving.' },
  { d: '2021-01-28', scope: 'ticker', w: 3, tickers: ['GME', 'AMC'], h: 'Brokers restrict buying at the peak of the retail short squeeze.' },
  { d: '2022-09-15', scope: 'ticker', w: 2, tickers: ['ETH'], h: 'Ethereum completes the Merge to proof of stake.' },
  { d: '2024-04-20', scope: 'ticker', w: 1, tickers: ['BTC'], h: 'Fourth bitcoin halving.' },
  { d: '2024-07-23', scope: 'ticker', w: 2, tickers: ['ETH'], h: 'US spot ether ETFs begin trading.' },
];

/** Sectors of well-known tickers and sector ETFs, used when SEC industry codes are unavailable. */
export const TICKER_SECTORS: Record<string, Sector[]> = {
  ...Object.fromEntries(['NVDA', 'AMD', 'AVGO', 'INTC', 'TSM', 'MU', 'QCOM', 'ASML', 'ARM', 'TXN', 'AMAT', 'LRCX', 'KLAC', 'MRVL', 'SMH', 'SOXX', 'SOXL'].map((t) => [t, ['semis', 'tech']])),
  ...Object.fromEntries(['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'META', 'AMZN', 'NFLX', 'ORCL', 'CRM', 'ADBE', 'XLK', 'QQQ', 'VGT'].map((t) => [t, ['tech']])),
  ...Object.fromEntries(['JPM', 'BAC', 'C', 'WFC', 'GS', 'MS', 'SCHW', 'USB', 'PNC', 'TFC', 'KEY', 'ZION', 'WAL', 'PACW', 'XLF', 'KRE', 'KBE'].map((t) => [t, ['banks']])),
  ...Object.fromEntries(['XOM', 'CVX', 'COP', 'OXY', 'SLB', 'EOG', 'HAL', 'PSX', 'MPC', 'VLO', 'XLE', 'XOP', 'OIH', 'USO', 'BNO'].map((t) => [t, ['energy']])),
  ...Object.fromEntries(['DAL', 'UAL', 'AAL', 'LUV', 'JETS'].map((t) => [t, ['airlines']])),
  ...Object.fromEntries(['COIN', 'MSTR', 'MARA', 'RIOT', 'IBIT', 'GBTC', 'FBTC', 'BITO', 'ETHE'].map((t) => [t, ['crypto']])),
  ...Object.fromEntries(['GLD', 'IAU', 'GDX', 'GDXJ', 'NEM'].map((t) => [t, ['gold']])),
  ...Object.fromEntries(['TLT', 'IEF', 'SHY'].map((t) => [t, ['bonds']])),
  ...Object.fromEntries(['IBB', 'XBI'].map((t) => [t, ['biotech']])),
  ...Object.fromEntries(['TSLA', 'GM', 'F'].map((t) => [t, ['autos']])),
};

/** Map an SEC Standard Industrial Classification code onto our sectors. */
export function sectorsForSic(sic: number): Sector[] {
  if (!Number.isFinite(sic)) return [];
  if (sic === 3674) return ['semis', 'tech'];
  if ((sic >= 6020 && sic <= 6099) || sic === 6211) return ['banks'];
  if ((sic >= 1300 && sic <= 1399) || (sic >= 2900 && sic <= 2999)) return ['energy'];
  if ((sic >= 3570 && sic <= 3579) || (sic >= 3600 && sic <= 3699) || (sic >= 7370 && sic <= 7379)) return ['tech'];
  if (sic === 4512 || sic === 4513 || sic === 4522) return ['airlines'];
  if ((sic >= 2833 && sic <= 2836) || sic === 8731) return ['biotech'];
  if (sic === 3711 || sic === 3714) return ['autos'];
  if (sic >= 5200 && sic <= 5999) return ['retail'];
  if (sic === 1040) return ['gold'];
  return [];
}

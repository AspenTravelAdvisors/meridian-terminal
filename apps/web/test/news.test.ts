import { type Bar, type StudyResult, bucketEvents } from '@meridian/engine';
import { describe, expect, it } from 'vitest';
import { newsByBar, newsColumns } from '../src/chart/aux';
import { newsHeadlines, withNewsTips } from '../src/chart/news';
import type { NewsEventDto } from '../src/lib/api';
import type { StudyInstanceCfg } from '../src/state/types';

const DAY = 86_400_000;
const bars: Bar[] = [0, 1, 2, 3, 6, 7].map((d) => ({ t: Date.UTC(2023, 2, 6 + d, 14, 30), o: 1, h: 1, l: 1, c: 1, v: 1 }));
const ev = (day: number, hour: number, scope: NewsEventDto['scope'], weight: 1 | 2 | 3, headline: string): NewsEventDto => ({
  t: Date.UTC(2023, 2, day, hour),
  scope,
  weight,
  headline,
  source: 'meridian',
  precise: true,
});
// Mon 6 … Thu 9, then Mon 13, Tue 14 (a weekend gap)
const events = [ev(9, 15, 'industry', 3, 'Bank sell-off'), ev(10, 21, 'industry', 3, 'SVB closed'), ev(12, 22, 'market', 2, 'Deposit guarantee'), ev(9, 16, 'ticker', 1, 'Minor filing')];

describe('news aux', () => {
  it('builds one weight column per scope, placing weekend news on Monday', () => {
    const cols = newsColumns(bars, DAY, events);
    expect(cols.newsIndustry[3]).toBe(3); // Thu 9 15:00 lands in Thu bar (opens 14:30)
    // Fri 10 21:00 and Sun 12 22:00 fall in the gap → first bar that can react (Mon 13)
    expect(cols.newsIndustry[4]).toBe(3);
    expect(cols.newsMarket[4]).toBe(2);
    expect(cols.newsTicker[3]).toBe(1);
  });

  it('keeps the headlines on exactly the bars the engine columns use', () => {
    const by = newsByBar(bars, DAY, events);
    expect(Object.keys(by).map(Number).sort()).toEqual([3, 4]);
    for (const [i, list] of Object.entries(by))
      for (const e of list) expect(bucketEvents(bars, DAY, [{ t: e.t, v: 1 }])[Number(i)]).toBe(1);
  });

  it('lists headlines the study would accept, strongest first', () => {
    const by = newsByBar(bars, DAY, events);
    expect(newsHeadlines(by[3], { minWeight: 1, ticker: true, industry: true, market: true })).toEqual(['Industry ★★★ Bank sell-off', 'Company ★ Minor filing']);
    expect(newsHeadlines(by[3], { minWeight: 2 })).toEqual(['Industry ★★★ Bank sell-off']);
    expect(newsHeadlines(by[4], { minWeight: 1, market: false })).toEqual(['Industry ★★★ SVB closed']);
  });

  it('puts headlines in front of the News study marker tooltips only', () => {
    const marker = { i: 4, at: 4, text: 'IND+MKT', pos: 'above' as const, color: 'bear' as const, tooltip: 'Industry and market-wide news at a bearish price flip.' };
    const mk = (id: string): StudyResult => ({ id, len: 6, outputs: [], lines: {}, markers: [marker], signals: [], geometry: {}, status: null, provisional: false });
    const cfgs = [
      { uid: 'n1', id: 'news-events', cfg: {} },
      { uid: 's1', id: 'td-sequential', cfg: {} },
    ] as unknown as StudyInstanceCfg[];
    const out = withNewsTips([mk('n1'), mk('s1')], cfgs, newsByBar(bars, DAY, events));
    expect(out[0].markers[0].tooltip).toBe('Industry ★★★ SVB closed\nMarket ★★ Deposit guarantee\nIndustry and market-wide news at a bearish price flip.');
    expect(out[1].markers[0].tooltip).toBe(marker.tooltip);
  });
});

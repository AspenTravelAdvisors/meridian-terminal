import { type StudyResult, getStudy, resolveConfig } from '@meridian/engine';
import type { NewsEventDto } from '../lib/api';
import type { StudyInstanceCfg } from '../state/types';

const LABEL = { ticker: 'Company', industry: 'Industry', market: 'Market' } as const;

/** Headline lines for one bar, as the News study is configured (enabled scopes, minimum importance), strongest first. */
export function newsHeadlines(events: NewsEventDto[] | undefined, cfg: Record<string, unknown>): string[] {
  if (!events?.length) return [];
  const min = typeof cfg.minWeight === 'number' ? cfg.minWeight : 2;
  return events
    .filter((e) => cfg[e.scope] !== false && e.weight >= min)
    .sort((a, b) => b.weight - a.weight)
    .map((e) => `${LABEL[e.scope]} ${'★'.repeat(e.weight)} ${e.headline}`);
}

/**
 * The engine only sees event weights, so the News study's markers carry no headlines. Put the headlines of each marker's
 * bar in front of its tooltip (shown on hover and in the explain card).
 */
export function withNewsTips(results: StudyResult[], cfgs: StudyInstanceCfg[], notes: Record<number, NewsEventDto[]> | undefined): StudyResult[] {
  if (!notes) return results;
  const def = getStudy('news-events');
  if (!def) return results;
  const byUid = new Map(cfgs.filter((c) => c.id === 'news-events').map((c) => [c.uid, resolveConfig(def, c.cfg)]));
  if (!byUid.size) return results;
  return results.map((r) => {
    const cfg = byUid.get(r.id);
    if (!cfg || !r.markers.length) return r;
    return {
      ...r,
      markers: r.markers.map((m) => {
        const lines = newsHeadlines(notes[m.i], cfg);
        return lines.length ? { ...m, tooltip: [...lines, m.tooltip].filter(Boolean).join('\n') } : m;
      }),
    };
  });
}

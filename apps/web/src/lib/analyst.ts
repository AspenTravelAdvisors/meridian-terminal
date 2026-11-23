import { type AlertOp, alertPrice } from '@meridian/engine';
import type { Alert, AnalystLevel, AnalystRun, SavedAnalysis } from '../state/types';

/**
 * Pure helpers for the AI analyst: picking key levels out of the snapshot, the saved-briefing search, and keeping
 * price alerts that follow a key level in step with each new briefing. No clock, no store access.
 */

/** Status values named like price levels (TDST, risk levels, projections, stops…). */
export const LEVEL_KEY = /tdst|risk|target|proj|support|resist|stop|level/i;
/** …except counts such as the Exhaustion Zone's `buyLevels` (how many levels agree). */
const COUNT_KEY = /levels$|count$/i;

/**
 * Is a study status value a price level? Its name must say so, and it must sit on the chart's price scale (within 5×
 * of the last close either way), so counts and ratios never become "levels to watch" or alerts.
 */
export function isPriceLevel(key: string, value: unknown, lastClose?: number): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !LEVEL_KEY.test(key) || COUNT_KEY.test(key)) return false;
  if (lastClose === undefined || !Number.isFinite(lastClose) || lastClose <= 0) return true;
  const r = value / lastClose;
  return r >= 0.2 && r <= 5;
}

/** Levels from the snapshot's `levels` map, in a stable order. */
export function snapshotLevels(levels: Record<string, number | null | undefined>): AnalystLevel[] {
  return Object.entries(levels)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
    .map(([key, value]) => ({ key, value }));
}

/** An alert on a level fires when price reaches it: from below that is a cross above, from above a cross below. */
export function levelAlertOp(lastClose: number | undefined, level: number, fallback: AlertOp = 'crosses_above'): AlertOp {
  if (lastClose === undefined || !Number.isFinite(lastClose) || lastClose === level) return fallback;
  return lastClose < level ? 'crosses_above' : 'crosses_below';
}

export function levelAlertName(symbol: string, interval: string, key: string, op: AlertOp, value: number): string {
  return `${symbol} ${interval}: ${key} ${op.replace('_', ' ')} ${alertPrice(value)}`;
}

/** The alert to create for one level of a chart briefing (the caller adds it to the alerts store). */
export function levelAlert(run: Pick<AnalystRun, 'symbol' | 'interval' | 'lastClose' | 'createdAt'>, level: AnalystLevel): Omit<Alert, 'id' | 'createdAt' | 'enabled'> {
  if (!run.symbol || !run.interval) throw new Error('level alerts need a chart briefing');
  const op = levelAlertOp(run.lastClose, level.value);
  const name = levelAlertName(run.symbol, run.interval, level.key, op, level.value);
  return {
    name,
    symbol: run.symbol,
    interval: run.interval,
    condition: { kind: 'price', op, value: level.value },
    mode: 'every_bar',
    timing: 'close',
    channels: { app: true, browser: false },
    track: { source: 'analyst', key: level.key, autoName: name, updatedAt: run.createdAt },
  };
}

/** Does this alert follow `key` on the run's chart? */
export const tracksLevel = (a: Alert, run: Pick<AnalystRun, 'symbol' | 'interval'>, key?: string) =>
  a.track?.source === 'analyst' && a.condition.kind === 'price' && a.symbol === run.symbol && a.interval === run.interval && (key === undefined || a.track.key === key);

export interface LevelSync {
  patches: { id: string; patch: Partial<Alert> }[];
  /** alerts whose value or direction changed */
  updated: number;
  /** alerts whose level is missing from this briefing (kept at their last value) */
  stale: number;
  unchanged: number;
}

/**
 * Bring every alert that follows a level of this chart up to date with a finished chart briefing: new value, the
 * direction that makes the alert fire when price reaches the level, the generated name (unless the user renamed it),
 * and a re-arm stamp so a fired one-shot alert can fire on the new level. Levels missing from the briefing are kept and
 * flagged stale. Pause state is never changed.
 */
export function syncLevelAlerts(alerts: readonly Alert[], run: Pick<AnalystRun, 'kind' | 'symbol' | 'interval' | 'levels' | 'lastClose' | 'createdAt'>): LevelSync {
  const out: LevelSync = { patches: [], updated: 0, stale: 0, unchanged: 0 };
  if (run.kind !== 'chart' || !run.symbol || !run.interval) return out;
  const byKey = new Map(run.levels.map((l) => [l.key, l.value]));
  for (const a of alerts) {
    if (!tracksLevel(a, run) || a.condition.kind !== 'price' || !a.track) continue;
    const t = a.track;
    const value = byKey.get(t.key);
    if (value === undefined || !Number.isFinite(value)) {
      out.stale++;
      if (!t.stale) out.patches.push({ id: a.id, patch: { track: { ...t, stale: true } } });
      continue;
    }
    const op = levelAlertOp(run.lastClose, value, a.condition.op);
    if (value === a.condition.value && op === a.condition.op) {
      out.unchanged++;
      if (t.stale) out.patches.push({ id: a.id, patch: { track: { ...t, stale: undefined, updatedAt: run.createdAt } } });
      continue;
    }
    const autoName = levelAlertName(run.symbol, run.interval, t.key, op, value);
    out.updated++;
    out.patches.push({
      id: a.id,
      patch: {
        condition: { kind: 'price', op, value },
        name: a.name === t.autoName ? autoName : a.name,
        track: { ...t, autoName, updatedAt: run.createdAt, stale: undefined },
        rearmedAt: run.createdAt,
        lastError: undefined,
      },
    });
  }
  return out;
}

// ── Saved briefings ────────────────────────────────────────────────────────
export function analysisTitle(r: Pick<AnalystRun, 'kind' | 'symbol' | 'interval' | 'question'>): string {
  const head = r.kind === 'portfolio' ? 'Portfolio' : `${r.symbol ?? 'Chart'} ${r.interval ?? ''}`.trim();
  const q = r.question?.trim();
  return `${head} — ${q ? (q.length > 70 ? `${q.slice(0, 69)}…` : q) : 'Briefing'}`;
}

export function toSaved(r: AnalystRun, id: string, now: number): SavedAnalysis {
  return {
    id,
    title: analysisTitle(r),
    tags: [],
    kind: r.kind,
    symbol: r.symbol,
    interval: r.interval,
    question: r.question,
    text: r.text,
    engine: r.engine,
    levels: r.levels,
    lastClose: r.lastClose,
    simulated: r.simulated,
    createdAt: r.createdAt,
    updatedAt: now,
  };
}

/** Plain text of a briefing for searching and snippets (Markdown markers removed). */
export const plainText = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface SearchHit {
  item: SavedAnalysis;
  score: number;
  /** text around the first match in the briefing body (absent when only the title/metadata matched) */
  snippet?: string;
}

export interface ParsedQuery {
  words: string[];
  tags: string[];
  symbol?: string;
  kind?: SavedAnalysis['kind'];
}

/**
 * Query syntax: plain words must all appear (title, symbol, question, briefing text, tags, level names and values);
 * `#tag` requires a tag; `sym:AAPL` (or `symbol:`) a symbol; `kind:portfolio` / `kind:chart` a briefing type.
 */
export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { words: [], tags: [] };
  for (const raw of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('#') && raw.length > 1) out.tags.push(raw.slice(1));
    else if (/^(sym|symbol):./.test(raw)) out.symbol = raw.slice(raw.indexOf(':') + 1);
    else if (raw === 'kind:chart' || raw === 'kind:portfolio') out.kind = raw.slice(5) as ParsedQuery['kind'];
    else out.words.push(raw);
  }
  return out;
}

function snippetAround(text: string, words: string[], width = 160): string | undefined {
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return undefined;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Search the saved library. Every word must match somewhere; title, symbol and tag matches rank above body matches;
 * ties (and an empty query) list the newest briefing first. `scopeSymbol` limits results to one symbol.
 */
export function searchAnalyses(items: readonly SavedAnalysis[], q: string, scopeSymbol?: string): SearchHit[] {
  const pq = parseQuery(q);
  const hits: SearchHit[] = [];
  for (const it of items) {
    const sym = (it.symbol ?? '').toLowerCase();
    if (scopeSymbol && it.symbol !== scopeSymbol) continue;
    if (pq.symbol && sym !== pq.symbol) continue;
    if (pq.kind && it.kind !== pq.kind) continue;
    const tags = it.tags.map((t) => t.toLowerCase());
    if (!pq.tags.every((t) => tags.some((x) => x.startsWith(t)))) continue;
    const title = it.title.toLowerCase();
    const body = plainText(it.text);
    const bodyL = body.toLowerCase();
    const meta = [sym, it.interval ?? '', it.kind, it.question ?? '', ...tags, ...it.levels.flatMap((l) => [l.key, alertPrice(l.value)])].join(' ').toLowerCase();
    let score = pq.tags.length * 3 + (pq.symbol ? 3 : 0);
    let ok = true;
    for (const w of pq.words) {
      const s = (sym === w ? 6 : 0) + (title.includes(w) ? 4 : 0) + (tags.some((t) => t.startsWith(w)) ? 3 : 0) + (meta.includes(w) ? 2 : 0) + (bodyL.includes(w) ? 1 : 0);
      if (!s) {
        ok = false;
        break;
      }
      score += s;
    }
    if (!ok) continue;
    hits.push({ item: it, score, snippet: pq.words.length ? snippetAround(body, pq.words) : undefined });
  }
  return hits.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
}

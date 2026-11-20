import { NEWS_CALENDAR, type Sector, TICKER_SECTORS, sectorsForSic } from './newsCalendar';
import { cryptoBase, equityTicker } from './positioning';
import { getJson } from './providers/http';
import { zonedToEpoch } from './providers/equity';

export { NEWS_CALENDAR, TICKER_SECTORS, sectorsForSic, type CalendarEvent, type Sector } from './newsCalendar';

export type NewsScope = 'ticker' | 'industry' | 'market';

/** A dated, rated event that may move a symbol. */
export interface NewsEvent {
  /** epoch ms when the event became public (or, for day-precision events, mid-morning US time of the reacting day) */
  t: number;
  scope: NewsScope;
  /** 1 notable, 2 major, 3 landmark */
  weight: 1 | 2 | 3;
  headline: string;
  source: 'meridian' | 'sec';
  /** false when only the day is known */
  precise: boolean;
  url?: string;
}

export interface NewsFeed {
  symbol: string;
  events: NewsEvent[];
  sectors: Sector[];
  sources: string[];
  notes: string[];
}

/** Day-precision events sit at 15:00 UTC: inside the US session in summer and winter, and inside the crypto UTC day. */
const DAY_ANCHOR_MS = 15 * 3_600_000;

function calendarTime(d: string): { t: number; precise: boolean } {
  if (d.length > 10) return { t: Date.parse(d), precise: true };
  const [y, m, day] = d.split('-').map(Number);
  return { t: Date.UTC(y, m - 1, day) + DAY_ANCHOR_MS, precise: false };
}

/** Events from the built-in calendar that apply to a symbol. */
export function calendarEventsFor(symbol: string, sectors: readonly Sector[]): NewsEvent[] {
  const base = cryptoBase(symbol);
  const isCrypto = base !== null;
  const ticker = isCrypto ? base : equityTicker(symbol);
  const secs = new Set<Sector>(isCrypto ? ['crypto', ...sectors] : sectors);
  const out: NewsEvent[] = [];
  for (const e of NEWS_CALENDAR) {
    const applies =
      e.scope === 'market'
        ? !isCrypto || !!e.crypto
        : e.scope === 'industry'
          ? (e.sectors ?? []).some((s) => secs.has(s))
          : !!ticker && (e.tickers ?? []).includes(ticker);
    if (!applies) continue;
    const { t, precise } = calendarTime(e.d);
    out.push({ t, scope: e.scope, weight: e.w, headline: e.h, source: 'meridian', precise });
  }
  return out;
}

// ── SEC EDGAR 8-K filings ──────────────────────────────────────────────────────

/** 8-K items worth surfacing and how much they tend to matter. Items not listed (exhibits, votes) are ignored. */
export const EIGHT_K_ITEMS: Record<string, { w: 1 | 2 | 3; label: string }> = {
  '1.01': { w: 1, label: 'Material agreement' },
  '1.02': { w: 1, label: 'Material agreement ended' },
  '1.03': { w: 3, label: 'Bankruptcy or receivership' },
  '1.05': { w: 3, label: 'Material cybersecurity incident' },
  '2.01': { w: 2, label: 'Acquisition or sale completed' },
  '2.02': { w: 2, label: 'Earnings release' },
  '2.05': { w: 2, label: 'Restructuring or layoffs' },
  '2.06': { w: 2, label: 'Material impairment' },
  '3.01': { w: 3, label: 'Delisting notice or listing transfer' },
  '4.01': { w: 2, label: 'Auditor change' },
  '4.02': { w: 3, label: 'Past financial statements no longer reliable' },
  '5.01': { w: 3, label: 'Change in control' },
  '5.02': { w: 1, label: 'Director or officer change' },
  '7.01': { w: 1, label: 'Regulation FD disclosure' },
  '8.01': { w: 1, label: 'Other material event' },
};

interface SecColumns {
  accessionNumber: string[];
  filingDate: string[];
  acceptanceDateTime?: string[];
  form: string[];
  items?: string[];
  primaryDocument?: string[];
}

interface SecSubmissions {
  name?: string;
  sic?: string;
  sicDescription?: string;
  filings?: { recent?: SecColumns; files?: { name: string; filingFrom?: string; filingTo?: string }[] };
}

const SEC_WWW = 'https://www.sec.gov';
const SEC_DATA = 'https://data.sec.gov';
const DAY = 86_400_000;

let cikCache: { at: number; map: Map<string, number> } | null = null;

/** Test hook: forget the cached ticker → CIK table. */
export function resetSecCache(): void {
  cikCache = null;
}

async function cikFor(ticker: string, ua: string, fetcher: typeof fetch, now: number, signal?: AbortSignal): Promise<number | null> {
  if (!cikCache || now - cikCache.at > DAY) {
    const j = await getJson<Record<string, { cik_str: number; ticker: string }>>('sec', `${SEC_WWW}/files/company_tickers.json`, fetcher, {
      headers: { 'User-Agent': ua },
      timeoutMs: 10_000,
      signal,
    });
    const map = new Map<string, number>();
    for (const r of Object.values(j)) map.set(String(r.ticker).toUpperCase(), Number(r.cik_str));
    cikCache = { at: now, map };
  }
  const t = ticker.toUpperCase();
  return cikCache.map.get(t) ?? cikCache.map.get(t.replace(/\./g, '-')) ?? null;
}

/**
 * EDGAR reports `acceptanceDateTime` as US Eastern wall-clock time even though the string ends in "Z" (filings are only
 * accepted 06:00–22:00 Eastern, and the values fall in that range). Convert it to real UTC.
 */
export function secAcceptedAt(acceptance: string | undefined, filingDate: string): { t: number; precise: boolean } {
  const m = acceptance ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(acceptance) : null;
  if (m) return { t: zonedToEpoch(`${m[1]} ${m[2]}`, 'America/New_York'), precise: true };
  const [y, mo, d] = filingDate.split('-').map(Number);
  return { t: Date.UTC(y, mo - 1, d) + DAY_ANCHOR_MS, precise: false };
}

/** Rate an 8-K by its most important item; null when nothing in it is material. */
export function rateEightK(items: string): { weight: 1 | 2 | 3; labels: string[] } | null {
  const hits = items
    .split(',')
    .map((s) => s.trim())
    .map((k) => EIGHT_K_ITEMS[k])
    .filter((x): x is { w: 1 | 2 | 3; label: string } => !!x)
    .sort((a, b) => b.w - a.w);
  if (!hits.length) return null;
  return { weight: hits[0].w, labels: hits.map((h) => h.label) };
}

function eightKs(cols: SecColumns | undefined, cik: number, fromMs: number, toMs: number): NewsEvent[] {
  if (!cols) return [];
  const out: NewsEvent[] = [];
  for (let k = 0; k < cols.form.length; k++) {
    if (cols.form[k] !== '8-K') continue;
    const rated = rateEightK(cols.items?.[k] ?? '');
    if (!rated) continue;
    const { t, precise } = secAcceptedAt(cols.acceptanceDateTime?.[k], cols.filingDate[k]);
    if (t < fromMs || t > toMs) continue;
    const acc = cols.accessionNumber[k];
    const doc = cols.primaryDocument?.[k];
    out.push({
      t,
      scope: 'ticker',
      weight: rated.weight,
      headline: `8-K: ${rated.labels.join('; ')}`,
      source: 'sec',
      precise,
      url: doc ? `${SEC_WWW}/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${doc}` : undefined,
    });
  }
  return out;
}

/** Company 8-K events and SEC industry sectors for a US ticker. */
export async function fetchSecEvents(
  ticker: string,
  opts: { userAgent: string; fromMs: number; toMs: number; now: number; signal?: AbortSignal; maxOlderPages?: number },
  fetcher: typeof fetch,
): Promise<{ events: NewsEvent[]; sectors: Sector[]; name?: string } | null> {
  const cik = await cikFor(ticker, opts.userAgent, fetcher, opts.now, opts.signal);
  if (cik === null) return null;
  const headers = { 'User-Agent': opts.userAgent };
  const sub = await getJson<SecSubmissions>('sec', `${SEC_DATA}/submissions/CIK${String(cik).padStart(10, '0')}.json`, fetcher, { headers, timeoutMs: 10_000, signal: opts.signal });
  const events = eightKs(sub.filings?.recent, cik, opts.fromMs, opts.toMs);
  // older filings live in extra pages; fetch only those overlapping the chart, newest first
  const older = (sub.filings?.files ?? [])
    .filter((f) => !f.filingTo || Date.parse(f.filingTo) >= opts.fromMs)
    .sort((a, b) => (b.filingTo ?? '').localeCompare(a.filingTo ?? ''))
    .slice(0, opts.maxOlderPages ?? 2);
  for (const f of older) {
    try {
      const cols = await getJson<SecColumns>('sec', `${SEC_DATA}/submissions/${encodeURIComponent(f.name)}`, fetcher, { headers, timeoutMs: 10_000, signal: opts.signal });
      events.push(...eightKs(cols, cik, opts.fromMs, opts.toMs));
    } catch {
      /* older page unavailable: keep what we have */
    }
  }
  return { events, sectors: sectorsForSic(Number(sub.sic)), name: sub.name };
}

/**
 * Every rated event for a symbol between `fromMs` and `toMs`: the built-in calendar (market-wide, industry, coins) and,
 * for US stocks when `secUserAgent` is set, SEC 8-K filings. SEC asks automated clients to identify themselves with a
 * contact in the User-Agent, so filings are skipped without one.
 */
export async function fetchNews(
  symbol: string,
  opts: { fromMs?: number; toMs?: number; secUserAgent?: string; now?: number; signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<NewsFeed> {
  const now = opts.now ?? Date.now();
  const fromMs = opts.fromMs ?? 0;
  const toMs = opts.toMs ?? now;
  const notes: string[] = [];
  const sources = ['meridian'];
  const isExpr = /[/*+()]/.test(symbol) || /\s-\s/.test(symbol);
  const isCrypto = !isExpr && cryptoBase(symbol) !== null;
  const ticker = isExpr || isCrypto ? null : equityTicker(symbol);
  let sectors: Sector[] = ticker ? [...(TICKER_SECTORS[ticker] ?? [])] : [];
  const events: NewsEvent[] = [];

  if (isExpr) notes.push('Symbol expressions get market-wide events only.');
  else if (ticker) {
    if (!opts.secUserAgent) notes.push('Company filings are off: set SEC_USER_AGENT on the server (SEC requires a contact in the User-Agent).');
    else {
      try {
        const sec = await fetchSecEvents(ticker, { userAgent: opts.secUserAgent, fromMs, toMs, now, signal: opts.signal }, fetcher);
        if (sec) {
          events.push(...sec.events);
          if (!sectors.length) sectors = sec.sectors;
          sources.push('sec');
        } else notes.push(`${ticker} is not an SEC registrant; company filings unavailable.`);
      } catch (e) {
        notes.push(`SEC filings unavailable (${e instanceof Error ? e.message : String(e)}).`);
      }
    }
  }
  for (const e of calendarEventsFor(isExpr ? 'SPY' : symbol, sectors)) if (e.t >= fromMs && e.t <= toMs && !(isExpr && e.scope !== 'market')) events.push(e);
  events.sort((a, b) => a.t - b.t || b.weight - a.weight);
  return { symbol, events, sectors, sources, notes };
}

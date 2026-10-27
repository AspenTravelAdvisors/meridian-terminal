/**
 * Merge rules for synced stores, used when this device and the cloud both changed a store since the last sync, and
 * when a device signs in for the first time (its local data joins the account's). Collections are unioned by id so
 * nothing either side created is lost; for the same id the cloud copy wins unless noted. Single-value settings take
 * the cloud copy. Inputs are zustand persist envelopes: `{ state, version }`.
 */
export interface Envelope {
  state: Record<string, unknown>;
  version?: number;
}

type WithId = { id: string };
const arr = <T = WithId>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {});

/** Union by id, cloud order first, then local-only items; `pick` resolves an id present on both sides. */
export function unionById<T extends WithId>(remote: T[], local: T[], pick: (r: T, l: T) => T = (r) => r): T[] {
  const localById = new Map(local.map((x) => [x.id, x]));
  const out = remote.map((r) => (localById.has(r.id) ? pick(r, localById.get(r.id)!) : r));
  const seen = new Set(remote.map((r) => r.id));
  for (const l of local) if (!seen.has(l.id)) out.push(l);
  return out;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const newer = <T extends { updatedAt?: number }>(r: T, l: T) => ((l.updatedAt ?? 0) > (r.updatedAt ?? 0) ? l : r);

type Merger = (remote: Record<string, unknown>, local: Record<string, unknown>) => Record<string, unknown>;

const MERGERS: Record<string, Merger> = {
  'meridian.watchlists': (r, l) => ({
    ...r,
    lists: unionById(arr<{ id: string; name: string; symbols: string[] }>(r.lists), arr(l.lists), (a, b) => ({ ...a, symbols: uniq([...a.symbols, ...b.symbols]) })),
  }),
  'meridian.alerts': (r, l) => ({
    ...r,
    // keep the latest firing either side knows about, so neither side fires the same bar again
    alerts: unionById(arr<WithId & { lastFiredBar?: number; lastFiredAt?: number; rearmedAt?: number }>(r.alerts), arr(l.alerts), (a, b) => {
      const pick = (b.rearmedAt ?? 0) > (a.rearmedAt ?? 0) ? b : a;
      const fired = [a.lastFiredBar, b.lastFiredBar].filter((x): x is number => typeof x === 'number');
      return { ...pick, lastFiredBar: fired.length ? Math.max(...fired) : undefined, lastFiredAt: Math.max(a.lastFiredAt ?? 0, b.lastFiredAt ?? 0) || undefined };
    }),
    log: unionById(arr<WithId & { at: number }>(r.log), arr(l.log))
      .sort((a, b) => b.at - a.at)
      .slice(0, 500),
  }),
  'meridian.portfolio': (r, l) => ({
    ...r,
    accounts: unionById(arr(r.accounts), arr(l.accounts)),
    txs: unionById(arr(r.txs), arr(l.txs)),
    tags: { ...obj(l.tags), ...obj(r.tags) },
  }),
  'meridian.journal': (r, l) => ({ ...r, notes: unionById(arr<WithId & { createdAt: number }>(r.notes), arr(l.notes)).sort((a, b) => b.createdAt - a.createdAt) }),
  'meridian.scripts': (r, l) => ({ ...r, scripts: unionById(arr<WithId & { updatedAt?: number }>(r.scripts), arr(l.scripts), newer) }),
  'meridian.layouts': (r, l) => ({ ...r, layouts: unionById(arr(r.layouts), arr(l.layouts)), templates: unionById(arr(r.templates), arr(l.templates)) }),
  'meridian.drawings': (r, l) => {
    const rb = obj<WithId[]>(r.bySymbol);
    const lb = obj<WithId[]>(l.bySymbol);
    const bySymbol: Record<string, WithId[]> = {};
    for (const sym of uniq([...Object.keys(rb), ...Object.keys(lb)])) bySymbol[sym] = unionById(arr(rb[sym]), arr(lb[sym]));
    return { ...r, bySymbol };
  },
  'meridian.recents': (r, l) => ({ ...r, symbols: uniq([...arr<string>(r.symbols), ...arr<string>(l.symbols)]).slice(0, 12) }),
  'meridian.studyDefaults': (r, l) => ({ ...r, defaults: { ...obj(l.defaults), ...obj(r.defaults) }, favorites: uniq([...arr<string>(r.favorites), ...arr<string>(l.favorites)]) }),
  // workspace (chart grid, panes, dock) and settings: the cloud copy wins as a whole
};

export function mergeDoc(key: string, remote: Envelope, local: Envelope): Envelope {
  const m = MERGERS[key];
  if (!m) return remote;
  return { ...remote, state: m(obj(remote.state), obj(local.state)) };
}

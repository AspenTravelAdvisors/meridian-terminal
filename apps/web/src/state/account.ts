import { create } from 'zustand';
import { type AccountInfo, type AlertActivity, apiGet, apiPost, getAccount } from '../lib/account';
import { type Envelope, mergeDoc } from './merge';
import { SYNCED_STORES } from './store';

/**
 * Account + cloud sync. Each persisted store is mirrored to the account as one JSON document. The local copy stays
 * the working copy (the app keeps working offline); changes push a moment later, other devices' changes arrive on
 * focus and every 30 s. A document changed on both sides since the last sync is merged (state/merge.ts).
 */
type SyncKey = keyof typeof SYNCED_STORES;
const KEYS = Object.keys(SYNCED_STORES) as SyncKey[];
const META = 'meridian.sync.meta';

interface Meta {
  userId: string;
  /** server revision each local document was last synced at */
  revs: Partial<Record<SyncKey, number>>;
  /** hash of the localStorage string as last synced (detects local edits) */
  hashes: Partial<Record<SyncKey, string>>;
  /** server time of the last pull */
  since: number;
}

export interface AccountState {
  status: 'unknown' | 'unavailable' | 'signed-out' | 'signed-in';
  info: AccountInfo | null;
  sync: 'idle' | 'syncing' | 'error' | 'offline';
  lastSyncAt?: number;
  syncError?: string;
  /** server alert scheduler heartbeat (null = never ran) */
  scheduler: AlertActivity['scheduler'];
  /** a just-issued recovery code, shown until the user confirms saving it */
  recoveryCode?: string;
  refresh(): Promise<void>;
  set(p: Partial<AccountState>): void;
}

export const useAccount = create<AccountState>()((set) => ({
  status: 'unknown',
  info: null,
  sync: 'idle',
  scheduler: null,
  async refresh() {
    try {
      const info = await getAccount();
      set({ info, status: !info.configured ? 'unavailable' : info.user ? 'signed-in' : 'signed-out' });
      if (info.user) startSync(info.user.id);
      else stopSync();
    } catch {
      set({ status: 'unavailable' });
    }
  },
  set: (p) => set(p),
}));

/** cyrb53 — fast non-cryptographic string hash, only used to notice local changes */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const read = (): Meta | null => {
  try {
    return JSON.parse(localStorage.getItem(META) ?? 'null') as Meta | null;
  } catch {
    return null;
  }
};
const write = (m: Meta) => localStorage.setItem(META, JSON.stringify(m));

let meta: Meta | null = null;
let applying = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let unsubs: (() => void)[] = [];
let busy: Promise<void> | null = null;

interface RemoteDoc {
  key: SyncKey;
  rev: number;
  updatedAt: number;
  data: Envelope;
}

/** Write a document into localStorage and have its store reload from it, without echoing it back as a change. */
async function applyLocal(key: SyncKey, env: Envelope): Promise<string> {
  const text = JSON.stringify(env);
  applying = true;
  try {
    localStorage.setItem(key, text);
    await SYNCED_STORES[key].persist.rehydrate();
  } finally {
    applying = false;
  }
  return localStorage.getItem(key) ?? text;
}

/** Bring one server document in. Returns true if the merged result still has to be pushed. */
async function takeRemote(d: RemoteDoc, firstLink: boolean): Promise<boolean> {
  const m = meta!;
  if (!firstLink && d.rev <= (m.revs[d.key] ?? 0)) return false;
  const local = localStorage.getItem(d.key);
  const localChanged = local !== null && hash(local) !== m.hashes[d.key];
  m.revs[d.key] = d.rev;
  if (local !== null && (firstLink || localChanged)) {
    let parsed: Envelope;
    try {
      parsed = JSON.parse(local) as Envelope;
    } catch {
      parsed = d.data;
    }
    const merged = mergeDoc(d.key, d.data, parsed);
    const stored = await applyLocal(d.key, merged);
    const same = JSON.stringify(merged) === JSON.stringify(d.data);
    m.hashes[d.key] = same ? hash(stored) : 'dirty';
    return !same;
  }
  m.hashes[d.key] = hash(await applyLocal(d.key, d.data));
  return false;
}

async function pull(firstLink = false): Promise<void> {
  const m = meta!;
  // overlap the window a little; revisions make re-reads harmless
  const { docs, serverTime } = await apiGet<{ docs: RemoteDoc[]; serverTime: number }>(`/api/sync?since=${firstLink ? 0 : Math.max(0, m.since - 30_000)}`);
  let needPush = false;
  for (const d of docs) if (KEYS.includes(d.key)) needPush = (await takeRemote(d, firstLink)) || needPush;
  m.since = serverTime;
  write(m);
  if (needPush || firstLink) await push();
}

async function push(): Promise<void> {
  const m = meta!;
  for (let attempt = 0; attempt < 3; attempt++) {
    const dirty = KEYS.flatMap((key) => {
      const text = localStorage.getItem(key);
      return text !== null && hash(text) !== m.hashes[key] ? [{ key, text }] : [];
    });
    if (!dirty.length) return;
    const { results } = await apiPost<{ results: ({ key: SyncKey; ok: true; rev: number } | { key: SyncKey; ok: false; server: RemoteDoc | null })[] }>('/api/sync', {
      docs: dirty.map((d) => ({ key: d.key, baseRev: m.revs[d.key] ?? 0, data: JSON.parse(d.text) })),
    });
    let conflicts = false;
    for (const r of results) {
      const sent = dirty.find((d) => d.key === r.key)!;
      if (r.ok) {
        m.revs[r.key] = r.rev;
        m.hashes[r.key] = hash(sent.text);
      } else if (r.server) {
        conflicts = true;
        await takeRemote({ ...r.server, key: r.key }, false);
      } else {
        m.revs[r.key] = 0; // the server lost the document: create it again
        conflicts = true;
      }
    }
    write(m);
    if (!conflicts) return;
  }
}

/** Run one sync step at a time; report state to the UI. */
function run(step: () => Promise<void>): Promise<void> {
  const prev = busy ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      if (!meta) return;
      useAccount.getState().set({ sync: 'syncing' });
      try {
        await step();
        useAccount.getState().set({ sync: 'idle', lastSyncAt: Date.now(), syncError: undefined });
      } catch (e) {
        const offline = typeof navigator !== 'undefined' && !navigator.onLine;
        const status = (e as { status?: number }).status;
        if (status === 401) {
          stopSync();
          useAccount.getState().set({ status: 'signed-out', info: { ...useAccount.getState().info!, user: null } });
          return;
        }
        useAccount.getState().set({ sync: offline ? 'offline' : 'error', syncError: e instanceof Error ? e.message : String(e) });
      }
    });
  busy = next;
  return next;
}

export const syncNow = () => run(async () => {
  await push();
  await pull();
});

function schedulePush() {
  if (applying || !meta) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void run(push), 1500);
}

const onVisible = () => {
  if (document.visibilityState === 'visible') void run(() => pull());
  else if (pushTimer) {
    // leaving the page: flush pending edits now
    clearTimeout(pushTimer);
    pushTimer = null;
    void run(push);
  }
};
const onOnline = () => void syncNow();

export function startSync(userId: string): void {
  if (meta?.userId === userId && pullTimer) return;
  stopSync();
  const saved = read();
  const firstLink = !saved || saved.userId !== userId;
  meta = firstLink ? { userId, revs: {}, hashes: {}, since: 0 } : saved;
  unsubs = KEYS.map((k) => SYNCED_STORES[k].subscribe(schedulePush));
  document.addEventListener('visibilitychange', onVisible);
  addEventListener('online', onOnline);
  pullTimer = setInterval(() => document.visibilityState === 'visible' && void run(() => pull()), 30_000);
  void run(() => pull(firstLink));
}

export function stopSync(): void {
  unsubs.forEach((u) => u());
  unsubs = [];
  if (pullTimer) clearInterval(pullTimer);
  if (pushTimer) clearTimeout(pushTimer);
  pullTimer = pushTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
  removeEventListener('online', onOnline);
  meta = null;
}

/** Signing out keeps this device's data but forgets the link, so the next sign-in merges again. */
export function forgetSyncLink(): void {
  stopSync();
  localStorage.removeItem(META);
}

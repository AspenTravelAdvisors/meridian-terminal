import type { Interval, SymbolInfo } from '@meridian/data';
import { type Bar, type StudyResult, getStudy, resolveConfig } from '@meridian/engine';
import type { Account, Transaction } from '@meridian/portfolio';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  Alert,
  AlertLogEntry,
  Drawing,
  DrawingType,
  GridLayout,
  JournalNote,
  PaneConfig,
  SavedLayout,
  Settings,
  StudyInstanceCfg,
  StudyTemplate,
  UserScript,
} from './types';
import { GRID_LAYOUTS } from './types';

export const uid = (p = 'x') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const storage = createJSONStorage(() => localStorage);

// ── Per-study saved defaults & favourites ──────────────────────────────────
interface StudyDefaultsState {
  defaults: Record<string, Record<string, unknown>>;
  favorites: string[];
  setDefault(id: string, cfg: Record<string, unknown>): void;
  toggleFavorite(id: string): void;
}
export const useStudyDefaults = create<StudyDefaultsState>()(
  persist(
    (set, get) => ({
      defaults: {},
      favorites: ['td-sequential', 'td-combo', 'td-demarker-1', 'ichimoku'],
      setDefault: (id, cfg) => set({ defaults: { ...get().defaults, [id]: cfg } }),
      toggleFavorite: (id) => set({ favorites: get().favorites.includes(id) ? get().favorites.filter((f) => f !== id) : [...get().favorites, id] }),
    }),
    { name: 'meridian.studyDefaults', storage },
  ),
);

export function newStudy(id: string, cfg: Record<string, unknown> = {}): StudyInstanceCfg {
  const def = getStudy(id);
  const defaults = useStudyDefaults.getState().defaults[id] ?? {};
  return {
    uid: uid('s'),
    id,
    cfg: def ? resolveConfig(def, { ...defaults, ...cfg }) : cfg,
    style: {},
    visible: true,
    visibility: { minutes: true, hours: true, days: true, weeks: true, months: true },
  };
}

const defaultPane = (symbol = 'SPY', interval: Interval = '1D', studies?: StudyInstanceCfg[]): PaneConfig => ({
  id: uid('p'),
  symbol,
  interval,
  chartType: 'candles',
  studies: studies ?? [newStudy('td-sequential'), newStudy('volume'), newStudy('td-demarker-1')],
  linkGroup: null,
  scaleMode: 'normal',
  adjust: 'split',
  compare: [],
});

const EXTRA_INTERVALS: Interval[] = ['1W', '1h', '4h', '1M', '15m', '5m', '30m'];

// ── Workspace (chart grid + panes) ─────────────────────────────────────────
interface WorkspaceState {
  grid: GridLayout;
  panes: PaneConfig[];
  activePaneId: string;
  dock: unknown | null;
  setGrid(g: GridLayout): void;
  setActive(id: string): void;
  updatePane(id: string, patch: Partial<PaneConfig>): void;
  /** symbol/interval change that respects link groups */
  setSymbol(id: string, symbol: string): void;
  setInterval(id: string, interval: Interval): void;
  addStudy(paneId: string, studyId: string, cfg?: Record<string, unknown>): void;
  updateStudy(paneId: string, uidS: string, patch: Partial<StudyInstanceCfg>): void;
  removeStudy(paneId: string, uidS: string): void;
  setDock(d: unknown): void;
  applyLayout(l: SavedLayout): void;
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => {
      const first = defaultPane();
      const mapPane = (id: string, f: (p: PaneConfig) => PaneConfig) => set({ panes: get().panes.map((p) => (p.id === id ? f(p) : p)) });
      return {
        grid: '1',
        panes: [first],
        activePaneId: first.id,
        dock: null,
        setGrid(g) {
          const need = GRID_LAYOUTS.find((x) => x.id === g)!.count;
          const panes = get().panes.slice();
          const active = panes.find((p) => p.id === get().activePaneId) ?? panes[0];
          while (panes.length < need) panes.push({ ...defaultPane(active.symbol, EXTRA_INTERVALS[(panes.length - 1) % EXTRA_INTERVALS.length], active.studies.map((s) => ({ ...s, uid: uid('s') }))) });
          set({ grid: g, panes });
        },
        setActive: (id) => set({ activePaneId: id }),
        updatePane: (id, patch) => mapPane(id, (p) => ({ ...p, ...patch })),
        setSymbol(id, symbol) {
          const src = get().panes.find((p) => p.id === id);
          if (!src) return;
          const n = get().grid;
          const visible = new Set(get().panes.slice(0, GRID_LAYOUTS.find((x) => x.id === n)!.count).map((p) => p.id));
          set({ panes: get().panes.map((p) => (p.id === id || (src.linkGroup && p.linkGroup === src.linkGroup && visible.has(p.id)) ? { ...p, symbol } : p)) });
          useRecents.getState().push(symbol);
        },
        setInterval(id, interval) {
          const src = get().panes.find((p) => p.id === id);
          if (!src) return;
          const syncIv = useSettings.getState().syncInterval;
          set({ panes: get().panes.map((p) => (p.id === id || (syncIv && src.linkGroup && p.linkGroup === src.linkGroup) ? { ...p, interval } : p)) });
        },
        addStudy: (paneId, studyId, cfg) => mapPane(paneId, (p) => ({ ...p, studies: [...p.studies, newStudy(studyId, cfg)] })),
        updateStudy: (paneId, uidS, patch) => mapPane(paneId, (p) => ({ ...p, studies: p.studies.map((s) => (s.uid === uidS ? { ...s, ...patch } : s)) })),
        removeStudy: (paneId, uidS) => mapPane(paneId, (p) => ({ ...p, studies: p.studies.filter((s) => s.uid !== uidS) })),
        setDock: (d) => set({ dock: d }),
        applyLayout: (l) => set({ grid: l.grid, panes: structuredClone(l.panes), activePaneId: l.panes[0]?.id ?? get().activePaneId, dock: l.dock }),
      };
    },
    { name: 'meridian.workspace', storage, version: 1 },
  ),
);

export const activePane = (): PaneConfig => {
  const s = useWorkspace.getState();
  return s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0];
};

// ── Saved layouts & study templates ────────────────────────────────────────
interface LayoutsState {
  layouts: SavedLayout[];
  templates: StudyTemplate[];
  save(name: string): void;
  remove(id: string): void;
  saveTemplate(name: string, studies: StudyInstanceCfg[]): void;
  removeTemplate(id: string): void;
}
export const useLayouts = create<LayoutsState>()(
  persist(
    (set, get) => ({
      layouts: [],
      templates: [],
      save(name) {
        const w = useWorkspace.getState();
        const l: SavedLayout = { id: uid('l'), name, savedAt: Date.now(), grid: w.grid, panes: structuredClone(w.panes), dock: w.dock };
        set({ layouts: [...get().layouts.filter((x) => x.name !== name), l] });
      },
      remove: (id) => set({ layouts: get().layouts.filter((l) => l.id !== id) }),
      saveTemplate: (name, studies) => set({ templates: [...get().templates, { id: uid('t'), name, studies: studies.map(({ uid: _u, ...rest }) => rest) }] }),
      removeTemplate: (id) => set({ templates: get().templates.filter((t) => t.id !== id) }),
    }),
    { name: 'meridian.layouts', storage },
  ),
);

// ── Settings ───────────────────────────────────────────────────────────────
interface SettingsState extends Settings {
  set(patch: Partial<Settings>): void;
}
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      palette: 'standard',
      syncCrosshair: true,
      syncTime: false,
      syncInterval: false,
      magnet: 'weak',
      timezone: 'exchange',
      live: true,
      defaultAdjust: 'split',
      showHeatStrip: true,
      showLegendValues: true,
      hollowProvisional: true,
      confirmBeforeDelete: true,
      set: (patch) => set(patch),
    }),
    { name: 'meridian.settings', storage },
  ),
);

// ── Drawings (per symbol) with undo/redo ───────────────────────────────────
interface DrawingsState {
  bySymbol: Record<string, Drawing[]>;
  past: { symbol: string; drawings: Drawing[] }[];
  future: { symbol: string; drawings: Drawing[] }[];
  commit(symbol: string, next: Drawing[]): void;
  add(symbol: string, d: Omit<Drawing, 'id' | 'z' | 'locked' | 'hidden'> & Partial<Drawing>): Drawing;
  update(symbol: string, id: string, patch: Partial<Drawing>, record?: boolean): void;
  remove(symbol: string, id: string): void;
  clear(symbol: string): void;
  undo(): void;
  redo(): void;
}
export const useDrawings = create<DrawingsState>()(
  persist(
    (set, get) => ({
      bySymbol: {},
      past: [],
      future: [],
      commit(symbol, next) {
        const prev = get().bySymbol[symbol] ?? [];
        set({ bySymbol: { ...get().bySymbol, [symbol]: next }, past: [...get().past.slice(-99), { symbol, drawings: prev }], future: [] });
      },
      add(symbol, d) {
        const list = get().bySymbol[symbol] ?? [];
        const full: Drawing = { locked: false, hidden: false, z: list.length ? Math.max(...list.map((x) => x.z)) + 1 : 1, ...d, id: uid('d') } as Drawing;
        get().commit(symbol, [...list, full]);
        return full;
      },
      update(symbol, id, patch, record = true) {
        const list = get().bySymbol[symbol] ?? [];
        const next = list.map((d) => (d.id === id ? { ...d, ...patch } : d));
        if (record) get().commit(symbol, next);
        else set({ bySymbol: { ...get().bySymbol, [symbol]: next } });
      },
      remove: (symbol, id) => get().commit(symbol, (get().bySymbol[symbol] ?? []).filter((d) => d.id !== id)),
      clear: (symbol) => get().commit(symbol, []),
      undo() {
        const past = get().past.slice();
        const last = past.pop();
        if (!last) return;
        const cur = get().bySymbol[last.symbol] ?? [];
        set({ past, future: [...get().future, { symbol: last.symbol, drawings: cur }], bySymbol: { ...get().bySymbol, [last.symbol]: last.drawings } });
      },
      redo() {
        const future = get().future.slice();
        const next = future.pop();
        if (!next) return;
        const cur = get().bySymbol[next.symbol] ?? [];
        set({ future, past: [...get().past, { symbol: next.symbol, drawings: cur }], bySymbol: { ...get().bySymbol, [next.symbol]: next.drawings } });
      },
    }),
    { name: 'meridian.drawings', storage, partialize: (s) => ({ bySymbol: s.bySymbol }) as Partial<DrawingsState> },
  ),
);

// ── Watchlists & recents ───────────────────────────────────────────────────
interface WatchlistState {
  lists: { id: string; name: string; symbols: string[] }[];
  activeId: string;
  setActive(id: string): void;
  add(listId: string, symbol: string): void;
  remove(listId: string, symbol: string): void;
  move(listId: string, symbol: string, delta: number): void;
  create(name: string): void;
  rename(id: string, name: string): void;
  drop(id: string): void;
}
export const useWatchlists = create<WatchlistState>()(
  persist(
    (set, get) => ({
      lists: [
        { id: 'w1', name: 'Core', symbols: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'GLD', 'TLT', 'SIM:DEMO'] },
        { id: 'w2', name: 'Sectors', symbols: ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB', 'XLRE', 'XLC'] },
      ],
      activeId: 'w1',
      setActive: (id) => set({ activeId: id }),
      add: (listId, symbol) => set({ lists: get().lists.map((l) => (l.id === listId && !l.symbols.includes(symbol) ? { ...l, symbols: [...l.symbols, symbol] } : l)) }),
      remove: (listId, symbol) => set({ lists: get().lists.map((l) => (l.id === listId ? { ...l, symbols: l.symbols.filter((s) => s !== symbol) } : l)) }),
      move: (listId, symbol, delta) =>
        set({
          lists: get().lists.map((l) => {
            if (l.id !== listId) return l;
            const i = l.symbols.indexOf(symbol);
            const j = Math.max(0, Math.min(l.symbols.length - 1, i + delta));
            const s = l.symbols.slice();
            s.splice(i, 1);
            s.splice(j, 0, symbol);
            return { ...l, symbols: s };
          }),
        }),
      create: (name) => {
        const id = uid('w');
        set({ lists: [...get().lists, { id, name, symbols: [] }], activeId: id });
      },
      rename: (id, name) => set({ lists: get().lists.map((l) => (l.id === id ? { ...l, name } : l)) }),
      drop: (id) => set({ lists: get().lists.filter((l) => l.id !== id), activeId: get().lists[0]?.id ?? '' }),
    }),
    { name: 'meridian.watchlists', storage },
  ),
);

interface RecentsState {
  symbols: string[];
  push(s: string): void;
}
export const useRecents = create<RecentsState>()(
  persist((set, get) => ({ symbols: [], push: (s) => set({ symbols: [s, ...get().symbols.filter((x) => x !== s)].slice(0, 12) }) }), { name: 'meridian.recents', storage }),
);

// ── Alerts ─────────────────────────────────────────────────────────────────
interface AlertsState {
  alerts: Alert[];
  log: AlertLogEntry[];
  add(a: Omit<Alert, 'id' | 'createdAt' | 'enabled'>): void;
  update(id: string, patch: Partial<Alert>): void;
  remove(id: string): void;
  pushLog(e: Omit<AlertLogEntry, 'id'>): void;
  clearLog(): void;
}
export const useAlerts = create<AlertsState>()(
  persist(
    (set, get) => ({
      alerts: [],
      log: [],
      add: (a) => set({ alerts: [...get().alerts, { ...a, id: uid('a'), createdAt: Date.now(), enabled: true }] }),
      update: (id, patch) => set({ alerts: get().alerts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }),
      remove: (id) => set({ alerts: get().alerts.filter((a) => a.id !== id) }),
      pushLog: (e) => set({ log: [{ ...e, id: uid('e') }, ...get().log].slice(0, 500) }),
      clearLog: () => set({ log: [] }),
    }),
    { name: 'meridian.alerts', storage },
  ),
);

// ── Portfolio ──────────────────────────────────────────────────────────────
interface PortfolioState {
  accounts: Account[];
  txs: Transaction[];
  tags: Record<string, { sector?: string; assetClass?: string }>;
  addAccount(a: Omit<Account, 'id'>): string;
  updateAccount(id: string, patch: Partial<Account>): void;
  removeAccount(id: string): void;
  addTxs(txs: Transaction[]): void;
  updateTx(id: string, patch: Partial<Transaction>): void;
  removeTx(id: string): void;
  setTag(symbol: string, tag: { sector?: string; assetClass?: string }): void;
  loadSample(): void;
  reset(): void;
}
export const usePortfolio = create<PortfolioState>()(
  persist(
    (set, get) => ({
      accounts: [{ id: 'acct1', name: 'Brokerage', currency: 'USD', lotMethod: 'FIFO' }],
      txs: [],
      tags: {},
      addAccount(a) {
        const id = uid('acct');
        set({ accounts: [...get().accounts, { ...a, id }] });
        return id;
      },
      updateAccount: (id, patch) => set({ accounts: get().accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }),
      removeAccount: (id) => set({ accounts: get().accounts.filter((a) => a.id !== id), txs: get().txs.filter((t) => t.accountId !== id) }),
      addTxs: (txs) => set({ txs: [...get().txs, ...txs] }),
      updateTx: (id, patch) => set({ txs: get().txs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),
      removeTx: (id) => set({ txs: get().txs.filter((t) => t.id !== id) }),
      setTag: (symbol, tag) => set({ tags: { ...get().tags, [symbol]: { ...get().tags[symbol], ...tag } } }),
      loadSample() {
        const a = get().accounts[0]?.id ?? 'acct1';
        const mk = (date: string, type: Transaction['type'], extra: Partial<Transaction>): Transaction => ({ id: uid('t'), accountId: a, date, type, source: 'sample', ...extra });
        set({
          txs: [
            mk('2024-01-02', 'cash_in', { amount: 100000 }),
            mk('2024-01-03', 'buy', { symbol: 'SPY', qty: 60, price: 467.28, fee: 0 }),
            mk('2024-01-05', 'buy', { symbol: 'AAPL', qty: 80, price: 181.18, fee: 0 }),
            mk('2024-02-12', 'buy', { symbol: 'MSFT', qty: 40, price: 415.26, fee: 0 }),
            mk('2024-03-04', 'buy', { symbol: 'NVDA', qty: 150, price: 85.2, fee: 0 }),
            mk('2024-05-16', 'dividend', { symbol: 'AAPL', amount: 20 }),
            mk('2024-06-10', 'sell', { symbol: 'NVDA', qty: 50, price: 121.79, fee: 0 }),
            mk('2024-08-05', 'buy', { symbol: 'GLD', qty: 60, price: 220.5, fee: 0 }),
            mk('2025-01-10', 'buy', { symbol: 'TLT', qty: 70, price: 85.9, fee: 0 }),
          ],
        });
      },
      reset: () => set({ txs: [] }),
    }),
    { name: 'meridian.portfolio', storage },
  ),
);

// ── Journal & scripts ──────────────────────────────────────────────────────
interface JournalState {
  notes: JournalNote[];
  add(n: Omit<JournalNote, 'id' | 'createdAt'>): void;
  update(id: string, patch: Partial<JournalNote>): void;
  remove(id: string): void;
}
export const useJournal = create<JournalState>()(
  persist(
    (set, get) => ({
      notes: [],
      add: (n) => set({ notes: [{ ...n, id: uid('n'), createdAt: Date.now() }, ...get().notes] }),
      update: (id, patch) => set({ notes: get().notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }),
      remove: (id) => set({ notes: get().notes.filter((n) => n.id !== id) }),
    }),
    { name: 'meridian.journal', storage },
  ),
);

interface ScriptsState {
  scripts: UserScript[];
  activeId: string | null;
  save(s: Partial<UserScript> & { name: string; code: string }): string;
  remove(id: string): void;
  setActive(id: string | null): void;
}
export const useScripts = create<ScriptsState>()(
  persist(
    (set, get) => ({
      scripts: [],
      activeId: null,
      save(s) {
        const id = s.id ?? uid('sc');
        const existing = get().scripts.find((x) => x.id === id);
        const next: UserScript = { inputs: {}, ...existing, ...s, id, updatedAt: Date.now() } as UserScript;
        set({ scripts: existing ? get().scripts.map((x) => (x.id === id ? next : x)) : [...get().scripts, next], activeId: id });
        return id;
      },
      remove: (id) => set({ scripts: get().scripts.filter((s) => s.id !== id) }),
      setActive: (id) => set({ activeId: id }),
    }),
    { name: 'meridian.scripts', storage },
  ),
);

// ── Runtime (not persisted): live chart state shared with panels ──────────
export interface PaneRuntime {
  bars: Bar[];
  /** full series length (bars is the replay-truncated view while a replay is active) */
  totalBars?: number;
  info: SymbolInfo | null;
  results: StudyResult[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  provider?: string;
  simulated?: boolean;
  fallbacks?: string[];
  crosshairI: number | null;
  live: 'off' | 'stream' | 'poll';
  lastUpdate?: number;
  computeMs?: number;
}

export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone: 'info' | 'ok' | 'warn' | 'error';
  action?: { label: string; run: () => void };
}

interface UiState {
  runtime: Record<string, PaneRuntime>;
  tool: DrawingType | null;
  selectedDrawing: string | null;
  studiesOpen: boolean;
  studySettings: { paneId: string; uid: string } | null;
  symbolSearch: { open: boolean; initial: string; target: 'pane' | 'watchlist' | 'compare' };
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  paletteOpen: boolean;
  /** pane id whose Renko/Range box-size dialog is open */
  boxSizePane: string | null;
  replay: Record<string, { active: boolean; index: number; playing: boolean; speed: number; selecting: boolean }>;
  toasts: Toast[];
  focusBar: { paneId: string; t: number } | null;
  setRuntime(id: string, patch: Partial<PaneRuntime>): void;
  set(patch: Partial<Omit<UiState, 'set' | 'setRuntime' | 'toast' | 'dismiss'>>): void;
  toast(t: Omit<Toast, 'id'>): void;
  dismiss(id: string): void;
}

export const emptyRuntime = (): PaneRuntime => ({ bars: [], info: null, results: [], status: 'idle', crosshairI: null, live: 'off' });

export const useUi = create<UiState>()((set, get) => ({
  runtime: {},
  tool: null,
  selectedDrawing: null,
  studiesOpen: false,
  studySettings: null,
  symbolSearch: { open: false, initial: '', target: 'pane' },
  settingsOpen: false,
  shortcutsOpen: false,
  paletteOpen: false,
  boxSizePane: null,
  replay: {},
  toasts: [],
  focusBar: null,
  setRuntime: (id, patch) => set({ runtime: { ...get().runtime, [id]: { ...(get().runtime[id] ?? emptyRuntime()), ...patch } } }),
  set: (patch) => set(patch),
  toast(t) {
    const id = uid('toast');
    set({ toasts: [...get().toasts.slice(-4), { ...t, id }] });
    setTimeout(() => get().dismiss(id), t.tone === 'error' ? 9000 : 5000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

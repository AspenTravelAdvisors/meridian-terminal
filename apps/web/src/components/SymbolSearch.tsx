import { CURATED, type SymbolInfo, SYMBOL_RE } from '@meridian/data';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchClient } from '../lib/api';
import { activePane, useRecents, useUi, useWatchlists, useWorkspace } from '../state/store';
import { Modal } from './ui';

const TYPES = ['all', 'stock', 'etf', 'index', 'crypto', 'fx', 'future', 'sim'] as const;

export function SymbolSearch() {
  const st = useUi((s) => s.symbolSearch);
  const close = () => useUi.getState().set({ symbolSearch: { ...st, open: false } });
  const [q, setQ] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('all');
  // results are tagged with the query they answer, so a fast Enter never picks a stale list
  const [results, setResults] = useState<{ q: string; list: SymbolInfo[] }>({ q: '', list: [] });
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const recents = useRecents((s) => s.symbols);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (st.open) {
      setQ(st.initial);
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [st.open, st.initial]);

  useEffect(() => {
    if (!st.open) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        setResults({ q, list: await searchClient(q, ctrl.signal) });
      } finally {
        setLoading(false);
      }
    }, 140);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, st.open]);

  const list = useMemo(() => {
    const base = q.trim() ? (results.q === q ? results.list : []) : [...recents.map((r) => CURATED.find((c) => c.symbol === r) ?? ({ symbol: r, name: 'Recent', exchange: '', type: 'other' } as SymbolInfo)), ...CURATED.filter((c) => !recents.includes(c.symbol))];
    const raw = q.trim().toUpperCase();
    const typed = (type === 'all' ? base : base.filter((r) => r.type === type)).slice().sort((a, b) => Number(b.symbol === raw) - Number(a.symbol === raw));
    // allow entering any valid symbol directly (e.g. a ticker the search doesn't know)
    if (raw && SYMBOL_RE.test(raw) && !typed.some((r) => r.symbol === raw)) typed.push({ symbol: raw, name: 'Use symbol as typed', exchange: '', type: 'other', currency: '', calendar: 'NYSE', timezone: 'America/New_York', provider: 'yahoo' });
    return typed.slice(0, 40);
  }, [q, results, recents, type]);

  const pick = (s: SymbolInfo) => {
    const pane = activePane();
    if (st.target === 'compare') useWorkspace.getState().updatePane(pane.id, { compare: [...new Set([...pane.compare, s.symbol])].slice(0, 5) });
    else if (st.target === 'watchlist') {
      const wl = useWatchlists.getState();
      wl.add(wl.activeId, s.symbol);
    } else useWorkspace.getState().setSymbol(pane.id, s.symbol);
    close();
  };

  return (
    <Modal open={st.open} onOpenChange={(o) => !o && close()} title={st.target === 'compare' ? 'Compare symbol' : st.target === 'watchlist' ? 'Add to watchlist' : 'Symbol search'} width={620}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="size-4 text-dim" />
        <input
          ref={inputRef}
          className="h-8 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint mobile:text-[16px]"
          placeholder="Symbol, name, or PROVIDER:TICKER (BINANCE:BTCUSDT, SIM:DEMO)…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(list.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter' && list[sel]) pick(list[sel]);
          }}
          aria-label="Search symbols"
          role="combobox"
          aria-expanded
          aria-controls="symbol-results"
          aria-activedescendant={`sym-${sel}`}
        />
        {loading && <span className="text-[11px] text-faint">searching…</span>}
      </div>
      <div className="flex gap-1 border-b border-border px-3 py-1.5">
        {TYPES.map((t) => (
          <button key={t} className="btn-ghost h-6 px-2 capitalize" data-active={type === t} onClick={() => setType(t)}>
            {t === 'sim' ? 'simulated' : t}
          </button>
        ))}
      </div>
      <ul id="symbol-results" role="listbox" className="max-h-[52vh] overflow-auto py-1">
        {list.map((s, k) => (
          <li
            key={`${s.symbol}-${k}`}
            id={`sym-${k}`}
            role="option"
            aria-selected={k === sel}
            className={`flex cursor-pointer items-center gap-3 px-3 py-1.5 ${k === sel ? 'bg-raised' : 'hover:bg-raised/60'}`}
            onMouseEnter={() => setSel(k)}
            onClick={() => pick(s)}
          >
            <span className="w-40 shrink-0 truncate font-semibold">{s.symbol}</span>
            <span className="flex-1 truncate text-dim">{s.name}</span>
            <span className="text-[10px] uppercase text-faint">{s.type === 'sim' ? 'simulated' : s.type}</span>
            <span className="w-28 truncate text-right text-[11px] text-faint">
              {s.exchange}
              {s.currency && s.currency !== 'USD' && s.type !== 'crypto' ? ` · ${s.currency}` : ''}
            </span>
          </li>
        ))}
        {!list.length && <li className="px-3 py-6 text-center text-dim">No matches</li>}
      </ul>
    </Modal>
  );
}

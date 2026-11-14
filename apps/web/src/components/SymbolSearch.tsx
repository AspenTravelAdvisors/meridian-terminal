import { CURATED, ExpressionError, type SymbolInfo, SYMBOL_RE, isExpression, parseExpression, printExpression } from '@meridian/data';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchClient } from '../lib/api';
import { activePane, useRecents, useUi, useWatchlists, useWorkspace } from '../state/store';
import { Modal } from './ui';

const TYPES = ['all', 'stock', 'etf', 'index', 'crypto', 'fx', 'future', 'sim'] as const;

/** Coins Binance quotes against USDT. "ETH/BTC" means the crypto cross, not Yahoo's ETH and BTC (Grayscale ETFs). */
const COINS = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'TON', 'SHIB', 'BCH', 'NEAR', 'UNI', 'ATOM', 'XLM', 'APT', 'ARB', 'OP', 'SUI', 'PEPE']);
/** Quote assets Binance lists cross pairs in (ETHBTC, SOLETH, …). */
const CROSS_QUOTES = new Set(['BTC', 'ETH', 'BNB']);

const exprRow = (symbol: string, name: string): SymbolInfo => ({ symbol, name, exchange: 'Expression', type: 'other', currency: '', calendar: 'NYSE', timezone: 'America/New_York', provider: 'yahoo' });

/** Rows for a typed expression: the expression itself, plus the crypto readings of "ETH/BTC". */
export function expressionRows(raw: string): { rows: SymbolInfo[]; error?: string } {
  const pair = /^([A-Z0-9]{2,10})\s*\/\s*([A-Z0-9]{2,10})$/.exec(raw);
  const rows: SymbolInfo[] = [];
  if (pair && COINS.has(pair[1]) && COINS.has(pair[2])) {
    const [, a, b] = pair;
    if (CROSS_QUOTES.has(b)) rows.push({ ...exprRow(`BINANCE:${a}${b}`, `${a} priced in ${b} (Binance cross pair)`), exchange: 'Binance', type: 'crypto', calendar: '24x7', timezone: 'UTC', provider: 'binance' });
    rows.push(exprRow(`BINANCE:${a}USDT/BINANCE:${b}USDT`, `Ratio of ${a} and ${b} USDT prices`));
  }
  try {
    const canon = printExpression(parseExpression(raw));
    if (!rows.some((r) => r.symbol === canon)) rows.push(exprRow(canon, pair && rows.length ? 'Yahoo symbols as typed' : 'Ratio / spread chart'));
    return { rows };
  } catch (e) {
    return { rows, error: e instanceof ExpressionError ? e.message : String(e) };
  }
}

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
      // expressions are not searchable names: the rows come from the parser
      if (isExpression(q)) return setResults({ q, list: [] });
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

  const expr = useMemo(() => (isExpression(q) ? expressionRows(q.trim().toUpperCase()) : null), [q]);
  const list = useMemo(() => {
    if (expr) return expr.rows;
    const base = q.trim() ? (results.q === q ? results.list : []) : [...recents.map((r) => CURATED.find((c) => c.symbol === r) ?? ({ symbol: r, name: 'Recent', exchange: '', type: 'other' } as SymbolInfo)), ...CURATED.filter((c) => !recents.includes(c.symbol))];
    const raw = q.trim().toUpperCase();
    const typed = (type === 'all' ? base : base.filter((r) => r.type === type)).slice().sort((a, b) => Number(b.symbol === raw) - Number(a.symbol === raw));
    // allow entering any valid symbol directly (e.g. a ticker the search doesn't know)
    if (raw && SYMBOL_RE.test(raw) && !typed.some((r) => r.symbol === raw)) typed.push({ symbol: raw, name: 'Use symbol as typed', exchange: '', type: 'other', currency: '', calendar: 'NYSE', timezone: 'America/New_York', provider: 'yahoo' });
    return typed.slice(0, 40);
  }, [q, expr, results, recents, type]);

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
          placeholder="Symbol, name, PROVIDER:TICKER, or a ratio like SPY/RSP…"
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
        {expr?.error && <li className="px-3 py-3 text-warn" role="alert">{expr.error}</li>}
        {!list.length && !expr?.error && <li className="px-3 py-6 text-center text-dim">No matches</li>}
        {(expr || !q.trim()) && (
          <li className="border-t border-border px-3 py-2 text-[11px] text-faint">
            Ratio and spread charts: combine symbols with <b>/</b> <b>*</b> <b>+</b> <b>-</b> and parentheses, e.g. <b>SPY/RSP</b>, <b>ETHUSDT/BTCUSDT</b>, <b>(XLY + XLK)/2</b>. Put spaces around + and - (BRK-B stays a ticker).
          </li>
        )}
      </ul>
    </Modal>
  );
}

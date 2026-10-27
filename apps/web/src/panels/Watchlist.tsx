import { CURATED, parseSymbol } from '@meridian/data';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ListPlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import { fmtPct, fmtPrice } from '../lib/format';
import { activePane, useUi, useWatchlists, useWorkspace } from '../state/store';
import { Chip, Menu, MenuItem, MenuSep } from '../components/ui';
import { fetchMatrix, useQuotes } from './hooks';

export function WatchlistPanel() {
  const { lists, activeId, setActive, remove, move, create, rename, drop } = useWatchlists();
  const list = lists.find((l) => l.id === activeId) ?? lists[0];
  const symbols = list?.symbols ?? [];
  const quotes = useQuotes(symbols);
  const activeSym = useWorkspace((s) => s.panes.find((p) => p.id === s.activePaneId)?.symbol);
  // daily DeMark chip per row (server-side matrix, client fallback)
  const chips = useQuery({ queryKey: ['wl-chips', symbols.join(',')], queryFn: () => fetchMatrix(symbols, ['1D']), staleTime: 300_000, enabled: symbols.length > 0, retry: 0 });
  const chipOf = (s: string) => chips.data?.find((c) => c.symbol === s)?.cell;

  return (
    <div className="panel-body flex flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <select className="input h-6 flex-1" value={list?.id} onChange={(e) => setActive(e.target.value)} aria-label="Watchlist">
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.symbols.length})
            </option>
          ))}
        </select>
        <button className="icon-btn" title="Add symbol" aria-label="Add symbol" onClick={() => useUi.getState().set({ symbolSearch: { open: true, initial: '', target: 'watchlist' } })}>
          <Plus className="size-4" />
        </button>
        <Menu trigger={<button className="icon-btn" aria-label="Watchlist menu"><ListPlus className="size-4" /></button>} align="end">
          <MenuItem onSelect={() => { const n = prompt('New watchlist name'); if (n) create(n); }}>New list…</MenuItem>
          <MenuItem onSelect={() => { const n = prompt('Rename list', list?.name); if (n && list) rename(list.id, n); }}>
            <span className="flex items-center gap-1.5"><Pencil className="size-3" /> Rename…</span>
          </MenuItem>
          <MenuItem onSelect={() => { const p = activePane(); if (list) useWatchlists.getState().add(list.id, p.symbol); }}>Add active symbol</MenuItem>
          <MenuSep />
          <MenuItem disabled={lists.length < 2} onSelect={() => list && confirm(`Delete “${list.name}”?`) && drop(list.id)}>
            <span className="flex items-center gap-1.5 text-danger"><Trash2 className="size-3" /> Delete list</span>
          </MenuItem>
        </Menu>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="text-right">Last</th>
              <th className="text-right">Chg%</th>
              <th title="Daily DeMark-style Sequential / Combo state">D</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {symbols.map((s) => {
              const q = quotes.data?.[s];
              const chip = chipOf(s);
              const name = CURATED.find((c) => c.symbol === s)?.name;
              return (
                <tr key={s} className={`group cursor-pointer ${s === activeSym ? 'bg-raised/70' : ''}`} onClick={() => useWorkspace.getState().setSymbol(activePane().id, s)} title={name}>
                  <td className="max-w-28 truncate font-medium">
                    {s.replace(/^BINANCE:/, '')}
                    {parseSymbol(s).provider === 'sim' && <span className="ml-1 text-[9px] text-warn">SIM</span>}
                  </td>
                  <td className="text-right">{q ? fmtPrice(q.last) : quotes.isLoading ? '…' : '—'}</td>
                  <td className="text-right" style={{ color: q ? (q.changePct >= 0 ? 'var(--ok)' : 'var(--danger)') : undefined }}>{q ? fmtPct(q.changePct) : ''}</td>
                  <td>{chip && chip.label !== '·' ? <Chip text={chip.label.split(' ')[0]} dir={chip.dir} strength={Math.abs(chip.score)} /> : <span className="text-faint">·</span>}</td>
                  <td className="w-14 text-right">
                    <span className="invisible inline-flex group-hover:visible">
                      <button className="icon-btn size-5" aria-label="Move up" onClick={(e) => (e.stopPropagation(), move(list.id, s, -1))}><ArrowUp className="size-3" /></button>
                      <button className="icon-btn size-5" aria-label="Move down" onClick={(e) => (e.stopPropagation(), move(list.id, s, 1))}><ArrowDown className="size-3" /></button>
                      <button className="icon-btn size-5" aria-label={`Remove ${s}`} onClick={(e) => (e.stopPropagation(), remove(list.id, s))}><X className="size-3" /></button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!symbols.length && <p className="p-4 text-center text-dim">Empty list — press + to add symbols.</p>}
        {quotes.isError && <p className="px-3 py-2 text-[11px] text-warn">Quotes unavailable ({String((quotes.error as Error)?.message ?? '')}).</p>}
      </div>
    </div>
  );
}

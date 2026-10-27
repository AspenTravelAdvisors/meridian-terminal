import { CURATED, csvToBars, parseCsv } from '@meridian/data';
import {
  type ColumnMapping,
  LOT_METHODS,
  PRESETS,
  TX_TYPES,
  type Transaction,
  allocation,
  buildLedger,
  correlationMatrix,
  detectPreset,
  equityCurve,
  exportCsv,
  importRows,
  incomeByMonth,
  maxDrawdown,
  moneyWeightedReturn,
  positionSize,
  realizedSummary,
  returnsFromCloses,
  riskStats,
  splitHeader,
  valuePositions,
  type PriceHistory,
} from '@meridian/portfolio';
import { useQuery } from '@tanstack/react-query';
import { AreaSeries, ColorType, createChart, LineSeries, type UTCTimestamp } from 'lightweight-charts';
import { Download, FileUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { chartActions } from '../chart/bus';
import { readTheme } from '../chart/render';
import { Chip, Empty, Field, TabPanel, Tabs } from '../components/ui';
import { getBarsCached } from '../data/useBars';
import { download } from '../lib/download';
import { fmtMoney, fmtNum, fmtPct, fmtPrice } from '../lib/format';
import { uid, usePortfolio, useUi, useWorkspace } from '../state/store';
import { fetchMatrix, useActive, useQuotes } from './hooks';

const today = () => new Date().toISOString().slice(0, 10);

function useLedger() {
  const { accounts, txs } = usePortfolio();
  const [acct, setAcct] = useState<string>('all');
  const filtered = useMemo(() => (acct === 'all' ? txs : txs.filter((t) => t.accountId === acct)), [txs, acct]);
  const ledger = useMemo(() => buildLedger(accounts, filtered), [accounts, filtered]);
  return { ledger, accounts, txs: filtered, acct, setAcct };
}

export function PortfolioPanel() {
  const [tab, setTab] = useState('holdings');
  const L = useLedger();
  const empty = !usePortfolio((s) => s.txs.length);
  return (
    <div className="panel-body flex flex-col">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'holdings', label: 'Holdings' },
          { id: 'tx', label: 'Transactions' },
          { id: 'perf', label: 'Performance' },
          { id: 'income', label: 'Income' },
          { id: 'import', label: 'Import' },
          { id: 'sizing', label: 'Position sizing' },
          { id: 'accounts', label: 'Accounts' },
        ]}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-1">
          <select className="input h-6" value={L.acct} onChange={(e) => L.setAcct(e.target.value)} aria-label="Account filter">
            <option value="all">All accounts</option>
            {L.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {empty && (
            <button className="btn h-6" onClick={() => usePortfolio.getState().loadSample()}>
              Load sample portfolio
            </button>
          )}
          <span className="ml-auto text-[10px] text-faint">Stored locally in this browser · analysis, not advice</span>
        </div>
        <TabPanel value="holdings"><Holdings L={L} /></TabPanel>
        <TabPanel value="tx"><Transactions L={L} /></TabPanel>
        <TabPanel value="perf"><Performance L={L} /></TabPanel>
        <TabPanel value="income"><Income L={L} /></TabPanel>
        <TabPanel value="import"><ImportWizard /></TabPanel>
        <TabPanel value="sizing"><Sizing L={L} /></TabPanel>
        <TabPanel value="accounts"><Accounts /></TabPanel>
      </Tabs>
    </div>
  );
}

type LT = ReturnType<typeof useLedger>;

function Holdings({ L }: { L: LT }) {
  const syms = L.ledger.positions.map((p) => p.symbol);
  const quotes = useQuotes(syms);
  const status = useQuery({ queryKey: ['pf-status', syms.join(',')], queryFn: () => fetchMatrix(syms, ['1D', '1W', '1M']), enabled: syms.length > 0, staleTime: 300_000, retry: 0 });
  const v = valuePositions(L.ledger, quotes.data ?? {});
  const rs = realizedSummary(L.ledger);
  const tags = usePortfolio((s) => s.tags);
  const alloc = allocation(v.rows, (r) => tags[r.symbol]?.assetClass ?? CURATED.find((c) => c.symbol === r.symbol)?.type ?? 'other');
  if (!L.ledger.positions.length) return <Empty title="No open positions">Add transactions, import a broker CSV, or load the sample portfolio.</Empty>;
  const open = (symbol: string, iv?: '1D' | '1W' | '1M') => {
    const ws = useWorkspace.getState();
    ws.setSymbol(ws.activePaneId, symbol);
    if (iv) ws.setInterval(ws.activePaneId, iv);
    void chartActions;
  };
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-3 py-2 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="Market value" value={fmtMoney(v.invested)} />
        <Stat label="Cash" value={fmtMoney(v.cash)} />
        <Stat label="Unrealized" value={fmtMoney(v.rows.reduce((a, r) => a + r.unrealized, 0))} tone={v.rows.reduce((a, r) => a + r.unrealized, 0)} />
        <Stat label="Day change" value={fmtMoney(v.rows.reduce((a, r) => a + r.dayChange, 0))} tone={v.rows.reduce((a, r) => a + r.dayChange, 0)} />
        <Stat label="Realized ST / LT" value={`${fmtMoney(rs.short, 0)} / ${fmtMoney(rs.long, 0)}`} tone={rs.total} />
        <Stat label="Allocation" value={alloc.map((a) => `${a.key} ${Math.round(a.pct * 100)}%`).join(' · ')} />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Avg cost</th>
            <th className="text-right">Last</th>
            <th className="text-right">Value</th>
            <th className="text-right">Unrealized</th>
            <th className="text-right">Day</th>
            <th className="text-right">Weight</th>
            <th title="DeMark-style status on Daily / Weekly / Monthly — click a chip to open the chart">DeMark Status (D / W / M)</th>
          </tr>
        </thead>
        <tbody>
          {v.rows.map((r) => (
            <tr key={r.symbol}>
              <td><button className="font-medium hover:text-accent" onClick={() => open(r.symbol)}>{r.symbol}</button></td>
              <td className="text-right">{fmtNum(r.qty, 4).replace(/\.?0+$/, '')}</td>
              <td className="text-right">{fmtPrice(r.avgCost)}</td>
              <td className="text-right">{quotes.data?.[r.symbol] ? fmtPrice(r.last) : <span className="text-faint" title="No quote — valued at cost">{fmtPrice(r.last)}*</span>}</td>
              <td className="text-right">{fmtMoney(r.value, 0)}</td>
              <td className="text-right" style={{ color: r.unrealized >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtMoney(r.unrealized, 0)} ({fmtPct(r.unrealizedPct, 1)})</td>
              <td className="text-right" style={{ color: r.dayChange >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtPct(r.dayChangePct)}</td>
              <td className="text-right">{(r.weight * 100).toFixed(1)}%</td>
              <td>
                <div className="flex flex-wrap gap-1">
                  {(['1D', '1W', '1M'] as const).map((iv) => {
                    const c = status.data?.find((x) => x.symbol === r.symbol && x.interval === iv)?.cell;
                    if (!c) return <span key={iv} className="text-faint">{status.isLoading ? '…' : '·'}</span>;
                    return <Chip key={iv} text={`${iv.replace('1', '')}: ${c.label}`} dir={c.dir} strength={Math.abs(c.score)} onClick={() => open(r.symbol, iv)} title={`Open ${r.symbol} on ${iv}`} />;
                  })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {L.ledger.warnings.length > 0 && <div className="px-3 py-2 text-[11px] text-warn">{L.ledger.warnings.slice(0, 5).map((w) => <div key={w}>⚠ {w}</div>)}</div>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className="truncate font-semibold tabular-nums" style={{ color: tone === undefined ? undefined : tone >= 0 ? 'var(--ok)' : 'var(--danger)' }} title={value}>{value}</div>
    </div>
  );
}

function Transactions({ L }: { L: LT }) {
  const pf = usePortfolio();
  const [draft, setDraft] = useState<Partial<Transaction>>({ date: today(), type: 'buy', accountId: pf.accounts[0]?.id });
  const add = () => {
    if (!draft.accountId || !draft.date || !draft.type) return;
    pf.addTxs([{ ...(draft as Transaction), id: uid('t'), symbol: draft.symbol?.toUpperCase(), source: 'manual' }]);
    setDraft({ ...draft, qty: undefined, price: undefined, amount: undefined, fee: undefined });
  };
  const n = (v: string) => (v === '' ? undefined : Number(v));
  const sorted = L.txs.slice().sort((a, b) => b.date.localeCompare(a.date));
  const lots = L.ledger.lots.filter((l) => l.symbol === draft.symbol?.toUpperCase());
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2 border-b border-border p-3">
        <Field label="Date"><input className="input" type="date" value={draft.date ?? ''} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></Field>
        <Field label="Type">
          <select className="input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Transaction['type'] })}>
            {TX_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Account">
          <select className="input" value={draft.accountId} onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}>
            {pf.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Symbol"><input className="input w-24" value={draft.symbol ?? ''} onChange={(e) => setDraft({ ...draft, symbol: e.target.value })} /></Field>
        <Field label="Qty"><input className="input w-20" type="number" step="any" value={draft.qty ?? ''} onChange={(e) => setDraft({ ...draft, qty: n(e.target.value) })} /></Field>
        <Field label="Price"><input className="input w-24" type="number" step="any" value={draft.price ?? ''} onChange={(e) => setDraft({ ...draft, price: n(e.target.value) })} /></Field>
        <Field label="Fee"><input className="input w-16" type="number" step="any" value={draft.fee ?? ''} onChange={(e) => setDraft({ ...draft, fee: n(e.target.value) })} /></Field>
        <Field label="Amount"><input className="input w-24" type="number" step="any" value={draft.amount ?? ''} onChange={(e) => setDraft({ ...draft, amount: n(e.target.value) })} /></Field>
        {draft.type === 'split' && <Field label="Ratio (new/old)"><input className="input w-20" type="number" step="any" value={draft.ratio ?? ''} onChange={(e) => setDraft({ ...draft, ratio: n(e.target.value) })} /></Field>}
        {draft.type === 'sell' && lots.length > 0 && (
          <Field label="Specific lot">
            <select className="input" value={draft.lotId ?? ''} onChange={(e) => setDraft({ ...draft, lotId: e.target.value || undefined })}>
              <option value="">(account method)</option>
              {lots.map((l) => <option key={l.id} value={l.id}>{l.openDate} · {l.qty} @ {fmtPrice(l.cost)}</option>)}
            </select>
          </Field>
        )}
        <button className="btn btn-primary" onClick={add}><Plus className="size-3.5" /> Add</button>
        <button className="btn ml-auto" onClick={() => download('meridian-transactions.csv', exportCsv(pf.txs), 'text/csv')} disabled={!pf.txs.length}><Download className="size-3.5" /> Export CSV</button>
      </div>
      <table className="table">
        <thead>
          <tr><th>Date</th><th>Type</th><th>Symbol</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">Fee</th><th className="text-right">Amount</th><th>Account</th><th>Source</th><th /></tr>
        </thead>
        <tbody>
          {sorted.map((t) => (
            <tr key={t.id}>
              <td>{t.date}</td>
              <td>{t.type}</td>
              <td>{t.symbol ?? ''}</td>
              <td className="text-right">{t.qty ?? ''}</td>
              <td className="text-right">{t.price !== undefined ? fmtPrice(t.price) : ''}</td>
              <td className="text-right">{t.fee ?? ''}</td>
              <td className="text-right">{t.amount !== undefined ? fmtMoney(t.amount) : ''}{t.ratio ? ` ×${t.ratio}` : ''}</td>
              <td>{pf.accounts.find((a) => a.id === t.accountId)?.name}</td>
              <td className="text-faint">{t.source}</td>
              <td><button className="icon-btn" aria-label="Delete transaction" onClick={() => pf.removeTx(t.id)}><Trash2 className="size-3.5" /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!sorted.length && <Empty title="No transactions" />}
    </div>
  );
}

function usePriceHistory(symbols: string[], from: string | null) {
  return useQuery({
    queryKey: ['pf-hist', symbols.join(','), from],
    enabled: !!from && symbols.length > 0,
    staleTime: 600_000,
    retry: 0,
    queryFn: async () => {
      const days = Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 30;
      const limit = Math.min(5000, Math.max(60, Math.ceil(days * 0.72)));
      const out: PriceHistory = {};
      const missing: string[] = [];
      await Promise.all(
        symbols.map(async (s) => {
          try {
            const bars = await getBarsCached(s, '1D', limit, 600_000);
            out[s] = Object.fromEntries(bars.map((b) => [new Date(b.t).toISOString().slice(0, 10), b.c]));
          } catch {
            missing.push(s);
          }
        }),
      );
      return { prices: out, missing };
    },
  });
}

function MiniChart({ series }: { series: { name: string; color: string; points: { date: string; value: number }[] }[] }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const t = readTheme();
    const chart = createChart(el.current, { autoSize: true, layout: { background: { type: ColorType.Solid, color: t.panel }, textColor: t.text, attributionLogo: true }, grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } }, rightPriceScale: { borderColor: t.border }, timeScale: { borderColor: t.border } });
    series.forEach((s, k) => {
      const ser = k === 0 ? chart.addSeries(AreaSeries, { lineColor: s.color, topColor: `${s.color}55`, bottomColor: `${s.color}05`, lineWidth: 2, title: s.name }) : chart.addSeries(LineSeries, { color: s.color, lineWidth: 1, title: s.name });
      ser.setData(s.points.map((p) => ({ time: (Date.parse(`${p.date}T00:00:00Z`) / 1000) as UTCTimestamp, value: p.value })));
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series]);
  return <div ref={el} className="h-56 w-full" />;
}

function Performance({ L }: { L: LT }) {
  const syms = useMemo(() => [...new Set(L.txs.map((t) => t.symbol?.toUpperCase()).filter((s): s is string => !!s))], [L.txs]);
  const from = L.txs.length ? L.txs.reduce((m, t) => (t.date < m ? t.date : m), L.txs[0].date) : null;
  const hist = usePriceHistory([...syms, 'SPY'], from);
  const res = useMemo(() => {
    if (!hist.data || !L.txs.length) return null;
    const { points, mode } = equityCurve(L.txs, hist.data.prices, today());
    const values = points.map((p) => p.value);
    const rets = points.slice(1).map((p) => p.ret);
    const dates = points.map((p) => p.date);
    const bench = returnsFromCloses(hist.data.prices.SPY ?? {}, dates);
    const align = bench.length === rets.length ? bench : undefined;
    const risk = riskStats(rets, { bench: align, periodsPerYear: 365 });
    const corr = correlationMatrix(Object.fromEntries(syms.filter((s) => hist.data!.prices[s]).map((s) => [s, returnsFromCloses(hist.data!.prices[s], dates)])));
    const spy0 = points.find((p) => hist.data!.prices.SPY?.[p.date] !== undefined);
    return { points, mode, mdd: maxDrawdown(values), risk, mwr: moneyWeightedReturn(points), corr, spy0 };
  }, [hist.data, L.txs, syms]);
  if (!L.txs.length) return <Empty title="No transactions to analyse" />;
  if (hist.isLoading) return <p className="p-3 text-faint">Loading price history…</p>;
  if (!res || !res.points.length) return <Empty title="No price history available" />;
  const last = res.points[res.points.length - 1];
  const twr = last.twr - 1;
  const spySeries = (() => {
    const px = hist.data?.prices.SPY;
    if (!px || !res.spy0) return [];
    const base = px[res.spy0.date];
    let lastPx = base;
    return res.points.map((p) => {
      if (px[p.date] !== undefined) lastPx = px[p.date];
      return { date: p.date, value: lastPx / base };
    });
  })();
  return (
    <div className="p-3">
      <div className="mb-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="TWR (cumulative)" value={fmtPct(twr * 100)} tone={twr} />
        <Stat label="MWR (XIRR, ann.)" value={Number.isFinite(res.mwr) ? fmtPct(res.mwr * 100) : '—'} tone={res.mwr} />
        <Stat label="Max drawdown" value={fmtPct(res.mdd.mdd * 100)} tone={-1} />
        <Stat label="Volatility (ann.)" value={fmtPct(res.risk.vol * 100)} />
        <Stat label="Sharpe" value={fmtNum(res.risk.sharpe)} />
        <Stat label="Sortino" value={fmtNum(res.risk.sortino)} />
        <Stat label="Beta vs SPY" value={fmtNum(res.risk.beta)} />
        <Stat label="VaR 95% (1d)" value={Number.isFinite(res.risk.var95) ? fmtPct(-res.risk.var95 * 100) : '—'} tone={-1} />
      </div>
      <MiniChart series={[{ name: 'Portfolio (TWR)', color: '#38bdf8', points: res.points.map((p) => ({ date: p.date, value: p.twr })) }, ...(spySeries.length ? [{ name: 'SPY', color: '#f59e0b', points: spySeries }] : [])]} />
      <p className="mt-1 text-[10px] text-faint">
        {res.mode === 'securities' ? 'No cash deposits recorded — returns cover securities only (buys/sells treated as external flows).' : 'Cash-tracked: deposits/withdrawals are external flows.'} Prices carried forward over non-trading days. {hist.data?.missing.length ? `Missing history: ${hist.data.missing.join(', ')} (valued at trade price).` : ''}
      </p>
      {res.corr.keys.length > 1 && (
        <div className="mt-3">
          <div className="section-title px-0">Correlation of daily returns</div>
          <table className="text-[11px]">
            <thead>
              <tr>
                <th />
                {res.corr.keys.map((k) => <th key={k} className="px-1.5 text-faint">{k}</th>)}
              </tr>
            </thead>
            <tbody>
              {res.corr.keys.map((a, i) => (
                <tr key={a}>
                  <td className="pr-2 text-faint">{a}</td>
                  {res.corr.m[i].map((v, j) => (
                    <td key={j} className="px-1.5 py-0.5 text-center tabular-nums" style={{ background: Number.isFinite(v) ? `color-mix(in srgb, ${v >= 0 ? 'var(--accent)' : 'var(--danger)'} ${Math.round(Math.abs(v) * 55)}%, transparent)` : undefined }}>
                      {Number.isFinite(v) ? v.toFixed(2) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Income({ L }: { L: LT }) {
  const months = incomeByMonth(L.ledger);
  if (!months.length) return <Empty title="No dividends or interest recorded" />;
  const max = Math.max(...months.map((m) => m.amount));
  const total = months.reduce((a, m) => a + m.amount, 0);
  return (
    <div className="p-3">
      <div className="mb-2 font-semibold">Total income: {fmtMoney(total)}</div>
      <div className="flex h-32 items-end gap-1 border-b border-border">
        {months.map((m) => (
          <div key={m.month} className="flex flex-1 flex-col items-center gap-1" title={`${m.month}: ${fmtMoney(m.amount)}\n${m.items.map((i) => `${i.date} ${i.symbol ?? ''} ${fmtMoney(i.amount)}`).join('\n')}`}>
            <div className="w-full max-w-8 rounded-t bg-ok/70" style={{ height: `${(100 * m.amount) / max}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1 text-[9px] text-faint">
        {months.map((m) => <div key={m.month} className="flex-1 truncate text-center">{m.month.slice(2)}</div>)}
      </div>
    </div>
  );
}

function ImportWizard() {
  const pf = usePortfolio();
  const [raw, setRaw] = useState<{ header: string[]; rows: string[][]; name: string } | null>(null);
  const [map, setMap] = useState<ColumnMapping>({ date: '' });
  const [preset, setPreset] = useState<string>('');
  const [acct, setAcct] = useState(pf.accounts[0]?.id ?? '');
  const onFile = async (f: File) => {
    const text = await f.text();
    const rows = parseCsv(text);
    const probe = splitHeader(rows);
    const det = detectPreset(probe.header) ?? PRESETS.find((p) => p.headerContains && rows.some((r) => r.includes(p.headerContains!))) ?? null;
    const sh = splitHeader(rows, det?.headerContains);
    setRaw({ ...sh, name: f.name });
    if (det) {
      setPreset(det.id);
      setMap(det.map);
    } else {
      setPreset('');
      const h = sh.header.map((x) => x.toLowerCase());
      const find = (...n: string[]) => sh.header[h.findIndex((x) => n.some((k) => x.includes(k)))] ?? undefined;
      setMap({ date: find('date') ?? '', action: find('action', 'type', 'activity', 'description'), symbol: find('symbol', 'ticker', 'instrument'), qty: find('quantity', 'qty', 'shares'), price: find('price'), fee: [find('fee', 'commission')].filter(Boolean) as string[], amount: find('amount', 'net', 'total') });
    }
    // a bare OHLCV file is not a transaction export — offer to open it as a chart instead
    const asBars = csvToBars(text);
    if (asBars.bars.length > 20 && !det && !find2(sh.header, ['action', 'quantity', 'qty']))
      useUi.getState().toast({ title: 'This looks like price data (OHLCV), not transactions', body: 'Use it for golden fixtures or charts via the data tools; the transaction mapping below is still available.', tone: 'info' });
  };
  const preview = useMemo(() => (raw && map.date ? importRows(raw.header, raw.rows, map, acct, pf.txs, preset || 'csv') : null), [raw, map, acct, pf.txs, preset]);
  const col = (k: keyof ColumnMapping, label: string) => (
    <Field label={label}>
      <select className="input" value={(k === 'fee' ? map.fee?.[0] : (map[k] as string | undefined)) ?? ''} onChange={(e) => setMap({ ...map, [k]: k === 'fee' ? (e.target.value ? [e.target.value] : []) : e.target.value || undefined })}>
        <option value="">—</option>
        {raw?.header.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </Field>
  );
  return (
    <div className="p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="btn cursor-pointer">
          <FileUp className="size-3.5" /> Choose CSV…
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        <span className="text-dim">{raw ? `${raw.name}: ${raw.rows.length} rows` : 'Schwab, Fidelity, IBKR (Flex), Robinhood and Meridian exports are detected; anything else maps manually.'}</span>
      </div>
      {raw && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            <Field label="Preset">
              <select className="input" value={preset} onChange={(e) => { setPreset(e.target.value); const p = PRESETS.find((x) => x.id === e.target.value); if (p) setMap(p.map); }}>
                <option value="">Generic</option>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            {col('date', 'Date *')}
            {col('action', 'Action / type')}
            {col('symbol', 'Symbol')}
            {col('qty', 'Quantity')}
            {col('price', 'Price')}
            {col('fee', 'Fee')}
            {col('amount', 'Amount')}
            <Field label="Into account">
              <select className="input" value={acct} onChange={(e) => setAcct(e.target.value)}>
                {pf.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Date order">
              <select className="input" value={map.dateOrder ?? 'auto'} onChange={(e) => setMap({ ...map, dateOrder: e.target.value as ColumnMapping['dateOrder'] })}>
                <option value="auto">auto</option>
                <option value="mdy">MM/DD/YYYY</option>
                <option value="dmy">DD/MM/YYYY</option>
              </select>
            </Field>
          </div>
          {preview && (
            <div className="mt-3">
              <div className="mb-1 flex items-center gap-3">
                <span><b>{preview.transactions.length}</b> new · <span className="text-dim">{preview.duplicates} duplicates skipped · {preview.skipped.length} rows not recognized</span></span>
                <button className="btn btn-primary" disabled={!preview.transactions.length} onClick={() => { pf.addTxs(preview.transactions); useUi.getState().toast({ title: `Imported ${preview.transactions.length} transactions`, tone: 'ok' }); setRaw(null); }}>
                  Import
                </button>
              </div>
              <p className="mb-1 text-[10px] text-faint">Preset mappings are best-effort — check the preview against your statement before importing.</p>
              <table className="table">
                <thead><tr><th>Date</th><th>Type</th><th>Symbol</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">Fee</th><th className="text-right">Amount</th></tr></thead>
                <tbody>
                  {preview.transactions.slice(0, 25).map((t) => (
                    <tr key={t.id}><td>{t.date}</td><td>{t.type}</td><td>{t.symbol}</td><td className="text-right">{t.qty}</td><td className="text-right">{t.price}</td><td className="text-right">{t.fee}</td><td className="text-right">{t.amount}</td></tr>
                  ))}
                </tbody>
              </table>
              {preview.skipped.length > 0 && (
                <details className="mt-2 text-[11px] text-dim">
                  <summary>Unrecognized rows</summary>
                  {preview.skipped.slice(0, 30).map((s) => <div key={s.row}>row {s.row}: {s.reason} — <span className="text-faint">{s.raw.join(' | ').slice(0, 120)}</span></div>)}
                </details>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
const find2 = (h: string[], keys: string[]) => h.some((x) => keys.some((k) => x.toLowerCase().includes(k)));

function Sizing({ L }: { L: LT }) {
  const { pane, rt } = useActive();
  const quotes = useQuotes(L.ledger.positions.map((p) => p.symbol));
  const equity = valuePositions(L.ledger, quotes.data ?? {}).total || 100_000;
  const last = rt.bars[rt.bars.length - 1]?.c ?? 0;
  const seq = rt.results.find((r) => pane.studies.find((s) => s.uid === r.id)?.id === 'td-sequential');
  const v = (seq?.status?.values ?? {}) as Record<string, number | null>;
  const levels = [
    ['TDST support', v.tdstSupport],
    ['TDST resistance', v.tdstResistance],
    ['Buy setup risk', v.buyRisk],
    ['Sell setup risk', v.sellRisk],
  ].filter((x): x is [string, number] => typeof x[1] === 'number');
  const [eq, setEq] = useState<number | ''>('');
  const [risk, setRisk] = useState(1);
  const [entry, setEntry] = useState<number | ''>('');
  const [stop, setStop] = useState<number | ''>('');
  const [maxPos, setMaxPos] = useState(20);
  const E = eq === '' ? equity : eq;
  const en = entry === '' ? last : entry;
  const st = stop === '' ? (levels.find(([, x]) => x < en)?.[1] ?? en * 0.95) : stop;
  const r = positionSize({ equity: E, riskPct: risk, entry: en, stop: st, maxPositionPct: maxPos });
  return (
    <div className="grid grid-cols-1 gap-4 p-3 md:grid-cols-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Equity" hint={eq === '' ? 'from portfolio value' : undefined}><input className="input" type="number" value={eq === '' ? Math.round(equity) : eq} onChange={(e) => setEq(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
        <Field label="Risk per trade (%)"><input className="input" type="number" step="0.1" value={risk} onChange={(e) => setRisk(Number(e.target.value))} /></Field>
        <Field label={`Entry (${pane.symbol})`} hint={entry === '' ? 'last price' : undefined}><input className="input" type="number" step="any" value={entry === '' ? en : entry} onChange={(e) => setEntry(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
        <Field label="Stop" hint={stop === '' ? 'nearest TD level below entry (or −5%)' : undefined}><input className="input" type="number" step="any" value={stop === '' ? Number(st.toFixed(4)) : stop} onChange={(e) => setStop(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
        <Field label="Max position (% equity)"><input className="input" type="number" value={maxPos} onChange={(e) => setMaxPos(Number(e.target.value))} /></Field>
        <div className="col-span-2 flex flex-wrap gap-1">
          {levels.map(([k, x]) => <button key={k} className="btn h-6" onClick={() => setStop(Number(x.toFixed(4)))}>{k}: {fmtPrice(x)}</button>)}
          {!levels.length && <span className="text-[11px] text-faint">Add DeMark-style Sequential to the chart to use its TDST / risk levels as stops.</span>}
        </div>
      </div>
      <div className="rounded-md border border-border p-3">
        <div className="text-[22px] font-semibold tabular-nums">{r.shares.toLocaleString()} <span className="text-[13px] font-normal text-dim">shares ({r.dir})</span></div>
        <dl className="mt-2 grid grid-cols-2 gap-1 text-[12px]">
          <dt className="text-dim">Risk per share</dt><dd className="m-0 text-right">{fmtPrice(r.riskPerShare)}</dd>
          <dt className="text-dim">Capital at risk</dt><dd className="m-0 text-right">{fmtMoney(r.riskAmount)}</dd>
          <dt className="text-dim">Position value</dt><dd className="m-0 text-right">{fmtMoney(r.positionValue)}</dd>
          <dt className="text-dim">% of equity</dt><dd className="m-0 text-right">{r.pctOfEquity.toFixed(1)}%{r.capped ? ' (capped)' : ''}</dd>
        </dl>
        <p className="mt-2 text-[10px] text-faint">Sizing arithmetic only — not a recommendation to trade.</p>
      </div>
    </div>
  );
}

function Accounts() {
  const pf = usePortfolio();
  return (
    <div className="p-3">
      <table className="table">
        <thead><tr><th>Name</th><th>Broker</th><th>Lot method</th><th>Transactions</th><th /></tr></thead>
        <tbody>
          {pf.accounts.map((a) => (
            <tr key={a.id}>
              <td><input className="input h-6" value={a.name} onChange={(e) => pf.updateAccount(a.id, { name: e.target.value })} aria-label="Account name" /></td>
              <td><input className="input h-6" value={a.broker ?? ''} onChange={(e) => pf.updateAccount(a.id, { broker: e.target.value })} aria-label="Broker" /></td>
              <td>
                <select className="input h-6" value={a.lotMethod} onChange={(e) => pf.updateAccount(a.id, { lotMethod: e.target.value as (typeof LOT_METHODS)[number] })}>
                  {LOT_METHODS.map((m) => <option key={m}>{m}</option>)}
                </select>
              </td>
              <td>{pf.txs.filter((t) => t.accountId === a.id).length}</td>
              <td><button className="icon-btn" disabled={pf.accounts.length < 2} aria-label="Delete account" onClick={() => confirm(`Delete account ${a.name} and its transactions?`) && pf.removeAccount(a.id)}><Trash2 className="size-3.5" /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex gap-2">
        <button className="btn" onClick={() => pf.addAccount({ name: `Account ${pf.accounts.length + 1}`, currency: 'USD', lotMethod: 'FIFO' })}><Plus className="size-3.5" /> Add account</button>
        <button className="btn text-danger" disabled={!pf.txs.length} onClick={() => confirm('Delete all transactions?') && pf.reset()}>Clear transactions</button>
      </div>
    </div>
  );
}

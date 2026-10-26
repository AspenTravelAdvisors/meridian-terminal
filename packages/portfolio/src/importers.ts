import type { Transaction, TxType } from './types';

/**
 * Broker CSV import. Presets are best-effort mappings of each broker's commonly seen export headers —
 * always review the preview; the generic mapping wizard covers anything else.
 */
export interface ColumnMapping {
  date: string;
  action?: string; // free-text action/description → type via keyword rules
  type?: string; // already-normalized type column
  symbol?: string;
  qty?: string;
  price?: string;
  fee?: string[];
  amount?: string;
  /** date format hint */
  dateOrder?: 'auto' | 'mdy' | 'dmy';
}

export interface BrokerPreset {
  id: string;
  name: string;
  /** headers that identify the format (lower-case, all must be present) */
  detect: string[];
  map: ColumnMapping;
  /** some exports carry preamble lines before the header */
  headerContains?: string;
}

export const PRESETS: BrokerPreset[] = [
  { id: 'schwab', name: 'Charles Schwab', detect: ['date', 'action', 'symbol', 'quantity', 'price', 'fees & comm', 'amount'], map: { date: 'Date', action: 'Action', symbol: 'Symbol', qty: 'Quantity', price: 'Price', fee: ['Fees & Comm'], amount: 'Amount', dateOrder: 'mdy' } },
  {
    id: 'fidelity',
    name: 'Fidelity',
    detect: ['run date', 'action', 'symbol', 'quantity'],
    headerContains: 'Run Date',
    map: { date: 'Run Date', action: 'Action', symbol: 'Symbol', qty: 'Quantity', price: 'Price ($)', fee: ['Commission ($)', 'Fees ($)'], amount: 'Amount ($)', dateOrder: 'mdy' },
  },
  { id: 'ibkr', name: 'Interactive Brokers (Flex trades)', detect: ['symbol', 'tradedate', 'quantity', 'tradeprice'], map: { date: 'TradeDate', action: 'Buy/Sell', symbol: 'Symbol', qty: 'Quantity', price: 'TradePrice', fee: ['IBCommission'], amount: 'Proceeds' } },
  {
    id: 'robinhood',
    name: 'Robinhood',
    detect: ['activity date', 'instrument', 'trans code', 'quantity', 'price', 'amount'],
    map: { date: 'Activity Date', action: 'Trans Code', symbol: 'Instrument', qty: 'Quantity', price: 'Price', amount: 'Amount', dateOrder: 'mdy' },
  },
  { id: 'meridian', name: 'Meridian export', detect: ['date', 'type', 'symbol', 'qty', 'price'], map: { date: 'date', type: 'type', symbol: 'symbol', qty: 'qty', price: 'price', fee: ['fee'], amount: 'amount' } },
];

export function detectPreset(header: string[]): BrokerPreset | null {
  const h = new Set(header.map((x) => x.trim().toLowerCase()));
  return PRESETS.find((p) => p.detect.every((d) => h.has(d))) ?? null;
}

/** Map free-text broker actions to a transaction type. Order matters (reinvest before dividend). */
export function classifyAction(action: string, qty: number, amount: number): TxType | null {
  const a = action.toLowerCase();
  if (/split|spl\b/.test(a)) return 'split';
  if (/reinvest/.test(a) && qty > 0) return 'buy';
  if (/\b(buy|bought|bot)\b|^b$/.test(a)) return 'buy';
  if (/\b(sell|sold|sld)\b|^s$/.test(a)) return 'sell';
  if (/div|cdiv|distribution/.test(a)) return 'dividend';
  if (/interest|\bint\b/.test(a)) return 'interest';
  if (/fee|commission|adr\s*fee|\bgold\b/.test(a)) return 'fee';
  if (/transfer.*(in|received)|acat.*in|journal.*in/.test(a) && qty > 0) return 'transfer_in';
  if (/transfer.*out|acat.*out/.test(a) && qty > 0) return 'transfer_out';
  if (/deposit|ach|eft|wire|moneylink|contribution|transfer|journal/.test(a)) return amount >= 0 ? 'cash_in' : 'cash_out';
  if (/withdraw/.test(a)) return 'cash_out';
  return null;
}

export interface ImportResult {
  transactions: Transaction[];
  skipped: { row: number; reason: string; raw: string[] }[];
  duplicates: number;
}

const num = (s: string | undefined) => {
  if (s === undefined) return NaN;
  let v = s.trim().replace(/[$\s]/g, '');
  if (!v || v === '--') return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(v)) {
    neg = true;
    v = v.slice(1, -1);
  }
  const n = Number(v.replace(/,/g, ''));
  return neg ? -n : n;
};

function isoDate(s: string, order: 'auto' | 'mdy' | 'dmy' = 'auto'): string | null {
  const v = s.trim().split(/\s+as of\s+/i)[0].trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(v);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const a = +m[1];
    const b = +m[2];
    const dmy = order === 'dmy' || (order === 'auto' && a > 12);
    const [mo, d] = dmy ? [b, a] : [a, b];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Stable fingerprint used to drop duplicates when the same file (or overlapping files) is imported twice. */
export const txFingerprint = (t: Pick<Transaction, 'accountId' | 'date' | 'type' | 'symbol' | 'qty' | 'price' | 'amount'>) =>
  [t.accountId, t.date, t.type, t.symbol ?? '', (t.qty ?? 0).toFixed(6), (t.price ?? 0).toFixed(6), (t.amount ?? 0).toFixed(2)].join('|');

let seq = 0;
const newId = (prefix: string, row: number) => `${prefix}-${row}-${(++seq).toString(36)}`;

export function importRows(
  header: string[],
  rows: string[][],
  map: ColumnMapping,
  accountId: string,
  existing: Transaction[] = [],
  source = 'csv',
): ImportResult {
  const idx = (name?: string) => (name ? header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase()) : -1);
  const iDate = idx(map.date);
  const iAct = idx(map.action);
  const iType = idx(map.type);
  const iSym = idx(map.symbol);
  const iQty = idx(map.qty);
  const iPx = idx(map.price);
  const iAmt = idx(map.amount);
  const iFees = (map.fee ?? []).map(idx).filter((k) => k >= 0);
  const seen = new Set(existing.map(txFingerprint));
  const out: Transaction[] = [];
  const skipped: ImportResult['skipped'] = [];
  let duplicates = 0;
  rows.forEach((r, k) => {
    const date = iDate >= 0 ? isoDate(r[iDate] ?? '', map.dateOrder) : null;
    if (!date) return skipped.push({ row: k + 2, reason: 'unreadable date', raw: r });
    const qtyRaw = iQty >= 0 ? num(r[iQty]) : NaN;
    const amtRaw = iAmt >= 0 ? num(r[iAmt]) : NaN;
    const qty = Math.abs(qtyRaw);
    let type: TxType | null = null;
    if (iType >= 0) type = (r[iType]?.trim().toLowerCase() as TxType) || null;
    else if (iAct >= 0) type = classifyAction(r[iAct] ?? '', Number.isFinite(qtyRaw) ? qtyRaw : 0, Number.isFinite(amtRaw) ? amtRaw : 0);
    if (!type && Number.isFinite(qtyRaw) && qtyRaw !== 0) type = qtyRaw > 0 ? 'buy' : 'sell';
    if (!type) return skipped.push({ row: k + 2, reason: `unrecognized action "${r[iAct] ?? ''}"`, raw: r });
    const symbol = iSym >= 0 ? r[iSym]?.trim().toUpperCase().replace(/\s+/g, '') || undefined : undefined;
    const price = iPx >= 0 ? Math.abs(num(r[iPx])) : NaN;
    const fee = iFees.reduce((a, j) => a + (Math.abs(num(r[j])) || 0), 0);
    const tx: Transaction = { id: newId(source, k + 2), accountId, date, type, source };
    if (symbol) tx.symbol = symbol;
    if (Number.isFinite(qty) && qty > 0) tx.qty = qty;
    if (Number.isFinite(price) && price > 0) tx.price = price;
    if (Number.isFinite(amtRaw)) tx.amount = Math.abs(amtRaw);
    if (fee > 0) tx.fee = fee;
    if ((type === 'buy' || type === 'sell') && (!tx.symbol || !tx.qty)) return skipped.push({ row: k + 2, reason: 'trade without symbol/quantity', raw: r });
    if ((type === 'buy' || type === 'sell') && !tx.price && tx.amount && tx.qty) tx.price = Math.max(0, (tx.amount - (type === 'buy' ? fee : -fee)) / tx.qty);
    if (type === 'split') {
      // brokers usually report the share delta of a split; convert to a ratio later in the review step
      tx.note = `split row: ${r.join(' | ')}`.slice(0, 500);
    }
    const fp = txFingerprint(tx);
    if (seen.has(fp)) {
      duplicates++;
      return;
    }
    seen.add(fp);
    out.push(tx);
  });
  return { transactions: out, skipped, duplicates };
}

/** Find the header row (some exports have a preamble) and return header + data rows. */
export function splitHeader(rows: string[][], contains?: string): { header: string[]; rows: string[][] } {
  let h = 0;
  if (contains) {
    const k = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === contains.toLowerCase()));
    if (k >= 0) h = k;
  } else {
    const k = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 4);
    if (k >= 0) h = k;
  }
  const header = rows[h] ?? [];
  const data = rows.slice(h + 1).filter((r) => r.length >= Math.min(3, header.length) && r.some((c) => c.trim()));
  return { header, rows: data };
}

/** Meridian CSV export (round-trips through the "Meridian export" preset). */
export function exportCsv(txs: Transaction[]): string {
  const cols = ['date', 'type', 'symbol', 'qty', 'price', 'fee', 'amount', 'ratio', 'accountId', 'note'] as const;
  const esc = (v: unknown) => {
    const s = v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...txs.map((t) => cols.map((c) => esc(t[c])).join(','))].join('\n');
}

import type { Account, Ledger, Lot, LotMethod, Position, Realized, Transaction } from './types';

const DAY = 86_400_000;
const toT = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Long-term when held MORE than one year (sold after the one-year anniversary of the purchase). */
export function holdingTerm(openDate: string, closeDate: string): 'short' | 'long' {
  const o = new Date(toT(openDate));
  const anniversary = Date.UTC(o.getUTCFullYear() + 1, o.getUTCMonth(), o.getUTCDate());
  return toT(closeDate) > anniversary ? 'long' : 'short';
}

function pickOrder(lots: Lot[], method: LotMethod): Lot[] {
  const open = lots.filter((l) => l.qty > 1e-12);
  switch (method) {
    case 'LIFO':
      return open.sort((a, b) => b.openDate.localeCompare(a.openDate) || b.id.localeCompare(a.id));
    case 'HIFO':
      return open.sort((a, b) => b.cost - a.cost || a.openDate.localeCompare(b.openDate));
    default:
      return open.sort((a, b) => a.openDate.localeCompare(b.openDate) || a.id.localeCompare(b.id));
  }
}

/** Replay transactions (date order, stable) into lots, realized gains, income, cash and positions. */
export function buildLedger(accounts: Account[], txs: Transaction[]): Ledger {
  const method = new Map(accounts.map((a) => [a.id, a.lotMethod]));
  const lots: Lot[] = [];
  const realized: Realized[] = [];
  const income: Ledger['income'] = [];
  const cash: Record<string, number> = Object.fromEntries(accounts.map((a) => [a.id, 0]));
  const flows: Ledger['flows'] = [];
  const warnings: string[] = [];
  let fees = 0;
  const sorted = txs.map((t, k) => ({ t, k })).sort((a, b) => a.t.date.localeCompare(b.t.date) || a.k - b.k);

  for (const { t } of sorted) {
    const acct = t.accountId;
    cash[acct] ??= 0;
    const sym = t.symbol?.toUpperCase();
    const fee = t.fee ?? 0;
    fees += fee;
    switch (t.type) {
      case 'buy': {
        if (!sym || !t.qty || t.price === undefined) {
          warnings.push(`${t.date} buy ${t.id}: missing symbol/qty/price`);
          break;
        }
        lots.push({ id: t.id, accountId: acct, symbol: sym, openDate: t.date, qty: t.qty, cost: (t.qty * t.price + fee) / t.qty });
        cash[acct] -= t.qty * t.price + fee;
        break;
      }
      case 'sell':
      case 'transfer_out': {
        if (!sym || !t.qty) {
          warnings.push(`${t.date} ${t.type} ${t.id}: missing symbol/qty`);
          break;
        }
        const mine = lots.filter((l) => l.accountId === acct && l.symbol === sym);
        let order: Lot[];
        const m = method.get(acct) ?? 'FIFO';
        if (m === 'SPECIFIC' && t.lotId) {
          const chosen = mine.find((l) => l.id === t.lotId);
          order = chosen ? [chosen, ...pickOrder(mine.filter((l) => l !== chosen), 'FIFO')] : pickOrder(mine, 'FIFO');
          if (!chosen) warnings.push(`${t.date} sell ${t.id}: lot ${t.lotId} not found, used FIFO`);
        } else order = pickOrder(mine, m === 'SPECIFIC' ? 'FIFO' : m);
        let left = t.qty;
        const price = t.price ?? 0;
        for (const lot of order) {
          if (left <= 1e-12) break;
          const q = Math.min(left, lot.qty);
          if (t.type === 'sell') {
            const proceeds = q * price - fee * (q / t.qty);
            const cost = q * lot.cost;
            realized.push({ accountId: acct, symbol: sym, lotId: lot.id, openDate: lot.openDate, closeDate: t.date, qty: q, proceeds, cost, gain: proceeds - cost, term: holdingTerm(lot.openDate, t.date) });
          }
          lot.qty -= q;
          left -= q;
        }
        if (left > 1e-9) warnings.push(`${t.date} ${t.type} ${t.id}: ${left.toFixed(4)} ${sym} more than held`);
        if (t.type === 'sell') cash[acct] += t.qty * price - fee - left * price;
        else if (price > 0) flows.push({ date: t.date, accountId: acct, amount: -(t.qty - left) * price });
        break;
      }
      case 'transfer_in': {
        if (!sym || !t.qty) {
          warnings.push(`${t.date} transfer_in ${t.id}: missing symbol/qty`);
          break;
        }
        const basis = t.price ?? (t.amount !== undefined ? t.amount / t.qty : 0);
        lots.push({ id: t.id, accountId: acct, symbol: sym, openDate: t.date, qty: t.qty, cost: basis });
        if (basis > 0) flows.push({ date: t.date, accountId: acct, amount: t.qty * basis });
        break;
      }
      case 'split': {
        if (!sym || !t.ratio) {
          warnings.push(`${t.date} split ${t.id}: missing symbol/ratio`);
          break;
        }
        for (const l of lots) if (l.symbol === sym && l.accountId === acct && l.qty > 0) {
          l.qty *= t.ratio;
          l.cost /= t.ratio;
        }
        break;
      }
      case 'dividend':
      case 'interest': {
        const amt = t.amount ?? (t.qty && t.price ? t.qty * t.price : 0);
        cash[acct] += amt - fee;
        income.push({ accountId: acct, date: t.date, symbol: sym, amount: amt, kind: t.type });
        break;
      }
      case 'fee':
        cash[acct] -= (t.amount ?? 0) + fee;
        fees += t.amount ?? 0;
        break;
      case 'cash_in':
        cash[acct] += t.amount ?? 0;
        flows.push({ date: t.date, accountId: acct, amount: t.amount ?? 0 });
        break;
      case 'cash_out':
        cash[acct] -= t.amount ?? 0;
        flows.push({ date: t.date, accountId: acct, amount: -(t.amount ?? 0) });
        break;
    }
  }

  const open = lots.filter((l) => l.qty > 1e-9);
  const bySym = new Map<string, Position>();
  for (const l of open) {
    const p = bySym.get(l.symbol) ?? { symbol: l.symbol, qty: 0, cost: 0, avgCost: 0, lots: [], accounts: [], firstDate: l.openDate };
    p.qty += l.qty;
    p.cost += l.qty * l.cost;
    p.lots.push(l);
    if (!p.accounts.includes(l.accountId)) p.accounts.push(l.accountId);
    if (l.openDate < p.firstDate) p.firstDate = l.openDate;
    bySym.set(l.symbol, p);
  }
  const positions = [...bySym.values()].map((p) => ({ ...p, avgCost: p.cost / p.qty })).sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { lots: open, realized, income, cash, fees, positions, warnings, flows };
}

/** Quantity held of each symbol at the end of every date in `dates` (for the equity curve). */
export function holdingsOverTime(txs: Transaction[], dates: string[]): { date: string; qty: Record<string, number>; cash: number; flow: number }[] {
  const sorted = txs.slice().sort((a, b) => a.date.localeCompare(b.date));
  const qty: Record<string, number> = {};
  let cash = 0;
  let k = 0;
  return dates.map((d) => {
    let flow = 0;
    while (k < sorted.length && sorted[k].date <= d) {
      const t = sorted[k++];
      const s = t.symbol?.toUpperCase() ?? '';
      const fee = t.fee ?? 0;
      switch (t.type) {
        case 'buy':
          qty[s] = (qty[s] ?? 0) + (t.qty ?? 0);
          cash -= (t.qty ?? 0) * (t.price ?? 0) + fee;
          break;
        case 'sell':
          qty[s] = (qty[s] ?? 0) - (t.qty ?? 0);
          cash += (t.qty ?? 0) * (t.price ?? 0) - fee;
          break;
        case 'transfer_in':
          qty[s] = (qty[s] ?? 0) + (t.qty ?? 0);
          flow += (t.qty ?? 0) * (t.price ?? (t.amount && t.qty ? t.amount / t.qty : 0));
          break;
        case 'transfer_out':
          qty[s] = (qty[s] ?? 0) - (t.qty ?? 0);
          flow -= (t.qty ?? 0) * (t.price ?? 0);
          break;
        case 'split':
          if (t.ratio) qty[s] = (qty[s] ?? 0) * t.ratio;
          break;
        case 'dividend':
        case 'interest':
          cash += (t.amount ?? 0) - fee;
          break;
        case 'fee':
          cash -= (t.amount ?? 0) + fee;
          break;
        case 'cash_in':
          cash += t.amount ?? 0;
          flow += t.amount ?? 0;
          break;
        case 'cash_out':
          cash -= t.amount ?? 0;
          flow -= t.amount ?? 0;
          break;
      }
    }
    return { date: d, qty: { ...qty }, cash, flow };
  });
}

export const daysBetween = (a: string, b: string) => (toT(b) - toT(a)) / DAY;

export function fmtPrice(v: number | null | undefined, ref?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const r = Math.abs(ref ?? v);
  const d = r >= 1000 ? 2 : r >= 10 ? 2 : r >= 1 ? 3 : r >= 0.01 ? 5 : 8;
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
export const fmtPct = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
export const fmtNum = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
export const fmtMoney = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: d, minimumFractionDigits: d }));
export function fmtVol(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0);
}
export function fmtTime(t: number, intraday: boolean, tz?: string): string {
  const o: Intl.DateTimeFormatOptions = intraday ? { year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { year: 'numeric', month: 'short', day: '2-digit' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...o, timeZone: tz }).format(t);
  } catch {
    return new Date(t).toISOString().slice(0, intraday ? 16 : 10);
  }
}
export const signalLabel = (id: string) => id.replace(/_/g, ' ').replace(/\bSEQ\b/, 'Seq').replace(/\bCD\b/, 'CD');
export const dirColor = (d: string) => (d === 'bull' ? 'var(--ok)' : d === 'bear' ? 'var(--danger)' : 'var(--text-dim)');

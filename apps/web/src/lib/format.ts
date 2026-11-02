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

const ADJUST_LABEL: Record<string, string> = { split: 'split-adjusted', all: 'split + dividend adjusted', none: 'unadjusted' };
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** "yahoo · split-adjusted · 1D · 2007-03-12 → 2026-10-30 · 5,000 bars" — the dataset behind one result. */
export function describeBars(bars: readonly { t: number }[], src?: { provider?: string; adjust?: string; interval?: string; simulated?: boolean }): string {
  const parts: string[] = [];
  if (src?.provider) parts.push(`${src.provider}${src.simulated ? ' (simulated)' : ''}`);
  if (src?.adjust) parts.push(ADJUST_LABEL[src.adjust] ?? src.adjust);
  if (src?.interval) parts.push(src.interval);
  if (bars.length) parts.push(`${isoDay(bars[0].t)} → ${isoDay(bars[bars.length - 1].t)}`);
  parts.push(`${bars.length.toLocaleString()} bars`);
  return parts.join(' · ');
}

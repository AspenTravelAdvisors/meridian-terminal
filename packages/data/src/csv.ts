import type { Bar } from './types';

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF) with delimiter auto-detection. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const d = delimiter ?? ([',', ';', '\t', '|'] as const).reduce((best, c) => (firstLine.split(c).length > firstLine.split(best).length ? c : best), ',' as string);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Parse many common date formats to epoch ms (UTC unless the string carries an offset). */
export function parseDate(s: string, order: 'auto' | 'mdy' | 'dmy' = 'auto'): number {
  const v = s.trim().replace(/^"|"$/g, '');
  if (!v) return NaN;
  if (/^\d{9,13}(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n < 1e11 ? n * 1000 : n; // seconds vs milliseconds
  }
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)) {
    const iso = v.replace(' ', 'T');
    if (iso.length <= 10) return Date.parse(`${iso}T00:00:00Z`);
    return Date.parse(/([Zz]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  }
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(v);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const dmy = order === 'dmy' || (order === 'auto' && a > 12);
    const [mo, d] = dmy ? [b, a] : [a, b];
    let hh = m[4] ? +m[4] : 0;
    if (m[7]) hh = (hh % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    return Date.UTC(y, mo - 1, d, hh, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  }
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{4})$/.exec(v);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  const t = Date.parse(v);
  return Number.isNaN(t) ? NaN : t;
}

/** Parse a number allowing $, thousands separators, parentheses negatives and trailing %. */
export function parseNum(s: string | undefined): number {
  if (s === undefined) return NaN;
  let v = s.trim().replace(/[$€£¥\s]/g, '');
  if (!v || v === '-' || v === '--') return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(v)) {
    neg = true;
    v = v.slice(1, -1);
  }
  v = v.replace(/,(?=\d{3}(\D|$))/g, '').replace('%', '');
  const n = Number(v);
  return neg ? -n : n;
}

export interface BarColumnMap {
  t: number;
  time?: number; // optional separate time column
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

/** Guess the OHLCV column indices from a header row. */
export function guessBarColumns(header: string[]): BarColumnMap | null {
  const h = header.map((x) => x.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...names: string[]) => h.findIndex((x) => names.includes(x));
  const t = find('date', 'datetime', 'timestamp', 'time', 't', 'opentime');
  const time = h.indexOf('time') !== t ? h.indexOf('time') : -1;
  const o = find('open', 'o');
  const hi = find('high', 'h');
  const lo = find('low', 'l');
  const c = find('close', 'c', 'last', 'price');
  const v = find('volume', 'vol', 'v');
  if ([t, o, hi, lo, c].some((x) => x < 0)) return null;
  return { t, time: time >= 0 ? time : undefined, o, h: hi, l: lo, c, v: v >= 0 ? v : undefined };
}

export function csvToBars(text: string, map?: BarColumnMap): { bars: Bar[]; warnings: string[] } {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  if (rows.length < 2) return { bars: [], warnings: ['no data rows'] };
  const cols = map ?? guessBarColumns(rows[0]);
  if (!cols) return { bars: [], warnings: ['could not find date/open/high/low/close columns — map them manually'] };
  const bars: Bar[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const ts = cols.time !== undefined ? `${row[cols.t]} ${row[cols.time]}` : row[cols.t];
    const t = parseDate(ts);
    const b: Bar = { t, o: parseNum(row[cols.o]), h: parseNum(row[cols.h]), l: parseNum(row[cols.l]), c: parseNum(row[cols.c]), v: cols.v !== undefined ? parseNum(row[cols.v]) || 0 : 0 };
    if (!Number.isFinite(b.t) || ![b.o, b.h, b.l, b.c].every(Number.isFinite)) {
      if (warnings.length < 10) warnings.push(`row ${r + 1} skipped`);
      continue;
    }
    b.h = Math.max(b.h, b.o, b.c);
    b.l = Math.min(b.l, b.o, b.c);
    bars.push(b);
  }
  bars.sort((a, b) => a.t - b.t);
  const dedup = bars.filter((b, k) => k === 0 || b.t !== bars[k - 1].t);
  if (dedup.length < bars.length) warnings.push(`${bars.length - dedup.length} duplicate timestamps removed`);
  return { bars: dedup, warnings };
}

/** Infer the bar interval (ms) from the median spacing of timestamps. */
export function inferIntervalMs(bars: readonly Bar[]): number {
  if (bars.length < 3) return 86_400_000;
  const d: number[] = [];
  for (let i = 1; i < Math.min(bars.length, 500); i++) d.push(bars[i].t - bars[i - 1].t);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

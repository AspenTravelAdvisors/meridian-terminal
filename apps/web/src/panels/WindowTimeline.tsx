import type { Interval } from '@meridian/data';
import { useQueries } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { getBarsSourced } from '../data/useBars';
import { compute } from '../engine/compute';
import { type Alignment, findAlignments, KIND_LABEL, TF_SHORT, tfRank, type WindowItem, windowItems, type WindowKind } from '../lib/windowTimeline';
import { useWorkspace } from '../state/store';
import { type StatusResult, useActive } from './hooks';

/**
 * Window Timeline: every timeframe's Exhaustion Window projections on one shared calendar, with the stretches where
 * two or more timeframes overlap on the same side lit up as a beam. Reads the same engine study as the chart marks.
 */

const BASE_TFS: Interval[] = ['1M', '1W', '1D'];
const RANGES = [
  { id: '1M', days: 31 },
  { id: '3M', days: 92 },
  { id: '6M', days: 183 },
  { id: '1Y', days: 366 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];
type SideFilter = 'all' | 'buy' | 'sell';
interface Prefs {
  side: SideFilter;
  range: RangeId;
  nines: boolean;
  combo: boolean;
  h4: boolean;
}
const DEFAULT_PREFS: Prefs = { side: 'all', range: '3M', nines: true, combo: true, h4: false };
const PREFS_KEY = 'meridian:window-timeline';

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: preferences just don't persist */
  }
}

const DAY = 86_400_000;
const KIND_ORDER: Record<WindowKind, number> = { seq13: 0, combo13: 1, setup9: 2 };
const isIntraday = (tf: Interval) => tfRank(tf) < tfRank('1D');

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
const fmtAt = (t: number, intraday: boolean) => (intraday ? timeFmt : dayFmt).format(t);
/** a span's last moment (spans are end-exclusive) */
const lastOf = (x: { to: number }) => x.to - 1;

function spanText(x: { from: number; to: number }, intraday: boolean) {
  const a = fmtAt(x.from, intraday);
  const b = fmtAt(lastOf(x), intraday);
  return a === b ? a : `${a} → ${b}`;
}

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function itemName(x: WindowItem) {
  const s = x.side === 'buy' ? 'B' : 'S';
  return x.kind === 'setup9' ? `${s}9` : x.kind === 'seq13' ? `${s}13` : `Combo ${s}13`;
}

function describeItem(x: WindowItem) {
  const intra = isIntraday(x.tf);
  const n = x.kind === 'setup9' ? 9 : 13;
  const when = x.minBars === x.estBars ? `due ${fmtAt(x.from, intra)}` : `earliest ${fmtAt(x.from, intra)} · est. ${fmtAt(lastOf(x), intra)}`;
  return `${TF_SHORT(x.tf)} · ${x.side} · ${KIND_LABEL[x.kind]} · count ${x.count}/${n} · ${when} · ${x.minBars === x.estBars ? x.minBars : `${x.minBars}–${x.estBars}`} bars`;
}

function describeAlign(a: Alignment, now: number) {
  const days = Math.max(1, Math.round((a.to - a.from) / DAY));
  const lead = a.from > now ? `in ${Math.max(1, Math.round((a.from - now) / DAY))}d` : 'now';
  return `${a.side} alignment · ${a.tfs.map(TF_SHORT).join('+')} · ${spanText(a, a.tfs.some(isIntraday))} · ${days}d long · ${lead}`;
}

function ticks(t0: number, t1: number, spanDays: number) {
  const minor: number[] = [];
  const major: { t: number; label: string }[] = [];
  const d = new Date(startOfDay(t0));
  if (spanDays <= 45) {
    for (; d.getTime() <= t1; d.setDate(d.getDate() + 1)) {
      const t = d.getTime();
      if (d.getDay() === 1) major.push({ t, label: dayFmt.format(t) });
      else minor.push(t);
    }
  } else {
    let lastYear = d.getFullYear();
    for (; d.getTime() <= t1; d.setDate(d.getDate() + 1)) {
      const t = d.getTime();
      if (d.getDate() === 1) {
        const y = d.getFullYear();
        major.push({ t, label: y !== lastYear ? String(y) : monthFmt.format(t) });
        lastYear = y;
      } else if (spanDays <= 200 && d.getDay() === 1) minor.push(t);
    }
  }
  return { minor, major };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function openTf(tf: Interval) {
  const ws = useWorkspace.getState();
  ws.setInterval(ws.activePaneId, tf);
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { id: T; text: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tron-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, text, title }: { on: boolean; onChange: (v: boolean) => void; text: string; title: string }) {
  return (
    <div className="tron-seg">
      <button type="button" aria-pressed={on} onClick={() => onChange(!on)} title={title}>
        {text}
      </button>
    </div>
  );
}

type Focus = { kind: 'item'; item: WindowItem } | { kind: 'align'; a: Alignment } | null;

const LABEL_W = 40;
const PAD_R = 14;
const AXIS_H = 22;
const LANE_H = 11;
const LANE_GAP = 4;
const ROW_PAD = 7;
const MIN_ROW = 26;
const CONF_H = 34;

export function WindowTimelinePanel() {
  const { pane } = useActive();
  const symbol = pane.symbol;
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const setPrefs = (p: Partial<Prefs>) =>
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      savePrefs(next);
      return next;
    });
  const tfs = useMemo<Interval[]>(() => (prefs.h4 ? [...BASE_TFS, '4h'] : BASE_TFS), [prefs.h4]);

  const qs = useQueries({
    queries: tfs.map((tf) => ({
      queryKey: ['window-timeline', symbol, tf],
      queryFn: async () => {
        const { bars: all, source } = await getBarsSourced(symbol, tf, 600);
        const bars = all.filter((b) => b.final !== false);
        if (!bars.length) return { items: [] as WindowItem[] };
        const [r] = await compute<StatusResult[]>({ op: 'statuses', bars, studies: [{ key: 'win', id: 'meridian-window' }] });
        const values = (r?.status?.values ?? {}) as Record<string, number | null>;
        return { items: windowItems(tf, values, bars[bars.length - 1].t, source.calendar) };
      },
      staleTime: 120_000,
      retry: 1,
    })),
  });

  const [stageRef, width] = useWidth<HTMLDivElement>();
  const [focus, setFocus] = useState<Focus>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  // the clock only moves the NOW line and the x-range; refresh it each minute
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(h);
  }, []);

  const keep = (x: WindowItem) => (prefs.side === 'all' || x.side === prefs.side) && (prefs.nines || x.kind !== 'setup9') && (prefs.combo || x.kind !== 'combo13');
  const rows = tfs.map((tf, k) => {
    const q = qs[k];
    const items = (q.data?.items ?? []).filter(keep).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1));
    return { tf, items, loading: q.isLoading, error: q.isError };
  });
  const visible = rows.flatMap((r) => r.items);
  const alignments = findAlignments(visible);
  const upcoming = alignments.filter((a) => a.to > now);

  const spanDays = RANGES.find((r) => r.id === prefs.range)?.days ?? 92;
  const day0 = startOfDay(now);
  // start a little before today, far enough to show a higher-timeframe bar that is already forming
  const earliest = Math.min(...visible.map((v) => v.from), day0);
  const t0 = Math.max(day0 - spanDays * DAY * 0.12, Math.min(day0 - spanDays * DAY * 0.03, earliest - spanDays * DAY * 0.01));
  const t1 = day0 + spanDays * DAY;
  const plotW = Math.max(60, width - LABEL_W - PAD_R);
  const x = (t: number) => LABEL_W + ((t - t0) / (t1 - t0)) * plotW;
  const cx = (t: number) => Math.min(LABEL_W + plotW, Math.max(LABEL_W, x(t)));

  let y = AXIS_H;
  const layout = rows.map((r) => {
    const h = Math.max(MIN_ROW, ROW_PAD * 2 + r.items.length * LANE_H + Math.max(0, r.items.length - 1) * LANE_GAP);
    const top = y;
    y += h;
    return { ...r, top, h };
  });
  const rowsBottom = y;
  const height = rowsBottom + CONF_H;
  const { minor, major } = ticks(t0, t1, spanDays);
  const beyond = visible.filter((v) => v.from >= t1);

  const color = (side: 'buy' | 'sell') => (side === 'buy' ? 'var(--tron-buy)' : 'var(--tron-sell)');
  const onKey = (e: KeyboardEvent, f: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      f();
    }
  };
  const focusedAlign = focus?.kind === 'align' ? focus.a : null;
  const focusedItem = focus?.kind === 'item' ? focus.item : null;
  const loading = rows.some((r) => r.loading);

  let hud: string;
  if (focusedItem) hud = describeItem(focusedItem);
  else if (focusedAlign) hud = describeAlign(focusedAlign, now);
  else if (upcoming[0]) hud = `next: ${describeAlign(upcoming[0], now)}`;
  else if (loading) hud = 'scanning timeframes…';
  else if (!visible.length) hud = 'no active 9 or 13 counts on these timeframes';
  else hud = 'no cross-timeframe alignment · windows do not overlap';

  return (
    <div className="panel-body tron">
      <div className="tron-head">
        <div className="min-w-0">
          <div className="tron-title">
            Window Timeline <span className="tron-sym">{symbol}</span>
          </div>
          <div className="tron-sub">DeMark-style 9 / 13 windows across timeframes</div>
        </div>
        <div className="tron-controls">
          <Seg
            label="Side"
            value={prefs.side}
            onChange={(side) => setPrefs({ side })}
            options={[
              { id: 'all', text: 'All' },
              { id: 'buy', text: 'Buy' },
              { id: 'sell', text: 'Sell' },
            ]}
          />
          <Seg label="Range" value={prefs.range} onChange={(range) => setPrefs({ range })} options={RANGES.map((r) => ({ id: r.id, text: r.id }))} />
          <Toggle on={prefs.nines} onChange={(nines) => setPrefs({ nines })} text="9s" title="Show setup 9s (they count toward alignments)" />
          <Toggle on={prefs.combo} onChange={(combo) => setPrefs({ combo })} text="Combo" title="Show Combo 13 windows" />
          <Toggle on={prefs.h4} onChange={(h4) => setPrefs({ h4 })} text="4H" title="Add a 4-hour row" />
        </div>
      </div>

      <div className="tron-stage" ref={stageRef}>
        {width > 0 && (
          <svg width={width} height={height} role="group" aria-label={`Window timeline for ${symbol}`} className="block">
            <defs>
              <filter id={`${uid}-glow`} x="-20%" y="-200%" width="140%" height="500%">
                <feGaussianBlur stdDeviation="2.6" />
              </filter>
              <clipPath id={`${uid}-plot`}>
                <rect x={LABEL_W} y={0} width={plotW} height={height} />
              </clipPath>
              {(['buy', 'sell'] as const).map((s) => (
                <pattern key={s} id={`${uid}-hatch-${s}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="5" height="5" style={{ fill: color(s), fillOpacity: 0.08 }} />
                  <line x1="0" y1="0" x2="0" y2="5" style={{ stroke: color(s), strokeWidth: 2, strokeOpacity: 0.55 }} />
                </pattern>
              ))}
            </defs>

            {/* grid */}
            <g clipPath={`url(#${uid}-plot)`}>
              {minor.map((t) => (
                <line key={`m${t}`} x1={x(t)} x2={x(t)} y1={AXIS_H} y2={rowsBottom} style={{ stroke: 'var(--tron-grid)' }} />
              ))}
              {major.map((m) => (
                <g key={`M${m.t}`}>
                  <line x1={x(m.t)} x2={x(m.t)} y1={AXIS_H - 5} y2={height - 4} style={{ stroke: 'var(--tron-grid-2)' }} />
                  <text x={x(m.t) + 3} y={AXIS_H - 9} className="tron-axis">
                    {m.label}
                  </text>
                </g>
              ))}
            </g>
            <line x1={LABEL_W} x2={LABEL_W + plotW} y1={AXIS_H} y2={AXIS_H} style={{ stroke: 'var(--tron-edge)' }} />

            {/* alignment beams, behind the bands */}
            <g clipPath={`url(#${uid}-plot)`}>
              {alignments.map((a, k) => {
                const on = focusedAlign === a;
                const x0 = cx(a.from);
                const w = Math.max(2, cx(a.to) - x0);
                return (
                  <g key={k}>
                    <rect x={x0} y={AXIS_H} width={w} height={rowsBottom - AXIS_H} style={{ fill: color(a.side), fillOpacity: on ? 0.2 : 0.09 }} />
                    <line x1={x0} x2={x0} y1={AXIS_H} y2={height - 6} strokeDasharray="2 3" style={{ stroke: color(a.side), strokeOpacity: 0.7 }} />
                    <line x1={x0 + w} x2={x0 + w} y1={AXIS_H} y2={height - 6} strokeDasharray="2 3" style={{ stroke: color(a.side), strokeOpacity: 0.7 }} />
                  </g>
                );
              })}
            </g>

            {/* timeframe rows */}
            {layout.map((r) => (
              <g key={r.tf}>
                <line x1={0} x2={LABEL_W + plotW} y1={r.top + r.h} y2={r.top + r.h} style={{ stroke: 'var(--tron-grid-2)' }} />
                <g
                  role="button"
                  tabIndex={0}
                  className="tron-hit"
                  aria-label={`Open the ${r.tf} chart`}
                  onClick={() => openTf(r.tf)}
                  onKeyDown={(e) => onKey(e, () => openTf(r.tf))}
                >
                  <rect x={0} y={r.top} width={LABEL_W - 6} height={r.h} style={{ fill: 'transparent' }} />
                  <text x={8} y={r.top + r.h / 2 + 4} className="tron-tf">
                    {TF_SHORT(r.tf)}
                  </text>
                </g>
                {(r.loading || r.error || !r.items.length) && (
                  <text x={LABEL_W + 8} y={r.top + r.h / 2 + 3} className="tron-axis">
                    {r.loading ? 'scanning…' : r.error ? 'no data' : 'no active count'}
                  </text>
                )}
                <g clipPath={`url(#${uid}-plot)`}>
                  {r.items.map((it, k) => {
                    const ly = r.top + ROW_PAD + k * (LANE_H + LANE_GAP);
                    const x0 = x(it.from);
                    const w = Math.max(3, x(it.to) - x0);
                    const c = color(it.side);
                    const lit = focusedItem === it || (focusedAlign?.items.includes(it) ?? false);
                    const dim = focus !== null && !lit;
                    const label = itemName(it);
                    const select = () => openTf(it.tf);
                    return (
                      <g
                        key={k}
                        role="button"
                        tabIndex={0}
                        className="tron-hit"
                        aria-label={describeItem(it)}
                        style={{ opacity: dim ? 0.4 : 1 }}
                        onMouseEnter={() => setFocus({ kind: 'item', item: it })}
                        onMouseLeave={() => setFocus(null)}
                        onFocus={() => setFocus({ kind: 'item', item: it })}
                        onBlur={() => setFocus(null)}
                        onClick={select}
                        onKeyDown={(e) => onKey(e, select)}
                      >
                        {it.kind === 'setup9' ? (
                          <>
                            <line x1={x0} x2={x0 + w} y1={ly + LANE_H / 2} y2={ly + LANE_H / 2} style={{ stroke: c, strokeWidth: 1, strokeOpacity: 0.6 }} />
                            <path
                              d={`M${x0 + w / 2} ${ly} l${LANE_H / 2} ${LANE_H / 2} l${-LANE_H / 2} ${LANE_H / 2} l${-LANE_H / 2} ${-LANE_H / 2}z`}
                              className="tron-glow"
                              filter={`url(#${uid}-glow)`}
                              style={{ fill: c }}
                            />
                            <path d={`M${x0 + w / 2} ${ly} l${LANE_H / 2} ${LANE_H / 2} l${-LANE_H / 2} ${LANE_H / 2} l${-LANE_H / 2} ${-LANE_H / 2}z`} style={{ fill: 'var(--tron-panel)', stroke: c, strokeWidth: lit ? 2 : 1.4 }} />
                            <text x={x0 + w / 2 + LANE_H / 2 + 4} y={ly + LANE_H - 2} className="tron-label" style={{ fill: c }}>
                              {label}
                            </text>
                          </>
                        ) : (
                          <>
                            <rect x={x0} y={ly} width={w} height={LANE_H} rx={1.5} className="tron-glow" filter={`url(#${uid}-glow)`} style={{ fill: c, opacity: it.kind === 'combo13' ? 0.45 : undefined }} />
                            <rect
                              x={x0}
                              y={ly}
                              width={w}
                              height={LANE_H}
                              rx={1.5}
                              strokeDasharray={it.kind === 'combo13' ? '3 2' : undefined}
                              style={
                                it.kind === 'combo13'
                                  ? { fill: `url(#${uid}-hatch-${it.side})`, stroke: c, strokeWidth: lit ? 1.8 : 1 }
                                  : { fill: c, fillOpacity: 'var(--tron-fill)', stroke: c, strokeWidth: lit ? 1.8 : 1 }
                              }
                            />
                            {/* leading edge: the earliest bar the count can finish on */}
                            <rect x={x0} y={ly - 1} width={2} height={LANE_H + 2} style={{ fill: c }} />
                            {w > label.length * 6 + 10 ? (
                              <text x={x0 + 6} y={ly + LANE_H - 2.5} className="tron-label" style={{ fill: 'var(--tron-text)' }}>
                                {label}
                              </text>
                            ) : (
                              <text x={x0 + w + 4} y={ly + LANE_H - 2.5} className="tron-label" style={{ fill: c }}>
                                {label}
                              </text>
                            )}
                          </>
                        )}
                      </g>
                    );
                  })}
                </g>
              </g>
            ))}

            {/* confluence lane */}
            <text x={8} y={rowsBottom + 21} className="tron-tf tron-tf-sm">
              ALN
            </text>
            <g clipPath={`url(#${uid}-plot)`}>
              {alignments.map((a, k) => {
                const x0 = cx(a.from);
                const w = Math.max(3, cx(a.to) - x0);
                const c = color(a.side);
                const on = focusedAlign === a;
                const text = a.tfs.map(TF_SHORT).join('+');
                const ly = rowsBottom + 12 + (a.side === 'sell' && alignments.some((b) => b.side === 'buy' && b.from < a.to && b.to > a.from) ? 9 : 0);
                return (
                  <g
                    key={k}
                    role="button"
                    tabIndex={0}
                    className="tron-hit"
                    aria-label={describeAlign(a, now)}
                    onMouseEnter={() => setFocus({ kind: 'align', a })}
                    onMouseLeave={() => setFocus(null)}
                    onFocus={() => setFocus({ kind: 'align', a })}
                    onBlur={() => setFocus(null)}
                    onClick={() => openTf(a.tfs[a.tfs.length - 1])}
                    onKeyDown={(e) => onKey(e, () => openTf(a.tfs[a.tfs.length - 1]))}
                  >
                    <rect x={x0} y={ly} width={w} height={7} className="tron-glow" filter={`url(#${uid}-glow)`} style={{ fill: c }} />
                    <rect x={x0} y={ly} width={w} height={7} style={{ fill: c, stroke: on ? 'var(--tron-text)' : 'none', strokeWidth: 1 }} />
                    {w > text.length * 6 + 6 && (
                      <text x={x0 + w / 2} y={ly + 6} textAnchor="middle" className="tron-label" style={{ fill: 'var(--tron-bg)', fontWeight: 700 }}>
                        {text}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>

            {/* NOW */}
            <g className="tron-now">
              <line x1={x(now)} x2={x(now)} y1={AXIS_H - 3} y2={height - 4} className="tron-glow" filter={`url(#${uid}-glow)`} style={{ stroke: 'var(--tron-line)', strokeWidth: 3 }} />
              <line x1={x(now)} x2={x(now)} y1={AXIS_H - 3} y2={height - 4} style={{ stroke: 'var(--tron-line)', strokeWidth: 1 }} />
              <rect x={x(now) - 14} y={2} width={28} height={11} rx={1} style={{ fill: 'var(--tron-line)' }} />
              <text x={x(now)} y={10.5} textAnchor="middle" className="tron-label" style={{ fill: 'var(--tron-bg)', fontWeight: 700 }}>
                NOW
              </text>
            </g>

            {beyond.length > 0 && (
              <text x={LABEL_W + plotW - 4} y={height - 4} textAnchor="end" className="tron-axis" style={{ fill: 'var(--tron-line)' }}>
                <title>{beyond.map(describeItem).join('\n')}</title>+{beyond.length} beyond range ›
              </text>
            )}
          </svg>
        )}
        <div className="tron-floor" aria-hidden />
      </div>

      <div className="tron-hud" aria-live="polite">
        {hud}
      </div>

      <div className="tron-list">
        <div className="tron-list-head">Alignments {upcoming.length > 0 && <span>· {upcoming.length}</span>}</div>
        {!upcoming.length && <p className="tron-empty">{loading ? 'Scanning…' : 'None ahead. Windows on different timeframes do not overlap yet.'}</p>}
        {upcoming.slice(0, 8).map((a, k) => {
          const intra = a.tfs.some(isIntraday);
          const lowest = a.tfs[a.tfs.length - 1];
          const parts = [...a.items].sort((p, q) => tfRank(q.tf) - tfRank(p.tf)).map((it) => `${TF_SHORT(it.tf)} ${KIND_LABEL[it.kind]} ${it.count}/${it.kind === 'setup9' ? 9 : 13}`);
          return (
            <button
              key={k}
              type="button"
              className="tron-row"
              aria-pressed={focusedAlign === a}
              onMouseEnter={() => setFocus({ kind: 'align', a })}
              onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus({ kind: 'align', a })}
              onBlur={() => setFocus(null)}
              onClick={() => openTf(lowest)}
              title={`Open the ${lowest} chart`}
            >
              <span className="tron-pill" style={{ color: color(a.side), borderColor: color(a.side) }}>
                {a.side}
              </span>
              <span className="tron-tfs">{a.tfs.map(TF_SHORT).join('+')}</span>
              <span className="tron-when">{spanText(a, intra)}</span>
              <span className="tron-lead">{a.from > now ? `in ${Math.max(1, Math.round((a.from - now) / DAY))}d` : 'now'}</span>
              <span className="tron-parts">{[...new Set(parts)].join(' · ')}</span>
            </button>
          );
        })}
      </div>

      <p className="tron-note">
        Bars run from the earliest bar a count can finish on (bright edge) to where it lands at its pace so far. Hatched bars are Combo, diamonds are setup 9s. A
        cancel or recycle can void a window first: it says when to watch, not that a turn will come.
      </p>
    </div>
  );
}

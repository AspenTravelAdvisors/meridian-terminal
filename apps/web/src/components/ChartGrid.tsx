import { FastForward, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useEffect } from 'react';
import { ChartPane } from '../chart/ChartPane';
import { useUi, useWorkspace } from '../state/store';
import { GRID_LAYOUTS, type GridLayout } from '../state/types';

const GRID: Record<GridLayout, string> = {
  '1': 'grid-cols-1 grid-rows-1',
  '2h': 'grid-cols-2 grid-rows-1',
  '2v': 'grid-cols-1 grid-rows-2',
  '3': 'grid-cols-2 grid-rows-2',
  '4': 'grid-cols-2 grid-rows-2',
  '6': 'grid-cols-3 grid-rows-2',
  '8': 'grid-cols-4 grid-rows-2',
};

export function ChartGrid() {
  const grid = useWorkspace((s) => s.grid);
  const panes = useWorkspace((s) => s.panes);
  const activeId = useWorkspace((s) => s.activePaneId);
  const count = GRID_LAYOUTS.find((g) => g.id === grid)!.count;
  const visible = panes.slice(0, count);
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className={`grid min-h-0 flex-1 gap-px bg-border ${GRID[grid]}`}>
        {visible.map((p, k) => (
          <div
            key={p.id}
            className={`relative min-h-0 min-w-0 bg-bg ${grid === '3' && k === 0 ? 'row-span-2' : ''}`}
            style={{ boxShadow: count > 1 && p.id === activeId ? 'inset 0 0 0 1px var(--accent)' : undefined }}
          >
            <ChartPane pane={p} active={p.id === activeId} solo={count === 1} />
          </div>
        ))}
      </div>
      <ReplayBar />
    </div>
  );
}

const SPEEDS = [1, 2, 5, 10, 25];

function ReplayBar() {
  const activeId = useWorkspace((s) => s.activePaneId);
  const rp = useUi((s) => s.replay[activeId]);
  const len = useUi((s) => s.runtime[activeId]?.bars.length ?? 0);
  const total = useUi((s) => s.runtime[activeId]?.totalBars ?? 0);
  const set = (patch: Partial<NonNullable<typeof rp>>) => {
    const cur = useUi.getState().replay[activeId] ?? { active: false, index: 0, playing: false, speed: 2, selecting: false };
    useUi.getState().set({ replay: { ...useUi.getState().replay, [activeId]: { ...cur, ...patch } } });
  };
  useEffect(() => {
    if (!rp?.active || !rp.playing) return;
    const t = setInterval(() => {
      const cur = useUi.getState().replay[activeId];
      if (!cur) return;
      // stop at the live edge instead of running past the end of the series
      const last = (useUi.getState().runtime[activeId]?.totalBars ?? Infinity) - 1;
      if (cur.index >= last) set({ index: last, playing: false });
      else set({ index: cur.index + 1 });
    }, 1000 / rp.speed);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rp?.active, rp?.playing, rp?.speed, activeId]);
  if (!rp || (!rp.active && !rp.selecting)) return null;
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-panel px-3 text-[12px]" role="toolbar" aria-label="Bar replay">
      <span className="font-semibold text-accent">Bar replay</span>
      {rp.selecting ? (
        <span className="text-dim">Click a bar on the chart to start the replay there…</span>
      ) : (
        <>
          <button className="icon-btn" title="Step back (Shift+←)" aria-label="Step back" onClick={() => set({ index: Math.max(10, rp.index - 1), playing: false })}>
            <SkipBack className="size-4" />
          </button>
          <button className="icon-btn" title={rp.playing ? 'Pause' : 'Play'} aria-label={rp.playing ? 'Pause' : 'Play'} onClick={() => set({ playing: !rp.playing })}>
            {rp.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <button className="icon-btn" title="Step forward (Shift+→)" aria-label="Step forward" onClick={() => set({ index: total ? Math.min(total - 1, rp.index + 1) : rp.index + 1, playing: false })}>
            <SkipForward className="size-4" />
          </button>
          <FastForward className="size-3.5 text-dim" />
          {SPEEDS.map((s) => (
            <button key={s} className="btn-ghost h-6 px-1.5" data-active={rp.speed === s} onClick={() => set({ speed: s })}>
              {s}×
            </button>
          ))}
          <span className="text-dim tabular-nums">bar {rp.index + 1}{total ? ` / ${total}` : ''}{len ? ` · ${len} shown` : ''}</span>
          <span className="text-faint">Studies recompute bar-by-bar with no look-ahead.</span>
        </>
      )}
      <button className="btn ml-auto" onClick={() => set({ active: false, selecting: false, playing: false })}>
        <X className="size-3.5" /> Exit replay
      </button>
    </div>
  );
}

import {
  ArrowRightFromLine,
  Circle,
  Crosshair,
  EyeOff,
  GitCommitHorizontal,
  Magnet,
  MoveDiagonal,
  MoveHorizontal,
  MoveVertical,
  Pencil,
  RectangleHorizontal,
  Ruler,
  SeparatorHorizontal,
  Spline,
  Tag,
  Trash2,
  TrendingDown,
  TrendingUp,
  Type,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { TOOL_LABELS } from '../chart/drawings';
import { activePane, useDrawings, useSettings, useUi } from '../state/store';
import type { DrawingType } from '../state/types';
import { Tooltip } from './ui';

const FibIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M3 5h18M3 9.5h18M3 13h18M3 17h18M3 21h18" strokeDasharray="0" opacity="0.9" />
    <path d="M5 21 19 5" strokeWidth="1.2" strokeDasharray="2 2" />
  </svg>
);
const ChannelIcon = () => (
  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M3 15 15 5M9 19 21 9" />
  </svg>
);

const TOOLS: { id: DrawingType; icon: ReactNode; key?: string }[][] = [
  [
    { id: 'trendline', icon: <MoveDiagonal className="size-4" />, key: 'Alt+T' },
    { id: 'ray', icon: <ArrowRightFromLine className="size-4 -rotate-12" /> },
    { id: 'extended', icon: <SeparatorHorizontal className="size-4 -rotate-12" /> },
    { id: 'hline', icon: <MoveHorizontal className="size-4" />, key: 'Alt+H' },
    { id: 'hray', icon: <ArrowRightFromLine className="size-4" /> },
    { id: 'vline', icon: <MoveVertical className="size-4" />, key: 'Alt+V' },
    { id: 'channel', icon: <ChannelIcon /> },
  ],
  [
    { id: 'fib', icon: <FibIcon />, key: 'Alt+F' },
    { id: 'fibext', icon: <Spline className="size-4" /> },
    { id: 'fibtime', icon: <GitCommitHorizontal className="size-4 rotate-90" /> },
  ],
  [
    { id: 'rect', icon: <RectangleHorizontal className="size-4" />, key: 'Alt+R' },
    { id: 'ellipse', icon: <Circle className="size-4" /> },
    { id: 'path', icon: <Pencil className="size-4" /> },
    { id: 'text', icon: <Type className="size-4" /> },
    { id: 'pricelabel', icon: <Tag className="size-4" /> },
  ],
  [
    { id: 'long', icon: <TrendingUp className="size-4" /> },
    { id: 'short', icon: <TrendingDown className="size-4" /> },
    { id: 'measure', icon: <Ruler className="size-4" />, key: 'Alt+M' },
  ],
];

export function DrawingToolbar() {
  const tool = useUi((s) => s.tool);
  const magnet = useSettings((s) => s.magnet);
  const setUi = useUi.getState().set;
  return (
    <nav className="flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border bg-panel py-1.5" aria-label="Drawing tools">
      <Tooltip side="right" content="Cursor (Esc)">
        <button className="icon-btn size-8" data-active={!tool} aria-label="Cursor" aria-pressed={!tool} onClick={() => setUi({ tool: null })}>
          <Crosshair className="size-4" />
        </button>
      </Tooltip>
      {TOOLS.map((group, g) => (
        <div key={g} className="flex flex-col items-center gap-0.5 border-t border-border pt-1">
          {group.map((t) => (
            <Tooltip key={t.id} side="right" content={<span>{TOOL_LABELS[t.id]} {t.key && <span className="kbd">{t.key}</span>}</span>}>
              <button className="icon-btn size-8" data-active={tool === t.id} aria-label={TOOL_LABELS[t.id]} aria-pressed={tool === t.id} onClick={() => setUi({ tool: tool === t.id ? null : t.id, selectedDrawing: null })}>
                {t.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      ))}
      <div className="mt-auto flex flex-col items-center gap-0.5 border-t border-border pt-1">
        <Tooltip side="right" content={`Magnet: ${magnet} — snaps to O/H/L/C`}>
          <button
            className="icon-btn size-8"
            data-active={magnet !== 'off'}
            aria-label={`Magnet ${magnet}`}
            onClick={() => useSettings.getState().set({ magnet: magnet === 'off' ? 'weak' : magnet === 'weak' ? 'strong' : 'off' })}
          >
            <Magnet className={`size-4 ${magnet === 'strong' ? 'fill-current' : ''}`} />
          </button>
        </Tooltip>
        <Tooltip side="right" content="Hide / show all drawings on this symbol">
          <button
            className="icon-btn size-8"
            aria-label="Toggle drawings visibility"
            onClick={() => {
              const sym = activePane().symbol;
              const list = useDrawings.getState().bySymbol[sym] ?? [];
              const hide = list.some((d) => !d.hidden);
              useDrawings.getState().commit(sym, list.map((d) => ({ ...d, hidden: hide })));
            }}
          >
            <EyeOff className="size-4" />
          </button>
        </Tooltip>
        <Tooltip side="right" content="Remove all drawings on this symbol">
          <button
            className="icon-btn size-8"
            aria-label="Remove all drawings"
            onClick={() => {
              const sym = activePane().symbol;
              if (!useSettings.getState().confirmBeforeDelete || confirm(`Remove all drawings on ${sym}? (Undo with Ctrl+Z)`)) useDrawings.getState().clear(sym);
            }}
          >
            <Trash2 className="size-4" />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}

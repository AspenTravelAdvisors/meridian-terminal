import { Settings2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { dirColor, fmtPrice, fmtVol } from '../lib/format';
import type { Explanation } from './explain';

interface Props {
  e: Explanation;
  /** pointer position inside the chart container */
  x: number;
  y: number;
  /** chart container size */
  w: number;
  h: number;
  time?: string;
  /** pinned = opened by click/tap (full card); otherwise a compact hover tooltip */
  pinned: boolean;
  onClose(): void;
  onSettings?: () => void;
}

/** Hover tooltip / click card explaining one chart element. */
export function ExplainCard({ e, x, y, w, h, time, pinned, onClose, onSettings }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pinned) return;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (k: KeyboardEvent) => k.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned, onClose]);

  const width = pinned ? 300 : 250;
  // narrow charts (phones): dock the card along the bottom instead of chasing the finger
  const docked = pinned && w < 480;
  const style: React.CSSProperties = docked
    ? { left: 8, right: 8, bottom: 32 }
    : {
        width,
        left: x + 16 + width > w - 64 ? Math.max(4, x - 16 - width) : x + 16,
        ...(y > h / 2 ? { bottom: h - y + 12 } : { top: y + 12 }),
      };
  const value = e.value === undefined || !Number.isFinite(e.value) ? null : e.volume ? fmtVol(e.value) : fmtPrice(e.value);

  return (
    <div
      role={pinned ? 'dialog' : 'tooltip'}
      aria-label={e.title}
      className={`absolute z-30 rounded-md border border-border bg-panel text-[11px] leading-snug shadow-lg ${pinned ? 'pointer-events-auto p-2.5' : 'pointer-events-none px-2 py-1.5'}`}
      style={style}
      onPointerDown={(ev) => ev.stopPropagation()}
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-[3px] size-2 shrink-0 rounded-full" style={{ background: e.color }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-text">{e.title}</div>
          {(e.source || time) && (
            <div className="text-faint">
              {[e.source, time].filter(Boolean).join(' · ')}
              {e.provisional && <span className="ml-1 rounded bg-raised px-1 text-[9px] uppercase tracking-wide text-warn">forming</span>}
            </div>
          )}
        </div>
        {value && <span className="shrink-0 tabular-nums text-text">{value}</span>}
        {pinned && (
          <button ref={closeRef} className="icon-btn -mr-1 -mt-1 shrink-0" aria-label="Close explanation" onClick={onClose}>
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {pinned ? (
        <>
          {e.meaning && <p className="mt-1.5 text-dim">{e.meaning}</p>}
          {e.detail && <p className="mt-1.5 line-clamp-4 rounded bg-raised px-1.5 py-1 text-text">{e.detail}</p>}
          {e.items && (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {e.items.length ? e.items.map((it, k) => <li key={k} style={{ color: dirColor(it.dir) }}>{it.text}</li>) : <li className="text-faint">No signals fired on this bar.</li>}
            </ul>
          )}
          {e.about && <p className="mt-1.5 border-t border-border pt-1.5 text-faint">{e.about}</p>}
          {onSettings && (
            <button className="btn mt-2 flex items-center gap-1 py-0.5 text-[11px]" onClick={onSettings}>
              <Settings2 className="size-3" /> Study settings
            </button>
          )}
        </>
      ) : (
        <>
          {e.detail && e.detail.toLowerCase() !== e.title.toLowerCase() && <div className="mt-0.5 line-clamp-2 text-dim">{e.detail}</div>}
          <div className="mt-0.5 text-[10px] text-faint">Click for what this means</div>
        </>
      )}
    </div>
  );
}

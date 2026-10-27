import { INTERVALS, type Interval } from '@meridian/data';
import {
  BarChart3,
  Bell,
  Camera,
  ChevronDown,
  Columns2,
  Command,
  FunctionSquare,
  History,
  Keyboard,
  LayoutGrid,
  Moon,
  PanelsTopLeft,
  Plus,
  Redo2,
  Save,
  Search,
  Settings,
  Sun,
  Undo2,
  UserRound,
} from 'lucide-react';
import { snapshotters } from '../chart/bus';
import { canvasToBlob, download } from '../lib/download';
import { useAccount } from '../state/account';
import { activePane, useDrawings, useLayouts, useSettings, useUi, useWorkspace } from '../state/store';
import { fmtPrice } from '../lib/format';
import { CHART_TYPES, GRID_LAYOUTS } from '../state/types';
import { openPanel, PANEL_DEFS } from './panels';
import { Menu, MenuItem, MenuLabel, MenuSep, Tooltip } from './ui';

const QUICK: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'];
const label = (iv: Interval) => (iv === '1D' ? 'D' : iv === '1W' ? 'W' : iv === '1M' ? 'M' : iv === '3M' ? '3M' : iv);

export async function snapshot(scope: 'pane' | 'grid') {
  const ws = useWorkspace.getState();
  const n = GRID_LAYOUTS.find((g) => g.id === ws.grid)!.count;
  const ids = scope === 'pane' ? [ws.activePaneId] : ws.panes.slice(0, n).map((p) => p.id);
  const canvases = ids.map((id) => snapshotters.get(id)?.()).filter((c): c is HTMLCanvasElement => !!c);
  if (!canvases.length) return;
  let out = canvases[0];
  if (canvases.length > 1) {
    const cols = ws.grid === '2v' ? 1 : ws.grid === '6' ? 3 : ws.grid === '8' ? 4 : 2;
    const w = Math.max(...canvases.map((c) => c.width));
    const h = Math.max(...canvases.map((c) => c.height));
    out = document.createElement('canvas');
    out.width = w * cols;
    out.height = h * Math.ceil(canvases.length / cols);
    const g = out.getContext('2d')!;
    canvases.forEach((c, k) => g.drawImage(c, (k % cols) * w, Math.floor(k / cols) * h));
  }
  download(`meridian-${activePane().symbol.replace(/[^A-Za-z0-9]/g, '_')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`, await canvasToBlob(out));
}

function AccountButton() {
  const status = useAccount((s) => s.status);
  const user = useAccount((s) => s.info?.user);
  const sync = useAccount((s) => s.sync);
  if (status === 'unavailable' || status === 'unknown') return null;
  const tip = user ? `${user.username} · ${sync === 'error' ? 'sync problem' : sync === 'offline' ? 'offline' : 'synced'}` : 'Sign in to sync and get alerts with Meridian closed';
  return (
    <Tooltip content={tip}>
      <button className="icon-btn relative" aria-label={user ? `Account: ${user.username}` : 'Sign in'} onClick={() => openPanel('account')}>
        <UserRound className="size-4" />
        {user && <span className={`absolute right-1 top-1 size-1.5 rounded-full ${sync === 'error' ? 'bg-danger' : sync === 'offline' ? 'bg-warn' : 'bg-ok'}`} aria-hidden />}
      </button>
    </Tooltip>
  );
}

export function TopBar() {
  const ws = useWorkspace();
  const pane = ws.panes.find((p) => p.id === ws.activePaneId) ?? ws.panes[0];
  const settings = useSettings();
  const ui = useUi.getState();
  const layouts = useLayouts();
  const replay = useUi((s) => s.replay[pane.id]);
  const theme = settings.theme;
  const dark = document.documentElement.dataset.theme !== 'light';

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-panel px-2" role="toolbar" aria-label="Chart toolbar">
      <div className="mr-2 flex items-center gap-1.5 pr-1 font-semibold tracking-tight">
        <svg viewBox="0 0 64 64" className="size-5" aria-hidden>
          <path d="M8 46 L22 28 L31 36 L42 16 L56 26" fill="none" stroke="var(--accent)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="42" cy="16" r="5" fill="var(--warn)" />
        </svg>
        <span className="hidden text-[13px] md:inline">Meridian</span>
      </div>
      <button className="btn min-w-28 justify-between font-semibold" onClick={() => ui.set({ symbolSearch: { open: true, initial: '', target: 'pane' } })} aria-label="Symbol search" title="Symbol search (just start typing)">
        <span className="flex items-center gap-1.5">
          <Search className="size-3.5 text-dim" />
          {pane.symbol}
        </span>
      </button>
      <Tooltip content="Compare / overlay another symbol">
        <button className="icon-btn" aria-label="Compare symbol" onClick={() => ui.set({ symbolSearch: { open: true, initial: '', target: 'compare' } })}>
          <Plus className="size-4" />
        </button>
      </Tooltip>
      <div className="mx-1 h-5 w-px bg-border" />
      {QUICK.map((iv) => (
        <button key={iv} className="btn-ghost h-7 px-1.5 font-medium" data-active={pane.interval === iv} onClick={() => ws.setInterval(pane.id, iv)} aria-pressed={pane.interval === iv}>
          {label(iv)}
        </button>
      ))}
      <Menu trigger={<button className="icon-btn" aria-label="More intervals"><ChevronDown className="size-3.5" /></button>}>
        {INTERVALS.map((iv) => (
          <MenuItem key={iv} active={pane.interval === iv} onSelect={() => ws.setInterval(pane.id, iv)}>
            {iv}
          </MenuItem>
        ))}
      </Menu>
      <div className="mx-1 h-5 w-px bg-border" />
      <Menu
        trigger={
          <button className="btn-ghost" aria-label="Chart type">
            <BarChart3 className="size-4" />
            <span className="hidden lg:inline">{CHART_TYPES.find((c) => c.id === pane.chartType)?.label}</span>
          </button>
        }
      >
        {CHART_TYPES.map((c) => (
          <MenuItem key={c.id} active={pane.chartType === c.id} onSelect={() => ws.updatePane(pane.id, { chartType: c.id })}>
            {c.label}
          </MenuItem>
        ))}
        {(pane.chartType === 'renko' || pane.chartType === 'range') && (
          <MenuItem onSelect={() => ui.set({ boxSizePane: pane.id })} hint={pane.boxSize ? fmtPrice(pane.boxSize) : `auto · ATR ${pane.boxAtr ?? 14}`}>
            Box size…
          </MenuItem>
        )}
        <MenuSep />
        <MenuLabel>Price scale</MenuLabel>
        {(['normal', 'log', 'percent', 'indexed'] as const).map((m) => (
          <MenuItem key={m} active={pane.scaleMode === m} onSelect={() => ws.updatePane(pane.id, { scaleMode: m })}>
            {m === 'normal' ? 'Regular' : m === 'log' ? 'Logarithmic' : m === 'percent' ? 'Percent' : 'Indexed to 100'}
          </MenuItem>
        ))}
        <MenuSep />
        <MenuLabel>Adjustment</MenuLabel>
        {(['split', 'all', 'none'] as const).map((a) => (
          <MenuItem key={a} active={pane.adjust === a} onSelect={() => ws.updatePane(pane.id, { adjust: a })}>
            {a === 'split' ? 'Split-adjusted' : a === 'all' ? 'Split + dividend adjusted' : 'Unadjusted'}
          </MenuItem>
        ))}
        <MenuSep />
        <MenuItem active={!!pane.showVolumeProfile} onSelect={() => ws.updatePane(pane.id, { showVolumeProfile: !pane.showVolumeProfile })}>
          Visible-range volume profile
        </MenuItem>
        {pane.compare.length > 0 && <MenuItem onSelect={() => ws.updatePane(pane.id, { compare: [] })}>Remove compared symbols ({pane.compare.join(', ')})</MenuItem>}
      </Menu>
      <Tooltip content={<span>Indicators & studies <span className="kbd">/</span></span>}>
        <button className="btn-ghost" onClick={() => ui.set({ studiesOpen: true })} aria-label="Studies">
          <FunctionSquare className="size-4" />
          <span className="hidden lg:inline">Studies</span>
        </button>
      </Tooltip>
      <Tooltip content="Create an alert for this chart">
        <button className="btn-ghost" onClick={() => openPanel('alerts')} aria-label="Alerts">
          <Bell className="size-4" />
          <span className="hidden lg:inline">Alert</span>
        </button>
      </Tooltip>
      <Tooltip content="Bar replay — pick a start bar, then step or play">
        <button
          className="btn-ghost"
          data-active={!!replay?.active || !!replay?.selecting}
          aria-label="Bar replay"
          onClick={() => ui.set({ replay: { ...useUi.getState().replay, [pane.id]: { active: false, index: 0, playing: false, speed: replay?.speed ?? 2, selecting: !(replay?.selecting || replay?.active) } } })}
        >
          <History className="size-4" />
          <span className="hidden lg:inline">Replay</span>
        </button>
      </Tooltip>
      <div className="mx-1 h-5 w-px bg-border" />
      <Menu trigger={<button className="btn-ghost" aria-label="Layout"><LayoutGrid className="size-4" /></button>}>
        <MenuLabel>Chart grid</MenuLabel>
        {GRID_LAYOUTS.map((g) => (
          <MenuItem key={g.id} active={ws.grid === g.id} onSelect={() => ws.setGrid(g.id)}>
            {g.label}
          </MenuItem>
        ))}
        <MenuSep />
        <MenuLabel>Sync</MenuLabel>
        <MenuItem active={settings.syncCrosshair} onSelect={() => settings.set({ syncCrosshair: !settings.syncCrosshair })}>Crosshair sync</MenuItem>
        <MenuItem active={settings.syncTime} onSelect={() => settings.set({ syncTime: !settings.syncTime })}>Date-range sync</MenuItem>
        <MenuItem active={settings.syncInterval} onSelect={() => settings.set({ syncInterval: !settings.syncInterval })}>Link groups also sync interval</MenuItem>
        <MenuSep />
        <MenuLabel>Saved layouts</MenuLabel>
        {layouts.layouts.map((l) => (
          <MenuItem key={l.id} onSelect={() => ws.applyLayout(l)}>
            {l.name}
          </MenuItem>
        ))}
        <MenuItem
          onSelect={() => {
            const name = prompt('Layout name', `Layout ${layouts.layouts.length + 1}`);
            if (name) layouts.save(name);
          }}
        >
          <span className="flex items-center gap-1.5"><Save className="size-3.5" /> Save current layout…</span>
        </MenuItem>
        {layouts.layouts.length > 0 && (
          <MenuItem
            onSelect={() => {
              const name = prompt(`Delete which layout? (${layouts.layouts.map((l) => l.name).join(', ')})`);
              const l = layouts.layouts.find((x) => x.name === name);
              if (l) layouts.remove(l.id);
            }}
          >
            Delete a layout…
          </MenuItem>
        )}
      </Menu>
      <Menu trigger={<button className="btn-ghost" aria-label="Panels"><PanelsTopLeft className="size-4" /><span className="hidden xl:inline">Panels</span></button>}>
        {PANEL_DEFS.map((d) => (
          <MenuItem key={d.id} onSelect={() => openPanel(d.id)}>
            {d.title}
          </MenuItem>
        ))}
      </Menu>
      <Tooltip content={<span>Undo <span className="kbd">Ctrl Z</span></span>}>
        <button className="icon-btn" aria-label="Undo" onClick={() => useDrawings.getState().undo()}>
          <Undo2 className="size-4" />
        </button>
      </Tooltip>
      <Tooltip content={<span>Redo <span className="kbd">Ctrl Y</span></span>}>
        <button className="icon-btn" aria-label="Redo" onClick={() => useDrawings.getState().redo()}>
          <Redo2 className="size-4" />
        </button>
      </Tooltip>
      <Menu trigger={<button className="icon-btn" aria-label="Snapshot"><Camera className="size-4" /></button>}>
        <MenuItem onSelect={() => snapshot('pane')}>Download active chart (PNG)</MenuItem>
        <MenuItem onSelect={() => snapshot('grid')}>
          <span className="flex items-center gap-1.5"><Columns2 className="size-3.5" /> Download full grid (PNG)</span>
        </MenuItem>
      </Menu>
      <div className="ml-auto flex items-center gap-1">
        <Tooltip content={<span>Command palette <span className="kbd">Ctrl K</span></span>}>
          <button className="icon-btn" aria-label="Command palette" onClick={() => ui.set({ paletteOpen: true })}>
            <Command className="size-4" />
          </button>
        </Tooltip>
        <Tooltip content="Keyboard shortcuts (?)">
          <button className="icon-btn" aria-label="Keyboard shortcuts" onClick={() => ui.set({ shortcutsOpen: true })}>
            <Keyboard className="size-4" />
          </button>
        </Tooltip>
        <Tooltip content={`Theme: ${theme}`}>
          <button className="icon-btn" aria-label="Toggle theme" onClick={() => settings.set({ theme: dark ? 'light' : 'dark' })}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </Tooltip>
        <AccountButton />
        <Tooltip content="Settings">
          <button className="icon-btn" aria-label="Settings" onClick={() => ui.set({ settingsOpen: true })}>
            <Settings className="size-4" />
          </button>
        </Tooltip>
      </div>
    </header>
  );
}

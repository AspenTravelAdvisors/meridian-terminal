import { type AnyStudyDef, CATEGORIES, type Category, type JsonSchema, STUDIES, defaultsOf, getStudy, inputsSchema, resolveConfig } from '@meridian/engine';
import { AlertTriangle, RotateCcw, Search, Star } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useIsMobile } from '../lib/useMedia';
import { activePane, newStudy, useLayouts, useScripts, useStudyDefaults, useUi, useWorkspace } from '../state/store';
import type { OutputStyle, StudyInstanceCfg, TfBucket } from '../state/types';
import { Field, Modal, Switch, TabPanel, Tabs } from './ui';

const CAT_LABEL: Record<Category | 'Favorites' | 'Templates' | 'Scripts', string> = {
  Favorites: '★ Favorites',
  DeMark: 'DeMark-style',
  Meridian: 'Meridian composites',
  Ichimoku: 'Ichimoku',
  Trend: 'Trend',
  Momentum: 'Momentum',
  Volatility: 'Volatility',
  Volume: 'Volume',
  Custom: 'Custom',
  Templates: 'Templates',
  Scripts: 'My scripts',
};

export function StudiesDialog() {
  const open = useUi((s) => s.studiesOpen);
  const close = () => useUi.getState().set({ studiesOpen: false });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Category | 'Favorites' | 'Templates' | 'Scripts'>('DeMark');
  const favs = useStudyDefaults((s) => s.favorites);
  const toggleFav = useStudyDefaults((s) => s.toggleFavorite);
  const templates = useLayouts((s) => s.templates);
  const scripts = useScripts((s) => s.scripts);
  const mobile = useIsMobile(); // on a phone, focusing search on open would cover the list with the keyboard
  const paneStudies = useWorkspace((s) => (s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0])?.studies);
  // how many of each study the active chart already has, so a second tap is never a silent duplicate
  const onChart = useMemo(() => {
    const n = new Map<string, number>();
    for (const st of paneStudies ?? []) n.set(st.id, (n.get(st.id) ?? 0) + 1);
    return n;
  }, [paneStudies]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s) return STUDIES.filter((d) => `${d.name} ${d.shortName} ${d.description} ${d.id}`.toLowerCase().includes(s));
    if (cat === 'Favorites') return STUDIES.filter((d) => favs.includes(d.id));
    return STUDIES.filter((d) => d.category === cat);
  }, [q, cat, favs]);

  const add = (d: AnyStudyDef) => {
    const p = activePane();
    useWorkspace.getState().addStudy(p.id, d.id);
    useUi.getState().toast({ title: `Added ${d.name}`, tone: 'ok' });
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Indicators & studies" width={820} description="Search and add studies to the active chart">
      <div className="flex h-[60vh] min-h-80 mobile:h-full mobile:min-h-0 mobile:flex-col">
        <aside className="w-48 shrink-0 border-r border-border p-2 mobile:flex mobile:w-full mobile:gap-1 mobile:overflow-x-auto mobile:border-r-0 mobile:border-b">
          {(['Favorites', ...CATEGORIES.filter((c) => c !== 'Custom'), 'Scripts', 'Templates'] as const).map((c) => (
            <button key={c} className="btn-ghost w-full justify-start mobile:w-auto mobile:shrink-0" data-active={!q && cat === c} onClick={() => (setCat(c), setQ(''))}>
              {CAT_LABEL[c]}
              <span className="ml-auto text-[10px] text-faint">{c === 'Favorites' ? favs.length : c === 'Templates' ? templates.length : c === 'Scripts' ? scripts.length : STUDIES.filter((d) => d.category === c).length}</span>
            </button>
          ))}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-4 text-dim" />
            <input autoFocus={!mobile} className="h-7 flex-1 bg-transparent outline-none placeholder:text-faint" placeholder="Search studies…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search studies" />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!q && cat === 'Templates' ? (
              <TemplatesList close={close} />
            ) : !q && cat === 'Scripts' ? (
              <ul>
                {scripts.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 border-b border-border/50 px-3 py-2 hover:bg-raised/60">
                    <button className="flex-1 text-left font-medium" onClick={() => {
                      const p = activePane();
                      const st = newStudy('script');
                      st.scriptId = s.id;
                      useWorkspace.getState().updatePane(p.id, { studies: [...p.studies, st] });
                      close();
                    }}>{s.name}</button>
                    <span className="text-[11px] text-faint">Meridian Script</span>
                  </li>
                ))}
                {!scripts.length && <li className="p-6 text-center text-dim">No saved scripts yet — write one in the Script Editor panel.</li>}
              </ul>
            ) : (
              <ul>
                {list.map((d) => (
                  <li key={d.id} className="group flex items-start gap-2 border-b border-border/50 px-3 py-2 hover:bg-raised/60">
                    <button className="mt-0.5 text-faint hover:text-warn" aria-label={favs.includes(d.id) ? 'Remove favorite' : 'Add favorite'} onClick={() => toggleFav(d.id)}>
                      <Star className={`size-3.5 ${favs.includes(d.id) ? 'fill-warn text-warn' : ''}`} />
                    </button>
                    <button className="min-w-0 flex-1 text-left" onClick={() => add(d)}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{d.name}</span>
                        <span className="text-[10px] text-faint">{d.overlay ? 'overlay' : 'pane'}</span>
                        {onChart.has(d.id) && <span className="chip bg-accent/15 text-accent" title="Already on the active chart — remove copies from the chart legend or the Object Tree">on chart{onChart.get(d.id)! > 1 ? ` ×${onChart.get(d.id)}` : ''}</span>}
                        {d.verify?.length ? <span className="chip bg-warn/15 text-warn" title="Has ⚠ VERIFY parameters — see docs/VERIFY_LOG.md">⚠ verify</span> : null}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-dim">{d.description}</div>
                    </button>
                    <button className="btn opacity-0 group-hover:opacity-100" onClick={() => add(d)}>Add</button>
                  </li>
                ))}
                {!list.length && <li className="p-6 text-center text-dim">No studies match “{q}”.</li>}
              </ul>
            )}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-[10px] text-faint">
            “DeMark-style” studies are independent implementations from documented rules; TD Sequential® and related names are trademarks of DeMark Analytics.
          </div>
        </div>
      </div>
    </Modal>
  );
}

function TemplatesList({ close }: { close(): void }) {
  const { templates, saveTemplate, removeTemplate } = useLayouts();
  const pane = useWorkspace((s) => s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0]);
  return (
    <div className="p-3">
      <button
        className="btn mb-3"
        onClick={() => {
          const name = prompt('Template name', `${pane.studies.length} studies`);
          if (name) saveTemplate(name, pane.studies);
        }}
      >
        Save active chart’s studies as template
      </button>
      <ul>
        {templates.map((t) => (
          <li key={t.id} className="flex items-center gap-2 border-b border-border/50 py-2">
            <span className="flex-1 font-medium">{t.name}</span>
            <span className="text-[11px] text-dim">{t.studies.map((s) => getStudy(s.id)?.shortName ?? s.id).join(', ')}</span>
            <button
              className="btn"
              onClick={() => {
                useWorkspace.getState().updatePane(pane.id, { studies: t.studies.map((s) => ({ ...s, uid: `s${Math.random().toString(36).slice(2, 9)}` })) });
                close();
              }}
            >
              Apply
            </button>
            <button className="btn-ghost" onClick={() => removeTemplate(t.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Study settings: Inputs (generated from the Zod schema) / Style / Visibility ──
const BUCKETS: TfBucket[] = ['minutes', 'hours', 'days', 'weeks', 'months'];

export function StudySettingsDialog() {
  const target = useUi((s) => s.studySettings);
  const pane = useWorkspace((s) => s.panes.find((p) => p.id === target?.paneId));
  const study = pane?.studies.find((s) => s.uid === target?.uid);
  const def = study ? getStudy(study.id) : undefined;
  const close = () => useUi.getState().set({ studySettings: null });
  const [tab, setTab] = useState('inputs');
  const [draft, setDraft] = useState<StudyInstanceCfg | null>(null);
  const cur = draft && draft.uid === study?.uid ? draft : study ?? null;
  if (!target || !study || !def || !cur) return null;
  const schema = inputsSchema(def);
  const setCfg = (cfg: Record<string, unknown>) => setDraft({ ...cur, cfg });
  const apply = () => {
    useWorkspace.getState().updateStudy(target.paneId, study.uid, { cfg: resolveConfig(def, cur.cfg), style: cur.style, visibility: cur.visibility });
    setDraft(null);
    close();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && (setDraft(null), close())}
      title={def.name}
      width={640}
      footer={
        <>
          <button className="btn mr-auto" onClick={() => setCfg(defaultsOf(def))} title="Reset inputs to defaults">
            <RotateCcw className="size-3.5" /> Defaults
          </button>
          <button className="btn" onClick={() => (useStudyDefaults.getState().setDefault(def.id, cur.cfg), useUi.getState().toast({ title: 'Saved as default for new instances', tone: 'ok' }))}>
            Save as default
          </button>
          <button className="btn" onClick={() => (setDraft(null), close())}>Cancel</button>
          <button className="btn btn-primary" onClick={apply}>OK</button>
        </>
      }
    >
      <Tabs tabs={[{ id: 'inputs', label: 'Inputs' }, { id: 'style', label: 'Style' }, { id: 'visibility', label: 'Visibility' }]} value={tab} onChange={setTab}>
        <TabPanel value="inputs" className="p-4">
          <p className="mb-3 text-[11px] text-dim">{def.description}</p>
          {def.presets && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <span className="label">Presets</span>
              {Object.entries(def.presets).map(([name, patch]) => (
                <button key={name} className="btn h-6" onClick={() => setCfg(resolveConfig(def, { ...defaultsOf(def), ...patch }))}>
                  {name}
                </button>
              ))}
            </div>
          )}
          <SchemaForm schema={schema} value={cur.cfg} onChange={setCfg} />
        </TabPanel>
        <TabPanel value="style" className="p-4">
          <StyleTab def={def} cfg={cur.cfg} style={cur.style} onChange={(style) => setDraft({ ...cur, style })} />
        </TabPanel>
        <TabPanel value="visibility" className="p-4">
          <p className="mb-3 text-[11px] text-dim">Show this study only on the selected timeframes.</p>
          <div className="flex flex-col gap-2">
            {BUCKETS.map((b) => (
              <Switch key={b} label={b[0].toUpperCase() + b.slice(1)} checked={cur.visibility[b] !== false} onChange={(v) => setDraft({ ...cur, visibility: { ...cur.visibility, [b]: v } })} />
            ))}
          </div>
        </TabPanel>
      </Tabs>
    </Modal>
  );
}

/** Generic form from JSON Schema (zod → toJSONSchema). Groups by `group`, nested objects become fieldsets. */
export function SchemaForm({ schema, value, onChange }: { schema: JsonSchema; value: Record<string, unknown>; onChange(v: Record<string, unknown>): void }) {
  const props = Object.entries(schema.properties ?? {});
  const groups = new Map<string, [string, JsonSchema][]>();
  for (const [k, p] of props) {
    const g = p.type === 'object' ? (p.title ?? k) : (p.group ?? 'General');
    groups.set(g, [...(groups.get(g) ?? []), [k, p]]);
  }
  return (
    <div className="flex flex-col gap-4">
      {[...groups.entries()].map(([g, fields]) => (
        <fieldset key={g} className="rounded-md border border-border p-3">
          <legend className="px-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{g}</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map(([k, p]) =>
              p.type === 'object' ? (
                <div key={k} className="sm:col-span-2">
                  {p.verify && <VerifyNote note={String(p.verify)} />}
                  <SchemaForm schema={p} value={(value[k] as Record<string, unknown>) ?? {}} onChange={(v) => onChange({ ...value, [k]: v })} />
                </div>
              ) : (
                <SchemaField key={k} name={k} p={p} v={value[k]} onChange={(v) => onChange({ ...value, [k]: v })} />
              ),
            )}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function VerifyNote({ note }: { note: string }) {
  return (
    <div className="mb-2 flex items-start gap-1.5 rounded bg-warn/10 px-2 py-1 text-[11px] text-warn">
      <AlertTriangle className="mt-0.5 size-3 shrink-0" /> <span>⚠ VERIFY — {note}</span>
    </div>
  );
}

function SchemaField({ name, p, v, onChange }: { name: string; p: JsonSchema; v: unknown; onChange(v: unknown): void }) {
  const title = (
    <span className="flex items-center gap-1">
      {p.title ?? name}
      {p.verify && (
        <span className="cursor-help text-warn" title={`⚠ VERIFY — ${p.verify}`}>
          ⚠
        </span>
      )}
    </span>
  );
  const id = `f-${name}`;
  if (p.type === 'boolean')
    return (
      <div className="flex flex-col gap-1">
        <Switch id={id} checked={!!v} onChange={onChange} label={p.title ?? name} />
        {p.verify && <span className="text-[10px] text-warn">⚠ {String(p.verify)}</span>}
        {p.description && <span className="text-[10px] text-faint">{p.description}</span>}
      </div>
    );
  if (p.enum)
    return (
      <Field label={title} hint={p.description}>
        <select id={id} className="input" value={String(v)} onChange={(e) => onChange(e.target.value)}>
          {p.enum.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      </Field>
    );
  if (p.type === 'number' || p.type === 'integer')
    return (
      <Field label={title} hint={p.description}>
        <input
          id={id}
          className="input"
          type="number"
          min={p.minimum}
          max={p.maximum}
          step={p.step ?? (p.type === 'integer' ? 1 : 0.01)}
          value={Number.isFinite(v as number) ? (v as number) : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </Field>
    );
  return (
    <Field label={title} hint={p.description}>
      <input id={id} className="input" value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function StyleTab({ def, cfg, style, onChange }: { def: AnyStudyDef; cfg: Record<string, unknown>; style: Record<string, OutputStyle>; onChange(s: Record<string, OutputStyle>): void }) {
  const outs = def.outputs(cfg).filter((o) => o.kind === 'line' || o.kind === 'histogram' || o.kind === 'labels');
  if (!outs.length) return <p className="text-dim">This study draws markers only; colours follow the theme palette (Settings → colorblind-safe palette).</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Output</th>
          <th>Visible</th>
          <th>Colour</th>
          <th>Width</th>
        </tr>
      </thead>
      <tbody>
        {outs.map((o) => {
          const s = style[o.id] ?? {};
          const set = (patch: OutputStyle) => onChange({ ...style, [o.id]: { ...s, ...patch } });
          return (
            <tr key={o.id}>
              <td>{o.title}</td>
              <td>
                <Switch checked={s.visible !== false && !(o.kind === 'line' && o.hiddenByDefault && s.visible === undefined)} onChange={(v) => set({ visible: v })} />
              </td>
              <td>{o.kind !== 'labels' && <input type="color" className="h-6 w-10 cursor-pointer rounded border border-border bg-transparent" value={s.color ?? '#38bdf8'} onChange={(e) => set({ color: e.target.value })} aria-label={`${o.title} colour`} />}</td>
              <td>
                {o.kind === 'line' && (
                  <select className="input" value={s.width ?? o.width ?? 1} onChange={(e) => set({ width: Number(e.target.value) })}>
                    {[1, 2, 3, 4].map((w) => (
                      <option key={w}>{w}</option>
                    ))}
                  </select>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

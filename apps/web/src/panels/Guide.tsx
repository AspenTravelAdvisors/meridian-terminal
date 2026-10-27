import { useMemo, useRef, useState } from 'react';
import guide from '../../../../docs/WALKTHROUGH.md?raw';
import { Markdown } from '../lib/markdown';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The walkthrough (docs/WALKTHROUGH.md, bundled at build time) with a jump-to-section index and search. */
export function GuidePanel() {
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => {
    const out: { title: string; body: string }[] = [];
    let cur: { title: string; body: string } | null = null;
    for (const line of guide.split('\n')) {
      if (line.startsWith('## ')) {
        cur = { title: line.slice(3).trim(), body: '' };
        out.push(cur);
      } else if (cur) cur.body += `${line}\n`;
    }
    return out;
  }, []);
  const intro = guide.split('\n## ')[0];
  const needle = q.trim().toLowerCase();
  const shown = needle ? sections.filter((s) => `${s.title}\n${s.body}`.toLowerCase().includes(needle)) : sections;
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <input className="input flex-1" placeholder="Search the guide" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the guide" />
        <select
          className="input w-40 mobile:w-32"
          aria-label="Jump to section"
          value=""
          onChange={(e) => {
            // read the value now: React resets this controlled select before the next frame
            const id = e.target.value;
            setQ('');
            requestAnimationFrame(() => box.current?.querySelector(`#g-${id}`)?.scrollIntoView({ block: 'start' }));
          }}
        >
          <option value="">Go to…</option>
          {sections.map((s) => (
            <option key={s.title} value={slug(s.title)}>
              {s.title}
            </option>
          ))}
        </select>
      </div>
      <div ref={box} className="guide min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-relaxed">
        {!needle && <Markdown text={intro} />}
        {shown.map((s) => (
          <section key={s.title} id={`g-${slug(s.title)}`} className="scroll-mt-2">
            <Markdown text={`## ${s.title}\n${s.body}`} />
          </section>
        ))}
        {needle && !shown.length && <p className="text-dim">Nothing in the guide mentions “{q}”.</p>}
      </div>
    </div>
  );
}

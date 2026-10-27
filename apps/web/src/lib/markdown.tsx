import { Fragment, type ReactNode } from 'react';
import { unwrap } from './unwrap';

/** Minimal, safe Markdown renderer for analyst briefings (no HTML passthrough). */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|(?<![\w])_[^_\s][^_]*_(?![\w])|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const id = `${key}-${k++}`;
    if (t.startsWith('**')) out.push(<strong key={id}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={id} className="rounded bg-raised px-1 text-[0.9em]">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(t)!;
      out.push(<a key={id} href={mm[2]} target="_blank" rel="noreferrer noopener" className="text-accent underline">{mm[1]}</a>);
    } else out.push(<em key={id}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Block-level Markdown: headings, lists, quotes, rules, pipe tables and fenced code. No raw HTML is ever rendered. */
export function Markdown({ text }: { text: string }) {
  const lines = unwrap(text);
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;
  let code: string[] | null = null;
  const flush = (k: number) => {
    if (list) {
      const items = list.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>);
      blocks.push(list.ordered ? <ol key={`l${k}`} className="my-1 ml-5 list-decimal">{items}</ol> : <ul key={`l${k}`} className="my-1 ml-5 list-disc">{items}</ul>);
      list = null;
    }
    if (table) {
      const [head, ...body] = table;
      blocks.push(
        <div key={`t${k}`} className="my-2 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c, `${k}-h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} className="align-top">{inline(c, `${k}-${i}-${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      table = null;
    }
  };
  lines.forEach((ln, k) => {
    if (code) {
      if (ln.trim().startsWith('```')) {
        blocks.push(<pre key={`c${k}`} className="my-2 overflow-x-auto rounded bg-raised p-2 font-mono text-[11px] leading-5">{code.join('\n')}</pre>);
        code = null;
      } else code.push(ln);
      return;
    }
    if (ln.trim().startsWith('```')) {
      flush(k);
      code = [];
      return;
    }
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      if (list) flush(k);
      if (/^\s*\|[\s:|-]+\|\s*$/.test(ln)) return; // header separator row
      (table ??= []).push(cells(ln));
      return;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(ln);
    const ul = /^\s*[-*]\s+(.*)$/.exec(ln);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(ln);
    if (ul || ol) {
      if (table) flush(k);
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flush(k);
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
      return;
    }
    flush(k);
    if (h) blocks.push(<div key={k} className={`mt-3 font-semibold ${h[1].length <= 2 ? 'text-[15px]' : 'text-[13px]'}`}>{inline(h[2], `${k}`)}</div>);
    else if (ln.startsWith('>')) blocks.push(<blockquote key={k} className="my-1 border-l-2 border-warn pl-2 text-dim">{inline(ln.replace(/^>\s?/, ''), `${k}`)}</blockquote>);
    else if (/^---+$/.test(ln.trim())) blocks.push(<hr key={k} className="my-2 border-border" />);
    else if (ln.trim()) blocks.push(<p key={k} className="my-1 leading-relaxed">{inline(ln, `${k}`)}</p>);
  });
  if (code) blocks.push(<pre key="c-end" className="my-2 overflow-x-auto rounded bg-raised p-2 font-mono text-[11px] leading-5">{(code as string[]).join('\n')}</pre>);
  flush(lines.length);
  return <Fragment>{blocks}</Fragment>;
}

/**
 * Join soft-wrapped lines the way Markdown does: a plain line continues the paragraph above it, an indented line continues
 * the list item above it, and consecutive `>` lines form one quote. Block starts (headings, items, tables, fences) never join.
 */
export function unwrap(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  const blockStart = (l: string) => /^\s*$|^#{1,4}\s|^\s*([-*]|\d+[.)])\s|^\s*\||^```|^---+\s*$/.test(l);
  for (const ln of text.split('\n')) {
    if (ln.trim().startsWith('```')) fenced = !fenced;
    const prev = out[out.length - 1];
    const inFence = fenced && !ln.trim().startsWith('```');
    if (!inFence && prev !== undefined && prev.trim() && !prev.trim().startsWith('```') && !/^\s*\|/.test(prev) && !/^#{1,4}\s|^---+\s*$/.test(prev)) {
      if (ln.startsWith('>') && prev.startsWith('>')) {
        out[out.length - 1] = `${prev} ${ln.replace(/^>\s?/, '')}`;
        continue;
      }
      if (!ln.startsWith('>') && !prev.startsWith('>') && !blockStart(ln)) {
        out[out.length - 1] = `${prev} ${ln.trim()}`;
        continue;
      }
      // an indented line under a list item continues that item
      if (/^\s{2,}\S/.test(ln) && !/^\s*([-*]|\d+[.)])\s/.test(ln) && /^\s*([-*]|\d+[.)])\s/.test(prev)) {
        out[out.length - 1] = `${prev} ${ln.trim()}`;
        continue;
      }
    }
    out.push(ln);
  }
  return out;
}

import { describe, expect, it } from 'vitest';
import { unwrap } from '../src/lib/unwrap';

describe('Markdown soft-wrap joining', () => {
  it('joins a wrapped paragraph and keeps blank-line breaks', () => {
    expect(unwrap('one two\nthree\n\nnext para')).toEqual(['one two three', '', 'next para']);
  });
  it('joins wrapped quote lines into one quote', () => {
    expect(unwrap('> a\n> b\nafter')).toEqual(['> a b', 'after']);
  });
  it('continues list items with indented lines but starts new items', () => {
    expect(unwrap('- first\n  continued\n- second')).toEqual(['- first continued', '- second']);
  });
  it('never joins headings, tables or fenced code', () => {
    expect(unwrap('## Title\ntext')).toEqual(['## Title', 'text']);
    expect(unwrap('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual(['| a | b |', '|---|---|', '| 1 | 2 |']);
    expect(unwrap('```\nconst a = 1\nconst b = 2\n```')).toEqual(['```', 'const a = 1', 'const b = 2', '```']);
  });
});

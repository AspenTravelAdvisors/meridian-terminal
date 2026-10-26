import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Bar, computeStudy, getStudy, resolveConfig } from '../src';

/**
 * Golden-reference harness (INDICATORS.md §0).
 *   fixtures/<study-id>/<SYMBOL>_<interval>.csv   columns: t,o,h,l,c,v + expected output columns
 *   fixtures/<study-id>/<SYMBOL>_<interval>.json  optional study config for that fixture
 * Expected columns are compared bar-for-bar against the study's `golden()` mapping. Empty cells are skipped.
 */
const ROOT = join(__dirname, '../../../fixtures');
const TOL = 1e-6;

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const header = lines[0].split(',').map((h) => h.trim());
  return { header, rows: lines.slice(1).map((l) => l.split(',').map((c) => c.trim())) };
}

const studies = existsSync(ROOT) ? readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];

describe('golden fixtures', () => {
  it('fixtures directory exists', () => expect(existsSync(ROOT)).toBe(true));
  for (const dir of studies) {
    const def = getStudy(dir.name);
    for (const file of readdirSync(join(ROOT, dir.name)).filter((f) => f.endsWith('.csv'))) {
      it(`${dir.name} / ${file}`, () => {
        expect(def, `unknown study id "${dir.name}"`).toBeTruthy();
        expect(def!.golden, `${dir.name} has no golden() mapping`).toBeTruthy();
        const { header, rows } = parseCsv(readFileSync(join(ROOT, dir.name, file), 'utf8'));
        const col = (name: string) => header.indexOf(name);
        const bars: Bar[] = rows.map((r) => ({ t: Number(r[col('t')]), o: +r[col('o')], h: +r[col('h')], l: +r[col('l')], c: +r[col('c')], v: +r[col('v')] || 0 }));
        const cfgPath = join(ROOT, dir.name, file.replace(/\.csv$/, '.json'));
        const cfg = resolveConfig(def!, existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {});
        const res = computeStudy(def!, cfg, bars);
        const expectedCols = header.filter((h) => !['t', 'o', 'h', 'l', 'c', 'v'].includes(h));
        const mismatches: string[] = [];
        rows.forEach((r, i) => {
          const got = def!.golden!(res, i);
          for (const name of expectedCols) {
            const cell = r[col(name)];
            if (cell === '' || cell === undefined) continue;
            const exp = cell.toLowerCase() === 'nan' ? NaN : Number(cell);
            const act = got[name];
            const ok = Number.isNaN(exp) ? Number.isNaN(act) : Math.abs(act - exp) <= TOL * Math.max(1, Math.abs(exp));
            if (!ok) mismatches.push(`bar ${i} (t=${r[col('t')]}) ${name}: expected ${exp}, got ${act}`);
          }
        });
        // Per INDICATORS §0: any mismatch → VERIFY_LOG entry (bar, expected, actual, suspected rule) before changing defaults.
        expect(mismatches.slice(0, 20)).toEqual([]);
      });
    }
  }
});

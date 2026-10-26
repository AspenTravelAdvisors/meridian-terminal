import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type AnyStudyDef, type Bar, Engine, STUDIES, type StudyResult, computeStudy, defaultsOf, inputsSchema } from '../src';
import { arbBars } from './helpers';

const same = (a: number, b: number) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));

function auxFor(def: AnyStudyDef, cfg: Record<string, unknown>, bars: Bar[]): Record<string, Float64Array> | undefined {
  const names = def.needsAux?.(cfg) ?? [];
  if (!names.length) return undefined;
  const aux: Record<string, Float64Array> = {};
  // a deterministic "benchmark": smoothed version of the series itself
  for (const n of names) aux[n] = Float64Array.from(bars, (b, i) => b.c * (1 + 0.1 * Math.sin(i / 9)));
  return aux;
}

function sliceAux(aux: Record<string, Float64Array> | undefined, n: number) {
  if (!aux) return undefined;
  return Object.fromEntries(Object.entries(aux).map(([k, v]) => [k, v.slice(0, n)]));
}

const key = (r: StudyResult, cut: number) => ({
  markers: r.markers
    .filter((m) => m.at < cut)
    .map((m) => `${m.i}|${m.at}|${m.text}|${m.pos}|${m.row}|${m.style}`)
    .sort(),
  signals: r.signals
    .filter((s) => s.i < cut)
    .map((s) => `${s.i}|${s.id}|${s.dir}|${s.price}`)
    .sort(),
});

describe.each(STUDIES.map((d) => [d.id, d] as const))('%s', (_id, def) => {
  const cfg = defaultsOf(def);

  it('has a schema that parses {} and produces a JSON schema for the Inputs tab', () => {
    expect(() => def.schema.parse({})).not.toThrow();
    const js = inputsSchema(def);
    expect(js.type).toBe('object');
    for (const v of def.verify ?? []) expect(Object.keys(js.properties ?? {})).toContain(v.key);
  });

  it('never looks ahead: outputs on a prefix equal the same bars’ outputs on the full series', () => {
    fc.assert(
      fc.property(arbBars(40, 220), fc.nat(), (bars, seed) => {
        const cut = 10 + (seed % (bars.length - 10));
        const aux = auxFor(def, cfg, bars);
        const full = computeStudy(def, cfg, bars, { aux, intervalMs: 60_000 });
        const pre = computeStudy(def, cfg, bars.slice(0, cut), { aux: sliceAux(aux, cut), intervalMs: 60_000 });
        for (const id of Object.keys(pre.lines))
          for (let i = 0; i < cut; i++) if (!same(pre.lines[id][i], full.lines[id][i])) throw new Error(`line ${id} differs at bar ${i} (cut ${cut})`);
        expect(key(full, cut)).toEqual(key(pre, cut));
      }),
      { numRuns: 40 },
    );
  });

  it('provisional bars never mutate committed state and match a final bar with the same values', () => {
    fc.assert(
      fc.property(arbBars(40, 160), fc.nat(), (bars, seed) => {
        const cut = 10 + (seed % (bars.length - 11));
        const aux = auxFor(def, cfg, bars);
        const eng = new Engine([{ def, cfg }], 60_000);
        if (aux) for (const [k, v] of Object.entries(aux)) eng.store.setAux(k, v);
        for (let i = 0; i < cut; i++) eng.update(bars[i]);
        // realistic ticks of the forming bar: the range only ever expands toward its final high/low…
        const live = bars[cut];
        eng.update({ ...live, h: live.o, l: live.o, c: live.o, v: 0, final: false });
        eng.update({ ...live, h: (live.o + live.h) / 2, l: (live.o + live.l) / 2, c: (live.o + live.c) / 2, v: live.v / 2, final: false });
        // …then the real forming values, provisionally
        eng.update({ ...live, final: false });
        const prov = eng.results()[0];
        // committing the same values must give exactly the provisional outputs for that bar
        eng.update({ ...live, final: true });
        const fin = eng.results()[0];
        for (const id of Object.keys(fin.lines))
          for (let i = 0; i <= cut; i++) if (!same(prov.lines[id][i], fin.lines[id][i])) throw new Error(`line ${id} bar ${i}: provisional ≠ final`);
        expect(key(prov, cut + 1)).toEqual(key(fin, cut + 1));
        // and equal a fresh run over the same final bars (ticks left no residue) — except for studies whose
        // output legitimately depends on intrabar tick order
        if (def.intrabar) return;
        const fresh = computeStudy(def, cfg, bars.slice(0, cut + 1), { aux: sliceAux(aux, cut + 1), intervalMs: 60_000 });
        for (const id of Object.keys(fin.lines)) for (let i = 0; i <= cut; i++) if (!same(fresh.lines[id][i], fin.lines[id][i])) throw new Error(`residue in ${id} at ${i}`);
        expect(key(fresh, cut + 1)).toEqual(key(fin, cut + 1));
      }),
      { numRuns: 25 },
    );
  });

  it('is deterministic (byte-identical output for identical input)', () => {
    const bars = fc.sample(arbBars(150, 150), { numRuns: 1, seed: 7 })[0];
    const aux = auxFor(def, cfg, bars);
    const ser = (r: StudyResult) => JSON.stringify({ ...r, lines: Object.fromEntries(Object.entries(r.lines).map(([k, v]) => [k, Array.from(v, (x) => (Number.isNaN(x) ? 'NaN' : x))])) });
    expect(ser(computeStudy(def, cfg, bars, { aux }))).toBe(ser(computeStudy(def, cfg, bars, { aux })));
  });
});

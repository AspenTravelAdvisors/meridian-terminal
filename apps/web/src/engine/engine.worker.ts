/// <reference lib="webworker" />
import { type Bar, Engine, type InspectRow, type StudyResult, computeStudies, getStudy, resolveConfig } from '@meridian/engine';

export type EngineStudy = { key: string; id: string; cfg: Record<string, unknown> };
export type EngineRequest =
  | { type: 'load'; seq: number; studies: EngineStudy[]; bars: Bar[]; intervalMs: number; aux?: Record<string, number[]> }
  | { type: 'append'; seq: number; bars: Bar[] }
  | { type: 'inspect'; seq: number; i: number };
export type EngineResponse =
  | { type: 'results'; seq: number; results: StudyResult[]; ms: number; len: number }
  | { type: 'inspect'; seq: number; i: number; rows: InspectRow[] }
  | { type: 'error'; seq: number; message: string };

let engine: Engine | null = null;
let studies: EngineStudy[] = [];
let bars: Bar[] = [];
let intervalMs = 0;
let aux: Record<string, Float64Array> = {};

function build(): Engine {
  const reqs = studies.flatMap((s) => {
    const def = getStudy(s.id);
    return def ? [{ def, cfg: resolveConfig(def, s.cfg), key: s.key }] : [];
  });
  const e = new Engine(reqs, intervalMs);
  for (const [k, v] of Object.entries(aux)) e.store.setAux(k, v);
  return e;
}

function post(seq: number, t0: number) {
  const results = engine!.results();
  const transfer: Transferable[] = [];
  for (const r of results) for (const v of Object.values(r.lines)) transfer.push(v.buffer);
  const msg: EngineResponse = { type: 'results', seq, results, ms: performance.now() - t0, len: engine!.length };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<EngineRequest>) => {
  const m = ev.data;
  const t0 = performance.now();
  try {
    if (m.type === 'load') {
      studies = m.studies;
      bars = m.bars;
      intervalMs = m.intervalMs;
      aux = Object.fromEntries(Object.entries(m.aux ?? {}).map(([k, v]) => [k, Float64Array.from(v)]));
      engine = build();
      engine.load(bars);
      post(m.seq, t0);
    } else if (m.type === 'append') {
      if (!engine) return;
      for (const b of m.bars) {
        engine.update(b);
        const last = bars[bars.length - 1];
        if (!last || b.t > last.t) bars.push(b);
        else if (b.t === last.t) bars[bars.length - 1] = b;
      }
      post(m.seq, t0);
    } else if (m.type === 'inspect') {
      // deterministic: re-run the DeMark-style studies on bars[0..i] with the inspector enabled at bar i
      const reqs = studies.flatMap((s) => {
        const def = getStudy(s.id);
        return def && (def.category === 'DeMark' || def.category === 'Meridian' || def.category === 'Ichimoku') ? [{ def, cfg: resolveConfig(def, s.cfg), key: s.key }] : [];
      });
      const slice = bars.slice(0, m.i + 1).map((b) => ({ ...b, final: true }));
      const res = computeStudies(reqs, slice, { inspectAt: m.i, intervalMs, aux: Object.fromEntries(Object.entries(aux).map(([k, v]) => [k, v.slice(0, m.i + 1)])) });
      const rows = res.flatMap((r) => (r.inspect ?? []).map((row) => ({ ...row, study: r.id })));
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'inspect', seq: m.seq, i: m.i, rows } satisfies EngineResponse);
    }
  } catch (e) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'error', seq: m.seq, message: e instanceof Error ? e.message : String(e) } satisfies EngineResponse);
  }
};

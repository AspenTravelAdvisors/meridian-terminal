/// <reference lib="webworker" />
import {
  type AlertContext,
  type AlertSpec,
  type Bar,
  evaluateAlert,
  type MatrixWeights,
  type StrategyConfig,
  type TestEvent,
  computeStudies,
  computeStudy,
  eventStudy,
  getStudy,
  matrixCell,
  resolveConfig,
  runStrategy,
  scanBars,
} from '@meridian/engine';

/** Generic off-main-thread compute for panels: screener, MTF matrix, signal tester, alerts, status cards. */
export type ComputeOp =
  | { op: 'matrix'; bars: Bar[]; weights?: MatrixWeights }
  | { op: 'scan'; symbol: string; bars: Bar[]; studies: { id: string; cfg?: Record<string, unknown> }[]; lookback: number; signals?: string[] }
  | { op: 'events'; bars: Bar[]; study: string; cfg?: Record<string, unknown>; signals: string[] }
  | { op: 'eventStudy'; bars: Bar[]; events: TestEvent[]; horizons: number[]; seed: number; samples: number }
  | { op: 'strategy'; bars: Bar[]; config: StrategyConfig }
  | { op: 'evaluate'; bars: Bar[]; studies: { key: string; id: string; cfg?: Record<string, unknown> }[] }
  | { op: 'lines'; bars: Bar[]; study: string; cfg?: Record<string, unknown>; outputs: string[] }
  | { op: 'statuses'; bars: Bar[]; studies: { key: string; id: string; cfg?: Record<string, unknown> }[] }
  | { op: 'alert'; alert: AlertSpec; bars: Bar[]; ctx: AlertContext };

function run(m: ComputeOp): unknown {
  switch (m.op) {
    case 'matrix':
      return matrixCell(m.bars, m.weights);
    case 'scan':
      return scanBars(m.symbol, m.bars, m.studies, { lookback: m.lookback, signals: m.signals });
    case 'events': {
      const def = getStudy(m.study);
      if (!def) throw new Error(`unknown study ${m.study}`);
      const r = computeStudy(def, resolveConfig(def, m.cfg ?? {}), m.bars);
      const want = new Set(m.signals);
      // risk lines double as stop levels for the strategy tester
      return { events: r.signals.filter((s) => want.has(s.id)).map((s) => ({ i: s.i, dir: s.dir, id: s.id })), lines: { riskBuy: r.lines.cdrisk_buy ?? r.lines.risk_buy, riskSell: r.lines.cdrisk_sell ?? r.lines.risk_sell } };
    }
    case 'eventStudy':
      return eventStudy(m.bars, m.events, m.horizons, { seed: m.seed, baselineSamples: m.samples });
    case 'strategy': {
      const r = runStrategy(m.bars, m.config);
      return { ...r, equity: Array.from(r.equity) };
    }
    case 'lines': {
      const def = getStudy(m.study);
      if (!def) throw new Error(`unknown study ${m.study}`);
      const r = computeStudy(def, resolveConfig(def, m.cfg ?? {}), m.bars);
      return Object.fromEntries(m.outputs.map((o) => [o, Array.from(r.lines[o] ?? [])]));
    }
    case 'alert':
      return evaluateAlert(m.alert, m.bars, m.ctx);
    case 'statuses': {
      const reqs = m.studies.flatMap((s) => {
        const def = getStudy(s.id);
        return def ? [{ def, cfg: resolveConfig(def, s.cfg ?? {}), key: s.key }] : [];
      });
      return computeStudies(reqs, m.bars).map((r) => ({ key: r.id, status: r.status, signals: r.signals.slice(-40) }));
    }
    case 'evaluate': {
      const reqs = m.studies.flatMap((s) => {
        const def = getStudy(s.id);
        return def ? [{ def, cfg: resolveConfig(def, s.cfg ?? {}), key: s.key }] : [];
      });
      const res = computeStudies(reqs, m.bars);
      const n = m.bars.length;
      return res.map((r) => ({
        key: r.id,
        status: r.status,
        signals: r.signals.filter((s) => s.i >= n - 3),
        last: Object.fromEntries(Object.entries(r.lines).map(([k, v]) => [k, [v[n - 2], v[n - 1]]])),
      }));
    }
  }
}

self.onmessage = (ev: MessageEvent<{ id: number; req: ComputeOp }>) => {
  try {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id: ev.data.id, ok: true, value: run(ev.data.req) });
  } catch (e) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id: ev.data.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};

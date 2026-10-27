import type { Bar, InspectRow, StudyResult } from '@meridian/engine';
import type { EngineRequest, EngineResponse, EngineStudy } from './engine.worker';

type Listener = (r: { results: StudyResult[]; ms: number; len: number }) => void;

/** One worker per visible chart pane (SPEC §4). Latest request wins; stale results are dropped. */
export class EngineClient {
  private w: Worker;
  private seq = 0;
  private latest = 0;
  private inspectWaiters = new Map<number, (rows: InspectRow[]) => void>();
  onResults: Listener | null = null;
  onError: ((msg: string) => void) | null = null;

  constructor() {
    this.w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'meridian-engine' });
    this.w.onmessage = (ev: MessageEvent<EngineResponse>) => {
      const m = ev.data;
      if (m.type === 'results') {
        if (m.seq >= this.latest) this.onResults?.(m);
      } else if (m.type === 'inspect') {
        this.inspectWaiters.get(m.seq)?.(m.rows);
        this.inspectWaiters.delete(m.seq);
      } else this.onError?.(m.message);
    };
  }

  private send(m: EngineRequest) {
    this.w.postMessage(m);
  }

  load(studies: EngineStudy[], bars: Bar[], intervalMs: number, aux?: Record<string, number[]>) {
    const seq = ++this.seq;
    this.latest = seq;
    this.send({ type: 'load', seq, studies, bars, intervalMs, aux });
  }

  append(bars: Bar[]) {
    const seq = ++this.seq;
    this.latest = seq;
    this.send({ type: 'append', seq, bars });
  }

  inspect(i: number): Promise<InspectRow[]> {
    const seq = ++this.seq;
    return new Promise((res) => {
      this.inspectWaiters.set(seq, res);
      this.send({ type: 'inspect', seq, i });
      setTimeout(() => {
        if (this.inspectWaiters.has(seq)) {
          this.inspectWaiters.delete(seq);
          res([]);
        }
      }, 4000);
    });
  }

  dispose() {
    this.w.terminate();
  }
}

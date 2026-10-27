import type { ComputeOp } from './compute.worker';

/** Small pool of compute workers shared by all panels. */
const POOL = Math.max(1, Math.min(3, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4) - 1));
let workers: Worker[] = [];
let next = 0;
let id = 0;
const waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();

function pool(): Worker[] {
  if (!workers.length)
    workers = Array.from({ length: POOL }, () => {
      const w = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module', name: 'meridian-compute' });
      w.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: string }>) => {
        const h = waiting.get(ev.data.id);
        if (!h) return;
        waiting.delete(ev.data.id);
        if (ev.data.ok) h.res(ev.data.value);
        else h.rej(new Error(ev.data.error));
      };
      return w;
    });
  return workers;
}

export function compute<T>(req: ComputeOp): Promise<T> {
  const ws = pool();
  const w = ws[next++ % ws.length];
  const myId = ++id;
  return new Promise<T>((res, rej) => {
    waiting.set(myId, { res: res as (v: unknown) => void, rej });
    w.postMessage({ id: myId, req });
  });
}

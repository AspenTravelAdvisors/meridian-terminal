/// <reference lib="webworker" />
import { type Bar, checkScriptLookAhead, runScript } from '@meridian/engine';

// Lock the sandbox down before any user code runs: no network, storage, nested workers or messaging.
const g = self as unknown as Record<string, unknown>;
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'Worker', 'SharedWorker', 'BroadcastChannel', 'navigator', 'location', 'Request', 'Response']) {
  try {
    Object.defineProperty(g, k, { value: undefined, configurable: false, writable: false });
  } catch {
    /* non-configurable in this browser — runScript also shadows these names */
  }
}
const send = (self as unknown as DedicatedWorkerGlobalScope).postMessage.bind(self);
self.onmessage = (ev: MessageEvent<{ code: string; bars: Bar[]; inputs: Record<string, number>; check: boolean }>) => {
  const { code, bars, inputs, check } = ev.data;
  const result = runScript(code, bars, inputs, () => performance.now());
  const lookAhead = check && !result.error ? checkScriptLookAhead(code, bars.slice(-3000), inputs) : null;
  send({ result, lookAhead });
};

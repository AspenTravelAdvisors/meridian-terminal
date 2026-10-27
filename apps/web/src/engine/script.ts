import type { Bar, ScriptResult } from '@meridian/engine';

/** Run a Meridian Script in a fresh, locked-down worker with a hard time budget (terminated on timeout). */
export function runScriptSandboxed(code: string, bars: Bar[], inputs: Record<string, number>, opts: { check?: boolean; timeoutMs?: number } = {}): Promise<{ result: ScriptResult; lookAhead: { ok: boolean; bar?: number; plot?: string } | null }> {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module', name: 'meridian-script' });
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ result: { name: 'Custom script', overlay: true, plots: [], hlines: [], signals: [], inputs: [], ms: opts.timeoutMs ?? 3000, error: `time budget exceeded (${opts.timeoutMs ?? 3000} ms) — script terminated` }, lookAhead: null });
    }, opts.timeoutMs ?? 3000);
    w.onmessage = (ev) => {
      clearTimeout(timer);
      w.terminate();
      resolve(ev.data);
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      w.terminate();
      resolve({ result: { name: 'Custom script', overlay: true, plots: [], hlines: [], signals: [], inputs: [], ms: 0, error: e.message || 'worker error' }, lookAhead: null });
    };
    w.postMessage({ code, bars, inputs, check: opts.check ?? false });
  });
}

import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import { type Bar, SCRIPT_API_SOURCE } from '@meridian/engine';
import { type QuickJSWASMModule, newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';

/**
 * Runs a Meridian Script on the server for background alerts. Scripts are user code, so they never run in the
 * function's own JavaScript engine: each run gets a fresh QuickJS interpreter (WebAssembly) with no I/O, no
 * modules and no host objects, a memory cap and a wall-clock deadline. Only bars, inputs and the script API go in;
 * only signals come out, as JSON.
 */
let mod: Promise<QuickJSWASMModule> | null = null;
/**
 * QuickJS's per-runtime limit does not cover every allocation (large array storage bypasses it), so the whole
 * interpreter gets a WebAssembly memory with a hard maximum: a runaway script fails inside the sandbox instead of
 * growing the function's memory.
 */
const WASM_MAX_BYTES = 192 * 1024 * 1024;

const DRIVER = `
const __build = (${SCRIPT_API_SOURCE});
(function (code, barsJson, inputsJson) {
  const out = { name: 'Custom script', overlay: true, plots: [], hlines: [], signals: [], inputs: [], ms: 0 };
  try {
    const api = __build(JSON.parse(barsJson), JSON.parse(inputsJson), out);
    const names = Object.keys(api);
    const fn = new Function(...names, "'use strict';\\n" + code + "\\n");
    fn(...names.map((k) => api[k]));
  } catch (e) {
    out.error = e && e.message ? String(e.message) : String(e);
  }
  return JSON.stringify({ name: out.name, error: out.error, signals: out.signals });
})`;

export interface SandboxResult {
  name: string;
  error?: string;
  signals: { i: number; id: string; dir: string; text: string }[];
}

export async function runScriptIsolated(code: string, bars: readonly Bar[], inputs: Record<string, number> = {}, opts: { timeoutMs?: number; memoryBytes?: number } = {}): Promise<SandboxResult> {
  if (code.length > 50_000) return { name: 'Custom script', error: 'script too long', signals: [] };
  mod ??= newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: WASM_MAX_BYTES / 65536 }) }));
  const qjs = await mod;
  const rt = qjs.newRuntime();
  rt.setMemoryLimit(opts.memoryBytes ?? 64 * 1024 * 1024);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (opts.timeoutMs ?? 1500)));
  const vm = rt.newContext();
  try {
    const fnRes = vm.evalCode(DRIVER, 'meridian-script-driver.js');
    if (fnRes.error) {
      const err = vm.dump(fnRes.error);
      fnRes.error.dispose();
      return { name: 'Custom script', error: `sandbox: ${JSON.stringify(err)}`, signals: [] };
    }
    const fn = fnRes.value;
    const slim = bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    const args = [vm.newString(code), vm.newString(JSON.stringify(slim)), vm.newString(JSON.stringify(inputs))];
    const call = vm.callFunction(fn, vm.undefined, ...args);
    args.forEach((a) => a.dispose());
    fn.dispose();
    if (call.error) {
      const err = vm.dump(call.error) as { message?: string } | string;
      call.error.dispose();
      const msg = typeof err === 'string' ? err : (err?.message ?? 'script failed');
      return { name: 'Custom script', error: /interrupted/i.test(msg) ? 'time budget exceeded — script stopped' : msg, signals: [] };
    }
    const text = vm.getString(call.value);
    call.value.dispose();
    return JSON.parse(text) as SandboxResult;
  } finally {
    vm.dispose();
    rt.dispose();
  }
}

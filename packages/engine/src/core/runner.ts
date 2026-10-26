import type {
  AnyStudyDef,
  Bar,
  InspectRow,
  Marker,
  OutputSpec,
  SeriesCtx,
  SignalDir,
  SignalEvent,
  StudyResult,
  Writer,
} from './types';

const INITIAL_CAP = 1024;

function grow(a: Float64Array, cap: number, fill = 0): Float64Array {
  const b = new Float64Array(cap);
  if (fill !== 0) b.fill(fill);
  b.set(a);
  return b;
}

/** Shared, append-only bar history. A single provisional slot may sit at index `finalLen`. */
export class SeriesStore {
  ctx: SeriesCtx;
  finalLen = 0;
  provisionalT: number | null = null;
  private cap = INITIAL_CAP;

  constructor(intervalMs = 0) {
    this.ctx = {
      t: new Float64Array(this.cap),
      o: new Float64Array(this.cap),
      h: new Float64Array(this.cap),
      l: new Float64Array(this.cap),
      c: new Float64Array(this.cap),
      v: new Float64Array(this.cap),
      len: 0,
      intervalMs,
      aux: {},
    };
  }

  /** Pre-size history (avoids repeated regrowth when the bar count is known). */
  reserve(n: number): void {
    this.ensure(n);
  }

  private ensure(n: number): void {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    const x = this.ctx;
    x.t = grow(x.t, cap);
    x.o = grow(x.o, cap);
    x.h = grow(x.h, cap);
    x.l = grow(x.l, cap);
    x.c = grow(x.c, cap);
    x.v = grow(x.v, cap);
    this.cap = cap;
  }

  write(i: number, b: Bar): void {
    this.ensure(i + 1);
    const x = this.ctx;
    x.t[i] = b.t;
    x.o[i] = b.o;
    x.h[i] = b.h;
    x.l[i] = b.l;
    x.c[i] = b.c;
    x.v[i] = b.v ?? 0;
  }

  setAux(name: string, values: Float64Array): void {
    this.ctx.aux[name] = values;
  }
}

class NoopRows {
  push(): void {}
}

/** One running study bound to a SeriesStore. */
export class StudyInstance {
  readonly outputs: OutputSpec[];
  readonly lineIds: string[];
  private lines: Float64Array[];
  private cap = INITIAL_CAP;
  private state: unknown;
  private provState: unknown = null;
  private markers: Marker[] = [];
  private signals: SignalEvent[] = [];
  private provMarkers: Marker[] = [];
  private provSignals: SignalEvent[] = [];
  private intra: Record<string, unknown> = {};
  private writer: Writer;
  private isProv = false;
  private rows: InspectRow[] | NoopRows = new NoopRows();
  /** highest index already written (a provisional slot may be re-evaluated and must be reset first) */
  private written = -1;
  inspectAt = -1;
  error: string | null = null;

  constructor(
    readonly def: AnyStudyDef,
    readonly cfg: Record<string, unknown>,
    readonly key: string = def.id,
  ) {
    this.outputs = def.outputs(cfg);
    this.lineIds = this.outputs.filter((o) => o.kind === 'line' || o.kind === 'histogram' || o.kind === 'data' || o.kind === 'labels').map((o) => o.id);
    this.lines = this.lineIds.map(() => new Float64Array(this.cap).fill(NaN));
    this.state = def.init(cfg);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const studyId = def.id;
    this.writer = {
      i: 0,
      provisional: false,
      inspecting: false,
      line(k, v) {
        self.lines[k][this.i] = v;
      },
      marker(m) {
        // callers always pass a fresh literal, so stamping it in place avoids a copy per marker
        const full = m as Marker;
        full.at = this.i;
        if (this.provisional) {
          full.provisional = true;
          self.provMarkers.push(full);
        } else self.markers.push(full);
      },
      signal(id: string, dir: SignalDir, price?: number, label?: string) {
        // one stable object shape for every event (fewer hidden-class transitions)
        const ev: SignalEvent = { i: this.i, id, dir, study: studyId, price, label, provisional: this.provisional || undefined };
        if (this.provisional) self.provSignals.push(ev);
        else self.signals.push(ev);
      },
      inspect(rule, pass, detail) {
        if (this.inspecting) (self.rows as InspectRow[]).push({ study: studyId, rule, pass, detail });
      },
    };
  }

  reserve(n: number): void {
    this.ensure(n);
  }

  private ensure(n: number): void {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    this.lines = this.lines.map((a) => grow(a, cap, NaN));
    this.cap = cap;
  }

  private prepare(i: number, provisional: boolean): void {
    this.ensure(i + 1);
    if (i <= this.written) for (const a of this.lines) a[i] = NaN;
    else this.written = i;
    this.writer.i = i;
    this.writer.provisional = provisional;
    this.writer.inspecting = i === this.inspectAt;
    if (this.writer.inspecting) this.rows = [];
  }

  commit(ctx: SeriesCtx, i: number): void {
    if (this.error) return;
    this.prepare(i, false);
    this.provMarkers = [];
    this.provSignals = [];
    this.provState = null;
    this.isProv = false;
    try {
      this.def.update(this.cfg, this.state, ctx, this.writer, this.intra);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    // reset intrabar scratch only if a study used it (avoids an allocation per bar per study)
    for (const _ in this.intra) {
      this.intra = {};
      break;
    }
  }

  provisional(ctx: SeriesCtx, i: number): void {
    if (this.error) return;
    this.prepare(i, true);
    this.provMarkers = [];
    this.provSignals = [];
    const fork = structuredClone(this.state);
    try {
      this.def.update(this.cfg, fork, ctx, this.writer, this.intra);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.provState = fork;
    this.isProv = true;
  }

  dropProvisional(): void {
    this.provMarkers = [];
    this.provSignals = [];
    this.provState = null;
    this.isProv = false;
    this.intra = {};
  }

  result(ctx: SeriesCtx): StudyResult {
    const len = ctx.len;
    const lines: Record<string, Float64Array> = {};
    this.lineIds.forEach((id, k) => (lines[id] = this.lines[k].slice(0, len)));
    const st = this.isProv ? this.provState : this.state;
    const res: StudyResult = {
      id: this.key,
      len,
      outputs: this.outputs,
      lines,
      markers: this.isProv ? this.markers.concat(this.provMarkers) : this.markers.slice(),
      signals: this.isProv ? this.signals.concat(this.provSignals) : this.signals.slice(),
      geometry: this.def.geometry && !this.error ? safe(() => this.def.geometry!(this.cfg, st, ctx), {}) : {},
      status: this.def.status && !this.error ? safe(() => this.def.status!(this.cfg, st, ctx), null) : null,
      provisional: this.isProv,
    };
    if (Array.isArray(this.rows)) res.inspect = this.rows;
    if (this.error) (res as StudyResult & { error?: string }).error = this.error;
    return res;
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export interface StudyRequest {
  def: AnyStudyDef;
  cfg: Record<string, unknown>;
  key?: string;
}

/**
 * Engine: a SeriesStore plus a set of study instances, updated bar by bar.
 *  - `update(bar)` with `final !== false` commits a closed bar (O(1) amortized per study).
 *  - `update(bar)` with `final === false` evaluates a provisional (forming) bar on forked state;
 *    committed state is never touched, so counts finalize only on bar close.
 */
export class Engine {
  readonly store: SeriesStore;
  readonly studies: StudyInstance[] = [];
  private lastProvBar: Bar | null = null;

  constructor(requests: StudyRequest[] = [], intervalMs = 0) {
    this.store = new SeriesStore(intervalMs);
    for (const r of requests) this.add(r);
  }

  add(r: StudyRequest): StudyInstance {
    if (this.store.finalLen > 0) throw new Error('add studies before pushing bars (or create a new Engine)');
    const inst = new StudyInstance(r.def, r.cfg, r.key ?? r.def.id);
    this.studies.push(inst);
    return inst;
  }

  reserve(n: number): void {
    this.store.reserve(n);
    for (const s of this.studies) s.reserve(n);
  }

  get length(): number {
    return this.store.ctx.len;
  }

  setInspectAt(i: number): void {
    for (const s of this.studies) s.inspectAt = i;
  }

  update(bar: Bar): void {
    const st = this.store;
    const ctx = st.ctx;
    const lastFinalT = st.finalLen > 0 ? ctx.t[st.finalLen - 1] : -Infinity;
    if (bar.t < lastFinalT) return; // stale / out-of-order — ignore
    if (bar.t === lastFinalT) return; // already committed; bars are immutable after close

    // A new bar arrived while an older provisional bar was pending and never finalized → commit it.
    if (this.lastProvBar && bar.t > this.lastProvBar.t) {
      const prev = this.lastProvBar;
      this.lastProvBar = null;
      this.commitBar({ ...prev, final: true });
    }

    if (bar.final === false) {
      const i = st.finalLen;
      st.write(i, bar);
      st.provisionalT = bar.t;
      ctx.len = i + 1;
      for (const s of this.studies) s.provisional(ctx, i);
      this.lastProvBar = bar;
    } else {
      this.lastProvBar = null;
      this.commitBar(bar);
    }
  }

  /**
   * Bulk-load closed bars: fill the shared history once, then run each study over all new bars in its own
   * tight loop (monomorphic and cache-friendly — markedly faster than interleaving studies per bar).
   * `ctx.len` is advanced per bar, exactly as in `update()`, so studies see the same history either way.
   * A trailing provisional bar (final === false) is routed through `update()`.
   */
  load(bars: readonly Bar[]): void {
    const st = this.store;
    const ctx = st.ctx;
    let end = bars.length;
    const tail = end > 0 && bars[end - 1].final === false ? bars[end - 1] : null;
    if (tail) end--;
    if (this.lastProvBar) this.dropProvisional();
    const start = st.finalLen;
    const lastT = start > 0 ? ctx.t[start - 1] : -Infinity;
    let n = start;
    this.reserve(start + end + 1);
    for (let k = 0; k < end; k++) {
      const b = bars[k];
      if (b.t <= (n > start ? ctx.t[n - 1] : lastT)) continue; // skip stale / duplicate bars
      st.write(n++, b);
    }
    for (const s of this.studies)
      for (let i = start; i < n; i++) {
        ctx.len = i + 1;
        s.commit(ctx, i);
      }
    st.finalLen = n;
    ctx.len = n;
    if (tail) this.update(tail);
  }

  private commitBar(bar: Bar): void {
    const st = this.store;
    const ctx = st.ctx;
    const i = st.finalLen;
    st.write(i, bar);
    st.finalLen = i + 1;
    st.provisionalT = null;
    ctx.len = i + 1;
    for (const s of this.studies) s.commit(ctx, i);
  }

  /** Discard a pending provisional bar (e.g. replay stepping back). */
  dropProvisional(): void {
    if (this.lastProvBar) {
      this.lastProvBar = null;
      this.store.provisionalT = null;
      this.store.ctx.len = this.store.finalLen;
      for (const s of this.studies) s.dropProvisional();
    }
  }

  results(): StudyResult[] {
    return this.studies.map((s) => s.result(this.store.ctx));
  }
}

/** Convenience batch API: run one study over a bar array. */
export function computeStudy(
  def: AnyStudyDef,
  cfg: Record<string, unknown>,
  bars: readonly Bar[],
  opts: { inspectAt?: number; aux?: Record<string, Float64Array>; intervalMs?: number } = {},
): StudyResult {
  const eng = new Engine([{ def, cfg }], opts.intervalMs ?? 0);
  if (opts.aux) for (const [k, v] of Object.entries(opts.aux)) eng.store.setAux(k, v);
  if (opts.inspectAt !== undefined) eng.setInspectAt(opts.inspectAt);
  eng.load(bars);
  return eng.results()[0];
}

/** Run many studies over the same bars, sharing one history. */
export function computeStudies(
  reqs: StudyRequest[],
  bars: readonly Bar[],
  opts: { inspectAt?: number; aux?: Record<string, Float64Array>; intervalMs?: number } = {},
): StudyResult[] {
  const eng = new Engine(reqs, opts.intervalMs ?? 0);
  if (opts.aux) for (const [k, v] of Object.entries(opts.aux)) eng.store.setAux(k, v);
  if (opts.inspectAt !== undefined) eng.setInspectAt(opts.inspectAt);
  eng.load(bars);
  return eng.results();
}

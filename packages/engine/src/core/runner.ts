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

/**
 * Columnar signal store: a long run emits 100k+ events, and holding them as objects during the loop makes every
 * young-generation GC copy the whole growing list. Events are packed into typed arrays (strings interned per buffer)
 * and materialized once, when results are read.
 */
class SignalBuf {
  len = 0;
  private cap = 0;
  private at = new Int32Array(0);
  private code = new Uint16Array(0);
  private lab = new Int32Array(0);
  private px = new Float64Array(0);
  private readonly keys: string[] = [];
  private readonly dirs: SignalDir[] = [];
  private readonly bull = new Map<string, number>();
  private readonly bear = new Map<string, number>();
  private readonly neutral = new Map<string, number>();
  private lastId = '';
  private lastDir: SignalDir = 'neutral';
  private lastCode = 0;
  private readonly labels: string[] = [];
  private readonly labelIdx = new Map<string, number>();

  push(i: number, id: string, dir: SignalDir, price: number | undefined, label: string | undefined): void {
    if (this.len === this.cap) this.grow();
    const k = this.len++;
    this.at[k] = i;
    let c: number | undefined;
    // studies mostly repeat their last event id: an identity check beats a hash lookup
    if (id === this.lastId && dir === this.lastDir) c = this.lastCode;
    else {
      const map = dir === 'bull' ? this.bull : dir === 'bear' ? this.bear : this.neutral;
      c = map.get(id);
      if (c === undefined) {
        c = this.keys.length;
        this.keys.push(id);
        this.dirs.push(dir);
        map.set(id, c);
      }
      this.lastId = id;
      this.lastDir = dir;
      this.lastCode = c;
    }
    this.code[k] = c;
    this.px[k] = price === undefined ? NaN : price;
    if (label === undefined) this.lab[k] = -1;
    else {
      let l = this.labelIdx.get(label);
      if (l === undefined) {
        l = this.labels.length;
        this.labels.push(label);
        this.labelIdx.set(label, l);
      }
      this.lab[k] = l;
    }
  }

  private grow(): void {
    const cap = Math.max(256, this.cap * 2);
    const at = new Int32Array(cap);
    at.set(this.at);
    const code = new Uint16Array(cap);
    code.set(this.code);
    const lab = new Int32Array(cap);
    lab.set(this.lab);
    const px = new Float64Array(cap);
    px.set(this.px);
    Object.assign(this, { at, code, lab, px, cap });
  }

  /** Rebuild event objects in emission order (price/label are undefined when the study passed none). */
  materialize(study: string, provisional: boolean, out: SignalEvent[] = []): SignalEvent[] {
    for (let k = 0; k < this.len; k++) {
      const p = this.px[k];
      const l = this.lab[k];
      const c = this.code[k];
      out.push({ i: this.at[k], id: this.keys[c], dir: this.dirs[c], study, price: Number.isNaN(p) ? undefined : p, label: l < 0 ? undefined : this.labels[l], provisional: provisional || undefined });
    }
    return out;
  }

  clear(): void {
    this.len = 0;
  }
}

/** Interns a small set of repeated strings (marker text, colors, positions). */
class Interner {
  readonly values: string[] = [];
  private readonly idx = new Map<string, number>();
  of(v: string | undefined): number {
    if (v === undefined) return -1;
    let k = this.idx.get(v);
    if (k === undefined) {
      k = this.values.length;
      this.values.push(v);
      this.idx.set(v, k);
    }
    return k;
  }
}

/**
 * Columnar marker store (same motivation as SignalBuf). The caller's literal is read and dropped immediately,
 * which lets the optimizer skip allocating it; markers are rebuilt once when results are read.
 */
class MarkerBuf {
  len = 0;
  private cap = 0;
  private bar = new Int32Array(0);
  private at = new Int32Array(0);
  private small = new Int8Array(0); // row (−1 = unset) and size (0 = unset), interleaved
  private str = new Int32Array(0); // text, pos, color, style, interleaved (−1 = unset)
  private px = new Float64Array(0);
  private hasPx = new Uint8Array(0);
  private readonly tips: (string | undefined)[] = [];
  private readonly strings = new Interner();

  push(m: Omit<Marker, 'at' | 'provisional'>, at: number): void {
    if (this.len === this.cap) this.grow();
    const k = this.len++;
    this.bar[k] = m.i;
    this.at[k] = at;
    this.small[2 * k] = m.row === undefined ? -1 : m.row;
    this.small[2 * k + 1] = m.size === undefined ? 0 : m.size;
    const S = this.strings;
    this.str[4 * k] = S.of(m.text);
    this.str[4 * k + 1] = S.of(m.pos);
    this.str[4 * k + 2] = S.of(m.color);
    this.str[4 * k + 3] = S.of(m.style);
    if (m.price === undefined) this.hasPx[k] = 0;
    else {
      this.hasPx[k] = 1;
      this.px[k] = m.price;
    }
    this.tips.push(m.tooltip);
  }

  private grow(): void {
    const cap = Math.max(256, this.cap * 2);
    const copy = <T extends Int32Array | Int8Array | Float64Array | Uint8Array>(a: T, n: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a);
      return b;
    };
    this.bar = copy(this.bar, cap);
    this.at = copy(this.at, cap);
    this.small = copy(this.small, 2 * cap);
    this.str = copy(this.str, 4 * cap);
    this.px = copy(this.px, cap);
    this.hasPx = copy(this.hasPx, cap);
    this.cap = cap;
  }

  materialize(provisional: boolean, out: Marker[] = []): Marker[] {
    const V = this.strings.values;
    for (let k = 0; k < this.len; k++) {
      const m: Marker = { i: this.bar[k], at: this.at[k], text: V[this.str[4 * k]], pos: V[this.str[4 * k + 1]] as Marker['pos'], color: V[this.str[4 * k + 2]] as Marker['color'] };
      const row = this.small[2 * k];
      if (row >= 0) m.row = row;
      const size = this.small[2 * k + 1];
      if (size) m.size = size as 1 | 2 | 3;
      const st = this.str[4 * k + 3];
      if (st >= 0) m.style = V[st] as Marker['style'];
      if (this.hasPx[k]) m.price = this.px[k];
      const tip = this.tips[k];
      if (tip !== undefined) m.tooltip = tip;
      if (provisional) m.provisional = true;
      out.push(m);
    }
    return out;
  }

  clear(): void {
    this.len = 0;
    this.tips.length = 0;
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
  private cap = 0;
  private state: unknown;
  private provState: unknown = null;
  private markers = new MarkerBuf();
  private signals = new SignalBuf();
  private provMarkers = new MarkerBuf();
  private provSignals = new SignalBuf();
  private intra: Record<string, unknown> = {};
  private writer: Writer;
  private isProv = false;
  private rows: InspectRow[] | NoopRows = new NoopRows();
  /** highest index already written (a provisional slot may be re-evaluated and must be reset first) */
  private written = -1;
  private readonly usesIntra: boolean;
  inspectAt = -1;
  error: string | null = null;

  constructor(
    readonly def: AnyStudyDef,
    readonly cfg: Record<string, unknown>,
    readonly key: string = def.id,
  ) {
    this.outputs = def.outputs(cfg);
    this.lineIds = this.outputs.filter((o) => o.kind === 'line' || o.kind === 'histogram' || o.kind === 'data' || o.kind === 'labels').map((o) => o.id);
    this.lines = this.lineIds.map(() => new Float64Array(0)); // sized on first reserve/ensure
    this.state = def.init(cfg);
    this.usesIntra = !!def.intrabar;
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
        (this.provisional ? self.provMarkers : self.markers).push(m, this.i);
      },
      signal(id: string, dir: SignalDir, price?: number, label?: string) {
        (this.provisional ? self.provSignals : self.signals).push(this.i, id, dir, price, label);
      },
      inspect(rule, pass, detail) {
        if (this.inspecting) (self.rows as InspectRow[]).push({ study: studyId, rule, pass, detail });
      },
    };
  }

  /** Size output columns to exactly n (bulk loads know their length, so they never regrow). */
  reserve(n: number): void {
    if (n <= this.cap) return;
    this.lines = this.lines.map((a) => grow(a, n, NaN));
    this.cap = n;
  }

  private ensure(n: number): void {
    if (n <= this.cap) return;
    let cap = Math.max(INITIAL_CAP, this.cap);
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
    // provisional leftovers exist only after a provisional() call — skip two allocations per bar otherwise
    if (this.isProv) {
      this.provMarkers.clear();
      this.provSignals.clear();
      this.provState = null;
      this.isProv = false;
    }
    try {
      this.def.update(this.cfg, this.state, ctx, this.writer, this.intra);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    // intrabar scratch belongs to the bar that just closed; only intrabar studies write it
    if (this.usesIntra) this.intra = {};
  }

  provisional(ctx: SeriesCtx, i: number): void {
    if (this.error) return;
    this.prepare(i, true);
    this.provMarkers.clear();
    this.provSignals.clear();
    const fork = structuredClone(this.state);
    try {
      this.def.update(this.cfg, fork, ctx, this.writer, this.intra);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.provState = fork;
    this.isProv = true;
  }

  /**
   * Bulk path for `Engine.load`: commit bars [from, to) in one tight loop. Equivalent to calling `commit` per bar
   * (same writer, same ctx.len per bar), minus the per-bar bookkeeping that only matters for live updates.
   */
  commitRange(ctx: SeriesCtx, from: number, to: number): void {
    if (this.error || from >= to) return;
    if (this.isProv) {
      this.provMarkers.clear();
      this.provSignals.clear();
      this.provState = null;
      this.isProv = false;
    }
    this.ensure(to);
    const w = this.writer;
    const def = this.def;
    const cfg = this.cfg;
    const state = this.state;
    const inspectAt = this.inspectAt;
    w.provisional = false;
    // indexes at or below `written` were provisional slots and must be reset before being rewritten
    for (let i = from; i <= this.written && i < to; i++) for (const a of this.lines) a[i] = NaN;
    if (to - 1 > this.written) this.written = to - 1;
    let i = from;
    try {
      for (; i < to; i++) {
        ctx.len = i + 1;
        w.i = i;
        if (i === inspectAt) {
          w.inspecting = true;
          this.rows = [];
        } else w.inspecting = false;
        def.update(cfg, state, ctx, w, this.intra);
        if (this.usesIntra) this.intra = {};
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    w.inspecting = false;
  }

  dropProvisional(): void {
    this.provMarkers.clear();
    this.provSignals.clear();
    this.provState = null;
    this.isProv = false;
    this.intra = {};
  }

  /**
   * Snapshot the outputs. `release` hands the column buffers over without copying — only for one-shot engines that
   * are discarded right after (computeStudies); a live engine keeps writing into its columns.
   */
  result(ctx: SeriesCtx, release = false): StudyResult {
    const len = ctx.len;
    const lines: Record<string, Float64Array> = {};
    this.ensure(len);
    for (let k = 0; k < this.lineIds.length; k++) lines[this.lineIds[k]] = release ? this.lines[k].subarray(0, len) : this.lines[k].slice(0, len);
    const signals = this.signals.materialize(this.def.id, false);
    if (this.isProv) this.provSignals.materialize(this.def.id, true, signals);
    const markers = this.markers.materialize(false);
    if (this.isProv) this.provMarkers.materialize(true, markers);
    const st = this.isProv ? this.provState : this.state;
    const res: StudyResult = {
      id: this.key,
      len,
      outputs: this.outputs,
      lines,
      markers,
      signals,
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
    for (const s of this.studies) s.commitRange(ctx, start, n);
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

  /** `release` = the engine is discarded after this call, so output columns can be handed over without a copy. */
  results(release = false): StudyResult[] {
    return this.studies.map((s) => s.result(this.store.ctx, release));
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
  return eng.results(true)[0];
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
  return eng.results(true);
}

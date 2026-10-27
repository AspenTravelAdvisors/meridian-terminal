/** Cross-pane events: crosshair sync, time sync, snapshots. */
export interface CrosshairMsg {
  source: string;
  t: number | null;
  price?: number;
  symbol: string;
}
export interface RangeMsg {
  source: string;
  from: number;
  to: number;
}

type Fn<T> = (m: T) => void;
class Bus<T> {
  private subs = new Set<Fn<T>>();
  on(f: Fn<T>) {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
  emit(m: T) {
    for (const f of this.subs) f(m);
  }
}

export const crosshairBus = new Bus<CrosshairMsg>();
export const rangeBus = new Bus<RangeMsg>();

/** paneId → function returning a snapshot canvas of that chart (with a header). */
export const snapshotters = new Map<string, () => HTMLCanvasElement | null>();
/** paneId → imperative chart actions used by keyboard shortcuts / toolbar */
export const chartActions = new Map<string, { fit(): void; scroll(bars: number): void; zoom(f: number): void; cancelTool(): void; finishPath(): void; goTo(t: number): void }>();

// Time-series data structures for live dashboards. Pure (no DOM).

export interface TimePoint {
  /** Epoch milliseconds. */
  t: number;
  /** Value; null renders as a gap. */
  v: number | null;
}

/** Fixed-capacity FIFO: pushing beyond capacity drops the oldest item. */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private start = 0;
  private len = 0;

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new RangeError("RingBuffer capacity must be ≥ 1");
    this.buf = new Array(Math.floor(capacity));
  }

  get length(): number {
    return this.len;
  }

  push(item: T): void {
    const cap = this.buf.length;
    if (this.len < cap) {
      this.buf[(this.start + this.len) % cap] = item;
      this.len++;
    } else {
      this.buf[this.start] = item;
      this.start = (this.start + 1) % cap;
    }
  }

  /** Item at logical index (0 = oldest; negative counts from the newest). */
  at(i: number): T | undefined {
    if (i < 0) i += this.len;
    if (i < 0 || i >= this.len) return undefined;
    return this.buf[(this.start + i) % this.buf.length];
  }

  first(): T | undefined {
    return this.at(0);
  }

  last(): T | undefined {
    return this.at(-1);
  }

  toArray(): T[] {
    const out: T[] = new Array(this.len);
    for (let i = 0; i < this.len; i++) out[i] = this.buf[(this.start + i) % this.buf.length] as T;
    return out;
  }

  clear(): void {
    this.buf = new Array(this.buf.length);
    this.start = 0;
    this.len = 0;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.toArray()[Symbol.iterator]();
  }
}

export type ResetPolicy = "gap" | "restart";

/**
 * Per-second rate between two samples of a monotonically increasing counter.
 * - first sample / non-increasing time → undefined (no rate yet)
 * - counter decreased (server restart, failover) → null with policy "gap" (default),
 *   or cur/dt with policy "restart" (Prometheus semantics: counter restarted from 0)
 */
export function counterRate(prev: { t: number; v: number } | undefined, cur: { t: number; v: number }, reset: ResetPolicy = "gap"): number | null | undefined {
  if (!prev || !Number.isFinite(prev.v) || !Number.isFinite(cur.v)) return undefined;
  const dt = (cur.t - prev.t) / 1000;
  if (!(dt > 0)) return undefined;
  if (cur.v < prev.v) return reset === "restart" ? cur.v / dt : null;
  return (cur.v - prev.v) / dt;
}

/** Tracks the previous sample of several counters and converts new samples into rates. */
export class RateTracker<K extends string = string> {
  private prev = new Map<K, { t: number; v: number }>();

  constructor(private readonly reset: ResetPolicy = "gap") {}

  /**
   * Feed absolute counter values sampled at `t`. Returns per-second rates for counters that
   * have a previous sample (null where a reset was detected), omitting the first sample.
   */
  update(t: number, counters: Partial<Record<K, number | null | undefined>>): Partial<Record<K, number | null>> {
    const out: Partial<Record<K, number | null>> = {};
    for (const k of Object.keys(counters) as K[]) {
      const v = counters[k];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const r = counterRate(this.prev.get(k), { t, v }, this.reset);
      if (r !== undefined) out[k] = r;
      const p = this.prev.get(k);
      if (!p || t > p.t) this.prev.set(k, { t, v });
    }
    return out;
  }

  clear(): void {
    this.prev.clear();
  }
}

export interface SeriesStats {
  min: number;
  max: number;
  avg: number;
  last: number;
  count: number;
}

/** min/max/avg/last over the non-null values (undefined when there are none). */
export function seriesStats(points: readonly TimePoint[]): SeriesStats | undefined {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  let last = NaN;
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) continue;
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    sum += p.v;
    count++;
    last = p.v;
  }
  return count ? { min, max, avg: sum / count, last, count } : undefined;
}

/** Last non-null value. */
export function lastValue(points: readonly TimePoint[]): number | undefined {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i].v;
    if (v !== null && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Index of the point whose time is closest to `t` (points sorted by t). -1 when empty. */
export function nearestIndex(points: readonly TimePoint[], t: number): number {
  const n = points.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].t - t) <= Math.abs(points[lo].t - t)) return lo - 1;
  return lo;
}

/**
 * Reduce a long series to at most ~maxPoints by keeping the min and max of each bucket
 * (spikes survive, unlike plain sampling). Null gaps are preserved.
 */
export function decimate(points: readonly TimePoint[], maxPoints: number): TimePoint[] {
  if (points.length <= maxPoints || maxPoints < 4) return points.slice();
  const buckets = Math.floor(maxPoints / 2);
  const t0 = points[0].t;
  const span = points[points.length - 1].t - t0 || 1;
  const out: TimePoint[] = [];
  let bucket = -1;
  let lo: TimePoint | undefined;
  let hi: TimePoint | undefined;
  let gap = false;
  const flush = () => {
    if (lo && hi) {
      if (lo === hi) out.push(lo);
      else if (lo.t <= hi.t) out.push(lo, hi);
      else out.push(hi, lo);
    }
    if (gap) out.push({ t: out.length ? out[out.length - 1].t : t0, v: null });
    lo = hi = undefined;
    gap = false;
  };
  for (const p of points) {
    const b = Math.min(buckets - 1, Math.floor(((p.t - t0) / span) * buckets));
    if (b !== bucket) {
      flush();
      bucket = b;
    }
    if (p.v === null || !Number.isFinite(p.v)) {
      gap = true;
      continue;
    }
    if (!lo || p.v < (lo.v as number)) lo = p;
    if (!hi || p.v > (hi.v as number)) hi = p;
  }
  flush();
  return out;
}

/** Median spacing between consecutive timestamps (0 for < 2 points). */
export function medianInterval(points: readonly TimePoint[]): number {
  if (points.length < 2) return 0;
  const d: number[] = [];
  const step = Math.max(1, Math.floor(points.length / 200));
  for (let i = step; i < points.length; i += step) d.push(points[i].t - points[i - step].t);
  d.sort((a, b) => a - b);
  return d[d.length >> 1] / step;
}

/**
 * Rolling store of several named series sharing timestamps (one sample = one `push`).
 * Use with RateTracker (or `pushCounters`) to chart rates from cumulative server counters.
 */
export class TimeSeriesBuffer<K extends string = string> {
  private samples: RingBuffer<{ t: number; values: Partial<Record<K, number | null>> }>;
  private rates: RateTracker<K>;

  constructor(capacity: number, reset: ResetPolicy = "gap") {
    this.samples = new RingBuffer(capacity);
    this.rates = new RateTracker<K>(reset);
  }

  get length(): number {
    return this.samples.length;
  }

  get capacity(): number {
    return this.samples.capacity;
  }

  /** Append raw (gauge) values sampled at `t`. */
  push(t: number, values: Partial<Record<K, number | null | undefined>>): void {
    const clean: Partial<Record<K, number | null>> = {};
    for (const k of Object.keys(values) as K[]) {
      const v = values[k];
      clean[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    this.samples.push({ t, values: clean });
  }

  /**
   * Append cumulative counters sampled at `t`; stores per-second rates.
   * Returns false for the first sample (no rate yet) — nothing is stored then.
   */
  pushCounters(t: number, counters: Partial<Record<K, number | null | undefined>>): boolean {
    const r = this.rates.update(t, counters);
    if (!Object.keys(r).length) return false;
    this.samples.push({ t, values: r });
    return true;
  }

  /** Points for one key; samples without the key are skipped. `sinceMs` limits to a trailing window. */
  series(key: K, sinceMs?: number): TimePoint[] {
    const all = this.samples.toArray();
    const from = sinceMs !== undefined && all.length ? all[all.length - 1].t - sinceMs : -Infinity;
    const out: TimePoint[] = [];
    for (const s of all) {
      if (s.t < from || !(key in s.values)) continue;
      out.push({ t: s.t, v: s.values[key] ?? null });
    }
    return out;
  }

  last(key: K): number | undefined {
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const v = this.samples.at(i)?.values[key];
      if (typeof v === "number") return v;
    }
    return undefined;
  }

  /** Value `back` samples before the latest (1 = previous sample). */
  previous(key: K, back = 1): number | undefined {
    let seen = 0;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const v = this.samples.at(i)?.values[key];
      if (typeof v !== "number") continue;
      if (seen === back) return v;
      seen++;
    }
    return undefined;
  }

  stats(key: K, sinceMs?: number): SeriesStats | undefined {
    return seriesStats(this.series(key, sinceMs));
  }

  latestTime(): number | undefined {
    return this.samples.last()?.t;
  }

  clear(): void {
    this.samples.clear();
    this.rates.clear();
  }
}

/** Relative change (cur - prev) / |prev|; undefined when prev is 0 or missing. */
export function relativeChange(cur: number | undefined | null, prev: number | undefined | null): number | undefined {
  if (typeof cur !== "number" || typeof prev !== "number" || !Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return undefined;
  return (cur - prev) / Math.abs(prev);
}

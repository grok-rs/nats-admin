// Geometry and binning for treemaps, histograms, heatmaps and arcs. Pure (no DOM).

import { niceNum } from "./scale";
import type { TimePoint } from "./series";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidOut<T> extends Rect {
  item: T;
  index: number;
}

function worstRatio(row: number[], side: number): number {
  const s = row.reduce((a, b) => a + b, 0);
  if (s <= 0 || side <= 0) return Infinity;
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk). Items with value ≤ 0 are skipped.
 * Returns rectangles in input order of the laid-out items (largest first is best for quality).
 */
export function squarify<T>(items: readonly T[], value: (t: T) => number, rect: Rect): LaidOut<T>[] {
  const list = items
    .map((item, index) => ({ item, index, v: Math.max(0, value(item) || 0) }))
    .filter((d) => d.v > 0)
    .sort((a, b) => b.v - a.v);
  const total = list.reduce((a, d) => a + d.v, 0);
  const out: LaidOut<T>[] = [];
  if (!total || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  const areas = list.map((d) => d.v * scale);
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < list.length) {
    const side = Math.min(w, h);
    const row: number[] = [areas[i]];
    let j = i + 1;
    while (j < list.length && worstRatio([...row, areas[j]], side) <= worstRatio(row, side)) {
      row.push(areas[j]);
      j++;
    }
    const rowArea = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      // Lay the row out as a column on the left.
      const cw = h > 0 ? rowArea / h : 0;
      let cy = y;
      for (let k = 0; k < row.length; k++) {
        const ch = cw > 0 ? row[k] / cw : 0;
        const d = list[i + k];
        out.push({ item: d.item, index: d.index, x, y: cy, w: cw, h: ch });
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      // Lay the row out as a strip on top.
      const rh = w > 0 ? rowArea / w : 0;
      let cx = x;
      for (let k = 0; k < row.length; k++) {
        const cw = rh > 0 ? row[k] / rh : 0;
        const d = list[i + k];
        out.push({ item: d.item, index: d.index, x: cx, y, w: cw, h: rh });
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
  return out;
}

export interface Bin {
  x0: number;
  x1: number;
  count: number;
}

export interface HistogramOptions {
  /** Number of bins, or "auto" (Freedman–Diaconis, clamped to 5…60). */
  bins?: number | "auto";
  /** Fixed domain; values outside are clamped into the first/last bin. */
  domain?: [number, number];
  /** Round bin edges to nice numbers (default true). */
  nice?: boolean;
}

/** Linear-interpolated quantile of an ascending-sorted array (q ∈ [0,1]). */
export function quantile(sorted: readonly number[], q: number): number | undefined {
  const n = sorted.length;
  if (!n) return undefined;
  if (n === 1) return sorted[0];
  const pos = Math.min(1, Math.max(0, q)) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Bin raw values into equal-width bins with nice edges. Non-finite values are ignored. */
export function histogram(values: readonly number[], opts: HistogramOptions = {}): Bin[] {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return [];
  let [lo, hi] = opts.domain ?? [v[0], v[v.length - 1]];
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    lo -= pad;
    hi += pad;
  }
  let count: number;
  if (typeof opts.bins === "number" && opts.bins > 0) count = Math.floor(opts.bins);
  else {
    const iqr = (quantile(v, 0.75) ?? 0) - (quantile(v, 0.25) ?? 0);
    const fd = iqr > 0 ? 2 * iqr * v.length ** (-1 / 3) : 0;
    count = fd > 0 ? Math.ceil((hi - lo) / fd) : Math.ceil(Math.log2(v.length) + 1);
    count = Math.min(60, Math.max(5, count));
  }
  let step = (hi - lo) / count;
  if (opts.nice !== false) {
    step = niceNum(step, true);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    if (hi <= lo) hi = lo + step;
    count = Math.max(1, Math.round((hi - lo) / step));
  }
  const bins: Bin[] = Array.from({ length: count }, (_, i) => ({ x0: lo + i * step, x1: lo + (i + 1) * step, count: 0 }));
  for (const x of v) {
    const i = Math.min(count - 1, Math.max(0, Math.floor((x - lo) / step)));
    bins[i].count++;
  }
  for (const b of bins) {
    b.x0 = Number.parseFloat(b.x0.toPrecision(12));
    b.x1 = Number.parseFloat(b.x1.toPrecision(12));
  }
  return bins;
}

export interface BucketOptions {
  start: number;
  end: number;
  bucketMs: number;
  /** "count" counts events; "sum" adds their values; "max" keeps the largest (default count). */
  agg?: "count" | "sum" | "max";
}

/**
 * Time-bucket events (timestamps or {t, v} points) into fixed buckets [start, end).
 * Every bucket is present (zero when empty) so activity strips have no holes.
 */
export function bucketize(events: readonly (number | TimePoint)[], opts: BucketOptions): TimePoint[] {
  const { start, end, bucketMs, agg = "count" } = opts;
  if (!(bucketMs > 0) || !(end > start)) return [];
  const n = Math.ceil((end - start) / bucketMs);
  const out: TimePoint[] = Array.from({ length: n }, (_, i) => ({ t: start + i * bucketMs, v: 0 }));
  for (const e of events) {
    const t = typeof e === "number" ? e : e.t;
    const v = typeof e === "number" ? 1 : (e.v ?? 0);
    if (!(t >= start && t < end)) continue;
    const b = out[Math.floor((t - start) / bucketMs)];
    if (agg === "count") b.v = (b.v as number) + 1;
    else if (agg === "sum") b.v = (b.v as number) + v;
    else b.v = Math.max(b.v as number, v);
  }
  return out;
}

/** Point on a circle; angle in radians, 0 = 3 o'clock, counter-clockwise positive (SVG y flipped). */
export function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.cos(angle), cy - r * Math.sin(angle)];
}

/**
 * SVG path for an annular sector between radii r0 < r1 from angle a0 to a1 (radians,
 * counter-clockwise from 3 o'clock). Handles full circles.
 */
export function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const sweep = a1 - a0;
  if (Math.abs(sweep) >= Math.PI * 2 - 1e-6) {
    // Two half arcs; inner ring cut out with even-odd winding.
    const outer = `M${cx + r1},${cy}A${r1},${r1} 0 1 0 ${cx - r1},${cy}A${r1},${r1} 0 1 0 ${cx + r1},${cy}Z`;
    const inner = r0 > 0 ? `M${cx + r0},${cy}A${r0},${r0} 0 1 1 ${cx - r0},${cy}A${r0},${r0} 0 1 1 ${cx + r0},${cy}Z` : "";
    return outer + inner;
  }
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const ccw = sweep > 0 ? 0 : 1; // SVG sweep-flag: 0 = counter-clockwise on screen
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const f = (n: number) => Number(n.toFixed(2));
  if (r0 <= 0) return `M${f(cx)},${f(cy)}L${f(x0)},${f(y0)}A${r1},${r1} 0 ${large} ${ccw} ${f(x1)},${f(y1)}Z`;
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M${f(x0)},${f(y0)}A${r1},${r1} 0 ${large} ${ccw} ${f(x1)},${f(y1)}L${f(x2)},${f(y2)}A${r0},${r0} 0 ${large} ${1 - ccw} ${f(x3)},${f(y3)}Z`;
}

/** Estimated rendered width (px) of `text` at ~11px UI font; used when no canvas is available. */
export function estimateTextWidth(text: string, fontPx = 11, mono = false): number {
  return text.length * fontPx * (mono ? 0.62 : 0.56);
}

/** Truncate to fit `maxPx` (estimated), appending "…". */
export function truncateToWidth(text: string, maxPx: number, fontPx = 11, mono = false): string {
  if (estimateTextWidth(text, fontPx, mono) <= maxPx) return text;
  const per = fontPx * (mono ? 0.62 : 0.56);
  const n = Math.max(0, Math.floor(maxPx / per) - 1);
  return n <= 0 ? "" : `${text.slice(0, n)}…`;
}

/** Shares (0–1) of each value in the total; zero total → all zero. */
export function shares(values: readonly number[], total?: number): number[] {
  const t = total ?? values.reduce((a, b) => a + Math.max(0, b || 0), 0);
  return values.map((v) => (t > 0 ? Math.max(0, v || 0) / t : 0));
}

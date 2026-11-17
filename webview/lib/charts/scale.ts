// Axis maths: nice numbers, linear scales and time ticks. Pure (no DOM).

/** Round `range` to a "nice" number (1, 2, 2.5, 5 × 10^k). */
export function niceNum(range: number, round: boolean): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const exp = Math.floor(Math.log10(range));
  const f = range / 10 ** exp;
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/** Fix floating point noise such as 0.30000000000000004. */
function clean(v: number): number {
  return Number.parseFloat(v.toPrecision(12));
}

function expand(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.1;
    return min > 0 ? [Math.max(0, min - pad), max + pad] : [min - pad, Math.min(0, max + pad)];
  }
  return [min, max];
}

export interface NiceOptions {
  /** Prefer steps that are nice multiples of a power of 1024 (bytes). */
  binary?: boolean;
}

/**
 * Nice ticks covering [min, max] with roughly `count` intervals. The first tick is ≤ min and
 * the last ≥ max, so the ticks double as the axis domain.
 */
export function niceTicks(min: number, max: number, count = 5, opts: NiceOptions = {}): number[] {
  [min, max] = expand(min, max);
  count = Math.max(1, Math.round(count));
  if (opts.binary) {
    const absMax = Math.max(Math.abs(min), Math.abs(max));
    let unit = 1;
    while (absMax / unit >= 1024 && unit < 1024 ** 5) unit *= 1024;
    if (unit > 1) return niceTicks(min / unit, max / unit, count).map((t) => clean(t * unit));
  }
  const step = niceNum((max - min) / count, true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo, i = 0; v <= hi + step / 2 && i < 1000; v += step, i++) ticks.push(clean(v));
  return ticks;
}

/** [min, max] extended to nice boundaries. */
export function niceDomain(min: number, max: number, count = 5, opts: NiceOptions = {}): [number, number] {
  const t = niceTicks(min, max, count, opts);
  return [t[0], t[t.length - 1]];
}

export interface LinearScale {
  (v: number): number;
  invert(px: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = ((v: number) => r0 + (v - d0) * k) as LinearScale;
  f.invert = (px: number) => (k === 0 ? d0 : d0 + (px - r0) / k);
  f.domain = domain;
  f.range = range;
  return f;
}

/** [min, max] of the finite numbers in `values`, or undefined when there are none. */
export function extent(values: Iterable<number | null | undefined>): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : undefined;
}

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

/** Candidate tick intervals for time axes (ms). */
export const TIME_STEPS = [S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S, M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M, H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 14 * D, 30 * D];

/**
 * Tick positions for a time axis between `start` and `end` (epoch ms) with at most `maxTicks`
 * labels. Ticks align to wall-clock multiples of the step in local time (12:00, 12:05, …).
 */
export function timeTicks(start: number, end: number, maxTicks = 6): { ticks: number[]; step: number } {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { ticks: [], step: S };
  maxTicks = Math.max(1, Math.floor(maxTicks));
  const span = end - start;
  const step = TIME_STEPS.find((s) => span / s <= maxTicks) ?? Math.ceil(span / maxTicks / D) * D;
  // Align to local wall clock: shift by the timezone offset for steps ≥ 1h.
  const tz = step >= H ? new Date(start).getTimezoneOffset() * M : 0;
  let t = Math.ceil((start - tz) / step) * step + tz;
  const ticks: number[] = [];
  for (let i = 0; t <= end && i < 500; t += step, i++) ticks.push(t);
  return { ticks, step };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Label for a time tick, precision chosen from the tick step. */
export function fmtTimeTick(t: number, step: number): string {
  const d = new Date(t);
  if (step >= D) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return step < M ? `${hm}:${pad2(d.getSeconds())}` : hm;
}

/** Full timestamp for tooltips: "12:03:04" (today) or "Nov 17 12:03:04". */
export function fmtTimeFull(t: number, now = Date.now()): string {
  const d = new Date(t);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

/** Human span, e.g. 300000 → "5m", 3600000 → "1h", 90000 → "1m 30s". */
export function fmtSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const parts: string[] = [];
  let rem = Math.round(ms / 1000);
  for (const [u, s] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    const n = Math.floor(rem / s);
    if (n) parts.push(`${n}${u}`);
    rem -= n * s;
  }
  return parts.slice(0, 2).join(" ") || "0s";
}

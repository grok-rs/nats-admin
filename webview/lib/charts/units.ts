// Unit-aware number formatting for charts, KPIs and tables. Pure (no DOM).
//
// A `Unit` is either a known key ("msgs/s", "bytes", "ms", …), a free-form suffix such as
// "req/s" (formatted compactly with the suffix appended) or a full UnitSpec.

export type UnitKey =
  | "none"
  | "count"
  | "msgs"
  | "msgs/s"
  | "bytes"
  | "bytes/s"
  | "ns"
  | "us"
  | "ms"
  | "s"
  | "percent"
  | "ratio";

export interface UnitSpec {
  /** Full formatted value with unit, e.g. "1.2 MiB" or "4.1k msgs/s". */
  format(v: number): string;
  /** Value and unit separately (KPI tiles style the unit smaller). */
  parts?(v: number): ValueParts;
  /** Short axis tick label. Defaults to `format`. */
  tick?(v: number): string;
  /** Caption shown above a y-axis when ticks do not carry the unit (e.g. "msgs/s"). */
  axisLabel?: string;
  /** Use powers of 1024 for nice axis ticks. */
  binary?: boolean;
}

export type Unit = UnitKey | UnitSpec | (string & {});

export interface ValueParts {
  value: string;
  unit: string;
}

const DASH = "–";

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Trim trailing zeros of a fixed-point string: "1.50" → "1.5", "2.0" → "2". */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Significant-ish fixed formatting: 3 significant digits for small values. */
function sig(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 100) return Math.round(v).toString();
  if (a >= 10) return trimZeros(v.toFixed(1));
  if (a >= 1) return trimZeros(v.toFixed(2));
  if (a >= 0.01) return trimZeros(v.toFixed(2));
  return trimZeros(v.toPrecision(2));
}

/** Compact count: 0–9,999 in full ("1,284"), then 12.9k, 3.4M, 1.2G, 5T. */
export function compact(v: number, fullBelow = 10_000): string {
  if (!finite(v)) return DASH;
  const a = Math.abs(v);
  if (a < fullBelow) {
    if (Number.isInteger(v)) return v.toLocaleString("en-US");
    return a >= 100 ? Math.round(v).toLocaleString("en-US") : sig(v);
  }
  const units = ["k", "M", "G", "T", "P"];
  let x = v;
  let i = -1;
  while (Math.abs(x) >= 1000 && i < units.length - 1) {
    x /= 1000;
    i++;
  }
  return `${trimZeros(Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1))}${units[i]}`;
}

/** Compact for axis ticks: always compact from 1,000 (0 / 500 / 1k / 1.5k). */
export function compactTick(v: number): string {
  return compact(v, 1000);
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function bytesParts(n: number): ValueParts {
  if (!finite(n)) return { value: DASH, unit: "" };
  if (n < 0) return { value: "∞", unit: "" };
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const value = i === 0 ? String(Math.round(v)) : trimZeros(v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2));
  return { value, unit: BYTE_UNITS[i] };
}

/** Duration in milliseconds → parts ("312 µs", "4.2 ms", "1.5 s", "3m 20s"). */
export function durationParts(ms: number): ValueParts {
  if (!finite(ms)) return { value: DASH, unit: "" };
  const a = Math.abs(ms);
  if (a === 0) return { value: "0", unit: "ms" };
  if (a < 0.001) return { value: sig(ms * 1e6), unit: "ns" };
  if (a < 1) return { value: sig(ms * 1000), unit: "µs" };
  if (a < 1000) return { value: sig(ms), unit: "ms" };
  if (a < 60_000) return { value: sig(ms / 1000), unit: "s" };
  const s = Math.round(a / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const out = d ? `${d}d${h ? ` ${h}h` : ""}` : h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m${sec ? ` ${sec}s` : ""}`;
  return { value: (ms < 0 ? "-" : "") + out, unit: "" };
}

function join(p: ValueParts): string {
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

function suffixSpec(suffix: string, axisLabel = suffix): UnitSpec {
  return {
    format: (v) => (finite(v) ? `${compact(v)}${suffix ? ` ${suffix}` : ""}` : DASH),
    parts: (v) => ({ value: compact(v), unit: finite(v) ? suffix : "" }),
    tick: compactTick,
    axisLabel,
  };
}

const percentParts = (v: number): ValueParts => {
  if (!finite(v)) return { value: DASH, unit: "" };
  const a = Math.abs(v);
  return { value: a > 0 && a < 10 ? trimZeros(v.toFixed(1)) : Math.round(v).toString(), unit: "%" };
};

const SPECS: Record<UnitKey, UnitSpec> = {
  none: { format: (v) => (finite(v) ? sig(v) : DASH), tick: (v) => sig(v) },
  count: suffixSpec("", ""),
  msgs: suffixSpec("msgs"),
  "msgs/s": suffixSpec("msgs/s"),
  bytes: {
    format: (v) => join(bytesParts(v)),
    parts: bytesParts,
    tick: (v) => (v === 0 ? "0" : join(bytesParts(v))),
    binary: true,
  },
  "bytes/s": {
    format: (v) => (finite(v) ? `${join(bytesParts(v))}/s` : DASH),
    parts: (v) => {
      const p = bytesParts(v);
      return { value: p.value, unit: p.unit ? `${p.unit}/s` : "" };
    },
    tick: (v) => (v === 0 ? "0" : join(bytesParts(v))),
    axisLabel: "per second",
    binary: true,
  },
  ns: {
    format: (v) => join(durationParts(v / 1e6)),
    parts: (v) => durationParts(v / 1e6),
  },
  us: {
    format: (v) => join(durationParts(v / 1e3)),
    parts: (v) => durationParts(v / 1e3),
  },
  ms: { format: (v) => join(durationParts(v)), parts: durationParts },
  s: { format: (v) => join(durationParts(v * 1000)), parts: (v) => durationParts(v * 1000) },
  percent: { format: (v) => join(percentParts(v)).replace(" %", "%"), parts: percentParts, tick: (v) => `${Math.round(v)}%` },
  ratio: {
    format: (v) => join(percentParts(v * 100)).replace(" %", "%"),
    parts: (v) => percentParts(v * 100),
    tick: (v) => `${Math.round(v * 100)}%`,
  },
};

export interface ResolvedUnit {
  format(v: number): string;
  parts(v: number): ValueParts;
  tick(v: number): string;
  axisLabel: string;
  binary: boolean;
}

/** Normalise any Unit (key, suffix string, spec or undefined) into a full formatter set. */
export function resolveUnit(unit: Unit | undefined): ResolvedUnit {
  const spec: UnitSpec = unit === undefined ? SPECS.count : typeof unit === "string" ? (SPECS[unit as UnitKey] ?? suffixSpec(unit)) : unit;
  const parts = spec.parts ?? ((v: number) => ({ value: spec.format(v), unit: "" }));
  return {
    format: (v) => (finite(v) ? spec.format(v) : DASH),
    parts: (v) => (finite(v) ? parts(v) : { value: DASH, unit: "" }),
    tick: spec.tick ?? spec.format,
    axisLabel: spec.axisLabel ?? "",
    binary: !!spec.binary,
  };
}

/** Format a value with its unit; null/undefined/NaN → "–". */
export function formatValue(v: number | null | undefined, unit?: Unit): string {
  return finite(v) ? resolveUnit(unit).format(v) : DASH;
}

export function formatParts(v: number | null | undefined, unit?: Unit): ValueParts {
  return finite(v) ? resolveUnit(unit).parts(v) : { value: DASH, unit: "" };
}

/** Signed percentage change, e.g. 0.123 → "+12.3%", -0.5 → "−50%". */
export function formatDeltaPercent(fraction: number): string {
  if (!finite(fraction)) return DASH;
  const p = fraction * 100;
  const a = Math.abs(p);
  const s = a >= 100 ? Math.round(a).toString() : a >= 10 ? trimZeros(a.toFixed(1)) : trimZeros(a.toFixed(1));
  return `${p > 0 ? "+" : p < 0 ? "−" : "±"}${s}%`;
}

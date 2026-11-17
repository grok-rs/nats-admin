// Formatting of config values for change lists (host notifications and the Plan webview).
// Pure module: the webview bundles it.

import { fmtBytes, fmtMillis } from "../shared/format";
import type { ConfigChange, ValueUnit } from "./types";

/** Compact JSON-ish rendering of a config value. */
export function fmtRaw(v: unknown, max = 120): string {
  if (v === undefined) return "(unset)";
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Human reading of a value with a unit, e.g. 86400000000000 ns → "1d"; undefined when nothing to add. */
export function humanize(v: unknown, unit: ValueUnit | undefined, path = ""): string | undefined {
  if (typeof v !== "number") {
    if (Array.isArray(v) && unit === "ns" && v.every((x) => typeof x === "number")) return v.map((x) => fmtDur(x / 1e6)).join(", ");
    return undefined;
  }
  if (v === -1) return "unlimited";
  switch (unit) {
    case "ns":
      if (v === 0) return /max_age|ttl|inactive|marker/.test(path) ? "unlimited" : undefined;
      return fmtDur(v / 1e6);
    case "ms":
      return v === 0 ? (path === "ttl" ? "no expiry" : undefined) : fmtDur(v);
    case "bytes":
      return v >= 1024 ? fmtBytes(v) : undefined;
    default:
      return undefined;
  }
}

function fmtDur(ms: number): string {
  return fmtMillis(ms);
}

/** "value (human)" */
export function fmtValue(v: unknown, unit?: ValueUnit, path = ""): string {
  const h = humanize(v, unit, path);
  return h ? `${fmtRaw(v)} (${h})` : fmtRaw(v);
}

/** One line per change for notifications / modal details. */
export function describeChange(c: ConfigChange): string {
  const marker = c.op === "add" ? "+" : "~";
  const body = c.op === "add" ? `${c.path} = ${fmtValue(c.to, c.unit, c.path)}` : `${c.path}: ${fmtValue(c.from, c.unit, c.path)} → ${fmtValue(c.to, c.unit, c.path)}`;
  const notes = [c.immutable && `⛔ ${c.immutable}`, c.risk && `⚠ ${c.risk}`].filter(Boolean).join(" ");
  return `${marker} ${body}${notes ? `  ${notes}` : ""}`;
}

/** Elements added / removed between two string lists (for subjects-like arrays). */
export function listDelta(from: unknown, to: unknown): { added: string[]; removed: string[] } | undefined {
  if (!Array.isArray(to) || !to.every((x) => typeof x === "string")) return undefined;
  const before = Array.isArray(from) ? from.map(String) : [];
  const after = to as string[];
  return { added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) };
}

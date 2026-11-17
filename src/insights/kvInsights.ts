// Pure helpers for the KV Browser overview charts: prefix treemap (by key count or bytes),
// change-activity bucketing and value-type ordering. No vscode / DOM imports.

import { buildKeyTree, sortedChildren, type KeyTreeNode } from "../shared/keyTree";
import type { TreemapNode } from "../nats/subjects";

export type PrefixMetric = "keys" | "bytes";

export interface KeyStat {
  key: string;
  size: number;
}

/**
 * Treemap tiles for a set of keys grouped by `separator`: folders sum their keys (count or
 * bytes), at most `maxChildren` tiles per level (the rest folded into "Other (n)"), levels
 * below `maxDepth` summarised into their folder. A key that is also a prefix keeps its own
 * value as a "(value)" tile.
 */
export function prefixTreemap(entries: readonly KeyStat[], separator: string, metric: PrefixMetric, opts: { maxChildren?: number; maxDepth?: number } = {}): TreemapNode[] {
  const maxChildren = Math.max(2, opts.maxChildren ?? 20);
  const maxDepth = Math.max(1, opts.maxDepth ?? 4);
  const own = new Map<string, number>();
  for (const e of entries) own.set(e.key, metric === "keys" ? 1 : Math.max(0, e.size));
  const root = buildKeyTree(own.keys(), separator);
  const total = (n: KeyTreeNode): number => (n.isKey ? (own.get(n.path) ?? 0) : 0) + [...n.children.values()].reduce((a, c) => a + total(c), 0);
  const level = (n: KeyTreeNode, depth: number): TreemapNode[] => {
    const tiles: TreemapNode[] = sortedChildren(n).map((c) => tile(c, depth));
    if (n.path && n.isKey && tiles.length) tiles.push({ id: `${n.path}\u0000value`, label: "(value)", value: own.get(n.path) ?? 0, hint: `The key ${n.path} itself` });
    const positive = tiles.filter((t) => sum(t) > 0);
    positive.sort((a, b) => sum(b) - sum(a));
    if (positive.length <= maxChildren) return positive;
    const keep = positive.slice(0, maxChildren - 1);
    const rest = positive.slice(maxChildren - 1);
    keep.push({ id: `${n.path}\u0000other`, label: `Other (${rest.length})`, value: rest.reduce((a, t) => a + sum(t), 0), hint: `${rest.length} smaller entries` });
    return keep;
  };
  const tile = (c: KeyTreeNode, depth: number): TreemapNode => {
    const hint = c.children.size ? `${c.path}${separator}* · ${c.count} ${c.count === 1 ? "key" : "keys"}` : c.path;
    if (c.children.size && depth + 1 < maxDepth) return { id: c.path, label: c.name, children: level(c, depth + 1), hint };
    return { id: c.children.size ? `${c.path}\u0000folder` : c.path, label: c.children.size ? `${c.name}${separator}*` : c.name, value: total(c), hint };
  };
  return separator ? level(root, 0) : sortedChildren(root).map((c) => ({ id: c.path, label: c.name, value: own.get(c.path) ?? 0, hint: c.path }));
}

function sum(t: TreemapNode): number {
  return t.children?.length ? t.children.reduce((a, c) => a + sum(c), 0) : Math.max(0, t.value ?? 0);
}

/** The KV key behind a treemap tile (undefined for folders, "Other" and summarised tiles). */
export function tileKey(id: string): string | undefined {
  const i = id.indexOf("\u0000");
  if (i < 0) return id;
  return id.slice(i + 1) === "value" ? id.slice(0, i) : undefined;
}

/** Nice bucket lengths for change activity, smallest first. */
export const ACTIVITY_STEPS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000, 604_800_000, 2_592_000_000] as const;

export interface ActivityWindow {
  start: number;
  end: number;
  bucketMs: number;
  buckets: number;
  /** Events before `start` (only when the span had to be clipped). */
  clipped: number;
}

/**
 * Pick a bucket length so the span from the oldest event to `now` fits in at most `maxBuckets`
 * buckets (aligned to the bucket length). Spans longer than `maxBuckets` × 30 days are clipped.
 */
export function activityWindow(times: readonly number[], nowMs: number, maxBuckets = 60): ActivityWindow | undefined {
  // A loop, not Math.min(...times): spreading a large bucket (nats.kv.maxKeys has no upper bound)
  // overflows the call stack.
  let oldest = Infinity;
  let newest = -Infinity;
  const valid: number[] = [];
  for (const t of times) {
    if (!Number.isFinite(t)) continue;
    valid.push(t);
    if (t < oldest) oldest = t;
    if (t > newest) newest = t;
  }
  if (!valid.length) return undefined;
  // Server clocks ahead of the local one: keep the newest writes inside the window.
  const now = Math.max(nowMs, newest);
  const span = Math.max(1, now - oldest);
  const step = ACTIVITY_STEPS_MS.find((s) => Math.ceil(span / s) + 1 <= maxBuckets) ?? ACTIVITY_STEPS_MS[ACTIVITY_STEPS_MS.length - 1];
  const end = Math.floor(now / step) * step + step;
  let start = Math.floor(oldest / step) * step;
  const minStart = end - maxBuckets * step;
  // Keep at least a handful of buckets so a single burst still reads as a strip.
  start = Math.min(start, end - Math.min(maxBuckets, 12) * step);
  const clippedStart = Math.max(start, minStart);
  return { start: clippedStart, end, bucketMs: step, buckets: Math.round((end - clippedStart) / step), clipped: valid.filter((t) => t < clippedStart).length };
}

/** Human label for a bucket length ("5 min", "1 h", "1 d"). */
export function stepLabel(ms: number): string {
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

/** Fixed order of value kinds so each kind keeps its colour slot. */
export const VALUE_KINDS = ["object", "array", "string", "number", "boolean", "null", "text", "binary", "gzip", "empty"] as const;

export function kindSlot(kind: string): number {
  const i = (VALUE_KINDS as readonly string[]).indexOf(kind);
  return i < 0 ? VALUE_KINDS.length : i;
}

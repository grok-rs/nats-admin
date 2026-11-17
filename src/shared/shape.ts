// Infers the aggregated structure of many JSON values (e.g. all KV values
// under a key prefix): which paths exist, their types and how often.

export interface ShapeRow {
  /** Path like `pool.min`, `replicas[]`, `items[].sku`. Empty string = root. */
  path: string;
  depth: number;
  /** type → number of values with that type at this path. */
  types: Record<string, number>;
  /** Number of documents that contain this path. */
  present: number;
  /** A few distinct example scalar values. */
  examples: string[];
}

export interface ShapeSummary {
  documents: number;
  rows: ShapeRow[];
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function childPath(base: string, key: string): string {
  const k = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : JSON.stringify(key);
  return base ? `${base}.${k}` : k;
}

export function aggregateShape(values: unknown[], maxDepth = 6, maxRows = 500): ShapeSummary {
  const rows = new Map<string, ShapeRow>();
  const children = new Map<string, string[]>();

  const visit = (v: unknown, path: string, depth: number, seen: Set<string>, parent?: string) => {
    let row = rows.get(path);
    if (!row) {
      if (rows.size >= maxRows) return;
      row = { path, depth, types: {}, present: 0, examples: [] };
      rows.set(path, row);
      if (parent !== undefined) {
        const list = children.get(parent) ?? [];
        list.push(path);
        children.set(parent, list);
      }
    }
    const t = typeOf(v);
    row.types[t] = (row.types[t] ?? 0) + 1;
    if (!seen.has(path)) {
      row.present++;
      seen.add(path);
    }
    if (t !== "object" && t !== "array" && row.examples.length < 3) {
      const ex = t === "string" ? JSON.stringify(v).slice(0, 40) : String(v);
      if (!row.examples.includes(ex)) row.examples.push(ex);
    }
    if (depth >= maxDepth) return;
    if (t === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) visit(child, childPath(path, k), depth + 1, seen, path);
    } else if (t === "array") {
      for (const item of (v as unknown[]).slice(0, 50)) visit(item, `${path}[]`, depth + 1, seen, path);
    }
  };

  for (const v of values) visit(v, "", 0, new Set());
  // Depth-first: every path directly followed by its children (first-seen order).
  const ordered: ShapeRow[] = [];
  const walk = (path: string) => {
    const row = rows.get(path);
    if (!row) return;
    ordered.push(row);
    for (const c of children.get(path) ?? []) walk(c);
  };
  walk("");
  return { documents: values.length, rows: ordered };
}

/** Valid NATS KV key: [-/_=.a-zA-Z0-9]+, no leading/trailing '.', no empty tokens. */
export function validateKvKey(key: string): string | undefined {
  if (!key) return "Key is required";
  if (!/^[-/_=.a-zA-Z0-9]+$/.test(key)) return "Keys may contain letters, digits and - / _ = . only";
  if (key.startsWith(".") || key.endsWith(".")) return "Keys cannot start or end with '.'";
  if (key.includes("..")) return "Keys cannot contain empty tokens ('..')";
  return undefined;
}

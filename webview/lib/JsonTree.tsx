// Collapsible JSON structure viewer: types, sizes, key paths — the
// "data structure" view for KV values and message payloads.

import { useMemo, useState } from "preact/hooks";
import { cx, Icon } from "./ui";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function pathJoin(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`;
}

function Scalar({ value }: { value: Json }) {
  const k = kindOf(value);
  const text = k === "string" ? JSON.stringify(value) : String(value);
  return <span class={cx("jt-val", `jt-${k}`)}>{text}</span>;
}

function summary(v: Json): string {
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (v && typeof v === "object") return `{${Object.keys(v).length} keys}`;
  return "";
}

function Node({
  name,
  value,
  path,
  depth,
  expandDepth,
  filter,
  onPath,
}: {
  name: string | number | null;
  value: Json;
  path: string;
  depth: number;
  expandDepth: number;
  filter: string;
  onPath?: (path: string) => void;
}) {
  const isObj = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < expandDepth);
  const entries = useMemo<[string | number, Json][]>(() => {
    if (!isObj) return [];
    return Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value as Record<string, Json>);
  }, [value, isObj]);

  const label =
    name === null ? null : (
      <span class={cx("jt-key", typeof name === "number" && "jt-index")} title={path} onClick={(e) => (e.stopPropagation(), onPath?.(path))}>
        {typeof name === "number" ? name : name}
      </span>
    );

  if (!isObj) {
    return (
      <div class="jt-row" style={{ paddingLeft: `${depth * 14 + 16}px` }}>
        {label}
        {label && <span class="jt-colon">: </span>}
        <Scalar value={value} />
      </div>
    );
  }
  const visible = filter ? entries.filter(([k, v]) => matches(k, v, filter)) : entries;
  return (
    <div>
      <div class="jt-row jt-branch" style={{ paddingLeft: `${depth * 14}px` }} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} class="jt-twisty" />
        {label}
        {label && <span class="jt-colon">: </span>}
        <span class="jt-summary">
          {Array.isArray(value) ? "[" : "{"}
          {!open && <span class="jt-meta"> {summary(value)} </span>}
          {!open && (Array.isArray(value) ? "]" : "}")}
        </span>
        <span class={cx("jt-type", `jt-type-${kindOf(value)}`)}>{summary(value)}</span>
      </div>
      {open && (
        <>
          {visible.map(([k, v]) => (
            <Node key={String(k)} name={k} value={v} path={pathJoin(path, k)} depth={depth + 1} expandDepth={expandDepth} filter={filter} onPath={onPath} />
          ))}
          {visible.length < entries.length && (
            <div class="jt-row jt-meta" style={{ paddingLeft: `${(depth + 1) * 14 + 16}px` }}>
              {entries.length - visible.length} hidden by filter
            </div>
          )}
          <div class="jt-row jt-summary" style={{ paddingLeft: `${depth * 14 + 16}px` }}>
            {Array.isArray(value) ? "]" : "}"}
          </div>
        </>
      )}
    </div>
  );
}

function matches(k: string | number, v: Json, f: string): boolean {
  if (String(k).toLowerCase().includes(f)) return true;
  if (v === null || typeof v !== "object") return String(v).toLowerCase().includes(f);
  return (Array.isArray(v) ? v.map((x, i) => [i, x] as const) : Object.entries(v)).some(([kk, vv]) => matches(kk, vv as Json, f));
}

export function JsonTree({ value, expandDepth = 2, onPath }: { value: unknown; expandDepth?: number; onPath?: (path: string) => void }) {
  const [filter, setFilter] = useState("");
  const [depth, setDepth] = useState(expandDepth);
  const [gen, setGen] = useState(0);
  const isObj = value !== null && typeof value === "object";
  return (
    <div class="jt">
      {isObj && (
        <div class="jt-toolbar">
          <input class="input input-sm" placeholder="Filter keys / values…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value.toLowerCase())} />
          <button type="button" class="btn btn-ghost btn-sm" title="Expand all" onClick={() => (setDepth(99), setGen(gen + 1))}>
            <Icon name="expand-all" />
          </button>
          <button type="button" class="btn btn-ghost btn-sm" title="Collapse all" onClick={() => (setDepth(1), setGen(gen + 1))}>
            <Icon name="collapse-all" />
          </button>
        </div>
      )}
      <div class="jt-body" key={gen}>
        <Node name={null} value={value as Json} path="" depth={0} expandDepth={depth} filter={filter} onPath={onPath} />
      </div>
    </div>
  );
}

/** Flat schema-ish outline: every path with its type (used for the "Structure" summary). */
export function describeShape(value: unknown, maxPaths = 200): { path: string; type: string; sample?: string }[] {
  const out: { path: string; type: string; sample?: string }[] = [];
  const walk = (v: unknown, path: string) => {
    if (out.length >= maxPaths) return;
    const k = kindOf(v);
    if (k === "object") {
      out.push({ path: path || "(root)", type: `object · ${Object.keys(v as object).length} keys` });
      for (const [kk, vv] of Object.entries(v as object)) walk(vv, pathJoin(path, kk));
    } else if (k === "array") {
      const arr = v as unknown[];
      out.push({ path: path || "(root)", type: `array · ${arr.length}` });
      if (arr.length) walk(arr[0], `${path}[0]`);
    } else {
      out.push({ path: path || "(root)", type: k, sample: k === "string" ? JSON.stringify(v).slice(0, 60) : String(v) });
    }
  };
  walk(value, "");
  return out;
}

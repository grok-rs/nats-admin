// Squarified treemap (subject space, storage by bucket…). Tiles are washed fills of the
// top-level hue with text in text tokens; tiles with children drill down, a breadcrumb
// climbs back. Tiles are real buttons (keyboard: Tab, Enter to drill, Backspace/Escape up).

import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { cx, Icon } from "../ui";
import { useElementSize } from "./hooks";
import { squarify } from "./layout";
import { seriesColor } from "./palette";
import { formatValue, type Unit } from "./units";
import "./charts.css";

export interface TreeNode {
  id: string;
  label: string;
  /** Leaf value; parents default to the sum of their children. */
  value?: number;
  children?: readonly TreeNode[];
  /** Explicit colour (default: categorical slot of the top-level ancestor). */
  color?: string;
  hint?: string;
}

export interface TreemapProps {
  data: readonly TreeNode[];
  /** Accessible name, e.g. "Subjects by message count". */
  label: string;
  unit?: Unit;
  /** Height in px (default 240). */
  height?: number;
  /** Clicking a tile with children drills into it (default true). */
  drill?: boolean;
  /** Called on every tile activation with the node and its path from the root. */
  onSelect?: (node: TreeNode, path: readonly TreeNode[]) => void;
  /** Monospace labels (default true: subjects / names). */
  mono?: boolean;
  /** Breadcrumb root label (default "All"). */
  rootLabel?: string;
  /** Separator used to join the breadcrumb path (default "."). */
  separator?: string;
  emptyText?: ComponentChildren;
  loading?: boolean;
  class?: string;
}

export function nodeValue(n: TreeNode): number {
  if (n.children?.length) return n.children.reduce((a, c) => a + nodeValue(c), 0);
  return Math.max(0, n.value ?? 0);
}

export function Treemap({ data, label, unit, height = 240, drill = true, onSelect, mono = true, rootLabel = "All", separator = ".", emptyText = "No data", loading, class: cls }: TreemapProps) {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const [path, setPath] = useState<TreeNode[]>([]);
  // Colour follows the top-level entity (by its rank in the full data set).
  const topColor = useMemo(() => {
    const m = new Map<string, string>();
    [...data].sort((a, b) => nodeValue(b) - nodeValue(a)).forEach((n, i) => m.set(n.id, n.color ?? seriesColor(i)));
    return m;
  }, [data]);
  if (loading) return <div class={cx("vz-treemap", cls)}><div class="skeleton" style={{ height: `${height}px` }} aria-busy="true" aria-label={`${label}: loading`} /></div>;
  // Re-resolve the drill path against fresh data (ids are stable, objects may not be).
  let level: readonly TreeNode[] = data;
  const live: TreeNode[] = [];
  for (const p of path) {
    const found = level.find((n) => n.id === p.id);
    if (!found?.children?.length) break;
    live.push(found);
    level = found.children;
  }
  const levelTotal = level.reduce((a, n) => a + nodeValue(n), 0);
  const rects = width > 0 ? squarify(level, nodeValue, { x: 0, y: 0, w: width, h: height }) : [];
  const baseColor = (n: TreeNode) => (live.length ? (live[0].color ?? topColor.get(live[0].id) ?? seriesColor(0)) : (n.color ?? topColor.get(n.id) ?? "var(--series-other)"));
  const maxV = Math.max(...level.map(nodeValue), 0);
  const up = () => setPath(live.slice(0, -1));
  const activate = (n: TreeNode) => {
    onSelect?.(n, [...live, n]);
    if (drill && n.children?.length) setPath([...live, n]);
  };
  return (
    <div class={cx("vz-treemap", cls)}>
      {drill && (
        <nav class="vz-crumbs" aria-label={`${label} path`}>
          <button type="button" class="vz-crumb" disabled={!live.length} onClick={() => setPath([])}>
            {rootLabel}
          </button>
          {live.map((n, i) => (
            <span key={n.id} class="vz-crumb-item">
              <Icon name="chevron-right" class="vz-crumb-sep" />
              <button type="button" class={cx("vz-crumb", mono && "mono")} disabled={i === live.length - 1} onClick={() => setPath(live.slice(0, i + 1))} aria-current={i === live.length - 1 ? "page" : undefined}>
                {n.label}
              </button>
            </span>
          ))}
          <span class="vz-crumb-total">{formatValue(levelTotal, unit)}</span>
        </nav>
      )}
      <div
        ref={ref}
        class="vz-tm-area"
        style={{ height: `${height}px` }}
        role="group"
        aria-label={`${label}${live.length ? ` in ${live.map((n) => n.label).join(separator)}` : ""}: ${level.length} items`}
        onKeyDown={(e) => {
          if ((e.key === "Backspace" || e.key === "Escape") && live.length) {
            e.preventDefault();
            up();
          }
        }}
      >
        {width > 0 && !rects.length && <div class="vz-empty-msg">{emptyText}</div>}
        {rects.map((r) => {
          const n = r.item;
          const v = nodeValue(n);
          const share = levelTotal > 0 ? (v / levelTotal) * 100 : 0;
          const showLabel = r.w >= 34 && r.h >= 18;
          const showValue = r.w >= 56 && r.h >= 36;
          const wash = 22 + Math.round((maxV > 0 ? v / maxV : 0) * 26);
          const fullName = live.length ? [...live.map((p) => p.label), n.label].join(separator) : n.label;
          const tip = `${fullName}: ${formatValue(v, unit)} (${share < 10 ? share.toFixed(1) : Math.round(share)}%)${n.children?.length ? ` · ${n.children.length} children — click to drill in` : ""}${n.hint ? ` — ${n.hint}` : ""}`;
          return (
            <button
              type="button"
              key={n.id}
              class={cx("vz-tile", !!n.children?.length && drill && "vz-tile-parent")}
              style={{
                left: `${r.x}px`,
                top: `${r.y}px`,
                width: `${Math.max(0, r.w)}px`,
                height: `${Math.max(0, r.h)}px`,
                "--tile": baseColor(n),
                "--wash": `${wash}%`,
              }}
              title={tip}
              aria-label={tip}
              onClick={() => activate(n)}
            >
              {showLabel && (
                <span class="vz-tile-text">
                  <span class={cx("vz-tile-label", mono && "mono")}>{n.label}</span>
                  {showValue && <span class="vz-tile-value">{formatValue(v, unit)}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

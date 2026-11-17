// Legend: swatch mirrors the mark (line for lines, rect for bars/areas, dot for points).
// Interactive legends are real toggle buttons (aria-pressed); double-click or Alt+click isolates.

import { cx } from "../ui";
import "./charts.css";

export interface LegendItem {
  id: string;
  label: string;
  /** CSS colour of the mark. */
  color: string;
  /** Optional value printed after the label (text tokens, never the series colour). */
  value?: string;
  hidden?: boolean;
  shape?: "line" | "rect" | "dot";
  dashed?: boolean;
  title?: string;
  mono?: boolean;
}

export interface LegendProps {
  items: readonly LegendItem[];
  /** Makes items toggle buttons. */
  onToggle?: (id: string) => void;
  /** Double-click / Alt+click: show only this item (again: show all). */
  onSolo?: (id: string) => void;
  /** Accessible group label. */
  label?: string;
  /** Vertical list (donut side legend) instead of a wrapping row. */
  vertical?: boolean;
  class?: string;
}

export function Swatch({ color, shape = "rect", dashed }: { color: string; shape?: "line" | "rect" | "dot"; dashed?: boolean }) {
  return <span class={cx("vz-swatch", `vz-swatch-${shape}`, dashed && "vz-swatch-dashed")} style={{ "--c": color }} aria-hidden="true" />;
}

export function Legend({ items, onToggle, onSolo, label = "Legend", vertical, class: cls }: LegendProps) {
  if (!items.length) return null;
  return (
    <div class={cx("vz-legend", vertical && "vz-legend-v", cls)} role={onToggle ? "group" : "list"} aria-label={label}>
      {items.map((it) => {
        const body = (
          <>
            <Swatch color={it.color} shape={it.shape} dashed={it.dashed} />
            <span class={cx("vz-legend-label", it.mono && "mono")}>{it.label}</span>
            {it.value !== undefined && <span class="vz-legend-value">{it.value}</span>}
          </>
        );
        if (!onToggle)
          return (
            <span key={it.id} class="vz-legend-item" role="listitem" title={it.title}>
              {body}
            </span>
          );
        return (
          <button
            type="button"
            key={it.id}
            class={cx("vz-legend-item", "vz-legend-btn", it.hidden && "vz-off")}
            aria-pressed={!it.hidden}
            title={it.title ?? `${it.hidden ? "Show" : "Hide"} ${it.label}${onSolo ? " (double-click to isolate)" : ""}`}
            onClick={(e) => {
              if (e.altKey && onSolo) onSolo(it.id);
              else onToggle(it.id);
            }}
            onDblClick={onSolo ? () => onSolo(it.id) : undefined}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}

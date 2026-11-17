// Ranked horizontal bars with labels and values ("top subjects", "busiest streams").
// One hue for every bar (nominal categories); the value is printed, so hover adds the share.
// Lays out inline (label · bar · value) when wide and stacked when narrow (container query).

import type { ComponentChildren } from "preact";
import { cx } from "../ui";
import { toneColor, type Tone } from "./palette";
import { formatValue, type Unit } from "./units";
import "./charts.css";

export interface BarListItem {
  id?: string;
  label: string;
  value: number;
  /** Override the bar colour (default slot 1) — use tone for status meaning. */
  color?: string;
  tone?: Tone;
  /** Extra muted text after the label (e.g. "3 consumers"). */
  secondary?: ComponentChildren;
  /** Tooltip text. */
  hint?: string;
}

export interface BarListProps {
  items: readonly BarListItem[];
  /** Accessible name, e.g. "Top subjects by msgs/s". */
  label: string;
  unit?: Unit;
  format?: (v: number) => string;
  /** Scale maximum (default: largest value). */
  max?: number;
  /** Sort descending by value (default true). */
  sort?: boolean;
  /** Show at most N rows; the rest fold into one "Other (n)" row. */
  limit?: number;
  /** Monospace labels (subjects, stream names). */
  mono?: boolean;
  /** Append the share of the total to each value. */
  showShare?: boolean;
  onSelect?: (item: BarListItem) => void;
  selectedId?: string;
  emptyText?: ComponentChildren;
  loading?: boolean;
  class?: string;
}

export function BarList({ items, label, unit, format, max, sort = true, limit, mono, showShare, onSelect, selectedId, emptyText = "No data", loading, class: cls }: BarListProps) {
  const fmt = format ?? ((v: number) => formatValue(v, unit));
  if (loading)
    return (
      <div class={cx("vz-barlist", cls)} aria-busy="true" aria-label={`${label}: loading`}>
        {[70, 52, 40, 28].map((w) => (
          <div key={w} class="vz-bar-row">
            <span class="skeleton skeleton-text" style={{ width: "60%" }} />
            <span class="vz-bar-track">
              <span class="skeleton" style={{ width: `${w}%`, height: "100%", display: "block" }} />
            </span>
            <span class="skeleton skeleton-text" style={{ width: "36px" }} />
          </div>
        ))}
      </div>
    );
  let rows = items.map((it, i) => ({ ...it, id: it.id ?? `${it.label}#${i}` }));
  if (sort) rows = [...rows].sort((a, b) => b.value - a.value);
  if (limit && rows.length > limit) {
    const rest = rows.slice(limit - 1);
    rows = [...rows.slice(0, limit - 1), { id: "__other", label: `Other (${rest.length})`, value: rest.reduce((a, r) => a + r.value, 0), color: "var(--series-other)" }];
  }
  if (!rows.length) return <div class="vz-empty-inline">{emptyText}</div>;
  const top = max ?? Math.max(...rows.map((r) => r.value), 0);
  const total = rows.reduce((a, r) => a + Math.max(0, r.value), 0);
  return (
    <ul class={cx("vz-barlist", cls)} aria-label={label}>
      {rows.map((r) => {
        const frac = top > 0 ? Math.max(0, r.value) / top : 0;
        const share = total > 0 ? (Math.max(0, r.value) / total) * 100 : 0;
        const shareText = `${share < 10 && share > 0 ? share.toFixed(1) : Math.round(share)}%`;
        const tip = `${r.label}: ${fmt(r.value)} (${shareText} of total)${r.hint ? ` — ${r.hint}` : ""}`;
        const color = r.color ?? (r.tone ? toneColor(r.tone) : "var(--series-1)");
        const content = (
          <>
            <span class="vz-bar-label">
              <span class={cx("vz-bar-name", mono && "mono")}>{r.label}</span>
              {r.secondary !== undefined && <span class="vz-bar-secondary">{r.secondary}</span>}
            </span>
            <span class="vz-bar-track" aria-hidden="true">
              <span class="vz-bar-fill" style={{ width: `${frac * 100}%`, background: color }} />
            </span>
            <span class="vz-bar-value">
              {fmt(r.value)}
              {showShare && <span class="vz-bar-share"> {shareText}</span>}
            </span>
          </>
        );
        const selectable = onSelect && r.id !== "__other";
        return (
          <li key={r.id} class="vz-bar-li">
            {selectable ? (
              <button type="button" class={cx("vz-bar-row", "vz-bar-btn", selectedId === r.id && "vz-selected")} title={tip} aria-label={tip} aria-pressed={selectedId !== undefined ? selectedId === r.id : undefined} onClick={() => onSelect!(r)}>
                {content}
              </button>
            ) : (
              <div class="vz-bar-row" title={tip}>
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

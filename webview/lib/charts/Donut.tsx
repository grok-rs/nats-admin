// Donut for part-to-whole at a glance (≤ 6 parts; the tail folds into "Other").
// The centre shows the total, or the hovered/focused part. 2px surface gaps between arcs.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { cx } from "../ui";
import { arcPath } from "./layout";
import { Legend } from "./Legend";
import { colorOf, type Tone } from "./palette";
import { formatValue, type Unit } from "./units";
import "./charts.css";

export interface DonutDatum {
  id?: string;
  label: string;
  value: number;
  color?: string;
  tone?: Tone;
  slot?: number;
}

export interface DonutProps {
  data: readonly DonutDatum[];
  /** Accessible name, e.g. "Storage by stream". */
  label: string;
  unit?: Unit;
  /** Diameter in px (default 132). */
  size?: number;
  /** Ring thickness in px (default 14). */
  thickness?: number;
  /** Centre text; default: total value with `centerLabel` (default "total") beneath. */
  center?: ComponentChildren;
  centerLabel?: string;
  /** Fold parts beyond this count into "Other" (default 6). */
  maxParts?: number;
  /** Legend beside (wide) / below (narrow) the ring (default true). */
  legend?: boolean;
  /** Monospace legend labels. */
  mono?: boolean;
  onSelect?: (d: DonutDatum) => void;
  emptyText?: ComponentChildren;
  loading?: boolean;
  class?: string;
}

export function Donut({ data, label, unit, size = 132, thickness = 14, center, centerLabel = "total", maxParts = 6, legend = true, mono, onSelect, emptyText = "No data", loading, class: cls }: DonutProps) {
  const [hover, setHover] = useState<number | undefined>(undefined);
  if (loading)
    return (
      <div class={cx("vz-donut", cls)}>
        <div class="skeleton" style={{ width: `${size}px`, height: `${size}px`, borderRadius: "50%" }} aria-busy="true" aria-label={`${label}: loading`} />
      </div>
    );
  let rows = data.filter((d) => d.value > 0).map((d, i) => ({ ...d, color: colorOf(d, i) }));
  rows.sort((a, b) => b.value - a.value);
  if (rows.length > maxParts) {
    const rest = rows.slice(maxParts - 1);
    rows = [...rows.slice(0, maxParts - 1), { label: `Other (${rest.length})`, value: rest.reduce((a, r) => a + r.value, 0), color: "var(--series-other)", id: "__other" }];
  }
  const total = rows.reduce((a, r) => a + r.value, 0);
  const r1 = size / 2 - 3;
  const r0 = r1 - thickness;
  const c = size / 2;
  const gap = rows.length > 1 ? 2 / r1 : 0; // ~2px surface gap
  let start = 0;
  const arcs = rows.map((r, i) => {
    const f = total > 0 ? r.value / total : 0;
    const a0 = Math.PI / 2 - start * Math.PI * 2 - gap / 2;
    const a1 = Math.PI / 2 - (start + f) * Math.PI * 2 + gap / 2;
    start += f;
    const grow = hover === i ? 3 : 0;
    return { r, i, f, d: f > 0 && a0 > a1 ? arcPath(c, c, r0, r1 + grow, a0, a1) : f >= 0.999 ? arcPath(c, c, r0, r1, 0, Math.PI * 2) : "" };
  });
  const pct = (f: number) => `${f * 100 < 10 && f > 0 ? (f * 100).toFixed(1) : Math.round(f * 100)}%`;
  const hv = hover !== undefined ? arcs[hover] : undefined;
  const aria = `${label}: total ${formatValue(total, unit)}; ${arcs.map((a) => `${a.r.label} ${formatValue(a.r.value, unit)} (${pct(a.f)})`).join(", ")}`;
  return (
    <div class={cx("vz-donut", cls)}>
      <div class="vz-donut-ring" style={{ width: `${size}px`, height: `${size}px` }} role="group" aria-label={aria}>
        <svg width={size} height={size} class="vz-svg">
          {total === 0 && <circle cx={c} cy={c} r={(r0 + r1) / 2} class="vz-donut-empty" style={{ strokeWidth: thickness }} />}
          {arcs.map((a) =>
            a.d ? (
              <path
                key={a.r.id ?? a.r.label}
                d={a.d}
                class={cx("vz-arc", onSelect && a.r.id !== "__other" && "vz-clickable")}
                style={{ fill: a.r.color }}
                tabIndex={0}
                role={onSelect ? "button" : "img"}
                aria-label={`${a.r.label}: ${formatValue(a.r.value, unit)} (${pct(a.f)})`}
                onPointerEnter={() => setHover(a.i)}
                onPointerLeave={() => setHover(undefined)}
                onFocus={() => setHover(a.i)}
                onBlur={() => setHover(undefined)}
                onClick={onSelect && a.r.id !== "__other" ? () => onSelect(a.r) : undefined}
                onKeyDown={
                  onSelect
                    ? (e) => {
                        if ((e.key === "Enter" || e.key === " ") && a.r.id !== "__other") {
                          e.preventDefault();
                          onSelect(a.r);
                        }
                      }
                    : undefined
                }
              />
            ) : null,
          )}
        </svg>
        <div class="vz-donut-center" aria-hidden="true" style={{ width: `${r0 * 1.6}px` }}>
          {hv ? (
            <>
              <div class="vz-donut-value">{formatValue(hv.r.value, unit)}</div>
              <div class="vz-donut-label">
                {hv.r.label} · {pct(hv.f)}
              </div>
            </>
          ) : total === 0 ? (
            <div class="vz-donut-label">{emptyText}</div>
          ) : (
            (center ?? (
              <>
                <div class="vz-donut-value">{formatValue(total, unit)}</div>
                <div class="vz-donut-label">{centerLabel}</div>
              </>
            ))
          )}
        </div>
      </div>
      {legend && total > 0 && (
        <Legend vertical label={`${label} legend`} items={arcs.map((a) => ({ id: a.r.id ?? a.r.label, label: a.r.label, color: a.r.color, shape: "rect" as const, mono: mono && a.r.id !== "__other", value: `${formatValue(a.r.value, unit)} · ${pct(a.f)}` }))} />
      )}
    </div>
  );
}

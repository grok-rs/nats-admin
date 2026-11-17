// One whole split into parts (e.g. acked / ack pending / pending / redelivered).
//  - thin (8px, 4px dense): fully rounded ends, no text — sits beside its figures / in tables
//  - tall (28px): each part its own block with its share printed inside where it fits
// 2px surface gaps separate the parts; every part is focusable with a tooltip; the legend
// names the parts in block order.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { cx } from "../ui";
import { inkOn, measureText } from "./dom";
import { useElementSize, useThemeVersion } from "./hooks";
import { Legend } from "./Legend";
import { colorOf, type Tone } from "./palette";
import { ChartTooltip, TipHead, TipRow } from "./Tooltip";
import { formatValue, type Unit } from "./units";
import "./charts.css";

export interface Segment {
  id?: string;
  label: string;
  value: number;
  color?: string;
  tone?: Tone;
  slot?: number;
  hint?: string;
}

export interface SegmentBarProps {
  segments: readonly Segment[];
  /** Accessible name, e.g. "Consumer message state". */
  label: string;
  /** Whole; when larger than the sum the remainder shows as empty track. */
  total?: number;
  unit?: Unit;
  variant?: "thin" | "tall" | "dense";
  /** Legend under the bar (default true). With "values", legend items include the amounts. */
  legend?: boolean | "values";
  /** Tall variant: print "share" (default) or "value" inside blocks. */
  print?: "share" | "value";
  onSelect?: (s: Segment) => void;
  emptyText?: ComponentChildren;
  class?: string;
}

const FONT = 11;

export function SegmentBar({ segments, label, total, unit, variant = "thin", legend = true, print = "share", onSelect, emptyText = "Nothing to show", class: cls }: SegmentBarProps) {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const theme = useThemeVersion();
  const sum = segments.reduce((a, s) => a + Math.max(0, s.value || 0), 0);
  const whole = Math.max(total ?? 0, sum);
  const parts = segments.map((s, i) => ({ s, i, color: colorOf(s, i), frac: whole > 0 ? Math.max(0, s.value || 0) / whole : 0 }));
  const shareText = (f: number) => `${f * 100 < 10 && f > 0 ? (f * 100).toFixed(1) : Math.round(f * 100)}%`;
  const aria = `${label}: ${parts.map((p) => `${p.s.label} ${formatValue(p.s.value, unit)} (${shareText(p.frac)})`).join(", ")}${total !== undefined && total > sum ? `, of ${formatValue(total, unit)}` : ""}`;
  const tall = variant === "tall";
  const hv = hover !== undefined ? parts[hover] : undefined;
  let acc = 0;
  const centers = parts.map((p) => {
    const c = acc + p.frac / 2;
    acc += p.frac;
    return c;
  });
  return (
    <div class={cx("vz-segbar", `vz-segbar-${variant}`, cls)}>
      <div ref={ref} class="vz-seg-track" role="img" aria-label={aria}>
        {whole === 0 && <span class="vz-seg-empty">{tall ? emptyText : null}</span>}
        {parts.map((p, i) => {
          if (p.frac <= 0) return null;
          const px = p.frac * width;
          const text = print === "value" ? formatValue(p.s.value, unit) : shareText(p.frac);
          const fits = tall && width > 0 && measureText(text, FONT) + 12 <= px - 2;
          return (
            <span
              key={p.s.id ?? `${p.s.label}#${i}`}
              class={cx("vz-seg", onSelect && "vz-clickable", hover === i && "vz-active")}
              style={{ flexGrow: p.frac, flexBasis: 0, background: p.color, color: fits ? inkOn(p.color, theme) : undefined }}
              tabIndex={0}
              role={onSelect ? "button" : undefined}
              aria-label={`${p.s.label}: ${formatValue(p.s.value, unit)} (${shareText(p.frac)})`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(undefined)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(undefined)}
              onClick={onSelect ? () => onSelect(p.s) : undefined}
              onKeyDown={
                onSelect
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(p.s);
                      }
                    }
                  : undefined
              }
            >
              {fits && <span class="vz-seg-text">{text}</span>}
            </span>
          );
        })}
        {whole > sum && <span class="vz-seg vz-seg-rest" style={{ flexGrow: (whole - sum) / whole, flexBasis: 0 }} aria-hidden="true" />}
        {hv && width > 0 && (
          <ChartTooltip x={centers[hover!] * width} y={-6} containerWidth={width} above>
            <TipHead>{hv.s.label}</TipHead>
            <TipRow shape="rect" color={hv.color} value={formatValue(hv.s.value, unit)} label={`${shareText(hv.frac)}${hv.s.hint ? ` · ${hv.s.hint}` : ""}`} />
          </ChartTooltip>
        )}
      </div>
      {legend && (
        <Legend
          label={`${label} parts`}
          items={parts.map((p) => ({
            id: p.s.id ?? p.s.label,
            label: p.s.label,
            color: p.color,
            shape: "rect" as const,
            value: legend === "values" ? `${formatValue(p.s.value, unit)}${tall ? "" : ` · ${shareText(p.frac)}`}` : undefined,
          }))}
        />
      )}
    </div>
  );
}

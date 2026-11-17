// Chart tooltip: one floating readout per chart, positioned inside the chart container.
// Values lead (strong), series names follow (muted); rows are keyed with a short line/rect.

import type { ComponentChildren } from "preact";
import { cx } from "../ui";
import "./charts.css";

export interface ChartTooltipProps {
  /** Anchor x/y in px relative to the chart container (position: relative). */
  x: number;
  y: number;
  /** Container width, used to flip the tooltip to the left of the anchor near the right edge. */
  containerWidth: number;
  children: ComponentChildren;
  /** Centre horizontally above the anchor instead of beside it (bars, cells). */
  above?: boolean;
}

export function ChartTooltip({ x, y, containerWidth, children, above }: ChartTooltipProps) {
  const flip = !above && x > containerWidth * 0.55;
  const style = above
    ? { left: `${Math.max(8, Math.min(containerWidth - 8, x))}px`, top: `${y}px` }
    : { left: `${x}px`, top: `${y}px` };
  const edge = above ? (x < 90 ? "vz-tip-above-start" : x > containerWidth - 90 ? "vz-tip-above-end" : "") : "";
  return (
    <div class={cx("vz-tip", flip && "vz-tip-flip", above && "vz-tip-above", edge)} style={style} aria-hidden="true">
      {children}
    </div>
  );
}

export function TipHead({ children }: { children: ComponentChildren }) {
  return <div class="vz-tip-head">{children}</div>;
}

export function TipRow({ color, value, label, shape = "line", dim }: { color?: string; value: ComponentChildren; label?: ComponentChildren; shape?: "line" | "rect" | "dot" | "none"; dim?: boolean }) {
  return (
    <div class={cx("vz-tip-row", dim && "vz-dim")}>
      {shape !== "none" && <span class={cx("vz-key", `vz-key-${shape}`)} style={color ? { background: color } : undefined} />}
      <span class="vz-tip-value">{value}</span>
      {label !== undefined && <span class="vz-tip-label">{label}</span>}
    </div>
  );
}

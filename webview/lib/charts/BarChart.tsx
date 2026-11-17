// Vertical categorical bars ("messages per stream"). Bars ≤ 24px wide with a 4px rounded cap,
// square at the baseline; one hue unless a datum carries a tone/colour. Each column is a
// focusable hit target with a tooltip; values print on the caps when there is room.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { cx } from "../ui";
import { fitText, maxTextWidth, measureText } from "./dom";
import { useElementSize } from "./hooks";
import { toneColor, type Tone } from "./palette";
import { linearScale, niceTicks } from "./scale";
import { ChartTooltip, TipHead, TipRow } from "./Tooltip";
import { resolveUnit, type Unit } from "./units";
import "./charts.css";

export interface BarDatum {
  id?: string;
  label: string;
  value: number;
  color?: string;
  tone?: Tone;
  hint?: string;
}

export interface BarChartProps {
  data: readonly BarDatum[];
  label: string;
  unit?: Unit;
  /** Total height including the label band (default 180). */
  height?: number;
  /** Colour for all bars (default slot 1). */
  color?: string;
  /** Print values on bar caps: "auto" (default, when they fit), true or false. */
  showValues?: boolean | "auto";
  yMax?: number;
  /** Monospace category labels. */
  mono?: boolean;
  onSelect?: (d: BarDatum) => void;
  selectedId?: string;
  emptyText?: ComponentChildren;
  loading?: boolean;
  class?: string;
}

const FONT = 10.5;

export function BarChart({ data, label, unit, height = 180, color, showValues = "auto", yMax, mono, onSelect, selectedId, emptyText = "No data", loading, class: cls }: BarChartProps) {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const u = resolveUnit(unit);
  if (loading) return <div class={cx("vz-chart", cls)}><div class="skeleton" style={{ height: `${height}px` }} aria-busy="true" aria-label={`${label}: loading`} /></div>;
  const max = yMax ?? Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(0, max || 1, Math.max(2, Math.floor((height - 40) / 36)), { binary: u.binary });
  const top = yMax ?? ticks[ticks.length - 1];
  const tickLabels = ticks.map((t) => u.tick(t));
  const labelW = Math.max(14, maxTextWidth(tickLabels, FONT));
  const plotLeft = labelW + 8;
  const plotRight = Math.max(plotLeft + 10, width - 4);
  const plotTop = (showValues !== false ? 14 : 6) + (u.axisLabel ? 14 : 0);
  const plotBottom = height - 20;
  const band = data.length ? (plotRight - plotLeft) / data.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.62));
  const y = linearScale([0, top], [plotBottom, plotTop]);
  const valuesFit = showValues === true || (showValues === "auto" && data.length > 0 && data.every((d) => measureText(u.tick(d.value), FONT) <= band - 2));
  const labelEvery = band > 0 ? Math.max(1, Math.ceil(36 / band)) : 1;
  const r = 4;
  const barPath = (x0: number, y0: number, w: number, h: number) => {
    if (h <= 0) return "";
    const rr = Math.min(r, w / 2, h);
    return `M${x0},${y0 + h}V${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}H${x0 + w - rr}Q${x0 + w},${y0} ${x0 + w},${y0 + rr}V${y0 + h}Z`;
  };
  const hv = hover !== undefined ? data[hover] : undefined;
  return (
    <div class={cx("vz-chart", "vz-barchart", cls)}>
      <div ref={ref} class="vz-plot" style={{ height: `${height}px` }} role="group" aria-label={`${label}: ${data.length} bars`}>
        {width > 0 && data.length > 0 && (
          <svg width={width} height={height} class="vz-svg">
            {u.axisLabel && (
              <text x={0} y={9} class="vz-axis-caption">
                {u.axisLabel}
              </text>
            )}
            {ticks.map((t, i) => {
              const py = Math.round(y(t)) + 0.5;
              return (
                <g key={t} aria-hidden="true">
                  <line x1={plotLeft} x2={plotRight} y1={py} y2={py} class={t === 0 ? "vz-baseline" : "vz-gridline"} />
                  <text x={plotLeft - 6} y={py} class="vz-tick" text-anchor="end" dominant-baseline="middle">
                    {tickLabels[i]}
                  </text>
                </g>
              );
            })}
            {data.map((d, i) => {
              const cxm = plotLeft + band * (i + 0.5);
              const x0 = cxm - barW / 2;
              const y0 = y(Math.max(0, d.value));
              const fill = d.color ?? (d.tone ? toneColor(d.tone) : color ?? "var(--series-1)");
              const text = `${d.label}: ${u.format(d.value)}${d.hint ? ` — ${d.hint}` : ""}`;
              const active = hover === i || selectedId === (d.id ?? d.label);
              return (
                <g
                  key={d.id ?? `${d.label}#${i}`}
                  class={cx("vz-bar-col", active && "vz-active", onSelect && "vz-clickable")}
                  tabIndex={0}
                  role={onSelect ? "button" : "img"}
                  aria-label={text}
                  aria-pressed={onSelect && selectedId !== undefined ? selectedId === (d.id ?? d.label) : undefined}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(undefined)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(undefined)}
                  onClick={onSelect ? () => onSelect(d) : undefined}
                  onKeyDown={
                    onSelect
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelect(d);
                          }
                        }
                      : undefined
                  }
                >
                  <rect x={plotLeft + band * i} y={plotTop - 4} width={band} height={plotBottom - plotTop + 4} class="vz-hit-col" />
                  <path d={barPath(x0, y0, barW, plotBottom - y0)} class="vz-bar" style={{ fill }} />
                  {valuesFit && d.value > 0 && (
                    <text x={cxm} y={y0 - 4} class="vz-value-label" text-anchor="middle" aria-hidden="true">
                      {u.tick(d.value)}
                    </text>
                  )}
                  {i % labelEvery === 0 && (
                    <text x={cxm} y={height - 5} class={cx("vz-tick", "vz-cat-label", mono && "vz-mono")} text-anchor="middle" aria-hidden="true">
                      {fitText(d.label, band * labelEvery - 4, FONT, mono)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {width > 0 && !data.length && <div class="vz-empty-msg">{emptyText}</div>}
        {hv && width > 0 && (
          <ChartTooltip x={plotLeft + band * (hover! + 0.5)} y={Math.max(0, y(Math.max(0, hv.value)) - 8)} containerWidth={width} above>
            <TipHead>{hv.label}</TipHead>
            <TipRow shape="rect" color={hv.color ?? (hv.tone ? toneColor(hv.tone) : color ?? "var(--series-1)")} value={u.format(hv.value)} label={hv.hint} />
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

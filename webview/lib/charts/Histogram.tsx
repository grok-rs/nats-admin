// Distribution of raw values (latency, payload sizes) with nice bin edges and optional
// percentile markers. Adjacent bins are separated by a 2px surface gap.

import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { cx } from "../ui";
import { maxTextWidth, measureText } from "./dom";
import { useElementSize } from "./hooks";
import { histogram, quantile, type Bin } from "./layout";
import { toneColor, type Tone } from "./palette";
import { linearScale, niceTicks } from "./scale";
import { ChartTooltip, TipHead, TipRow } from "./Tooltip";
import { compactTick, resolveUnit, type Unit } from "./units";
import "./charts.css";

export interface HistogramMarker {
  value: number;
  label: string;
  tone?: Tone;
}

export interface HistogramProps {
  /** Raw observations. */
  values: readonly number[];
  /** Accessible name, e.g. "Request latency". */
  label: string;
  /** Unit of the observations (x-axis), e.g. "ms" or "bytes". */
  unit?: Unit;
  /** Bin count or "auto" (default). */
  bins?: number | "auto";
  domain?: [number, number];
  /** Vertical markers; "percentiles" adds p50 / p95 / p99. */
  markers?: readonly HistogramMarker[] | "percentiles";
  /** Noun for counts in tooltips (default "samples"). */
  countLabel?: string;
  height?: number;
  color?: string;
  emptyText?: ComponentChildren;
  loading?: boolean;
  class?: string;
}

const FONT = 10.5;

export function Histogram({ values, label, unit, bins = "auto", domain, markers, countLabel = "samples", height = 170, color = "var(--series-1)", emptyText = "No samples yet", loading, class: cls }: HistogramProps) {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const u = resolveUnit(unit);
  const data: Bin[] = useMemo(() => histogram(values as number[], { bins, domain }), [values, bins, domain?.[0], domain?.[1]]);
  const sorted = useMemo(() => (markers === "percentiles" ? [...values].filter(Number.isFinite).sort((a, b) => a - b) : []), [values, markers]);
  if (loading) return <div class={cx("vz-chart", cls)}><div class="skeleton" style={{ height: `${height}px` }} aria-busy="true" aria-label={`${label}: loading`} /></div>;
  const marks: HistogramMarker[] =
    markers === "percentiles"
      ? ([
          [0.5, "p50", "info"],
          [0.95, "p95", "warn"],
          [0.99, "p99", "danger"],
        ] as const)
          .map(([q, l, tone]) => ({ value: quantile(sorted, q) ?? Number.NaN, label: l, tone: tone as Tone }))
          .filter((m) => Number.isFinite(m.value))
      : [...(markers ?? [])];
  const maxCount = Math.max(0, ...data.map((b) => b.count));
  const yTicks = niceTicks(0, maxCount || 1, Math.max(2, Math.floor((height - 40) / 34)));
  const yLabels = yTicks.map(compactTick);
  const labelW = Math.max(12, maxTextWidth(yLabels, FONT));
  const plotLeft = labelW + 8;
  const plotRight = Math.max(plotLeft + 10, width - 8);
  const plotTop = marks.length ? 18 : 8;
  const plotBottom = height - 20;
  const x0 = data.length ? data[0].x0 : 0;
  const x1 = data.length ? data[data.length - 1].x1 : 1;
  const x = linearScale([x0, x1], [plotLeft, plotRight]);
  const y = linearScale([0, yTicks[yTicks.length - 1]], [plotBottom, plotTop]);
  const xTicks = niceTicks(x0, x1, Math.max(2, Math.floor((plotRight - plotLeft) / 70)), { binary: u.binary }).filter((t) => t >= x0 - 1e-9 && t <= x1 + 1e-9);
  const total = data.reduce((a, b) => a + b.count, 0);
  const hb = hover !== undefined ? data[hover] : undefined;
  const lastIdx = data.length - 1;
  // With a fixed domain, out-of-range values are clamped into the edge bins: label them as open-ended.
  const range = (b: Bin) => {
    const i = data.indexOf(b);
    if (domain && i === lastIdx && values.some((v) => v > b.x1)) return `≥ ${u.format(b.x0)}`;
    if (domain && i === 0 && values.some((v) => v < b.x0)) return `< ${u.format(b.x1)}`;
    return `${u.tick(b.x0)} – ${u.format(b.x1)}`;
  };
  const markText = marks.map((m) => `${m.label} ${u.format(m.value)}`).join(", ");
  return (
    <div class={cx("vz-chart", "vz-histogram", cls)}>
      <div ref={ref} class="vz-plot" style={{ height: `${height}px` }} role="group" aria-label={`${label}: ${total} ${countLabel} in ${data.length} bins${markText ? `; ${markText}` : ""}`}>
        {width > 0 && data.length > 0 && (
          <svg width={width} height={height} class="vz-svg">
            {yTicks.map((t, i) => {
              const py = Math.round(y(t)) + 0.5;
              return (
                <g key={`y${t}`} aria-hidden="true">
                  <line x1={plotLeft} x2={plotRight} y1={py} y2={py} class={t === 0 ? "vz-baseline" : "vz-gridline"} />
                  <text x={plotLeft - 6} y={py} class="vz-tick" text-anchor="end" dominant-baseline="middle">
                    {yLabels[i]}
                  </text>
                </g>
              );
            })}
            {xTicks.map((t) => {
              const px = x(t);
              const text = u.tick(t);
              const w = measureText(text, FONT);
              return (
                <text key={`x${t}`} x={px} y={height - 5} class="vz-tick" aria-hidden="true" text-anchor={px - w / 2 < 0 ? "start" : px + w / 2 > width ? "end" : "middle"}>
                  {text}
                </text>
              );
            })}
            {data.map((b, i) => {
              const bx = x(b.x0) + 1;
              const bw = Math.max(1, x(b.x1) - x(b.x0) - 2);
              const by = y(b.count);
              const bh = plotBottom - by;
              const rr = Math.min(3, bw / 2, bh);
              const d = bh > 0 ? `M${bx},${plotBottom}V${by + rr}Q${bx},${by} ${bx + rr},${by}H${bx + bw - rr}Q${bx + bw},${by} ${bx + bw},${by + rr}V${plotBottom}Z` : "";
              return (
                <g
                  key={i}
                  class={cx("vz-bar-col", hover === i && "vz-active")}
                  tabIndex={0}
                  role="img"
                  aria-label={`${range(b)}: ${b.count} ${countLabel}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(undefined)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(undefined)}
                >
                  <rect x={x(b.x0)} y={plotTop} width={Math.max(1, x(b.x1) - x(b.x0))} height={plotBottom - plotTop} class="vz-hit-col" />
                  {d && <path d={d} class="vz-bar" style={{ fill: color }} />}
                </g>
              );
            })}
            {marks.map((m) => {
              if (m.value < x0 || m.value > x1) return null;
              const px = Math.round(x(m.value)) + 0.5;
              return (
                <g key={m.label} class="vz-marker" aria-hidden="true">
                  <line x1={px} x2={px} y1={plotTop - 2} y2={plotBottom} style={{ stroke: toneColor(m.tone ?? "neutral") }} />
                  <text x={px} y={10} text-anchor={px > width - 50 ? "end" : px < 50 ? "start" : "middle"} class="vz-marker-label">
                    {m.label} {u.format(m.value)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        {width > 0 && !data.length && <div class="vz-empty-msg">{emptyText}</div>}
        {hb && width > 0 && (
          <ChartTooltip x={(x(hb.x0) + x(hb.x1)) / 2} y={Math.max(0, y(hb.count) - 8)} containerWidth={width} above>
            <TipHead>{range(hb)}</TipHead>
            <TipRow shape="rect" color={color} value={`${hb.count.toLocaleString("en-US")} ${countLabel}`} label={total ? `${((hb.count / total) * 100).toFixed(1)}%` : undefined} />
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}

// Multi-series time chart: lines (+ optional area wash), time x-axis with wall-clock ticks,
// unit-aware y-axis, hairline grid, legend toggles, crosshair + tooltip (mouse and keyboard),
// thresholds, gaps for missing data, and empty / loading / stale states.

import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { cx } from "../ui";
import { maxTextWidth, measureText } from "./dom";
import { CrosshairContext, useCrosshair, useElementSize, useHiddenSet, useId } from "./hooks";
import { Legend } from "./Legend";
import { colorOf, toneColor, type Tone } from "./palette";
import { fmtTimeFull, fmtTimeTick, linearScale, niceTicks, timeTicks } from "./scale";
import { decimate, lastValue, medianInterval, nearestIndex, type TimePoint } from "./series";
import { ChartTooltip, TipHead, TipRow } from "./Tooltip";
import { resolveUnit, type Unit } from "./units";
import "./charts.css";

export interface TimeSeries {
  /** Stable id (colour follows the entity: keep ids and array order stable). */
  id: string;
  name: string;
  points: readonly TimePoint[];
  /** Explicit CSS colour. Default: categorical slot by array index (or `slot`). */
  color?: string;
  /** Pin a categorical slot (0-based) regardless of array position. */
  slot?: number;
  /** Status meaning (errors, redeliveries): uses the tone colour instead of a slot. */
  tone?: Tone;
  /** Draw the ~10% area wash under this series (default: only when a single series is visible). */
  area?: boolean;
  dashed?: boolean;
  /** Start hidden (uncontrolled legend state). */
  hidden?: boolean;
}

export interface Threshold {
  value: number;
  tone?: Tone;
  label?: string;
}

export interface TimeSeriesChartProps {
  series: readonly TimeSeries[];
  /** Accessible name, e.g. "Message throughput". */
  label: string;
  unit?: Unit;
  /** Total height in px including the x-axis band (default 180). */
  height?: number;
  /** Show a trailing window of this length ending at `end` (default: the latest point). */
  windowMs?: number;
  end?: number;
  yMin?: number;
  yMax?: number;
  thresholds?: readonly Threshold[];
  /** "auto" (default): legend when ≥ 2 series. */
  legend?: boolean | "auto";
  /** Print each series' latest value in the legend (default true). */
  legendValues?: boolean;
  /** Controlled hidden series ids (with onToggleSeries). */
  hiddenIds?: readonly string[];
  onToggleSeries?: (id: string) => void;
  /** Controlled crosshair time (sync); otherwise a surrounding <CrosshairSync> or local state. */
  hoverTime?: number;
  onHoverTime?: (t: number | undefined) => void;
  /** Break the line where consecutive points are further apart than gapFactor × median spacing (default 5). */
  gapFactor?: number;
  /** End-of-line dots (default true). */
  endDots?: boolean;
  emptyText?: ComponentChildren;
  loading?: boolean;
  /** Refetching: hold the previous render at reduced opacity. */
  stale?: boolean;
  class?: string;
}

interface Prepared {
  s: TimeSeries;
  color: string;
  pts: TimePoint[];
  median: number;
}

const FONT = 10.5;
const X_BAND = 20;

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { series, label, unit, height = 180, windowMs, end, yMin, yMax, thresholds = [], legend = "auto", legendValues = true, gapFactor = 5, endDots = true, emptyText = "No data yet", loading, stale } = props;
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const u = resolveUnit(unit);
  const clipId = useId("vz-clip");
  const liveId = useId("vz-live");
  const sync = useCrosshair();
  const local = useHiddenSet(series.filter((s) => s.hidden).map((s) => s.id));
  const hidden: ReadonlySet<string> = props.hiddenIds ? new Set(props.hiddenIds) : local.hidden;
  const toggle = props.onToggleSeries ?? local.toggle;
  const [localHover, setLocalHover] = useState<number | undefined>(undefined);
  const [keyboard, setKeyboard] = useState(false);
  const hover = props.hoverTime ?? (sync ? sync.t : localHover);
  const setHover = (t: number | undefined) => {
    props.onHoverTime?.(t);
    if (sync) sync.set(t);
    else setLocalHover(t);
  };

  const all: Prepared[] = useMemo(
    () => series.map((s, i) => ({ s, color: colorOf(s, i), pts: s.points as TimePoint[], median: medianInterval(s.points) })),
    [series],
  );
  const visible = all.filter((p) => !hidden.has(p.s.id));

  // ---- domains ----
  let tMax = end ?? -Infinity;
  let tMin = Infinity;
  if (end === undefined) for (const p of all) if (p.pts.length) tMax = Math.max(tMax, p.pts[p.pts.length - 1].t);
  for (const p of all) if (p.pts.length) tMin = Math.min(tMin, p.pts[0].t);
  if (!Number.isFinite(tMax)) tMax = Date.now();
  let tStart = windowMs ? tMax - windowMs : Number.isFinite(tMin) ? tMin : tMax - 60_000;
  if (tStart >= tMax) tStart = tMax - 60_000;

  let lo = Infinity;
  let hi = -Infinity;
  let hasData = false;
  for (const p of visible)
    for (const pt of p.pts) {
      if (pt.t < tStart || pt.t > tMax || pt.v === null || !Number.isFinite(pt.v)) continue;
      hasData = true;
      if (pt.v < lo) lo = pt.v;
      if (pt.v > hi) hi = pt.v;
    }
  if (hasData)
    for (const th of thresholds) {
      lo = Math.min(lo, th.value);
      hi = Math.max(hi, th.value);
    }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  lo = yMin ?? Math.min(0, lo);
  hi = yMax ?? hi;
  const plotTop = u.axisLabel && hasData ? 24 : 8;
  const plotBottom = height - X_BAND;
  const plotH = Math.max(20, plotBottom - plotTop);
  const tickCount = Math.max(2, Math.min(6, Math.floor(plotH / 34)));
  let yTicks = niceTicks(lo, hi, tickCount, { binary: u.binary });
  if (yMin !== undefined || yMax !== undefined) yTicks = yTicks.filter((t) => (yMin === undefined || t >= lo - 1e-9) && (yMax === undefined || t <= hi + 1e-9));
  const y0 = yMin ?? yTicks[0];
  const y1 = yMax ?? yTicks[yTicks.length - 1];
  const yLabels = hasData ? yTicks.map((t) => u.tick(t)) : [];
  const labelW = Math.max(16, maxTextWidth(yLabels, FONT));
  const plotLeft = labelW + 8;
  const plotRight = Math.max(plotLeft + 10, width - 8);
  const x = linearScale([tStart, tMax], [plotLeft, plotRight]);
  const y = linearScale([y0, y1], [plotBottom, plotTop]);

  // ---- paths ----
  const maxPts = Math.max(50, Math.round((plotRight - plotLeft) * 2));
  const singleVisible = visible.length === 1;
  const drawn = visible.map((p) => {
    const inWin = p.pts.filter((pt) => pt.t >= tStart - p.median * 2 && pt.t <= tMax);
    const pts = decimate(inWin, maxPts);
    const gapMs = p.median > 0 ? p.median * gapFactor : Infinity;
    let line = "";
    let area = "";
    let seg: string[] = [];
    let segStartX = 0;
    let prevT = -Infinity;
    const base = y(Math.max(y0, Math.min(y1, 0)));
    const flush = (lastX: number) => {
      if (seg.length) {
        line += `M${seg.join("L")}`;
        area += `M${segStartX.toFixed(1)},${base.toFixed(1)}L${seg.join("L")}L${lastX.toFixed(1)},${base.toFixed(1)}Z`;
      }
      seg = [];
    };
    let lastX = 0;
    for (const pt of pts) {
      if (pt.v === null || !Number.isFinite(pt.v) || pt.t - prevT > gapMs) flush(lastX);
      if (pt.v === null || !Number.isFinite(pt.v)) {
        prevT = -Infinity;
        continue;
      }
      const px = x(pt.t);
      const py = y(pt.v);
      if (!seg.length) segStartX = px;
      seg.push(`${px.toFixed(1)},${py.toFixed(1)}`);
      lastX = px;
      prevT = pt.t;
    }
    flush(lastX);
    const last = [...pts].reverse().find((pt) => pt.v !== null && Number.isFinite(pt.v));
    return { ...p, line, area, last, showArea: p.s.area ?? singleVisible };
  });

  // ---- hover ----
  const ref0 = visible.reduce<Prepared | undefined>((best, p) => (!best || p.pts.length > best.pts.length ? p : best), undefined);
  let hoverIdx = -1;
  let hoverT: number | undefined;
  if (hover !== undefined && ref0 && hover >= tStart - (ref0.median || 0) && hover <= tMax + (ref0.median || 0)) {
    hoverIdx = nearestIndex(ref0.pts, hover);
    if (hoverIdx >= 0) hoverT = ref0.pts[hoverIdx].t;
  }
  const hoverRows =
    hoverT === undefined
      ? []
      : visible.map((p) => {
          const i = nearestIndex(p.pts, hoverT!);
          const pt = i >= 0 ? p.pts[i] : undefined;
          const tol = Math.max(p.median, 1) * 1.5;
          const v = pt && Math.abs(pt.t - hoverT!) <= tol ? pt.v : null;
          return { p, v };
        });

  const onMove = (e: PointerEvent) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - rect.left + plotLeft;
    setKeyboard(false);
    setHover(x.invert(px));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!ref0 || !ref0.pts.length) return;
    const n = ref0.pts.length;
    let i = hoverIdx < 0 ? n - 1 : hoverIdx;
    if (e.key === "ArrowLeft") i = Math.max(0, i - (e.shiftKey ? 10 : 1));
    else if (e.key === "ArrowRight") i = Math.min(n - 1, i + (e.shiftKey ? 10 : 1));
    else if (e.key === "Home") i = nearestIndex(ref0.pts, tStart);
    else if (e.key === "End") i = n - 1;
    else if (e.key === "Escape") {
      setHover(undefined);
      return;
    } else return;
    e.preventDefault();
    setKeyboard(true);
    setHover(ref0.pts[i].t);
  };

  // ---- labels / a11y ----
  const latest = visible.map((p) => `${p.s.name} ${u.format(lastValue(p.pts) ?? Number.NaN)}`).join(", ");
  const aria = `${label}. ${visible.length} of ${all.length} series shown${hasData ? `. Latest: ${latest}` : ". No data"}. Use arrow keys to inspect values.`;
  const readout = hoverT !== undefined && keyboard ? `${fmtTimeFull(hoverT)}: ${hoverRows.map((r) => `${r.p.s.name} ${u.format(r.v ?? Number.NaN)}`).join(", ")}` : "";

  const showLegend = legend === true || (legend === "auto" && series.length >= 2);
  const xt = width > 0 ? timeTicks(tStart, tMax, Math.max(2, Math.floor((plotRight - plotLeft) / 76))) : { ticks: [], step: 1000 };

  if (loading) {
    return (
      <div class={cx("vz-chart", props.class)}>
        <div class="skeleton" style={{ height: `${height}px` }} aria-busy="true" aria-label={`${label}: loading`} />
        {showLegend && <div class="skeleton skeleton-text" style={{ width: "40%", marginTop: "8px" }} />}
      </div>
    );
  }

  return (
    <div class={cx("vz-chart", "vz-ts", stale && "vz-stale", props.class)}>
      <div
        ref={ref}
        class="vz-plot"
        style={{ height: `${height}px` }}
        tabIndex={0}
        role="img"
        aria-label={aria}
        aria-describedby={liveId}
        onKeyDown={onKey}
        onBlur={() => keyboard && setHover(undefined)}
      >
        {width > 0 && (
          <svg width={width} height={height} class="vz-svg" aria-hidden="true">
            <defs>
              <clipPath id={clipId}>
                <rect x={plotLeft} y={plotTop - 6} width={plotRight - plotLeft + 6} height={plotH + 8} />
              </clipPath>
            </defs>
            {u.axisLabel && hasData && (
              <text x={0} y={10} class="vz-axis-caption">
                {u.axisLabel}
              </text>
            )}
            {(hasData ? yTicks : [0]).map((t, i) => {
              const py = Math.round(hasData ? y(t) : plotBottom) + 0.5;
              return (
                <g key={`y${t}`}>
                  <line x1={plotLeft} x2={plotRight} y1={py} y2={py} class={t === 0 || !hasData ? "vz-baseline" : "vz-gridline"} />
                  {hasData && (
                    <text x={plotLeft - 6} y={py} class="vz-tick" text-anchor="end" dominant-baseline="middle">
                      {yLabels[i]}
                    </text>
                  )}
                </g>
              );
            })}
            {xt.ticks.map((t) => {
              const px = x(t);
              const text = fmtTimeTick(t, xt.step);
              const w = measureText(text, FONT);
              const anchor = px - w / 2 < 0 ? "start" : px + w / 2 > width ? "end" : "middle";
              return (
                <g key={`x${t}`}>
                  <line x1={Math.round(px) + 0.5} x2={Math.round(px) + 0.5} y1={plotBottom} y2={plotBottom + 3} class="vz-baseline" />
                  <text x={px} y={height - 5} class="vz-tick" text-anchor={anchor}>
                    {text}
                  </text>
                </g>
              );
            })}
            <g clip-path={`url(#${clipId})`}>
              {drawn.map((d) =>
                d.showArea && d.area ? <path key={`a-${d.s.id}`} d={d.area} class="vz-area" style={{ fill: d.color }} /> : null,
              )}
              {drawn.map((d) =>
                d.line ? <path key={`l-${d.s.id}`} d={d.line} class={cx("vz-line", d.s.dashed && "vz-dashed")} style={{ stroke: d.color }} /> : null,
              )}
            </g>
            {thresholds.map((th, i) => {
              if (!hasData || th.value < y0 || th.value > y1) return null;
              const py = Math.round(y(th.value)) + 0.5;
              const text = `${th.label ? `${th.label} ` : ""}${u.format(th.value)}`;
              return (
                <g key={`th${i}`} class="vz-threshold">
                  <line x1={plotLeft} x2={plotRight} y1={py} y2={py} style={{ stroke: toneColor(th.tone ?? "warn") }} />
                  <text x={plotRight - 2} y={py - 4} text-anchor="end" class="vz-threshold-label">
                    {text}
                  </text>
                </g>
              );
            })}
            {endDots &&
              hoverT === undefined &&
              drawn.map((d) =>
                d.last && d.last.t >= tStart ? <circle key={`e-${d.s.id}`} cx={x(d.last.t)} cy={y(d.last.v as number)} r={3.5} class="vz-dot" style={{ fill: d.color }} /> : null,
              )}
            {hoverT !== undefined && (
              <g class="vz-hover">
                <line x1={Math.round(x(hoverT)) + 0.5} x2={Math.round(x(hoverT)) + 0.5} y1={plotTop - 4} y2={plotBottom} class="vz-crosshair" />
                {hoverRows.map((r) =>
                  r.v === null ? null : <circle key={`h-${r.p.s.id}`} cx={x(hoverT!)} cy={y(r.v)} r={4} class="vz-dot" style={{ fill: r.p.color }} />,
                )}
              </g>
            )}
            <rect
              x={plotLeft}
              y={plotTop}
              width={Math.max(0, plotRight - plotLeft)}
              height={plotH}
              class="vz-hit"
              onPointerMove={(e) => onMove(e as unknown as PointerEvent)}
              onPointerLeave={() => setHover(undefined)}
            />
          </svg>
        )}
        {width > 0 && !hasData && <div class="vz-empty-msg">{visible.length || !all.length ? emptyText : "All series hidden — use the legend to show them"}</div>}
        {hoverT !== undefined && width > 0 && (
          <ChartTooltip x={x(hoverT)} y={plotTop} containerWidth={width}>
            <TipHead>{fmtTimeFull(hoverT)}</TipHead>
            {hoverRows.map((r) => (
              <TipRow key={r.p.s.id} color={r.p.color} value={u.format(r.v ?? Number.NaN)} label={visible.length > 1 || r.p.s.name !== label ? r.p.s.name : undefined} />
            ))}
          </ChartTooltip>
        )}
        <div id={liveId} class="sr-only" aria-live="polite">
          {readout}
        </div>
      </div>
      {showLegend && (
        <Legend
          label={`${label} series`}
          items={all.map((p) => ({
            id: p.s.id,
            label: p.s.name,
            color: p.color,
            hidden: hidden.has(p.s.id),
            shape: (p.s.area ?? singleVisible) ? "rect" : "line",
            dashed: p.s.dashed,
            value: legendValues ? u.format(lastValue(p.pts) ?? Number.NaN) : undefined,
          }))}
          onToggle={toggle}
          onSolo={props.onToggleSeries ? undefined : (id) => local.solo(id, series.map((s) => s.id))}
        />
      )}
    </div>
  );
}

/**
 * Shares one crosshair between every TimeSeriesChart inside it (hover one chart, all show the
 * same instant), like a Grafana shared tooltip.
 */
export function CrosshairSync({ children }: { children: ComponentChildren }) {
  const [t, set] = useState<number | undefined>(undefined);
  return <CrosshairContext.Provider value={{ t, set }}>{children}</CrosshairContext.Provider>;
}

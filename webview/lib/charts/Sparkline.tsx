// Word-sized trend line for KPI tiles and table cells. Hover/focus shows the value.

import { useState } from "preact/hooks";
import { cx } from "../ui";
import { useElementSize } from "./hooks";
import { toneColor, type Tone } from "./palette";
import { fmtTimeFull, linearScale } from "./scale";
import type { TimePoint } from "./series";
import { ChartTooltip, TipRow } from "./Tooltip";
import { resolveUnit, type Unit } from "./units";
import "./charts.css";

export interface SparklineProps {
  /** Plain values (evenly spaced) or time points (null = gap). */
  values: readonly number[] | readonly TimePoint[];
  /** Fixed width in px; default fills the container. */
  width?: number;
  /** Height in px (default 28). */
  height?: number;
  /** Line colour (default series slot 1); `tone` uses a status colour. */
  color?: string;
  tone?: Tone;
  /** ~10% area wash (default true). */
  area?: boolean;
  /** Y domain; default [min(0, data), max(data)]. */
  min?: number;
  max?: number;
  /** Accessible name, e.g. "msgs/s, last 5 minutes". */
  label?: string;
  unit?: Unit;
  /** Hover/keyboard readout (default true). */
  interactive?: boolean;
  /** Dot on the latest value (default true). */
  endDot?: boolean;
  class?: string;
}

function toPoints(values: SparklineProps["values"]): { pts: TimePoint[]; timed: boolean } {
  if (!values.length) return { pts: [], timed: false };
  if (typeof values[0] === "number") return { pts: (values as number[]).map((v, i) => ({ t: i, v })), timed: false };
  return { pts: values as TimePoint[], timed: true };
}

export function Sparkline({ values, width: fixedW, height = 28, color, tone, area = true, min, max, label, unit, interactive = true, endDot = true, class: cls }: SparklineProps) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const w = fixedW ?? size.width;
  const u = resolveUnit(unit);
  const { pts, timed } = toPoints(values);
  const stroke = color ?? (tone ? toneColor(tone) : "var(--series-1)");
  const finite = pts.filter((p) => p.v !== null && Number.isFinite(p.v)) as { t: number; v: number }[];
  const lo = min ?? Math.min(0, ...finite.map((p) => p.v));
  const hi = max ?? Math.max(lo + 1e-9, ...finite.map((p) => p.v));
  const pad = 3.5;
  const t0 = pts.length ? pts[0].t : 0;
  const t1 = pts.length ? pts[pts.length - 1].t : 1;
  const x = linearScale([t0, t1 === t0 ? t0 + 1 : t1], [pad, Math.max(pad + 1, w - pad)]);
  const y = linearScale([lo, hi === lo ? lo + 1 : hi], [height - 2, pad]);
  let line = "";
  let areaPath = "";
  let seg: string[] = [];
  let sx = 0;
  let lx = 0;
  const flush = () => {
    if (seg.length > 1) {
      line += `M${seg.join("L")}`;
      areaPath += `M${sx.toFixed(1)},${height}L${seg.join("L")}L${lx.toFixed(1)},${height}Z`;
    } else if (seg.length === 1) line += `M${seg[0]}h0.01`;
    seg = [];
  };
  for (const p of pts) {
    if (p.v === null || !Number.isFinite(p.v)) {
      flush();
      continue;
    }
    const px = x(p.t);
    if (!seg.length) sx = px;
    seg.push(`${px.toFixed(1)},${y(p.v).toFixed(1)}`);
    lx = px;
  }
  flush();
  const last = finite[finite.length - 1];
  const hp = hover !== undefined ? pts[hover] : undefined;
  const aria = `${label ?? "Trend"}: ${finite.length ? `latest ${u.format(last.v)}, range ${u.format(Math.min(...finite.map((p) => p.v)))}–${u.format(Math.max(...finite.map((p) => p.v)))}` : "no data"}`;

  const pick = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const t = x.invert(clientX - r.left);
    let best = -1;
    let bd = Infinity;
    pts.forEach((p, i) => {
      if (p.v === null) return;
      const d = Math.abs(p.t - t);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best >= 0 ? best : undefined);
  };

  return (
    <div
      ref={ref}
      class={cx("vz-spark", cls)}
      style={{ height: `${height}px`, width: fixedW ? `${fixedW}px` : undefined }}
      role="img"
      aria-label={aria}
      tabIndex={interactive && finite.length ? 0 : undefined}
      onKeyDown={(e) => {
        if (!pts.length) return;
        const i = hover ?? pts.length - 1;
        if (e.key === "ArrowLeft") setHover(Math.max(0, i - 1));
        else if (e.key === "ArrowRight") setHover(Math.min(pts.length - 1, i + 1));
        else if (e.key === "Escape") setHover(undefined);
        else return;
        e.preventDefault();
      }}
      onBlur={() => setHover(undefined)}
      onPointerMove={interactive ? (e) => pick(e.clientX, e.currentTarget as Element) : undefined}
      onPointerLeave={interactive ? () => setHover(undefined) : undefined}
    >
      {w > 0 && (
        <svg width={w} height={height} aria-hidden="true" class="vz-svg">
          {area && areaPath && <path d={areaPath} class="vz-area" style={{ fill: stroke }} />}
          {line && <path d={line} class="vz-line vz-line-thin" style={{ stroke }} />}
          {!finite.length && <line x1={0} x2={w} y1={height - 1.5} y2={height - 1.5} class="vz-baseline" />}
          {endDot && last && hp === undefined && <circle cx={x(last.t)} cy={y(last.v)} r={2.5} class="vz-dot vz-dot-sm" style={{ fill: stroke }} />}
          {hp && hp.v !== null && (
            <>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={0} y2={height} class="vz-crosshair" />
              <circle cx={x(hp.t)} cy={y(hp.v)} r={3} class="vz-dot vz-dot-sm" style={{ fill: stroke }} />
            </>
          )}
        </svg>
      )}
      {hp && hp.v !== null && w > 0 && (
        <ChartTooltip x={x(hp.t)} y={-4} containerWidth={w} above>
          <TipRow shape="none" value={u.format(hp.v)} label={timed ? fmtTimeFull(hp.t) : undefined} />
        </ChartTooltip>
      )}
    </div>
  );
}

// Time-bucketed intensity: ActivityStrip (one row of buckets, e.g. advisories per minute) and
// Heatmap (rows × columns, e.g. consumer × minute pending). Sequential one-hue scale that
// recedes toward the surface at zero; ScaleLegend explains it. Cells have hover/focus tooltips.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { cx } from "../ui";
import { fitText, maxTextWidth } from "./dom";
import { useElementSize } from "./hooks";
import { sequentialColor, toneColor, type Tone } from "./palette";
import { fmtTimeFull, fmtTimeTick, timeTicks } from "./scale";
import type { TimePoint } from "./series";
import { ChartTooltip, TipHead, TipRow } from "./Tooltip";
import { formatValue, type Unit } from "./units";
import "./charts.css";

function hueFor(tone: Tone | undefined, hue: string | undefined): string {
  return hue ?? (tone ? toneColor(tone) : "var(--series-1)");
}

export interface ScaleLegendProps {
  max: number;
  unit?: Unit;
  hue?: string;
  tone?: Tone;
  /** Label for the low end (default "0"). */
  minLabel?: string;
  steps?: number;
}

/** Sequential scale key: "0 ▢▢▢▢▢ 1.2k". */
export function ScaleLegend({ max, unit, hue, tone, minLabel = "0", steps = 5 }: ScaleLegendProps) {
  const h = hueFor(tone, hue);
  return (
    <div class="vz-scale" aria-label={`Colour scale from ${minLabel} to ${formatValue(max, unit)}`} role="img">
      <span class="vz-scale-label">{minLabel}</span>
      {Array.from({ length: steps }, (_, i) => (
        <span key={i} class="vz-scale-step" style={{ background: i === 0 ? "var(--vz-empty)" : sequentialColor(i / (steps - 1), h) }} />
      ))}
      <span class="vz-scale-label">{formatValue(max, unit)}</span>
    </div>
  );
}

export interface ActivityStripProps {
  /** One point per bucket: t = bucket start, v = count/amount (see bucketize()). */
  buckets: readonly TimePoint[];
  /** Bucket length in ms (for tooltips "12:03–12:04"). */
  bucketMs: number;
  /** Accessible name, e.g. "Advisories per minute". */
  label: string;
  unit?: Unit;
  /** Cell height in px (default 18). */
  height?: number;
  /** Status hue (danger for errors) or explicit hue; default slot 1. */
  tone?: Tone;
  hue?: string;
  /** Show start/end time labels (default true). */
  axis?: boolean;
  onSelect?: (bucket: TimePoint) => void;
  class?: string;
}

export function ActivityStrip({ buckets, bucketMs, label, unit, height = 18, tone, hue, axis = true, onSelect, class: cls }: ActivityStripProps) {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const h = hueFor(tone, hue);
  const max = Math.max(0, ...buckets.map((b) => b.v ?? 0));
  const n = buckets.length;
  const gap = n > 0 && width / n < 6 ? 1 : 2;
  const cellW = n ? (width - gap * (n - 1)) / n : 0;
  const total = buckets.reduce((a, b) => a + (b.v ?? 0), 0);
  const hb = hover !== undefined ? buckets[hover] : undefined;
  const first = buckets[0]?.t;
  const last = buckets[n - 1]?.t;
  const ticks = first !== undefined && last !== undefined && width > 0 ? timeTicks(first, last + bucketMs, Math.max(2, Math.floor(width / 90))) : { ticks: [], step: 60_000 };
  return (
    <div class={cx("vz-strip", cls)}>
      <div ref={ref} class="vz-strip-cells" style={{ height: `${height}px`, gap: `${gap}px` }} role="group" aria-label={`${label}: ${formatValue(total, unit)} total over ${n} buckets, peak ${formatValue(max, unit)}`}>
        {buckets.map((b, i) => {
          const v = b.v ?? 0;
          const text = `${fmtTimeTick(b.t, bucketMs)}–${fmtTimeTick(b.t + bucketMs, bucketMs)}: ${formatValue(v, unit)}`;
          return (
            <span
              key={b.t}
              class={cx("vz-cell", hover === i && "vz-active", onSelect && "vz-clickable")}
              style={{ background: max > 0 ? sequentialColor(v / max, h) : "var(--vz-empty)" }}
              tabIndex={cellW >= 6 || hover === i ? 0 : -1}
              role={onSelect ? "button" : "img"}
              aria-label={text}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(undefined)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(undefined)}
              onClick={onSelect ? () => onSelect(b) : undefined}
              onKeyDown={(e) => {
                const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (step) {
                  e.preventDefault();
                  const next = (e.currentTarget as HTMLElement).parentElement?.children[Math.min(n - 1, Math.max(0, i + step))] as HTMLElement | undefined;
                  next?.focus();
                } else if (onSelect && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelect(b);
                }
              }}
            />
          );
        })}
        {hb && width > 0 && (
          <ChartTooltip x={hover! * (cellW + gap) + cellW / 2} y={-6} containerWidth={width} above>
            <TipHead>
              {fmtTimeFull(hb.t)} · {Math.round(bucketMs / 1000) >= 60 ? `${Math.round(bucketMs / 60_000)}m` : `${Math.round(bucketMs / 1000)}s`}
            </TipHead>
            <TipRow shape="rect" color={max > 0 ? sequentialColor((hb.v ?? 0) / max, h) : "var(--vz-empty)"} value={formatValue(hb.v ?? 0, unit)} label={label} />
          </ChartTooltip>
        )}
      </div>
      {axis && n > 0 && width > 0 && (
        <div class="vz-strip-axis" aria-hidden="true">
          {ticks.ticks.map((t) => {
            const left = ((t - first!) / (last! + bucketMs - first!)) * 100;
            if (left < 0 || left > 100) return null;
            return (
              <span key={t} class="vz-strip-tick" style={{ left: `${left}%`, transform: left < 5 ? "none" : left > 95 ? "translateX(-100%)" : "translateX(-50%)" }}>
                {fmtTimeTick(t, ticks.step)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface HeatmapProps {
  rows: readonly { id: string; label: string }[];
  /** Column labels; with `t` the axis shows wall-clock ticks. */
  cols: readonly { id?: string; label?: string; t?: number }[];
  /** values[row][col]; null = no data (hatched-empty). */
  values: readonly (readonly (number | null)[])[];
  /** Accessible name, e.g. "Pending messages per consumer". */
  label: string;
  unit?: Unit;
  /** Cell height in px (default 16). */
  cellHeight?: number;
  tone?: Tone;
  hue?: string;
  /** Monospace row labels (default true). */
  mono?: boolean;
  /** Scale legend under the grid (default true). */
  scale?: boolean;
  onSelect?: (row: number, col: number, value: number | null) => void;
  emptyText?: ComponentChildren;
  class?: string;
}

export function Heatmap({ rows, cols, values, label, unit, cellHeight = 16, tone, hue, mono = true, scale = true, onSelect, emptyText = "No data", class: cls }: HeatmapProps) {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<[number, number] | undefined>(undefined);
  const h = hueFor(tone, hue);
  let max = 0;
  for (const r of values) for (const v of r) if (typeof v === "number" && v > max) max = v;
  const labelW = Math.min(Math.max(40, maxTextWidth(rows.map((r) => r.label), 11, mono) + 10), Math.max(60, width * 0.32));
  const gap = 2;
  const gridW = Math.max(0, width - labelW);
  const cellW = cols.length ? (gridW - gap * (cols.length - 1)) / cols.length : 0;
  const hv = hover ? values[hover[0]]?.[hover[1]] : undefined;
  const timed = cols.length > 0 && cols.every((c) => typeof c.t === "number");
  const step = timed && cols.length > 1 ? (cols[1].t as number) - (cols[0].t as number) : 60_000;
  const ticks = timed && width > 0 ? timeTicks(cols[0].t as number, (cols[cols.length - 1].t as number) + step, Math.max(2, Math.floor(gridW / 80))) : { ticks: [], step };
  const colLabel = (ci: number) => (timed ? fmtTimeFull(cols[ci].t as number) : (cols[ci].label ?? String(ci)));
  if (!rows.length || !cols.length) return <div class={cx("vz-heatmap", cls)}><div class="vz-empty-inline">{emptyText}</div></div>;
  return (
    <div class={cx("vz-heatmap", cls)}>
      <div ref={ref} class="vz-hm-grid" role="grid" aria-label={`${label}: ${rows.length} rows × ${cols.length} columns, peak ${formatValue(max, unit)}`}>
        {width > 0 &&
          rows.map((r, ri) => (
            <div key={r.id} class="vz-hm-row" role="row" style={{ height: `${cellHeight}px` }}>
              <span class={cx("vz-hm-label", mono && "mono")} role="rowheader" style={{ width: `${labelW}px` }} title={r.label}>
                {fitText(r.label, labelW - 8, 11, mono)}
              </span>
              <span class="vz-hm-cells" style={{ gap: `${gap}px` }}>
                {cols.map((_, ci) => {
                  const v = values[ri]?.[ci] ?? null;
                  const active = hover?.[0] === ri && hover?.[1] === ci;
                  return (
                    <span
                      key={ci}
                      role="gridcell"
                      class={cx("vz-cell", v === null && "vz-cell-null", active && "vz-active", onSelect && "vz-clickable")}
                      style={{ width: `${cellW}px`, background: v === null ? undefined : max > 0 ? sequentialColor(v / max, h) : "var(--vz-empty)" }}
                      tabIndex={ri === 0 && ci === 0 ? 0 : -1}
                      aria-label={`${r.label}, ${colLabel(ci)}: ${v === null ? "no data" : formatValue(v, unit)}`}
                      onPointerEnter={() => setHover([ri, ci])}
                      onPointerLeave={() => setHover(undefined)}
                      onFocus={() => setHover([ri, ci])}
                      onBlur={() => setHover(undefined)}
                      onClick={onSelect ? () => onSelect(ri, ci, v) : undefined}
                      onKeyDown={(e) => {
                        const d: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
                        const mv = d[e.key];
                        if (mv) {
                          e.preventDefault();
                          const nr = Math.min(rows.length - 1, Math.max(0, ri + mv[0]));
                          const nc = Math.min(cols.length - 1, Math.max(0, ci + mv[1]));
                          const grid = (e.currentTarget as HTMLElement).closest(".vz-hm-grid");
                          const target = grid?.querySelectorAll<HTMLElement>(".vz-hm-row")[nr]?.querySelectorAll<HTMLElement>(".vz-cell")[nc];
                          target?.focus();
                        } else if (onSelect && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          onSelect(ri, ci, v);
                        }
                      }}
                    />
                  );
                })}
              </span>
            </div>
          ))}
        {hover && width > 0 && (
          <ChartTooltip x={labelW + hover[1] * (cellW + gap) + cellW / 2} y={hover[0] * (cellHeight + 2) - 4} containerWidth={width} above>
            <TipHead>{colLabel(hover[1])}</TipHead>
            <TipRow shape="rect" color={hv === null || hv === undefined ? "var(--vz-empty)" : max > 0 ? sequentialColor(hv / max, h) : "var(--vz-empty)"} value={hv === null || hv === undefined ? "no data" : formatValue(hv, unit)} label={rows[hover[0]].label} />
          </ChartTooltip>
        )}
      </div>
      <div class="vz-hm-foot" style={{ paddingLeft: `${labelW}px` }}>
        {timed && (
          <div class="vz-strip-axis" aria-hidden="true">
            {ticks.ticks.map((t) => {
              const t0 = cols[0].t as number;
              const span = (cols[cols.length - 1].t as number) + step - t0;
              const left = ((t - t0) / span) * 100;
              if (left < 0 || left > 100) return null;
              return (
                <span key={t} class="vz-strip-tick" style={{ left: `${left}%`, transform: left < 5 ? "none" : left > 95 ? "translateX(-100%)" : "translateX(-50%)" }}>
                  {fmtTimeTick(t, ticks.step)}
                </span>
              );
            })}
          </div>
        )}
        {scale && max > 0 && <ScaleLegend max={max} unit={unit} hue={h} />}
      </div>
    </div>
  );
}

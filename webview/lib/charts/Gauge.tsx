// Semi-circular usage gauge with warn/danger threshold ticks.

import type { ComponentChildren } from "preact";
import { cx } from "../ui";
import { arcPath, polar } from "./layout";
import { toneColor, TONE_LABEL, usageTone, type Tone } from "./palette";
import { formatValue, type Unit } from "./units";
import "./charts.css";

export interface GaugeProps {
  value: number;
  /** Limit; ≤ 0 or non-finite = unlimited (no arc fill). */
  max: number;
  min?: number;
  /** Accessible name and caption, e.g. "JetStream storage". */
  label: string;
  unit?: Unit;
  /** Thresholds as fractions of the range (defaults 0.75 / 0.9). */
  warn?: number;
  danger?: number;
  higherIsWorse?: boolean;
  tone?: Tone;
  /** Width in px (height is ~0.62×). Default 168. */
  size?: number;
  /** Secondary line under the percentage; default "6.2 GiB of 10 GiB". */
  sublabel?: ComponentChildren;
  /** Hide the caption under the gauge (when a Card title already names it). */
  hideLabel?: boolean;
  loading?: boolean;
  class?: string;
}

export function Gauge({ value, max, min = 0, label, unit, warn = 0.75, danger = 0.9, higherIsWorse = true, tone, size = 168, sublabel, hideLabel, loading, class: cls }: GaugeProps) {
  const unlimited = !(max > min) || !Number.isFinite(max);
  const frac = unlimited ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const t: Tone = tone ?? (unlimited ? "info" : usageTone(frac, warn, danger, higherIsWorse));
  const fill = t === "ok" ? "var(--meter-ok, var(--series-1))" : toneColor(t);
  const stroke = Math.max(8, Math.round(size * 0.075));
  const r1 = size / 2 - 2;
  const r0 = r1 - stroke;
  const cx0 = size / 2;
  const cy0 = r1 + 2;
  const h = Math.round(cy0 + 4);
  const pct = unlimited ? "∞" : `${frac * 100 < 10 && frac > 0 ? (frac * 100).toFixed(1) : Math.round(frac * 100)}%`;
  const sub = sublabel ?? (unlimited ? `${formatValue(value, unit)} · no limit` : `${formatValue(value, unit)} of ${formatValue(max, unit)}`);
  const aria = `${label}: ${unlimited ? `${formatValue(value, unit)}, no limit` : `${pct} (${formatValue(value, unit)} of ${formatValue(max, unit)})`}${t !== "ok" && t !== "info" ? `, ${TONE_LABEL[t].toLowerCase()}` : ""}`;
  const tick = (f: number, cls2: string) => {
    const a = Math.PI - f * Math.PI;
    const [x1, y1] = polar(cx0, cy0, r1 + 1, a);
    const [x2, y2] = polar(cx0, cy0, r0 - 3, a);
    return <line x1={x1} y1={y1} x2={x2} y2={y2} class={cls2} />;
  };
  if (loading)
    return (
      <div class={cx("vz-gauge", cls)} style={{ width: `${size}px` }}>
        <div class="skeleton" style={{ width: `${size}px`, height: `${h}px`, borderRadius: `${size}px ${size}px 4px 4px` }} aria-busy="true" aria-label={`${label}: loading`} />
      </div>
    );
  return (
    <div
      class={cx("vz-gauge", `vz-gauge-${t}`, cls)}
      style={{ width: `${size}px`, "--fill": fill }}
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={unlimited ? undefined : max}
      aria-valuenow={value}
      aria-valuetext={aria}
      title={aria}
    >
      <div class="vz-gauge-dial" style={{ height: `${h}px` }}>
        <svg width={size} height={h} aria-hidden="true" class="vz-svg">
          <path d={arcPath(cx0, cy0, r0, r1, Math.PI, 0)} class="vz-gauge-track" />
          {frac > 0 && <path d={arcPath(cx0, cy0, r0, r1, Math.PI, Math.PI - frac * Math.PI)} class="vz-gauge-fill" />}
          {!unlimited && tick(higherIsWorse ? warn : 1 - warn, "vz-gauge-tick vz-gauge-tick-warn")}
          {!unlimited && tick(higherIsWorse ? danger : 1 - danger, "vz-gauge-tick vz-gauge-tick-danger")}
        </svg>
        <div class="vz-gauge-center" style={{ bottom: `${h - cy0}px`, maxWidth: `${Math.round(r0 * 1.7)}px` }}>
          <div class="vz-gauge-value" style={{ fontSize: `${Math.round(Math.max(16, size * 0.15))}px` }}>
            {pct}
          </div>
          <div class="vz-gauge-sub">{sub}</div>
        </div>
      </div>
      {!hideLabel && <div class="vz-gauge-label">{label}</div>}
    </div>
  );
}

// Linear usage meter against a limit, with warn/danger thresholds.
// The fill carries severity (accent → warn → danger); the track is a lighter step of the same
// hue so the state reads across the whole bar. A limit ≤ 0 (NATS "-1 = unlimited") shows no fill.

import type { ComponentChildren } from "preact";
import { cx } from "../ui";
import { toneColor, usageTone, type Tone } from "./palette";
import { formatValue, type Unit } from "./units";
import "./charts.css";

export interface MeterProps {
  value: number;
  /** Limit; ≤ 0 or non-finite = unlimited. */
  max: number;
  label?: ComponentChildren;
  unit?: Unit;
  /** Warn/danger thresholds as fractions of max (defaults 0.75 / 0.9). */
  warn?: number;
  danger?: number;
  /** false for "more is better" meters (free space, availability). */
  higherIsWorse?: boolean;
  /** Force a tone instead of deriving it from thresholds. */
  tone?: Tone;
  /** Value text: "used" ("6.2 GiB / 10 GiB"), "percent", "both" (default), or "none". */
  show?: "used" | "percent" | "both" | "none";
  size?: "xs" | "sm" | "md";
  /** Compact single-line layout for table cells. */
  inline?: boolean;
  /** Draw tick marks at the thresholds (default true for md). */
  ticks?: boolean;
  title?: string;
  class?: string;
}

export function Meter({ value, max, label, unit, warn = 0.75, danger = 0.9, higherIsWorse = true, tone, show = "both", size = "md", inline, ticks, title, class: cls }: MeterProps) {
  const unlimited = !(max > 0) || !Number.isFinite(max);
  const frac = unlimited ? 0 : Math.max(0, value) / max;
  const t: Tone = tone ?? (unlimited ? "info" : usageTone(frac, warn, danger, higherIsWorse));
  const fill = t === "ok" ? "var(--meter-ok, var(--series-1))" : toneColor(t);
  const pct = unlimited ? "" : `${frac * 100 < 10 && frac > 0 ? (frac * 100).toFixed(1) : Math.round(frac * 100)}%`;
  const used = unlimited ? `${formatValue(value, unit)} · no limit` : `${formatValue(value, unit)} / ${formatValue(max, unit)}`;
  const text = show === "none" ? "" : show === "percent" ? pct || used : show === "used" ? used : unlimited ? used : `${used} · ${pct}`;
  const showTicks = ticks ?? size === "md";
  const aria = `${typeof label === "string" ? `${label}: ` : ""}${used}${pct ? ` (${pct})` : ""}${t === "warn" ? ", warning" : t === "danger" ? ", critical" : ""}`;
  return (
    <div
      class={cx("vz-meter", `vz-meter-${size}`, inline && "vz-meter-inline", unlimited && "vz-meter-unlimited", cls)}
      style={{ "--fill": fill }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={unlimited ? undefined : max}
      aria-valuenow={value}
      aria-valuetext={aria}
      title={title ?? aria}
    >
      {(label !== undefined || (text && !inline)) && (
        <div class="vz-meter-head">
          {label !== undefined && <span class="vz-meter-label">{label}</span>}
          {text && !inline && <span class="vz-meter-value">{text}</span>}
        </div>
      )}
      <div class="vz-meter-track">
        {!unlimited && <div class="vz-meter-fill" style={{ width: `${Math.min(100, frac * 100)}%` }} />}
        {showTicks && !unlimited && (
          <>
            <span class="vz-meter-tick" style={{ left: `${(higherIsWorse ? warn : 1 - warn) * 100}%` }} />
            <span class="vz-meter-tick vz-meter-tick-danger" style={{ left: `${(higherIsWorse ? danger : 1 - danger) * 100}%` }} />
          </>
        )}
      </div>
      {inline && text && <span class="vz-meter-value">{text}</span>}
    </div>
  );
}

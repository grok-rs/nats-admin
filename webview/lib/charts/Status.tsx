// Status primitives: StatusDot (state at a glance), HealthPill (score 0–100 → tone),
// ToneIcon. Status colours always travel with an icon or a text label, never alone.

import { cx, Icon } from "../ui";
import { DEFAULT_HEALTH, healthLabel, healthTone, TONE_ICON, TONE_LABEL, type HealthThresholds, type Tone } from "./palette";
import "./charts.css";

export interface StatusDotProps {
  tone: Tone;
  /** Accessible / visible label, e.g. "Connected". Defaults to the tone name. */
  label?: string;
  /** Render the label next to the dot (otherwise it is screen-reader only + tooltip). */
  showLabel?: boolean;
  /** Pulsing halo for live / in-progress states. */
  pulse?: boolean;
  size?: "sm" | "md";
  class?: string;
}

export function StatusDot({ tone, label, showLabel, pulse, size = "md", class: cls }: StatusDotProps) {
  const text = label ?? TONE_LABEL[tone];
  return (
    <span class={cx("vz-status", cls)} title={showLabel ? undefined : text}>
      <span class={cx("vz-dot-status", `vz-tone-${tone}`, `vz-sdot-${size}`, pulse && "vz-pulse")} aria-hidden="true" />
      {showLabel ? <span class="vz-status-label">{text}</span> : <span class="sr-only">{text}</span>}
    </span>
  );
}

export function ToneIcon({ tone, title, class: cls }: { tone: Tone; title?: string; class?: string }) {
  return <Icon name={TONE_ICON[tone]} title={title} class={cx(`vz-tone-text-${tone}`, cls)} />;
}

export interface HealthPillProps {
  /** Health score 0–100; undefined → "Unknown". */
  score: number | undefined | null;
  /** Override the label (default Healthy / Degraded / Critical / Unknown). */
  label?: string;
  thresholds?: HealthThresholds;
  /** Hide the numeric score (label + icon only). */
  hideScore?: boolean;
  size?: "sm" | "md";
  title?: string;
  onClick?: () => void;
}

export function HealthPill({ score, label, thresholds = DEFAULT_HEALTH, hideScore, size = "md", title, onClick }: HealthPillProps) {
  const tone = healthTone(score, thresholds);
  const text = label ?? healthLabel(score, thresholds);
  const hasScore = typeof score === "number" && Number.isFinite(score);
  const tip = title ?? `${text}${hasScore ? ` · health score ${Math.round(score!)} / 100` : ""} (≥${thresholds.ok} healthy, ≥${thresholds.warn} degraded)`;
  const body = (
    <>
      <Icon name={TONE_ICON[tone]} class="vz-pill-icon" />
      <span>{text}</span>
      {hasScore && !hideScore && <span class="vz-pill-score">{Math.round(score!)}</span>}
    </>
  );
  const classes = cx("vz-pill", `vz-pill-${tone}`, size === "sm" && "vz-pill-sm", onClick && "vz-pill-btn");
  return onClick ? (
    <button type="button" class={classes} title={tip} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span class={classes} title={tip} role="status" aria-label={tip}>
      {body}
    </span>
  );
}

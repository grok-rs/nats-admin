// Colour roles for every chart and status display. Pure (no DOM) so it can be unit tested.
//
// Categorical slots come from the VS Code theme (styles.css maps --series-1..8 onto
// --vscode-charts-* and --vscode-terminal-ansi*), in a fixed, validated order:
//   1 blue · 2 orange · 3 magenta · 4 yellow · 5 cyan · 6 red · 7 purple · 8 green
// The order was chosen with the dataviz palette validator against VS Code's default
// Dark/Light Modern values (adjacent CVD ΔE ≥ 17, first three slots also pass all-pairs).
// Slots are assigned in order and never cycled: a 9th series is "other" (grey).
// Status tones (ok/warn/danger/info) are reserved for meaning and always paired with an
// icon or label; they are never used as "series N".

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

export const SERIES_SLOTS = 8;
export const SERIES_HUES = ["blue", "orange", "magenta", "yellow", "cyan", "red", "purple", "green"] as const;

/** CSS colour for categorical slot `i` (0-based). Index ≥ 8 → the neutral "other" colour. */
export function seriesColor(i: number): string {
  return Number.isInteger(i) && i >= 0 && i < SERIES_SLOTS ? `var(--series-${i + 1})` : "var(--series-other)";
}

/** CSS colour for a status tone. */
export function toneColor(tone: Tone | undefined): string {
  switch (tone) {
    case "ok":
      return "var(--ok)";
    case "warn":
      return "var(--warn)";
    case "danger":
      return "var(--danger)";
    case "info":
      return "var(--info)";
    default:
      return "var(--tone-neutral)";
  }
}

/** Tinted background for a tone (badges, pills, banners). */
export function toneBg(tone: Tone | undefined, pct = 14): string {
  return `color-mix(in srgb, ${toneColor(tone)} ${pct}%, transparent)`;
}

/** Codicon name that carries a tone's meaning without colour. */
export const TONE_ICON: Record<Tone, string> = {
  ok: "pass-filled",
  warn: "warning",
  danger: "error",
  info: "info",
  neutral: "circle-large-outline",
};

export const TONE_LABEL: Record<Tone, string> = {
  ok: "OK",
  warn: "Warning",
  danger: "Critical",
  info: "Info",
  neutral: "Unknown",
};

/** Resolve the colour of a datum: explicit colour > tone > categorical slot. */
export function colorOf(d: { color?: string; tone?: Tone; slot?: number }, index: number): string {
  if (d.color) return d.color;
  if (d.tone) return toneColor(d.tone);
  return seriesColor(d.slot ?? index);
}

/**
 * Sequential (magnitude) colour: one hue, t ∈ [0,1] from "near zero" to full strength.
 * Mixing toward the chart surface makes low values recede in both light and dark themes.
 */
export function sequentialColor(t: number, hue = "var(--series-1)"): string {
  if (!Number.isFinite(t) || t <= 0) return "var(--vz-empty)";
  const pct = Math.round(18 + Math.min(1, t) * 82);
  return `color-mix(in oklab, ${hue} ${pct}%, var(--vz-surface))`;
}

/** Diverging colour: t ∈ [-1,1], blue (negative) ↔ neutral grey ↔ red (positive). */
export function divergingColor(t: number, neg = "var(--series-1)", pos = "var(--series-6)"): string {
  if (!Number.isFinite(t) || Math.abs(t) < 0.02) return "var(--vz-neutral)";
  const pct = Math.round(15 + Math.min(1, Math.abs(t)) * 85);
  return `color-mix(in oklab, ${t < 0 ? neg : pos} ${pct}%, var(--vz-neutral))`;
}

export interface HealthThresholds {
  /** Score at or above which the tone is "ok" (default 90). */
  ok: number;
  /** Score at or above which the tone is "warn" (default 60); below → "danger". */
  warn: number;
}

export const DEFAULT_HEALTH: HealthThresholds = { ok: 90, warn: 60 };

/** Health score 0–100 → tone. undefined/NaN → neutral. */
export function healthTone(score: number | undefined | null, t: HealthThresholds = DEFAULT_HEALTH): Tone {
  if (score === undefined || score === null || !Number.isFinite(score)) return "neutral";
  if (score >= t.ok) return "ok";
  if (score >= t.warn) return "warn";
  return "danger";
}

export function healthLabel(score: number | undefined | null, t: HealthThresholds = DEFAULT_HEALTH): string {
  const tone = healthTone(score, t);
  return tone === "ok" ? "Healthy" : tone === "warn" ? "Degraded" : tone === "danger" ? "Critical" : "Unknown";
}

/**
 * Usage fraction → tone using warn/danger thresholds (fractions of the limit).
 * With higherIsWorse=false (e.g. free space, availability) the scale is mirrored.
 */
export function usageTone(fraction: number, warn = 0.75, danger = 0.9, higherIsWorse = true): Tone {
  if (!Number.isFinite(fraction)) return "neutral";
  const f = higherIsWorse ? fraction : 1 - fraction;
  if (f >= danger) return "danger";
  if (f >= warn) return "warn";
  return "ok";
}

export type Environment = "dev" | "test" | "staging" | "prod";

export const ENV_META: Record<Environment, { label: string; short: string; color: string }> = {
  dev: { label: "Development", short: "DEV", color: "var(--env-dev)" },
  test: { label: "Test", short: "TEST", color: "var(--env-test)" },
  staging: { label: "Staging", short: "STAGING", color: "var(--env-staging)" },
  prod: { label: "Production", short: "PROD", color: "var(--env-prod)" },
};

// Dashboard layout kit shared by every NATS Admin dashboard: page shell, header with
// environment / read-only cues, KPI tiles, cards, responsive grid, empty/loading/disconnected
// states, time range + refresh controls, chips, key/value grid and a sortable data table.
//
//   import { DashboardPage, DashboardHeader, KpiRow, KpiTile, Card, Grid, DataTable } from "./lib/dashboard";
//
// Charts live in "./lib/charts". Styling: ./dashboard.css (ds-* classes) on top of styles.css tokens.

import type { ComponentChildren, CSSProperties } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Sparkline } from "./charts/Sparkline";
import { Meter } from "./charts/Meter";
import { StatusDot, ToneIcon } from "./charts/Status";
import { useId, useNow } from "./charts/hooks";
import { ENV_META, toneColor, type Environment, type Tone } from "./charts/palette";
import { relativeChange, type TimePoint } from "./charts/series";
import { formatDeltaPercent, formatParts, formatValue, type Unit } from "./charts/units";
import { fmtTimeFull } from "./charts/scale";
import { Button, CopyButton, cx, Icon } from "./ui";
import "./charts/charts.css";
import "./dashboard.css";

export type { Environment, Tone } from "./charts/palette";

// ---------------------------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------------------------

/** Full-height page: fixed header, scrolling body. */
export function DashboardPage({ header, children, label, class: cls }: { header?: ComponentChildren; children: ComponentChildren; label?: string; class?: string }) {
  return (
    <div class={cx("ds-page", cls)}>
      {header}
      <main class="ds-body" aria-label={label}>
        {children}
      </main>
    </div>
  );
}

/** Small heading that separates groups of cards inside the body. */
export function SectionHeading({ title, subtitle, actions }: { title: ComponentChildren; subtitle?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="ds-section-heading">
      <h2 class="ds-section-title">{title}</h2>
      {subtitle && <span class="ds-section-sub">{subtitle}</span>}
      {actions && <div class="ds-section-actions">{actions}</div>}
    </div>
  );
}

/** One row of filters/controls above the content it scopes (time range first). */
export function FilterBar({ children, label = "Filters", class: cls }: { children: ComponentChildren; label?: string; class?: string }) {
  return (
    <div class={cx("ds-filterbar", cls)} role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Header, environment and safety cues
// ---------------------------------------------------------------------------------------------

export function EnvBadge({ env, label, compact }: { env: Environment; label?: string; compact?: boolean }) {
  const meta = ENV_META[env];
  return (
    <span class={cx("ds-env", `ds-env-${env}`)} title={`Environment: ${meta.label}`}>
      <span class="ds-env-dot" aria-hidden="true" />
      {label ?? (compact ? meta.short : meta.label)}
    </span>
  );
}

export function ReadOnlyBadge({ title = "Read-only connection: every write (publish, put, delete, purge, config changes, acks) is blocked" }: { title?: string }) {
  return (
    <span class="ds-ro" title={title}>
      <Icon name="lock" />
      Read-only
    </span>
  );
}

/** Red full-width banner shown on production connections. */
export function ProdBanner({ connectionName, readOnly, children }: { connectionName?: string; readOnly?: boolean; children?: ComponentChildren }) {
  return (
    <div class="ds-prod-banner" role="note" aria-label="Production connection">
      <span class="ds-prod-tag">
        <Icon name="flame" />
        PRODUCTION
      </span>
      <span class="ds-prod-text">
        {connectionName && <span class="mono ds-prod-conn">{connectionName}</span>}
        {children ?? (readOnly ? "Read-only — writes are blocked on this connection." : "Changes affect live traffic. Destructive actions require typing the resource name.")}
      </span>
    </div>
  );
}

export interface DashboardHeaderProps {
  /** Codicon name, e.g. "dashboard", "database", "pulse". */
  icon?: string;
  title: ComponentChildren;
  /** Secondary line (wrap identifiers in <span class="mono">). */
  subtitle?: ComponentChildren;
  env?: Environment;
  /** Connection / profile name (shown in the production banner). */
  connectionName?: string;
  readOnly?: boolean;
  /** Connection state, e.g. { tone: "ok", label: "Connected" }. */
  status?: { tone: Tone; label: string; pulse?: boolean };
  /** Buttons on the right (use <Button variant="ghost" small …>). */
  actions?: ComponentChildren;
  /** Second row: chips, filters, metadata. */
  meta?: ComponentChildren;
  /** Replace the default production banner text. */
  prodMessage?: ComponentChildren;
  class?: string;
}

export function DashboardHeader({ icon, title, subtitle, env, connectionName, readOnly, status, actions, meta, prodMessage, class: cls }: DashboardHeaderProps) {
  return (
    <header class={cx("ds-header", env && `ds-header-env ds-env-${env}`, cls)}>
      {env === "prod" && (
        <ProdBanner connectionName={connectionName} readOnly={readOnly}>
          {prodMessage}
        </ProdBanner>
      )}
      <div class="ds-header-main">
        {icon && (
          <span class="ds-header-icon" aria-hidden="true">
            <Icon name={icon} />
          </span>
        )}
        <div class="ds-header-text">
          <h1 class="ds-title">{title}</h1>
          {subtitle && <div class="ds-subtitle">{subtitle}</div>}
        </div>
        <div class="ds-header-badges">
          {status && <StatusDot tone={status.tone} label={status.label} pulse={status.pulse} showLabel />}
          {env && env !== "prod" && <EnvBadge env={env} />}
          {readOnly && <ReadOnlyBadge />}
        </div>
        {actions && <div class="ds-header-actions">{actions}</div>}
      </div>
      {meta && <div class="ds-header-meta">{meta}</div>}
    </header>
  );
}

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected" | "error";

/**
 * Inline banner for degraded connection states (renders nothing when connected). Keep showing
 * the last data underneath at reduced opacity (Card `stale`).
 */
export function ConnectionBanner({ state, message, since, onRetry, retryLabel = "Reconnect" }: { state: ConnectionState; message?: ComponentChildren; since?: number; onRetry?: () => void; retryLabel?: string }) {
  if (state === "connected") return null;
  const spec = {
    connecting: { tone: "info" as Tone, icon: "loading", spin: true, text: "Connecting…" },
    reconnecting: { tone: "warn" as Tone, icon: "sync", spin: true, text: "Connection lost — reconnecting…" },
    disconnected: { tone: "danger" as Tone, icon: "debug-disconnect", spin: false, text: "Disconnected" },
    error: { tone: "danger" as Tone, icon: "error", spin: false, text: "Connection error" },
  }[state];
  return (
    <div class={cx("ds-conn-banner", `ds-tone-${spec.tone}`)} role={state === "error" || state === "disconnected" ? "alert" : "status"}>
      <Icon name={spec.icon} spin={spec.spin} />
      <span class="ds-conn-text">
        <b>{spec.text}</b>
        {message && <span> {message}</span>}
        {since !== undefined && <span class="muted"> · showing data from {fmtTimeFull(since)}</span>}
      </span>
      {onRetry && (
        <Button small variant="secondary" icon="plug" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------------------------

/** Accessible info icon with a hover/focus tooltip. */
export function InfoTip({ text, class: cls }: { text: string; class?: string }) {
  return (
    <span class={cx("ds-infotip", cls)} tabIndex={0} role="img" aria-label={text} data-tip={text}>
      <Icon name="info" />
    </span>
  );
}

export interface KpiTileProps {
  /** Sentence-case label, no trailing colon ("Inbound messages"). */
  label: string;
  value: number | string | null | undefined;
  /** Unit for numeric values (formats and renders the unit smaller). */
  unit?: Unit;
  /** Custom formatter for numeric values (overrides unit formatting). */
  format?: (v: number) => string;
  /** Relative change as a fraction (0.12 = +12%), or give `previous`. */
  delta?: number;
  /** Previous value: delta is computed from it. */
  previous?: number;
  /** "percent" (default) or "absolute" (signed difference in the tile's unit). */
  deltaMode?: "percent" | "absolute";
  /** Comparison period, e.g. "vs 5m ago". */
  deltaLabel?: string;
  /** Which direction is good: colours the delta (default "up"; "neither" keeps it neutral). */
  goodWhen?: "up" | "down" | "neither";
  /** Sparkline data (values or time points). */
  trend?: readonly number[] | readonly TimePoint[];
  /** Status of the metric: accent bar + icon (never colour alone). */
  tone?: Tone;
  /** Tooltip explaining the metric (source, unit, window). */
  hint?: string;
  /** Secondary line, e.g. "of 10 GiB limit". */
  sub?: ComponentChildren;
  /** Optional usage bar against a limit. */
  meter?: { value: number; max: number; warn?: number; danger?: number };
  loading?: boolean;
  /** Dim while refetching. */
  stale?: boolean;
  /** Makes the tile a button (drill-down). */
  onClick?: () => void;
  class?: string;
}

export function KpiTile({ label, value, unit, format, delta, previous, deltaMode = "percent", deltaLabel, goodWhen = "up", trend, tone, hint, sub, meter, loading, stale, onClick, class: cls }: KpiTileProps) {
  if (loading) {
    return (
      <div class={cx("ds-kpi", cls)} aria-busy="true" aria-label={`${label}: loading`}>
        <div class="ds-kpi-label">{label}</div>
        <span class="skeleton" style={{ width: "62%", height: "24px", marginTop: "4px" }} />
        <span class="skeleton skeleton-text" style={{ width: "40%" }} />
      </div>
    );
  }
  const numeric = typeof value === "number" && Number.isFinite(value);
  const parts = numeric ? (format ? { value: format(value as number), unit: "" } : formatParts(value as number, unit)) : { value: value === null || value === undefined || value === "" ? "–" : String(value), unit: "" };
  let d = delta;
  let abs: number | undefined;
  if (d === undefined && numeric && typeof previous === "number") {
    d = relativeChange(value as number, previous);
    abs = (value as number) - previous;
  }
  const showAbs = deltaMode === "absolute" && abs !== undefined;
  const dir = d === undefined ? 0 : Math.abs(d) < 0.0005 ? 0 : d > 0 ? 1 : -1;
  const deltaTone: Tone = dir === 0 || goodWhen === "neither" ? "neutral" : (dir > 0) === (goodWhen === "up") ? "ok" : "danger";
  const arrow = dir > 0 ? "↑" : dir < 0 ? "↓" : "→";
  const deltaText = d === undefined ? "" : showAbs ? `${abs! > 0 ? "+" : abs! < 0 ? "−" : "±"}${formatValue(Math.abs(abs!), unit)}` : formatDeltaPercent(d);
  const aria = `${label}: ${parts.value}${parts.unit ? ` ${parts.unit}` : ""}${d !== undefined ? `, ${dir > 0 ? "up" : dir < 0 ? "down" : "unchanged"} ${deltaText}${deltaLabel ? ` ${deltaLabel}` : ""}` : ""}${tone && tone !== "neutral" ? `, status ${tone}` : ""}`;
  const body = (
    <>
      <div class="ds-kpi-head">
        {tone && tone !== "neutral" && <ToneIcon tone={tone} class="ds-kpi-tone" />}
        <span class="ds-kpi-label">{label}</span>
        {hint && <InfoTip text={hint} />}
      </div>
      <div class="ds-kpi-value-row">
        <span class="ds-kpi-value">{parts.value}</span>
        {parts.unit && <span class="ds-kpi-unit">{parts.unit}</span>}
      </div>
      {(d !== undefined || sub !== undefined) && (
        <div class="ds-kpi-foot">
          {d !== undefined && (
            <span class={cx("ds-delta", `ds-delta-${deltaTone}`)}>
              <span aria-hidden="true">{arrow}</span> {deltaText}
            </span>
          )}
          {deltaLabel && d !== undefined && <span class="ds-kpi-sub">{deltaLabel}</span>}
          {sub !== undefined && <span class="ds-kpi-sub">{sub}</span>}
        </div>
      )}
      {meter && <Meter value={meter.value} max={meter.max} warn={meter.warn} danger={meter.danger} size="xs" show="none" ticks={false} />}
      {trend && trend.length > 1 && (
        <div class="ds-kpi-trend">
          <Sparkline values={trend} height={26} unit={unit} label={`${label} trend`} interactive={!onClick} color={tone === "danger" || tone === "warn" ? toneColor(tone) : undefined} />
        </div>
      )}
    </>
  );
  const classes = cx("ds-kpi", tone && `ds-tone-${tone}`, stale && "ds-stale", onClick && "ds-kpi-btn", cls);
  return onClick ? (
    <button type="button" class={classes} aria-label={aria} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div class={classes} role="group" aria-label={aria}>
      {body}
    </div>
  );
}

/** Responsive row of KPI tiles (wraps; `min` = minimum tile width in px, default 160). */
export function KpiRow({ children, min = 160, label = "Key metrics", class: cls }: { children: ComponentChildren; min?: number; label?: string; class?: string }) {
  return (
    <div class={cx("ds-kpis", cls)} style={{ "--kpi-min": `${min}px` }} role="region" aria-label={label}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Cards and grid
// ---------------------------------------------------------------------------------------------

export type Span = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface CardProps {
  title?: ComponentChildren;
  subtitle?: ComponentChildren;
  icon?: string;
  /** Header controls on the right (small ghost buttons, chips). */
  actions?: ComponentChildren;
  footer?: ComponentChildren;
  children?: ComponentChildren;
  /** Column span in a 12-column Grid (collapses responsively). */
  span?: Span;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** Accessible table twin of the chart: adds a chart/table toggle to the header. */
  tableView?: ComponentChildren | (() => ComponentChildren);
  /** No body padding (tables, edge-to-edge lists). */
  flush?: boolean;
  /** Skeleton body. */
  loading?: boolean;
  /** Dim the body while refetching / disconnected (keeps the last render). */
  stale?: boolean;
  /** Status accent on the card's left edge (+ use an icon/label in the content). */
  tone?: Tone;
  /** Minimum body height in px (keeps layout steady across states). */
  minHeight?: number;
  id?: string;
  class?: string;
}

export function Card({ title, subtitle, icon, actions, footer, children, span, collapsible, defaultCollapsed, tableView, flush, loading, stale, tone, minHeight, id, class: cls }: CardProps) {
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
  const [asTable, setAsTable] = useState(false);
  const titleId = useId("ds-card-title");
  const bodyId = useId("ds-card-body");
  const hasHeader = title !== undefined || actions !== undefined || tableView !== undefined;
  const titleEl = (
    <span class="ds-card-titles">
      <h2 class="ds-card-title" id={titleId}>
        {icon && <Icon name={icon} class="ds-card-icon" />}
        {title}
      </h2>
      {subtitle && <span class="ds-card-subtitle">{subtitle}</span>}
    </span>
  );
  const table = asTable && tableView ? (typeof tableView === "function" ? (tableView as () => ComponentChildren)() : tableView) : null;
  return (
    <section id={id} class={cx("ds-card", span && `ds-span-${span}`, tone && `ds-card-tone ds-tone-${tone}`, cls)} aria-labelledby={title !== undefined ? titleId : undefined}>
      {hasHeader && (
        <header class="ds-card-header">
          {collapsible ? (
            <button type="button" class="ds-card-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed((c) => !c)}>
              <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
              {titleEl}
            </button>
          ) : (
            titleEl
          )}
          {(actions || tableView) && !collapsed && (
            <div class="ds-card-actions">
              {actions}
              {tableView && (
                <Button
                  variant="ghost"
                  small
                  icon={asTable ? "graph-line" : "table"}
                  title={asTable ? "Show chart" : "Show as table"}
                  aria-label={asTable ? "Show chart" : "Show as table"}
                  aria-pressed={asTable}
                  onClick={() => setAsTable((t) => !t)}
                />
              )}
            </div>
          )}
        </header>
      )}
      {!collapsed && (
        <div id={bodyId} class={cx("ds-card-body", flush && "ds-flush", stale && "ds-stale")} style={minHeight ? { minHeight: `${minHeight}px` } : undefined} aria-busy={loading || undefined}>
          {loading ? (
            <div class="ds-card-loading">
              <span class="skeleton" style={{ height: `${Math.max(48, (minHeight ?? 120) - 40)}px` }} />
              <span class="skeleton skeleton-text" style={{ width: "45%" }} />
            </div>
          ) : (
            (table ?? children)
          )}
        </div>
      )}
      {footer && !collapsed && <footer class="ds-card-footer">{footer}</footer>}
    </section>
  );
}

/**
 * Responsive grid. Default: 12 columns; children use `span` (Card) or <Cell span>. Spans
 * collapse to half width under ~960px and full width under ~620px of grid width.
 * With `min`, the grid auto-fills columns of at least `min` px instead.
 */
export function Grid({ children, cols = 12, min, gap = 12, class: cls }: { children: ComponentChildren; cols?: number; min?: number; gap?: number; class?: string }) {
  const style: CSSProperties = { "--ds-gap": `${gap}px` };
  if (min) style["--ds-min"] = `${min}px`;
  else style["--ds-cols"] = String(cols);
  return (
    <div class="ds-grid-c">
      <div class={cx("ds-grid", !!min && "ds-grid-auto", cls)} style={style}>
        {children}
      </div>
    </div>
  );
}

/** Grid cell for non-Card content. */
export function Cell({ span, children, class: cls }: { span?: Span; children: ComponentChildren; class?: string }) {
  return <div class={cx("ds-cell", span && `ds-span-${span}`, cls)}>{children}</div>;
}

// ---------------------------------------------------------------------------------------------
// Loading / empty states
// ---------------------------------------------------------------------------------------------

export function Skeleton({ width, height, variant = "block", lines = 1, class: cls }: { width?: number | string; height?: number | string; variant?: "block" | "text" | "circle"; lines?: number; class?: string }) {
  const w = typeof width === "number" ? `${width}px` : width;
  const h = typeof height === "number" ? `${height}px` : height;
  if (variant === "text" && lines > 1)
    return (
      <span class={cx("ds-skeleton-lines", cls)} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} class="skeleton skeleton-text" style={{ width: i === lines - 1 ? "60%" : (w ?? "100%") }} />
        ))}
      </span>
    );
  return <span class={cx("skeleton", variant === "text" && "skeleton-text", variant === "circle" && "skeleton-circle", cls)} style={{ width: w ?? "100%", height: h ?? (variant === "text" ? undefined : "16px") }} aria-hidden="true" />;
}

export type EmptyKind = "no-connection" | "no-data" | "search" | "success" | "error";

/** Small two-tone line illustrations (currentColor + one accent), 72×56. */
export function Illustration({ kind }: { kind: EmptyKind }) {
  const common = { width: 72, height: 56, viewBox: "0 0 72 56", fill: "none", "aria-hidden": "true" as const, class: cx("ds-illu", `ds-illu-${kind}`) };
  switch (kind) {
    case "no-connection":
      return (
        <svg {...common}>
          <ellipse cx="36" cy="49" rx="26" ry="3" class="ds-illu-shadow" />
          <path d="M4 28h12" class="ds-illu-line" />
          <rect x="16" y="20" width="12" height="16" rx="3" class="ds-illu-line" />
          <path d="M28 24h5M28 32h5" class="ds-illu-line" />
          <rect x="44" y="20" width="12" height="16" rx="3" class="ds-illu-line" />
          <path d="M56 28h12" class="ds-illu-line" />
          <path d="M40 18l-2 6h4l-2 6" class="ds-illu-accent" />
        </svg>
      );
    case "no-data":
      return (
        <svg {...common}>
          <ellipse cx="36" cy="49" rx="26" ry="3" class="ds-illu-shadow" />
          <path d="M12 8v34h50" class="ds-illu-line" />
          <path d="M18 34h40" class="ds-illu-dash" />
          <circle cx="24" cy="34" r="2" class="ds-illu-fill" />
          <circle cx="38" cy="34" r="2" class="ds-illu-fill" />
          <circle cx="52" cy="34" r="2.5" class="ds-illu-accent-fill" />
          <path d="M50 12h10M55 7v10" class="ds-illu-accent" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <ellipse cx="36" cy="49" rx="26" ry="3" class="ds-illu-shadow" />
          <circle cx="32" cy="24" r="13" class="ds-illu-line" />
          <path d="M41.5 33.5L52 44" class="ds-illu-line ds-illu-thick" />
          <path d="M26 24h12" class="ds-illu-accent" />
        </svg>
      );
    case "success":
      return (
        <svg {...common}>
          <ellipse cx="36" cy="49" rx="26" ry="3" class="ds-illu-shadow" />
          <circle cx="36" cy="25" r="16" class="ds-illu-ok" />
          <path d="M28.5 25.5l5 5 10-11" class="ds-illu-ok ds-illu-thick" />
        </svg>
      );
    case "error":
      return (
        <svg {...common}>
          <ellipse cx="36" cy="49" rx="26" ry="3" class="ds-illu-shadow" />
          <path d="M36 8l19 33H17L36 8z" class="ds-illu-warn" />
          <path d="M36 20v10" class="ds-illu-warn ds-illu-thick" />
          <circle cx="36" cy="35.5" r="1.6" class="ds-illu-warn-fill" />
        </svg>
      );
  }
}

export interface EmptyAction {
  label: string;
  icon?: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  kind?: EmptyKind;
  /** Use a codicon instead of an illustration. */
  icon?: string;
  title: ComponentChildren;
  /** Explanation: why it's empty and what to do. */
  children?: ComponentChildren;
  primary?: EmptyAction;
  secondary?: EmptyAction;
  /** Extra custom actions. */
  actions?: ComponentChildren;
  /** Tighter padding for use inside cards. */
  compact?: boolean;
  class?: string;
}

export function EmptyState({ kind = "no-data", icon, title, children, primary, secondary, actions, compact, class: cls }: EmptyStateProps) {
  return (
    <div class={cx("ds-empty", compact && "ds-empty-compact", cls)} role={kind === "error" ? "alert" : "status"}>
      {icon ? <Icon name={icon} class="ds-empty-icon" /> : <Illustration kind={kind} />}
      <div class="ds-empty-title">{title}</div>
      {children && <div class="ds-empty-body">{children}</div>}
      {(primary || secondary || actions) && (
        <div class="ds-empty-actions">
          {primary && (
            <Button variant="primary" icon={primary.icon} onClick={primary.onClick}>
              {primary.label}
            </Button>
          )}
          {secondary && (
            <Button variant="secondary" icon={secondary.icon} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Controls: time range, refresh, chips
// ---------------------------------------------------------------------------------------------

export interface TimeRangeOption {
  id: string;
  label: string;
  ms: number;
  title: string;
}

export const TIME_RANGES: readonly TimeRangeOption[] = [
  { id: "1m", label: "1m", ms: 60_000, title: "Last 1 minute" },
  { id: "5m", label: "5m", ms: 300_000, title: "Last 5 minutes" },
  { id: "15m", label: "15m", ms: 900_000, title: "Last 15 minutes" },
  { id: "1h", label: "1h", ms: 3_600_000, title: "Last 1 hour" },
];

/** Milliseconds for a TIME_RANGES id (default 5m). */
export function rangeMs(id: string, options: readonly TimeRangeOption[] = TIME_RANGES): number {
  return options.find((o) => o.id === id)?.ms ?? 300_000;
}

export function TimeRangePicker({ value, onChange, options = TIME_RANGES, label = "Time range" }: { value: string; onChange: (id: string, ms: number) => void; options?: readonly TimeRangeOption[]; label?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = Math.max(0, options.findIndex((o) => o.id === value));
  const move = (i: number) => {
    const n = (i + options.length) % options.length;
    onChange(options[n].id, options[n].ms);
    refs.current[n]?.focus();
  };
  return (
    <div class="ds-range" role="radiogroup" aria-label={label}>
      <Icon name="history" class="ds-range-icon" />
      {options.map((o, i) => (
        <button
          type="button"
          key={o.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="radio"
          aria-checked={i === idx}
          tabIndex={i === idx ? 0 : -1}
          class={cx("ds-range-btn", i === idx && "ds-range-on")}
          title={o.title}
          onClick={() => onChange(o.id, o.ms)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(idx + 1);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(idx - 1);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "just now", "12s ago", "3m ago", "2h ago". */
export function fmtAgoShort(t: number | undefined, now = Date.now()): string {
  if (t === undefined) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export interface RefreshIndicatorProps {
  /** Epoch ms of the last successful update. */
  updatedAt?: number;
  /** Live polling paused by the user. */
  paused?: boolean;
  /** Polling suspended because the panel is hidden. */
  suspended?: boolean;
  refreshing?: boolean;
  /** Last error (shown instead of "Live"). */
  error?: string;
  intervalMs?: number;
  onTogglePause?: () => void;
  onRefresh?: () => void;
}

export function RefreshIndicator({ updatedAt, paused, suspended, refreshing, error, intervalMs, onTogglePause, onRefresh }: RefreshIndicatorProps) {
  const now = useNow(1000);
  const tone: Tone = error ? "danger" : paused ? "neutral" : suspended ? "warn" : "ok";
  const state = error ? "Error" : paused ? "Paused" : suspended ? "Suspended" : "Live";
  const tip = `${state}${intervalMs && !paused ? ` · refreshing every ${intervalMs >= 1000 ? `${intervalMs / 1000}s` : `${intervalMs}ms`}` : ""}${updatedAt ? ` · last update ${fmtTimeFull(updatedAt)}` : ""}${error ? ` · ${error}` : ""}`;
  return (
    <div class={cx("ds-refresh", `ds-tone-${tone}`)} title={tip}>
      <StatusDot tone={tone} label={state} pulse={!paused && !error && !suspended} />
      <span class="ds-refresh-state">{state}</span>
      <span class="ds-refresh-ago" aria-live="off">
        {error ? <span class="ds-refresh-err">{error}</span> : `updated ${fmtAgoShort(updatedAt, now)}`}
      </span>
      {onTogglePause && <Button variant="ghost" small icon={paused ? "debug-start" : "debug-pause"} title={paused ? "Resume live updates" : "Pause live updates"} aria-label={paused ? "Resume live updates" : "Pause live updates"} onClick={onTogglePause} />}
      {onRefresh && <Button variant="ghost" small icon="refresh" title="Refresh now" aria-label="Refresh now" busy={refreshing} onClick={onRefresh} />}
    </div>
  );
}

export interface ChipProps {
  children: ComponentChildren;
  icon?: string;
  tone?: Tone;
  /** Monospace text (subjects, ids). */
  mono?: boolean;
  /** Toggle state (renders aria-pressed when onClick is set). */
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  title?: string;
  size?: "sm" | "md";
  class?: string;
}

export function Chip({ children, icon, tone, mono, selected, onClick, onRemove, title, size = "md", class: cls }: ChipProps) {
  const classes = cx("ds-chip", size === "sm" && "ds-chip-sm", tone && `ds-chip-tone ds-tone-${tone}`, selected && "ds-chip-on", mono && "ds-chip-mono", cls);
  const inner = (
    <>
      {icon && <Icon name={icon} class="ds-chip-icon" />}
      <span class="ds-chip-text">{children}</span>
    </>
  );
  if (onRemove)
    return (
      <span class={classes} title={title}>
        {onClick ? (
          <button type="button" class="ds-chip-main" aria-pressed={selected} onClick={onClick}>
            {inner}
          </button>
        ) : (
          <span class="ds-chip-main">{inner}</span>
        )}
        <button type="button" class="ds-chip-x" aria-label={`Remove ${typeof children === "string" ? children : ""}`.trim()} title="Remove" onClick={onRemove}>
          <Icon name="close" />
        </button>
      </span>
    );
  return onClick ? (
    <button type="button" class={cx(classes, "ds-chip-btn")} title={title} aria-pressed={selected} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <span class={classes} title={title}>
      {inner}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Key / value grid
// ---------------------------------------------------------------------------------------------

export interface KeyValueItem {
  label: string;
  value: ComponentChildren;
  /** Monospace value (ids, subjects, URLs). */
  mono?: boolean;
  /** Text to copy; shows a copy button. */
  copy?: string;
  hint?: string;
  tone?: Tone;
  /** Span the full grid width. */
  wide?: boolean;
}

export function KeyValueGrid({ items, columns = "auto", minColumnWidth = 200, dense, class: cls }: { items: readonly KeyValueItem[]; columns?: number | "auto"; minColumnWidth?: number; dense?: boolean; class?: string }) {
  const style: CSSProperties = columns === "auto" ? { "--kv-min": `${minColumnWidth}px` } : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };
  return (
    <dl class={cx("ds-kv", dense && "ds-kv-dense", cls)} style={style}>
      {items.map((it) => (
        <div key={it.label} class={cx("ds-kv-item", it.wide && "ds-kv-wide")}>
          <dt class="ds-kv-label">
            {it.label}
            {it.hint && <InfoTip text={it.hint} />}
          </dt>
          <dd class={cx("ds-kv-value", it.mono && "mono", it.tone && `tone-${it.tone}`)}>
            <span class="ds-kv-text">{it.value === undefined || it.value === null || it.value === "" ? "–" : it.value}</span>
            {it.copy && <CopyButton text={it.copy} title={`Copy ${it.label}`} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------------------------
// Data table
// ---------------------------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: ComponentChildren;
  /** Value used for sorting, filtering and default rendering (default: row[key]). */
  value?: (row: T) => string | number | boolean | null | undefined;
  /** Cell renderer (default: formatted value). */
  render?: (row: T) => ComponentChildren;
  /** Right-align with tabular numbers. */
  numeric?: boolean;
  align?: "left" | "right" | "center";
  mono?: boolean;
  /** Default true. */
  sortable?: boolean;
  /** Include in the text filter (default true). */
  filterable?: boolean;
  /** CSS width, e.g. "90px" or "30%". */
  width?: string;
  /** Header tooltip (explain units, sources). */
  title?: string;
  /** Hide the column when the table is narrower than ~560px ("sm") or ~820px ("md"). */
  hideBelow?: "sm" | "md";
  /** Unit for numeric default rendering. */
  unit?: Unit;
  /** Sort descending first (numbers usually). Default: numeric columns. */
  descFirst?: boolean;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  /** Accessible name / caption. */
  label: string;
  initialSort?: { key: string; dir: "asc" | "desc" };
  /** Show a text filter (true) or configure it. */
  filter?: boolean | { placeholder?: string; initial?: string };
  onRowClick?: (row: T) => void;
  selectedKey?: string;
  rowTone?: (row: T) => Tone | undefined;
  rowClass?: (row: T) => string | undefined;
  /** Scroll container max height (sticky header). Default 420px. */
  maxHeight?: number | string;
  /** Message (or EmptyState) when there are no rows at all. */
  empty?: ComponentChildren;
  loading?: boolean;
  dense?: boolean;
  /** Extra controls placed next to the filter. */
  toolbar?: ComponentChildren;
  /** Render at most this many rows with a "show all" button (default 500). */
  limit?: number;
  class?: string;
}

function readValue<T>(c: Column<T>, row: T): string | number | boolean | null | undefined {
  if (c.value) return c.value(row);
  const v = (row as Record<string, unknown>)[c.key];
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : v === null || v === undefined ? v : String(v);
}

export function compareValues(a: unknown, b: unknown): number {
  const na = a === null || a === undefined || a === "";
  const nb = b === null || b === undefined || b === "";
  if (na || nb) return na && nb ? 0 : na ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function DataTable<T>({ columns, rows, rowKey, label, initialSort, filter, onRowClick, selectedKey, rowTone, rowClass, maxHeight = 420, empty = "No rows", loading, dense, toolbar, limit = 500, class: cls }: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | undefined>(initialSort);
  const [query, setQuery] = useState(typeof filter === "object" ? (filter.initial ?? "") : "");
  const [showAll, setShowAll] = useState(false);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = useMemo(() => {
    if (!terms.length) return rows;
    const cols = columns.filter((c) => c.filterable !== false);
    return rows.filter((r) => {
      const hay = cols.map((c) => String(readValue(c, r) ?? "")).join(" \u0000 ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, columns, query]);
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const c = columns.find((x) => x.key === sort.key);
    if (!c) return filtered;
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = readValue(c, a);
      const vb = readValue(c, b);
      const empty = (v: unknown) => v === null || v === undefined || v === "";
      if (empty(va) || empty(vb)) return compareValues(va, vb); // empties always last
      return compareValues(va, vb) * mul;
    });
  }, [filtered, sort, columns]);
  useEffect(() => setShowAll(false), [query]);
  const visibleRows = showAll ? sorted : sorted.slice(0, limit);
  const toggleSort = (c: Column<T>) => {
    if (c.sortable === false) return;
    const descFirst = c.descFirst ?? !!c.numeric;
    setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: descFirst ? "desc" : "asc" }));
  };
  const focusRow = (i: number) => {
    const rowsEl = bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]");
    rowsEl?.[Math.max(0, Math.min(rowsEl.length - 1, i))]?.focus();
  };
  const showFilter = !!filter;
  const placeholder = typeof filter === "object" && filter.placeholder ? filter.placeholder : "Filter…";
  return (
    <div class={cx("ds-table-wrap", dense && "ds-table-dense", cls)}>
      {(showFilter || toolbar) && (
        <div class="ds-table-tools">
          {showFilter && (
            <label class="ds-table-filter">
              <Icon name="filter" />
              <input class="input input-sm" type="search" name="table-filter" value={query} placeholder={placeholder} aria-label={`Filter ${label}`} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
            </label>
          )}
          <span class="ds-table-count" aria-live="polite">
            {terms.length ? `${filtered.length} of ${rows.length}` : `${rows.length} ${rows.length === 1 ? "row" : "rows"}`}
          </span>
          {toolbar}
        </div>
      )}
      <div class="ds-table-scroll" style={{ maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight }}>
        <table class="table ds-table" aria-label={label} aria-busy={loading || undefined}>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const align = c.align ?? (c.numeric ? "right" : "left");
                return (
                  <th
                    key={c.key}
                    scope="col"
                    class={cx(c.numeric && "num", `ds-al-${align}`, c.hideBelow && `ds-hide-${c.hideBelow}`)}
                    style={c.width ? { width: c.width } : undefined}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : c.sortable === false ? undefined : "none"}
                    title={c.title}
                  >
                    {c.sortable === false ? (
                      <span class="ds-th-static">{c.header}</span>
                    ) : (
                      <button type="button" class={cx("ds-th-btn", active && "ds-th-active")} onClick={() => toggleSort(c)}>
                        <span>{c.header}</span>
                        <Icon name={active ? (sort!.dir === "asc" ? "arrow-up" : "arrow-down") : "arrow-both"} class={cx("ds-sort-icon", !active && "ds-sort-idle")} />
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {loading &&
              !rows.length &&
              [0, 1, 2, 3].map((i) => (
                <tr key={`sk${i}`} class="ds-row-skeleton">
                  {columns.map((c) => (
                    <td key={c.key} class={cx(c.hideBelow && `ds-hide-${c.hideBelow}`)}>
                      <span class="skeleton skeleton-text" style={{ width: c.numeric ? "50%" : `${55 + ((i * 17 + c.key.length * 7) % 35)}%`, marginLeft: c.numeric ? "auto" : undefined }} />
                    </td>
                  ))}
                </tr>
              ))}
            {visibleRows.map((r, i) => {
              const key = rowKey(r, i);
              const tone = rowTone?.(r);
              return (
                <tr
                  key={key}
                  data-row=""
                  class={cx(onRowClick && "clickable", selectedKey === key && "selected", tone && `ds-row-tone ds-tone-${tone}`, rowClass?.(r))}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-selected={onRowClick && selectedKey !== undefined ? selectedKey === key : undefined}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(r);
                          } else if (e.key === "ArrowDown") {
                            e.preventDefault();
                            focusRow(i + 1);
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            focusRow(i - 1);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((c) => {
                    const align = c.align ?? (c.numeric ? "right" : "left");
                    let content: ComponentChildren;
                    if (c.render) content = c.render(r);
                    else {
                      const v = readValue(c, r);
                      content = typeof v === "number" ? formatValue(v, c.unit ?? "count") : v === null || v === undefined || v === "" ? <span class="muted">–</span> : String(v);
                    }
                    return (
                      <td key={c.key} class={cx(c.numeric && "num", c.mono && "mono", `ds-al-${align}`, c.hideBelow && `ds-hide-${c.hideBelow}`)}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!loading && !visibleRows.length && (
              <tr class="ds-row-empty">
                <td colSpan={columns.length}>
                  {rows.length && terms.length ? (
                    <span class="ds-table-nomatch">
                      <Icon name="search" /> No rows match “{query.trim()}”.{" "}
                      <button type="button" class="ds-link" onClick={() => setQuery("")}>
                        Clear filter
                      </button>
                    </span>
                  ) : (
                    empty
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {sorted.length > visibleRows.length && (
        <div class="ds-table-more">
          Showing {visibleRows.length} of {sorted.length}.{" "}
          <button type="button" class="ds-link" onClick={() => setShowAll(true)}>
            Show all
          </button>
        </div>
      )}
    </div>
  );
}

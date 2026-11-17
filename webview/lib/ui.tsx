// Shared Preact components styled with VS Code theme variables.

import type { ButtonHTMLAttributes, ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Icon({ name, spin, title, class: cls }: { name: string; spin?: boolean; title?: string; class?: string }) {
  return <i class={cx("codicon", `codicon-${name}`, spin && "codicon-modifier-spin", cls)} title={title} aria-hidden={title ? undefined : "true"} />;
}

type ButtonProps = {
  icon?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  small?: boolean;
  busy?: boolean;
  children?: ComponentChildren;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "icon">;

export function Button({ icon, variant = "secondary", small, busy, children, class: cls, disabled, ...rest }: ButtonProps) {
  return (
    <button type="button" class={cx("btn", `btn-${variant}`, small && "btn-sm", !children && "btn-icon", cls as string)} disabled={disabled || busy} {...rest}>
      {busy ? <Icon name="loading" spin /> : icon ? <Icon name={icon} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Toolbar({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return <div class={cx("toolbar", cls)}>{children}</div>;
}

export function Spacer() {
  return <div class="spacer" />;
}

export function Badge({ children, tone = "neutral", title }: { children: ComponentChildren; tone?: "neutral" | "info" | "ok" | "warn" | "danger" | "accent"; title?: string }) {
  return (
    <span class={cx("badge", `badge-${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function Empty({ icon = "info", title, children }: { icon?: string; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} />
      <div class="empty-title">{title}</div>
      {children && <div class="empty-body">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onDismiss }: { error: string | null | undefined; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div class="banner banner-error" role="alert">
      <Icon name="error" />
      <span class="banner-text">{error}</span>
      {onDismiss && <Button variant="ghost" small icon="close" title="Dismiss" onClick={onDismiss} />}
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ComponentChildren; tone?: "info" | "warn" | "ok" }) {
  return (
    <div class={cx("banner", `banner-${tone}`)}>
      <Icon name={tone === "warn" ? "warning" : tone === "ok" ? "pass" : "info"} />
      <span class="banner-text">{children}</span>
    </div>
  );
}

export function Field({ label, hint, children, class: cls }: { label: string; hint?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <label class={cx("field", cls)}>
      <span class="field-label">{label}</span>
      {children}
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  class: cls,
  title,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  class?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <select class={cx("input", cls)} value={value} title={title} disabled={disabled} onChange={(e) => onChange((e.target as HTMLSelectElement).value as T)}>
      {options.map((o) => (
        <option value={o.value} key={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { id: T; label: string; icon?: string; disabled?: boolean; title?: string }[]; onChange: (t: T) => void }) {
  return (
    <div class="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          type="button"
          role="tab"
          key={t.id}
          aria-selected={t.id === value}
          class={cx("tab", t.id === value && "tab-active")}
          disabled={t.disabled}
          title={t.title}
          onClick={() => onChange(t.id)}
        >
          {t.icon && <Icon name={t.icon} />}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Two panes with a draggable divider. `initial` is the first pane's share in %. */
export function SplitPane({
  children,
  initial = 50,
  min = 15,
  max = 85,
  vertical = false,
  storageKey,
}: {
  children: [ComponentChildren, ComponentChildren];
  initial?: number;
  min?: number;
  max?: number;
  vertical?: boolean;
  storageKey?: string;
}) {
  const [pct, setPct] = useState<number>(() => {
    const saved = storageKey ? Number(sessionStorage.getItem(`split:${storageKey}`)) : NaN;
    return Number.isFinite(saved) && saved > 0 ? saved : initial;
  });
  const ref = useRef<HTMLDivElement>(null);
  const onDown = useCallback(
    (e: PointerEvent) => {
      e.preventDefault();
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const raw = vertical ? ((ev.clientY - rect.top) / rect.height) * 100 : ((ev.clientX - rect.left) / rect.width) * 100;
        const next = Math.min(max, Math.max(min, raw));
        setPct(next);
        if (storageKey) sessionStorage.setItem(`split:${storageKey}`, String(next));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [vertical, min, max, storageKey],
  );
  const first = vertical ? { height: `${pct}%` } : { width: `${pct}%` };
  return (
    <div ref={ref} class={cx("split", vertical ? "split-v" : "split-h")}>
      <div class="split-pane" style={first}>
        {children[0]}
      </div>
      <div
        class="split-divider"
        role="separator"
        tabIndex={0}
        onPointerDown={(e) => onDown(e as unknown as PointerEvent)}
        onDblClick={() => setPct(initial)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") setPct((p) => Math.max(min, p - 2));
          if (e.key === "ArrowRight" || e.key === "ArrowDown") setPct((p) => Math.min(max, p + 2));
        }}
      />
      <div class="split-pane split-pane-rest">{children[1]}</div>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ComponentChildren; sub?: ComponentChildren; tone?: "ok" | "warn" | "danger" }) {
  return (
    <div class={cx("stat", tone && `stat-${tone}`)}>
      <div class="stat-label">{label}</div>
      <div class="stat-value">{value}</div>
      {sub !== undefined && <div class="stat-sub">{sub}</div>}
    </div>
  );
}

export function Section({ title, actions, children, class: cls }: { title: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={cx("section", cls)}>
      <header class="section-header">
        <h3>{title}</h3>
        {actions && <div class="section-actions">{actions}</div>}
      </header>
      <div class="section-body">{children}</div>
    </section>
  );
}

/** Copy text to the clipboard and briefly show a check mark. */
export function CopyButton({ text, title = "Copy", small = true }: { text: string | (() => string); title?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Button
      variant="ghost"
      small={small}
      icon={done ? "check" : "copy"}
      title={title}
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === "function" ? text() : text).then(() => setDone(true));
      }}
    />
  );
}

/** Async action state helper. */
export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/** Flash message that disappears after a moment. */
export function useFlash(ms = 2500): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), ms);
    return () => clearTimeout(t);
  }, [msg, ms]);
  return [msg, setMsg];
}

export function Flash({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <span class="flash">
      <Icon name="check" /> {message}
    </span>
  );
}

export function fmtTime(iso: string | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function fmtClock(iso: string | undefined): string {
  return fmtTime(iso).slice(11);
}

// ---- design-system additions (see lib/dashboard.tsx and lib/charts for the full kit) ----

/** Text for screen readers only. */
export function VisuallyHidden({ children }: { children: ComponentChildren }) {
  return <span class="sr-only">{children}</span>;
}

/** Keyboard shortcut hint, e.g. <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>. */
export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd>{children}</kbd>;
}

/** Debounced copy of a value (filters, search boxes). */
export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

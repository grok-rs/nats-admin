// Preact hooks shared by charts and dashboards.

import { createContext } from "preact";
import type { RefObject } from "preact";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { TimeSeriesBuffer, type ResetPolicy, type SeriesStats, type TimePoint } from "./series";

/** Live content-box size of an element (ResizeObserver). Width 0 until first measured. */
export function useElementSize<T extends Element>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      setSize((s) => (s.width === w && s.height === h ? s : { width: w, height: h }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** True while the webview/tab is hidden (document.hidden). */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

export interface PollingState<T> {
  /** Last successful result. Kept while refetching or after an error ("refetch keeps the frame"). */
  data: T | undefined;
  /** Message of the last failed run; cleared by the next success. */
  error: string | undefined;
  /** True until the first run settles. */
  loading: boolean;
  /** True while a run is in flight. */
  refreshing: boolean;
  /** Epoch ms of the last successful run. */
  updatedAt: number | undefined;
  /** True while polling is suspended because the document is hidden. */
  suspended: boolean;
  /** Run now (resets the interval). */
  refresh(): Promise<void>;
}

/**
 * Poll `fn` every `intervalMs` while `enabled`. Runs never overlap (the next run is scheduled
 * after the previous settles), pause while the document is hidden and resume with an immediate
 * run when it becomes visible again. `fn` may change between renders; the latest is used.
 */
export function usePolling<T>(fn: () => T | Promise<T>, intervalMs: number, enabled = true): PollingState<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const hidden = useDocumentHidden();
  const [state, setState] = useState<Omit<PollingState<T>, "refresh" | "suspended">>({
    data: undefined,
    error: undefined,
    loading: true,
    refreshing: false,
    updatedAt: undefined,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const alive = useRef(true);
  const active = enabled && !hidden && intervalMs > 0;
  const activeRef = useRef(active);
  activeRef.current = active;
  const intervalMsRef = useRef(intervalMs);
  intervalMsRef.current = intervalMs;

  const run = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    clearTimeout(timer.current);
    setState((s) => (s.refreshing ? s : { ...s, refreshing: true }));
    const p = (async () => {
      try {
        const data = await fnRef.current();
        if (alive.current) setState({ data, error: undefined, loading: false, refreshing: false, updatedAt: Date.now() });
      } catch (e) {
        if (alive.current) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false, refreshing: false }));
      } finally {
        inFlight.current = undefined;
        if (alive.current && activeRef.current) timer.current = setTimeout(() => void run(), intervalMsRef.current);
      }
    })();
    inFlight.current = p;
    return p;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (active) void run();
  }, [active, intervalMs, run]);

  return { ...state, suspended: enabled && hidden, refresh: run };
}

/** Re-render every `ms` (for "updated 3s ago" labels). */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

export interface TimeSeriesHandle<K extends string> {
  /** Append gauge values (CPU %, connections…) sampled at `t`. */
  push(t: number, values: Partial<Record<K, number | null | undefined>>): void;
  /** Append cumulative counters (in_msgs, bytes…) sampled at `t`; stores per-second rates. */
  pushCounters(t: number, counters: Partial<Record<K, number | null | undefined>>): boolean;
  /** Points for one key, optionally limited to the trailing `windowMs`. */
  series(key: K, windowMs?: number): TimePoint[];
  last(key: K): number | undefined;
  previous(key: K, back?: number): number | undefined;
  stats(key: K, windowMs?: number): SeriesStats | undefined;
  latestTime(): number | undefined;
  clear(): void;
  /** Number of stored samples. */
  length: number;
  /** Increments on every change (use as a memo dependency). */
  version: number;
}

/**
 * Ring buffer of the latest `capacity` samples for several named series, with counter → rate
 * conversion (resets produce a gap by default). Re-renders the component on every push.
 */
export function useTimeSeries<K extends string = string>(capacity = 600, reset: ResetPolicy = "gap"): TimeSeriesHandle<K> {
  const buf = useMemo(() => new TimeSeriesBuffer<K>(capacity, reset), [capacity, reset]);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  return useMemo(
    () => ({
      push: (t, values) => {
        buf.push(t, values);
        bump();
      },
      pushCounters: (t, counters) => {
        const stored = buf.pushCounters(t, counters);
        if (stored) bump();
        return stored;
      },
      series: (k, w) => buf.series(k, w),
      last: (k) => buf.last(k),
      previous: (k, back) => buf.previous(k, back),
      stats: (k, w) => buf.stats(k, w),
      latestTime: () => buf.latestTime(),
      clear: () => {
        buf.clear();
        bump();
      },
      length: buf.length,
      version,
    }),
    [buf, version, bump],
  );
}

/**
 * Increments whenever the VS Code theme changes (body class or the injected CSS variables),
 * so components that resolve colours in JS can recompute.
 */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setV((x) => x + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    mo.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind"] });
    return () => mo.disconnect();
  }, []);
  return v;
}

/** Shared crosshair time for every TimeSeriesChart inside a <CrosshairSync>. */
export interface CrosshairState {
  t: number | undefined;
  set(t: number | undefined): void;
}

export const CrosshairContext = createContext<CrosshairState | null>(null);

export function useCrosshair(): CrosshairState | null {
  return useContext(CrosshairContext);
}

/** Stable unique id for aria attributes. */
let idSeq = 0;
export function useId(prefix = "vz"): string {
  const ref = useRef<string | undefined>(undefined);
  if (!ref.current) ref.current = `${prefix}-${++idSeq}`;
  return ref.current;
}

/** A Set of hidden ids with toggle/solo helpers (legend interaction). */
export function useHiddenSet(initial: Iterable<string> = []): {
  hidden: ReadonlySet<string>;
  toggle(id: string): void;
  solo(id: string, all: readonly string[]): void;
  reset(): void;
} {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(initial));
  return {
    hidden,
    toggle: (id) =>
      setHidden((h) => {
        const n = new Set(h);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    solo: (id, all) =>
      setHidden((h) => {
        const onlyThis = all.every((x) => (x === id ? !h.has(x) : h.has(x)));
        return onlyThis ? new Set() : new Set(all.filter((x) => x !== id));
      }),
    reset: () => setHidden(new Set()),
  };
}

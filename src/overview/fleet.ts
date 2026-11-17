// Host-side metrics service shared by the Overview sidebar and the Home panel. Pull-based:
// nothing is collected unless a visible view asks. Concurrent requests for the same profile
// share one in-flight sample, recent samples are reused, and an unreachable monitoring
// endpoint is backed off so a firewalled :8222 doesn't slow every refresh down.

import * as vscode from "vscode";
import type { Services } from "../services";
import { deriveMonitorUrl, type ConnectionProfile } from "../core/profile";
import { healthBus } from "../core/healthBus";
import { cfg } from "../core/ui";
import { collectSample, MetricsTracker } from "./metrics";
import type { FleetRow, HealthDTO, LiveMetrics, ProfileSummary } from "./model";

const MONITOR_BACKOFF_MS = 30_000;

export class FleetMonitor implements vscode.Disposable {
  private readonly tracker = new MetricsTracker();
  private readonly last = new Map<string, LiveMetrics>();
  private readonly inflight = new Map<string, Promise<LiveMetrics | undefined>>();
  private readonly monitorRetryAt = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly s: Services) {
    this.disposables.push(
      s.manager.onDidChangeState((e) => {
        if (e.state === "disconnected" || e.state === "error") this.forget(e.profileId);
        // A reconnect may land on another server: re-probe monitoring straight away.
        if (e.state === "connected") this.monitorRetryAt.delete(e.profileId);
      }),
      s.store.onDidChange(() => {
        for (const id of [...this.last.keys()]) if (!s.store.get(id)) this.forget(id);
      }),
    );
  }

  /** Last sample without collecting (may be stale or undefined). */
  peek(profileId: string): LiveMetrics | undefined {
    return this.s.manager.get(profileId) ? this.last.get(profileId) : undefined;
  }

  /**
   * Sample a live connection. Reuses a sample younger than `maxAgeMs` and joins an in-flight one.
   * Returns undefined when the profile is not connected.
   */
  sample(profileId: string, maxAgeMs = 1000): Promise<LiveMetrics | undefined> {
    const lc = this.s.manager.get(profileId);
    if (!lc) return Promise.resolve(undefined);
    const cached = this.last.get(profileId);
    if (cached && Date.now() - cached.at < maxAgeMs) return Promise.resolve(cached);
    const running = this.inflight.get(profileId);
    if (running) return running;
    const p = (async () => {
      const now = Date.now();
      const monitorUrl = deriveMonitorUrl(lc.profile);
      const retryAt = this.monitorRetryAt.get(profileId);
      const skipMonitor = retryAt !== undefined && now < retryAt;
      const raw = await collectSample(lc, {
        monitorUrl,
        skipMonitor,
        timeoutMs: Math.min(2500, Math.max(800, cfg("overview.refreshInterval", 3000) - 200)),
        countKinds: this.tracker.needsKinds(profileId, now),
      });
      if (monitorUrl && !skipMonitor) {
        if (raw.monitor.ok) this.monitorRetryAt.delete(profileId);
        else this.monitorRetryAt.set(profileId, now + MONITOR_BACKOFF_MS);
      }
      if (skipMonitor) raw.monitor.retryAt = retryAt;
      // The connection may have closed while sampling.
      if (!this.s.manager.get(profileId)) return undefined;
      const m = this.tracker.ingest(profileId, raw);
      this.last.set(profileId, m);
      return m;
    })().finally(() => this.inflight.delete(profileId));
    this.inflight.set(profileId, p);
    return p;
  }

  /** Re-probe the monitoring endpoint and re-count streams on the next sample. */
  invalidate(profileId: string): void {
    this.monitorRetryAt.delete(profileId);
    this.tracker.invalidateKinds(profileId);
    this.last.delete(profileId);
  }

  forget(profileId: string): void {
    this.tracker.forget(profileId);
    this.last.delete(profileId);
    this.monitorRetryAt.delete(profileId);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

const monitors = new WeakMap<vscode.ExtensionContext, FleetMonitor>();

/** The shared FleetMonitor for this extension instance (created on first use, disposed with the extension). */
export function fleetMonitor(s: Services): FleetMonitor {
  let m = monitors.get(s.context);
  if (!m) {
    m = new FleetMonitor(s);
    monitors.set(s.context, m);
    s.context.subscriptions.push(m);
  }
  return m;
}

/** Serializable summary of a profile with its live state. */
export function profileSummary(s: Services, p: ConnectionProfile): ProfileSummary {
  const { state, error } = s.manager.stateOf(p.id);
  return {
    id: p.id,
    name: p.name,
    servers: p.servers.length ? p.servers : ["nats://127.0.0.1:4222"],
    environment: p.environment,
    readOnly: !!p.readOnly,
    origin: p.origin ?? "manual",
    contextName: p.contextName,
    description: p.description,
    autoConnect: !!p.autoConnect,
    selectedContext: s.store.isSelectedContext(p),
    managed: s.store.isManaged(p.id),
    warning: s.store.warningFor(p.id),
    state,
    error,
    active: s.manager.activeId === p.id,
    auth: p.auth.kind,
    tls: !!p.tls?.enabled,
  };
}

export function healthOf(connId: string): HealthDTO | undefined {
  const h = healthBus.get(connId);
  return h ? { ...h, top: h.top.slice(0, 5) } : undefined;
}

/** Fleet row for one profile: summary, live metrics (sampled when `sample` is set) and health. */
export async function fleetRow(s: Services, p: ConnectionProfile, opts: { sample: boolean; maxAgeMs: number }): Promise<FleetRow> {
  const fm = fleetMonitor(s);
  // While reconnecting, keep the last good sample (the views say so) instead of replacing it with
  // one made of RTT / JetStream timeouts.
  const sample = opts.sample && s.manager.stateOf(p.id).state === "connected";
  const metrics = sample ? await fm.sample(p.id, opts.maxAgeMs).catch(() => fm.peek(p.id)) : fm.peek(p.id);
  return { profile: profileSummary(s, p), metrics, health: s.manager.get(p.id) ? healthOf(p.id) : undefined };
}

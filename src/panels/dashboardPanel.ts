// Server dashboard: identity, RTT, client stats, JetStream account usage, HTTP monitoring
// (varz / connz / jsz / healthz), health summary and a streams ↔ subjects map.
// Polls only while the panel is visible and not paused; pushes `snapshot` events.

import * as vscode from "vscode";
import type { Services } from "../services";
import type { ConnState, LiveConnection } from "../core/connectionManager";
import { errorMessage } from "../core/connectionManager";
import { cfg } from "../core/ui";
import { deriveMonitorUrl, type Environment, type ProfileOrigin } from "../core/profile";
import { healthBus } from "../core/healthBus";
import { log } from "../core/log";
import { fetchMonitor, type ConnzLite, type VarzLite } from "../nats/monitor";
import { listStreams } from "../nats/streams";
import { WebviewPanelBase, type RpcHandler } from "./webviewHost";
import { openMessageBrowser } from "./messageBrowserPanel";
import { healthOf } from "../overview/fleet";
import { openDocs, runCommand } from "../overview/actions";
import { withTimeout } from "../overview/metrics";
import type { HealthDTO } from "../overview/model";

export interface DashboardProfile {
  name: string;
  environment?: Environment;
  readOnly: boolean;
  origin: ProfileOrigin;
}

export interface DashboardInit {
  profileId: string;
  profileName: string;
  monitorUrl?: string;
  refreshInterval: number;
  profile?: DashboardProfile;
  /** RTT warning threshold (nats.health.rttWarningMs). */
  rttWarnMs?: number;
}

export interface StreamRow {
  name: string;
  subjects: string[];
  messages: number;
  bytes: number;
  consumers: number;
  storage: string;
  retention: string;
  replicas: number;
  sourced: string;
}

export type VarzSnapshot = Pick<
  VarzLite,
  | "server_name"
  | "server_id"
  | "version"
  | "uptime"
  | "start"
  | "now"
  | "cpu"
  | "mem"
  | "cores"
  | "connections"
  | "total_connections"
  | "subscriptions"
  | "slow_consumers"
  | "in_msgs"
  | "out_msgs"
  | "in_bytes"
  | "out_bytes"
> & { max_connections?: number; routes?: number; leafnodes?: number; remotes?: number; gomaxprocs?: number; max_payload?: number };

export interface DashboardSnapshot {
  at: number;
  state: ConnState;
  error?: string;
  connectedUrl?: string;
  profile?: DashboardProfile;
  /** Polling is paused by the user (manual refresh still works). */
  paused?: boolean;
  server?: {
    name: string;
    id: string;
    version: string;
    go: string;
    host: string;
    port: number;
    proto: number;
    cluster?: string;
    maxPayload: number;
    tlsRequired: boolean;
    authRequired: boolean;
    jetstream: boolean;
    headers: boolean;
    clientId?: number;
    clientIp?: string;
    domain?: string;
  };
  rttMs?: number;
  client?: { inMsgs: number; outMsgs: number; inBytes: number; outBytes: number };
  jetstream?: {
    enabled: boolean;
    error?: string;
    memory?: number;
    storage?: number;
    reservedMemory?: number;
    reservedStorage?: number;
    streams?: number;
    consumers?: number;
    limits?: { maxMemory: number; maxStorage: number; maxStreams: number; maxConsumers: number; maxAckPending?: number };
    /** Per-replication-tier limits (R1, R3…) of tiered accounts, whose top-level limits are 0 / -1. */
    tierLimits?: { maxMemory?: number; maxStorage?: number }[];
    api?: { total: number; errors: number; level?: number; inflight?: number };
    domain?: string;
  };
  monitor: {
    url?: string;
    ok: boolean;
    error?: string;
    varz?: VarzSnapshot;
    connz?: ConnzLite;
    jsz?: { memory: number; storage: number; streams: number; consumers: number; messages: number; bytes: number; accounts?: number; maxMemory?: number; maxStorage?: number; api?: { total: number; errors: number } };
    health?: { status: string; error?: string };
  };
  /** Latest health check summary (health module, via healthBus). */
  health?: HealthDTO;
  streams?: StreamRow[];
  streamsError?: string;
}

const STREAMS_EVERY = 3;
/** JetStream API calls give up after this long (a reconnecting client would otherwise wait the full 10 s JS timeout). */
const JS_TIMEOUT_MS = 5000;

class DashboardPanel extends WebviewPanelBase {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  /** A poll was requested (state change, visibility) while another one was in flight. */
  private repoll = false;
  private paused = false;
  private tick = 0;
  private streams?: StreamRow[];
  private streamsError?: string;

  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    init: DashboardInit,
  ) {
    super(s.context, { viewType: "nats.dashboard", key: `dashboard:${profileId}`, title: `Dashboard · ${init.profileName}`, script: "dashboard", init });
    this.disposables.push(
      this.panel.onDidChangeViewState(() => this.schedule(0)),
      s.manager.onDidChangeState((e) => {
        if (e.profileId === this.profileId) {
          this.streams = undefined;
          this.schedule(0);
        }
      }),
      s.store.onDidChange(() => {
        const p = s.store.get(this.profileId);
        if (p) this.setTitle(`Dashboard · ${p.name}`);
        this.schedule(0);
      }),
      healthBus.onDidChange((h) => {
        if (h.connId === this.profileId) this.post("health", healthOf(this.profileId));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nats.dashboard") || e.affectsConfiguration("nats.health.rttWarningMs")) this.post("config", { refreshInterval: this.interval, rttWarnMs: cfg("health.rttWarningMs", 100) });
      }),
      { dispose: () => this.timer && clearTimeout(this.timer) },
    );
    this.schedule(0);
  }

  private get interval(): number {
    return Math.max(500, cfg("dashboard.refreshInterval", 2000));
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.isDisposed || !this.panel.visible || this.paused) return;
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      // Don't drop it: a connection state change must reach the webview right after the
      // in-flight poll, not one interval later.
      this.repoll = true;
      return;
    }
    this.polling = true;
    this.repoll = false;
    try {
      const snap = await this.collect(false);
      this.post("snapshot", snap);
    } catch (e) {
      log.debug(`[nats.dashboard] poll failed: ${errorMessage(e)}`);
    } finally {
      this.polling = false;
      this.schedule(this.repoll ? 0 : this.interval);
    }
  }

  private lc(): LiveConnection | undefined {
    return this.s.manager.get(this.profileId);
  }

  private profileInfo(): DashboardProfile | undefined {
    const p = this.s.store.get(this.profileId);
    return p ? { name: p.name, environment: p.environment, readOnly: !!p.readOnly, origin: p.origin ?? "manual" } : undefined;
  }

  async collect(forceStreams: boolean): Promise<DashboardSnapshot> {
    const profile = this.s.store.get(this.profileId);
    const monitorUrl = profile ? deriveMonitorUrl(profile) : undefined;
    const { state, error } = this.s.manager.stateOf(this.profileId);
    const lc = this.lc();
    const snap: DashboardSnapshot = { at: Date.now(), state, error, profile: this.profileInfo(), paused: this.paused, monitor: { url: monitorUrl, ok: false } };

    const monitorTask = monitorUrl ? this.collectMonitor(monitorUrl, snap) : Promise.resolve();
    if (!monitorUrl) snap.monitor.error = "No monitoring URL (WebSocket connections need an explicit Monitor URL)";

    if (lc && !lc.nc.isClosed()) {
      const info = lc.info;
      snap.connectedUrl = lc.nc.getServer();
      if (info) {
        snap.server = {
          name: info.server_name,
          id: info.server_id,
          version: info.version,
          go: info.go,
          host: info.host,
          port: info.port,
          proto: info.proto,
          cluster: info.cluster,
          maxPayload: info.max_payload,
          tlsRequired: Boolean(info.tls_required),
          authRequired: Boolean(info.auth_required),
          jetstream: Boolean(info.jetstream),
          headers: Boolean(info.headers),
          clientId: info.client_id,
          clientIp: info.client_ip,
          domain: (info as { domain?: string }).domain,
        };
      }
      snap.client = lc.nc.stats();
      const rttTask = withTimeout(lc.nc.rtt(), Math.min(3000, this.interval * 2), "RTT").catch(() => undefined);
      const [rtt] = await Promise.all([rttTask, this.collectJetStream(lc, snap, forceStreams)]);
      snap.rttMs = rtt;
      snap.health = healthOf(this.profileId);
    }
    await monitorTask;
    snap.streams = this.streams;
    snap.streamsError = this.streamsError;
    return snap;
  }

  private async collectJetStream(lc: LiveConnection, snap: DashboardSnapshot, forceStreams: boolean): Promise<void> {
    let enabled: boolean;
    try {
      enabled = await withTimeout(lc.hasJetStream(), JS_TIMEOUT_MS, "JetStream");
    } catch (e) {
      snap.jetstream = { enabled: true, error: errorMessage(e) };
      return;
    }
    if (!enabled) {
      snap.jetstream = { enabled: false };
      return;
    }
    try {
      const jsm = await lc.jsm();
      const ai = await withTimeout(jsm.getAccountInfo(), JS_TIMEOUT_MS, "JetStream account info");
      snap.jetstream = {
        enabled: true,
        memory: ai.memory,
        storage: ai.storage,
        reservedMemory: ai.reserved_memory,
        reservedStorage: ai.reserved_storage,
        streams: ai.streams,
        consumers: ai.consumers,
        limits: {
          maxMemory: ai.limits.max_memory,
          maxStorage: ai.limits.max_storage,
          maxStreams: ai.limits.max_streams,
          maxConsumers: ai.limits.max_consumers,
          maxAckPending: ai.limits.max_ack_pending,
        },
        tierLimits: Object.values(ai.tiers ?? {}).map((t) => ({ maxMemory: t?.limits?.max_memory, maxStorage: t?.limits?.max_storage })),
        api: ai.api,
        domain: ai.domain,
      };
      if (forceStreams || this.streams === undefined || this.tick++ % STREAMS_EVERY === 0) {
        try {
          const list = await withTimeout(listStreams(jsm, true), JS_TIMEOUT_MS * 2, "Stream list");
          this.streams = list.map((si) => ({
            name: si.config.name,
            subjects: si.config.subjects ?? [],
            messages: si.state.messages,
            bytes: si.state.bytes,
            consumers: si.state.consumer_count,
            storage: String(si.config.storage),
            retention: String(si.config.retention),
            replicas: si.config.num_replicas,
            sourced: si.config.mirror ? `mirror of ${si.config.mirror.name}` : si.config.sources?.length ? `sources: ${si.config.sources.map((x) => x.name).join(", ")}` : "",
          }));
          this.streamsError = undefined;
        } catch (e) {
          this.streamsError = errorMessage(e);
        }
      }
    } catch (e) {
      snap.jetstream = { enabled: true, error: errorMessage(e) };
    }
  }

  private async collectMonitor(url: string, snap: DashboardSnapshot): Promise<void> {
    const timeout = Math.min(3000, this.interval);
    const [varz, connz, jsz, health] = await Promise.allSettled([
      fetchMonitor<VarzLite & Record<string, any>>(url, "varz", {}, timeout),
      fetchMonitor<ConnzLite>(url, "connz", { limit: 500, sort: "cid" }, timeout),
      fetchMonitor<Record<string, any>>(url, "jsz", {}, timeout),
      fetchMonitor<{ status: string; error?: string }>(url, "healthz", {}, timeout),
    ]);
    if (varz.status === "fulfilled") {
      const v = varz.value;
      snap.monitor.ok = true;
      snap.monitor.varz = {
        server_name: v.server_name,
        server_id: v.server_id,
        version: v.version,
        uptime: v.uptime,
        start: v.start,
        now: v.now,
        cpu: v.cpu,
        mem: v.mem,
        cores: v.cores,
        connections: v.connections,
        total_connections: v.total_connections,
        subscriptions: v.subscriptions,
        slow_consumers: v.slow_consumers,
        in_msgs: v.in_msgs,
        out_msgs: v.out_msgs,
        in_bytes: v.in_bytes,
        out_bytes: v.out_bytes,
        max_connections: v.max_connections,
        routes: v.routes,
        leafnodes: v.leafnodes,
        remotes: v.remotes,
        gomaxprocs: v.gomaxprocs,
        max_payload: v.max_payload,
      };
    } else {
      snap.monitor.error = errorMessage(varz.reason);
    }
    if (connz.status === "fulfilled") snap.monitor.connz = connz.value;
    if (jsz.status === "fulfilled" && typeof jsz.value.streams === "number") {
      const j = jsz.value;
      snap.monitor.jsz = {
        memory: j.memory,
        storage: j.storage,
        streams: j.streams,
        consumers: j.consumers,
        messages: j.messages,
        bytes: j.bytes,
        accounts: j.accounts,
        maxMemory: j.config?.max_memory,
        maxStorage: j.config?.max_storage,
        api: j.api,
      };
    }
    if (health.status === "fulfilled") snap.monitor.health = health.value;
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      refresh: () => this.collect(true),
      setPaused: (p: { paused: boolean }) => {
        this.paused = !!p.paused;
        this.schedule(0); // stops the timer while paused, polls right away on resume
        return this.paused;
      },
      openServerInfo: () => vscode.commands.executeCommand("nats.serverInfo", { connId: this.profileId }),
      connect: () => this.s.manager.connect(this.profileId).then(() => true),
      openMonitor: (p: { path?: string }) => {
        const profile = this.s.store.get(this.profileId);
        const url = profile && deriveMonitorUrl(profile);
        if (url) void vscode.env.openExternal(vscode.Uri.parse(`${url}/${p.path ?? ""}`));
      },
      editConnection: () => vscode.commands.executeCommand("nats.editConnection", this.s.explorer.connectionNode(this.profileId) ?? this.profileId),
      browseStream: (p: { stream: string }) => {
        const lc = this.lc();
        if (!lc) throw new Error("Not connected");
        openMessageBrowser(this.s, lc, p.stream);
      },
      run: (p: { command: string }) => runCommand(this.s, p.command, this.profileId),
      openDocs: (p: { url: string }) => openDocs(p.url),
    };
  }
}

export function openDashboard(s: Services, lc: LiveConnection): void {
  if (WebviewPanelBase.reveal(`dashboard:${lc.id}`)) return;
  const p = lc.profile;
  const init: DashboardInit = {
    profileId: lc.id,
    profileName: p.name,
    monitorUrl: deriveMonitorUrl(p),
    refreshInterval: Math.max(500, cfg("dashboard.refreshInterval", 2000)),
    profile: { name: p.name, environment: p.environment, readOnly: !!p.readOnly, origin: p.origin ?? "manual" },
    rttWarnMs: cfg("health.rttWarningMs", 100),
  };
  new DashboardPanel(s, lc.id, init);
}

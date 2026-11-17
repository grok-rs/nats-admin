// Cluster overview panel: every server from $SYS statsz (system-account users) or the connected
// server's HTTP monitoring endpoint, plus routes / gateways / leaf nodes and "who am I".
// One panel per connection; the webview polls `snapshot` while visible.

import * as vscode from "vscode";
import type { Services } from "../services";
import type { ConnState, LiveConnection } from "../core/connectionManager";
import { cfg } from "../core/ui";
import type { Environment } from "../core/profile";
import { fetchUserInfo, SystemAccessError, forgetSystemAccess } from "../nats/system";
import { collectMonitor, collectSystem, basicFromInfo, errText, monitorCandidates } from "../admin/clusterData";
import { whoAmIView, type ClusterSnapshot, type GatewayRow, type LeafRow, type RouteRow, type ServerRow, type WhoAmIView } from "../admin/clusterModel";
import { WebviewPanelBase, type RpcHandler } from "./webviewHost";

export interface ClusterInit {
  profileId: string;
  profileName: string;
  environment?: Environment;
  readOnly: boolean;
  serverName?: string;
  connectedUrl?: string;
  cluster?: string;
  monitorUrl?: string;
  refreshInterval: number;
  state: ConnState;
}

const TOPOLOGY_TTL = 10_000;
const USER_TTL = 60_000;
const SYS_RETRY = 60_000;
const MONITOR_RETRY = 30_000;

class ClusterPanel extends WebviewPanelBase {
  private sys?: { ok: boolean; at: number; note?: string };
  private topo?: { at: number; routes: RouteRow[]; gateways: GatewayRow[]; leafs: LeafRow[]; health: Map<string, ServerRow["health"]>; leafCounts: Map<string, number | undefined> };
  private user?: { at: number; view: WhoAmIView };
  private monitorFail?: { at: number; error: string };
  private lastMonitorUrl?: string;

  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    init: ClusterInit,
  ) {
    super(s.context, { viewType: "nats.cluster", key: ClusterPanel.key(profileId), title: `Cluster · ${init.profileName}`, script: "cluster", init });
    this.disposables.push(
      this.panel.onDidChangeViewState(() => this.post("visible", { visible: this.panel.visible })),
      s.manager.onDidChangeState((e) => {
        if (e.profileId !== profileId) return;
        this.sys = undefined;
        this.topo = undefined;
        this.user = undefined;
        this.monitorFail = undefined;
        this.lastMonitorUrl = undefined;
        this.post("connection", { state: e.state, error: s.manager.stateOf(profileId).error });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nats.dashboard")) this.post("config", { refreshInterval: ClusterPanel.interval() });
      }),
    );
  }

  static key(profileId: string): string {
    return `cluster:${profileId}`;
  }

  static interval(): number {
    return Math.max(1000, cfg("dashboard.refreshInterval", 2000));
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error("Not connected — reconnect to load the cluster overview");
    return lc;
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      snapshot: ({ force }: { force?: boolean } = {}) => this.snapshot(!!force),
      whoAmI: async () => {
        await vscode.commands.executeCommand("nats.whoAmI", this.profileId);
        return true;
      },
      serverDetails: async ({ id, name }: { id: string; name?: string }) => {
        await vscode.commands.executeCommand("nats.serverDetails", { connId: this.profileId, serverId: id, serverName: name });
        return true;
      },
      openMonitor: async ({ path }: { path?: string }) => {
        const url = this.monitorUrl();
        if (!url) throw new Error("No monitoring URL for this connection");
        await vscode.env.openExternal(vscode.Uri.parse(`${url}${path ?? "/"}`));
        return true;
      },
      editConnection: async () => {
        await vscode.commands.executeCommand("nats.editConnection", this.profileId);
        return true;
      },
      reconnect: async () => {
        await this.s.manager.connect(this.profileId);
        return true;
      },
    };
  }

  private async userView(lc: LiveConnection, force: boolean): Promise<WhoAmIView> {
    if (!force && this.user && Date.now() - this.user.at < USER_TTL) return this.user.view;
    const view = whoAmIView(await fetchUserInfo(lc.nc, 1500));
    this.user = { at: Date.now(), view };
    return view;
  }

  private async snapshot(force: boolean): Promise<ClusterSnapshot> {
    const lc = this.lc();
    const info = lc.info;
    const [rtt, user] = await Promise.all([lc.nc.rtt().catch(() => undefined), this.userView(lc, force)]);
    const base = {
      at: Date.now(),
      connectedServerId: info?.server_id,
      connectedServerName: info?.server_name,
      connectedUrl: lc.nc.getServer(),
      rttMs: rtt,
      user,
    };
    const markConnected = (rows: ServerRow[]) => rows.forEach((r) => (r.connected = r.id === info?.server_id || r.connected));

    // 1. $SYS view
    if (force && this.sys && !this.sys.ok) {
      forgetSystemAccess(lc.nc);
      this.sys = undefined;
    }
    if (!this.sys || this.sys.ok || Date.now() - this.sys.at > SYS_RETRY) {
      try {
        const needTopo = force || !this.topo || Date.now() - this.topo.at > TOPOLOGY_TTL;
        const part = await collectSystem(lc.nc, { topology: needTopo, maxWait: 1500 });
        if (!part.servers.length) {
          // A view that worked a moment ago keeps its (stale) data instead of switching to the
          // limited fallback for a minute because one scatter-gather came back empty.
          if (this.sys?.ok) throw new Error("No server answered $SYS.REQ.SERVER.PING within 1.5 s");
          throw new SystemAccessError("no server answered");
        }
        this.sys = { ok: true, at: Date.now() };
        if (needTopo) {
          this.topo = {
            at: part.topologyAt ?? Date.now(),
            routes: part.routes,
            gateways: part.gateways,
            leafs: part.leafs,
            health: new Map(part.servers.map((r) => [r.id, r.health])),
            leafCounts: new Map(part.servers.map((r) => [r.id, r.leafs])),
          };
        } else if (this.topo) {
          for (const r of part.servers) {
            r.health = this.topo.health.get(r.id);
            r.leafs = this.topo.leafCounts.get(r.id);
          }
        }
        markConnected(part.servers);
        return { ...base, mode: "system", ...part, routes: this.topo?.routes ?? [], gateways: this.topo?.gateways ?? [], leafs: this.topo?.leafs ?? [], topologyAt: this.topo?.at };
      } catch (e) {
        if (!(e instanceof SystemAccessError)) throw e;
        this.sys = { ok: false, at: Date.now(), note: e.message };
        this.topo = undefined;
      }
    }

    // 2. HTTP monitoring, preferably of the connected server
    const candidates = monitorCandidates(lc.profile, lc.nc.getServer());
    let monitorUrl = candidates[0];
    let monitorError: string | undefined;
    if (!candidates.length) monitorError = "No monitoring URL (WebSocket connection) — set one in the connection settings.";
    else if (!force && this.monitorFail && Date.now() - this.monitorFail.at < MONITOR_RETRY) monitorError = this.monitorFail.error;
    else {
      for (const url of candidates) {
        try {
          const part = await collectMonitor(url, 2500, info?.server_id);
          this.monitorFail = undefined;
          this.lastMonitorUrl = url;
          markConnected(part.servers);
          return { ...base, mode: "monitor", ...part, monitorUrl: url, sysNote: this.sys?.note };
        } catch (e) {
          monitorError = monitorError ? `${monitorError}; ${url}: ${errText(e)}` : `${url}: ${errText(e)}`;
        }
      }
      // Unreachable endpoints are not retried on every poll (each attempt can take the full timeout).
      this.monitorFail = { at: Date.now(), error: monitorError! };
    }

    // 3. INFO only
    return { ...base, mode: "basic", ...basicFromInfo(info), monitorUrl, monitorError, sysNote: this.sys?.note };
  }

  /** Monitoring URL for "open in browser": the one that answered last, else the best candidate. */
  monitorUrl(): string | undefined {
    const lc = this.lc();
    return this.lastMonitorUrl ?? monitorCandidates(lc.profile, lc.nc.getServer())[0];
  }
}

export function openCluster(s: Services, lc: LiveConnection): void {
  if (WebviewPanelBase.reveal(ClusterPanel.key(lc.id))) return;
  const p = lc.profile;
  new ClusterPanel(s, lc.id, {
    profileId: lc.id,
    profileName: p.name,
    environment: p.environment,
    readOnly: !!p.readOnly,
    serverName: lc.info?.server_name,
    connectedUrl: lc.nc.getServer(),
    cluster: lc.info?.cluster,
    monitorUrl: monitorCandidates(p, lc.nc.getServer())[0],
    refreshInterval: ClusterPanel.interval(),
    state: s.manager.stateOf(lc.id).state,
  });
}

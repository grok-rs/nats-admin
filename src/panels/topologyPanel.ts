// JetStream topology panel: interactive graph of the account (subjects → streams → consumers,
// mirrors / sources, service endpoints). One panel per connection; the webview polls
// `snapshot` while visible and lays the graph out itself (src/admin/graphLayout.ts).

import * as vscode from "vscode";
import { writeFile } from "node:fs/promises";
import type { Services } from "../services";
import type { ConnState, LiveConnection } from "../core/connectionManager";
import { cfg } from "../core/ui";
import { healthBus, type HealthSummary } from "../core/healthBus";
import type { Environment } from "../core/profile";
import { infoUri } from "../fs/infoDocs";
import { fetchUserInfo } from "../nats/system";
import { collectTopology } from "../admin/topologyData";
import type { HealthThresholds, TopologyData } from "../admin/topologyModel";
import { WebviewPanelBase, type RpcHandler } from "./webviewHost";
import { openMessageBrowser } from "./messageBrowserPanel";
import { openConsumerLab } from "./consumerLabPanel";
import { openKvBrowser } from "./kvBrowserPanel";
import { openLiveTail } from "./liveTailPanel";
import { openPublisher } from "./publisherPanel";

export interface HealthLite {
  score: number;
  errors: number;
  warnings: number;
  at: string;
  top: { severity: string; title: string }[];
}

export interface TopologyInit {
  profileId: string;
  profileName: string;
  environment?: Environment;
  readOnly: boolean;
  serverName?: string;
  serverUrl?: string;
  cluster?: string;
  refreshInterval: number;
  thresholds: HealthThresholds;
  health?: HealthLite;
  state: ConnState;
}

export type TopologyAction =
  | "browse"
  | "consumerLab"
  | "kvBrowser"
  | "streamInfo"
  | "consumerInfo"
  | "kvInfo"
  | "objInfo"
  | "serviceInfo"
  | "liveTail"
  | "request";

export interface TopologyOpenParams {
  action: TopologyAction;
  stream?: string;
  consumer?: string;
  bucket?: string;
  subject?: string;
  service?: string;
}

/** Commands the webview may trigger (each receives the profile id). */
const RUNNABLE = new Set(["nats.openHealthDashboard", "nats.runHealthCheck", "nats.createStream", "nats.openCluster", "nats.whoAmI"]);

function healthLite(h: HealthSummary | undefined): HealthLite | undefined {
  return h ? { score: h.score, errors: h.errors, warnings: h.warnings, at: h.at, top: h.top } : undefined;
}

export function topologyThresholds(): HealthThresholds {
  return {
    pendingWarning: cfg("health.pendingWarning", 10_000),
    ackPendingRatio: cfg("health.ackPendingRatio", 0.9),
    storageWarningRatio: cfg("health.storageWarningRatio", 0.8),
    storageErrorRatio: cfg("health.storageErrorRatio", 0.95),
    lagWarning: Math.max(100, Math.round(cfg("health.pendingWarning", 10_000) / 10)),
  };
}

class TopologyPanel extends WebviewPanelBase {
  private account?: { at: number; name?: string };

  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    init: TopologyInit,
  ) {
    super(s.context, { viewType: "nats.topology", key: TopologyPanel.key(profileId), title: `Topology · ${init.profileName}`, script: "topology", init });
    this.disposables.push(
      this.panel.onDidChangeViewState(() => this.post("visible", { visible: this.panel.visible })),
      s.manager.onDidChangeState((e) => {
        if (e.profileId !== profileId) return;
        this.account = undefined;
        this.post("connection", { state: e.state, error: s.manager.stateOf(profileId).error });
      }),
      healthBus.onDidChange((h) => {
        if (h.connId === profileId) this.post("health", healthLite(healthBus.get(profileId)));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nats.health")) this.post("thresholds", topologyThresholds());
      }),
    );
  }

  static key(profileId: string): string {
    return `topology:${profileId}`;
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error("Not connected — reconnect to load the topology");
    return lc;
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      snapshot: async (): Promise<TopologyData> => {
        const lc = this.lc();
        const [data, account] = await Promise.all([collectTopology(lc), this.accountName(lc)]);
        data.account = account;
        return data;
      },
      health: () => healthLite(healthBus.get(this.profileId)) ?? null,
      open: (p: TopologyOpenParams) => this.open(p),
      exportSvg: async ({ svg, name }: { svg: string; name?: string }) => {
        const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? ".");
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(base, `${(name ?? "topology").replace(/[^\w.-]+/g, "-")}.svg`),
          filters: { "SVG image": ["svg"] },
          title: "Export topology as SVG",
        });
        if (!target) return null;
        await writeFile(target.fsPath, svg, "utf8");
        void vscode.window.showInformationMessage(`Topology exported to ${target.fsPath}`, "Open").then((c) => {
          if (c) void vscode.commands.executeCommand("vscode.open", target);
        });
        return target.fsPath;
      },
      reconnect: async () => {
        await this.s.manager.connect(this.profileId);
        return true;
      },
      runCommand: async ({ id }: { id: string }) => {
        if (!RUNNABLE.has(id)) throw new Error(`Command ${id} cannot be run from the topology view`);
        await vscode.commands.executeCommand(id, this.profileId);
        return true;
      },
    };
  }

  private async accountName(lc: LiveConnection): Promise<string | undefined> {
    if (this.account && Date.now() - this.account.at < 120_000) return this.account.name;
    const info = await fetchUserInfo(lc.nc, 1500);
    this.account = { at: Date.now(), name: info?.account_name || info?.account };
    return this.account.name;
  }

  private async open(p: TopologyOpenParams): Promise<boolean> {
    const lc = this.lc();
    const beside = vscode.ViewColumn.Beside;
    switch (p.action) {
      case "browse":
        if (!p.stream) throw new Error("No stream");
        openMessageBrowser(this.s, lc, p.stream, p.subject ? { filter: p.subject } : undefined);
        return true;
      case "consumerLab":
        if (!p.stream || !p.consumer) throw new Error("No consumer");
        openConsumerLab(this.s, lc, p.stream, p.consumer);
        return true;
      case "kvBrowser":
        if (!p.bucket) throw new Error("No bucket");
        await openKvBrowser(this.s, lc, p.bucket);
        return true;
      case "streamInfo":
        await this.s.infoDocs.show(infoUri(lc.id, `/stream/${p.stream}.json`), { column: beside });
        return true;
      case "consumerInfo":
        await this.s.infoDocs.show(infoUri(lc.id, `/consumer/${p.stream}/${p.consumer}.json`), { column: beside });
        return true;
      case "kvInfo":
        await this.s.infoDocs.show(infoUri(lc.id, `/kv/${p.bucket}.json`), { column: beside });
        return true;
      case "objInfo":
        await this.s.infoDocs.show(infoUri(lc.id, `/obj/${p.bucket}.json`), { column: beside });
        return true;
      case "serviceInfo":
        await this.s.infoDocs.show(infoUri(lc.id, `/service/${p.service}.json`), { column: beside });
        return true;
      case "liveTail":
        if (!p.subject) throw new Error("No subject");
        openLiveTail(this.s, lc, { subject: p.subject });
        return true;
      case "request":
        openPublisher(this.s, lc, { subject: p.subject, mode: "request" });
        return true;
      default:
        throw new Error(`Unknown action ${String(p.action)}`);
    }
  }
}

export function openTopology(s: Services, lc: LiveConnection): void {
  if (WebviewPanelBase.reveal(TopologyPanel.key(lc.id))) return;
  const p = lc.profile;
  new TopologyPanel(s, lc.id, {
    profileId: lc.id,
    profileName: p.name,
    environment: p.environment,
    readOnly: !!p.readOnly,
    serverName: lc.info?.server_name,
    serverUrl: lc.nc.getServer(),
    cluster: lc.info?.cluster,
    refreshInterval: Math.max(5000, cfg("dashboard.refreshInterval", 2000) * 5),
    thresholds: topologyThresholds(),
    health: healthLite(healthBus.get(lc.id)),
    state: s.manager.stateOf(lc.id).state,
  });
}

// Explorer nodes for system-account users: a "Servers" folder under each live connection
// (only when $SYS access is detected) listing every server from $SYS.REQ.SERVER.PING.
// Registered through treeHooks.registerConnectionChildren (src/admin/register.ts).

import * as vscode from "vscode";
import type { LiveConnection } from "../core/connectionManager";
import { fmtBytes, fmtMillis, fmtNumber } from "../shared/format";
import { pingServers, type ServerStatsMsg } from "../nats/system";
import { serverRowFromStatsz, serverTone, cpuFraction, type ServerRow } from "../admin/clusterModel";
import { CachedNode, MessageNode, NatsNode, md, nodeUri } from "./base";

export class ServersFolderNode extends CachedNode {
  private count?: number;
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    private readonly repaint: (n: NatsNode) => void,
  ) {
    super(connId, parent);
  }

  getTreeItem(): vscode.TreeItem {
    const ti = new vscode.TreeItem("Servers", vscode.TreeItemCollapsibleState.Collapsed);
    ti.id = `${this.connId}/servers`;
    ti.iconPath = new vscode.ThemeIcon("server-environment");
    ti.description = this.count !== undefined ? String(this.count) : undefined;
    ti.tooltip = md(["**Servers** — every server answering `$SYS.REQ.SERVER.PING`", "_Visible because this connection has system-account access._"]);
    ti.contextValue = "folder.servers";
    return ti;
  }

  protected async load(): Promise<NatsNode[]> {
    const stats = await pingServers(this.lc.nc, { maxWait: 1500 });
    if (this.count !== stats.length) {
      this.count = stats.length;
      setTimeout(() => this.repaint(this), 0);
    }
    if (!stats.length) return [new MessageNode(this.connId, this, "No server answered $SYS.REQ.SERVER.PING", "warning")];
    const connectedId = this.lc.info?.server_id;
    return stats.map((m) => new SysServerNode(this.connId, this, m, m.server.id === connectedId));
  }
}

export class SysServerNode extends NatsNode {
  readonly row: ServerRow;
  constructor(
    connId: string,
    parent: NatsNode,
    readonly stats: ServerStatsMsg,
    readonly connected: boolean,
  ) {
    super(connId, parent);
    this.row = serverRowFromStatsz(stats);
  }

  get serverId(): string {
    return this.stats.server.id;
  }

  get serverName(): string {
    return this.row.name;
  }

  getTreeItem(): vscode.TreeItem {
    const r = this.row;
    const ti = new vscode.TreeItem(r.name, vscode.TreeItemCollapsibleState.None);
    ti.id = `${this.connId}/sys-server/${r.id}`;
    ti.resourceUri = nodeUri(this.connId, `/sys-server/${r.id}`);
    const { tone, issues } = serverTone(r);
    const color = tone === "danger" ? "errorForeground" : tone === "warn" ? "editorWarning.foreground" : this.connected ? "testing.iconPassed" : undefined;
    ti.iconPath = new vscode.ThemeIcon(this.connected ? "vm-active" : "vm", color ? new vscode.ThemeColor(color) : undefined);
    const cpu = cpuFraction(r);
    ti.description = [`v${r.version}`, `${fmtNumber(r.connections)} conns`, r.cpu !== undefined ? `CPU ${r.cpu.toFixed(r.cpu < 10 ? 1 : 0)}%` : undefined].filter(Boolean).join(" · ");
    const js = r.js;
    ti.tooltip = md([
      `**${r.name}**${this.connected ? " — $(plug) connected here" : ""}${r.metaLeader ? " · $(star-full) JetStream meta leader" : ""}`,
      `\`${r.id}\``,
      `$(organization) cluster ${r.cluster ?? "—"}${r.domain ? ` · domain ${r.domain}` : ""} · v${r.version}`,
      r.uptimeMs !== undefined && `$(watch) up ${fmtMillis(r.uptimeMs)}`,
      `$(pulse) CPU ${r.cpu !== undefined ? `${r.cpu.toFixed(1)}%` : "–"}${cpu !== undefined ? ` (${Math.round(cpu * 100)}% of ${r.cores} cores)` : ""} · memory ${r.mem !== undefined ? fmtBytes(r.mem) : "–"}`,
      `$(plug) ${fmtNumber(r.connections)} connections · ${fmtNumber(r.subscriptions)} subscriptions${r.slowConsumers ? ` · $(warning) ${r.slowConsumers} slow consumers` : ""}`,
      `$(arrow-swap) ${r.routePeers.length} route peers${r.gateways.length ? ` · gateways ${r.gateways.join(", ")}` : ""}`,
      js && `$(database) JetStream memory ${fmtBytes(js.memory)} / ${fmtBytes(js.maxMemory)} · storage ${fmtBytes(js.storage)} / ${fmtBytes(js.maxStorage)}`,
      ...issues.map((i) => `$(warning) ${i}`),
      "_Click for details (VARZ · JSZ · HEALTHZ)_",
    ]);
    ti.contextValue = "sysServer";
    ti.command = { command: "nats.serverDetails", title: "Server Details", arguments: [this] };
    return ti;
  }
}

// The NATS explorer tree: connections → server, streams (→ consumers),
// Key-Value buckets (→ hierarchical keys), Object Stores (→ objects), services.

import * as vscode from "vscode";
import type { ConsumerInfo, StreamInfo } from "@nats-io/jetstream";
import type { ObjectInfo, ObjectStoreStatus } from "@nats-io/obj";
import type { ConnectionStore } from "../core/connectionStore";
import { type ConnectionManager, type ConnState, type LiveConnection } from "../core/connectionManager";
import { describeServers, ENVIRONMENTS, type ConnectionProfile } from "../core/profile";
import { credsInfo, expiryStatus } from "../core/creds";
import { cfg } from "../core/ui";
import { listConsumers, listStreams } from "../nats/streams";
import { listBuckets, listKeys } from "../nats/kv";
import { listObjBuckets, listObjects } from "../nats/obj";
import { discoverServices, type EndpointView, type ServiceView } from "../nats/services";
import { CachedNode, MessageNode, NatsNode, md, nodeUri } from "./base";
import { treeHooks } from "./hooks";
import { buildKeyTree, sortedChildren, type KeyTreeNode } from "../shared/keyTree";
import { fmtBytes, fmtCompact, fmtMillis, fmtNanos, fmtNumber } from "../shared/format";
import type { KvBucketDTO } from "../shared/dto";

type Ctx = {
  manager: ConnectionManager;
  store: ConnectionStore;
  explorer: NatsExplorer;
};

const ORIGIN_TAG: Record<NonNullable<ConnectionProfile["origin"]>, { short?: string; label: string; icon: string; ctx: string }> = {
  manual: { label: "Saved in VS Code", icon: "save", ctx: "manual" },
  "nats-context": { short: "ctx", label: "NATS CLI context", icon: "terminal", ctx: "ctx" },
  workspace: { short: "workspace", label: "Workspace setting nats.connections", icon: "folder", ctx: "ws" },
  env: { short: "env", label: "Environment (NATS_URL)", icon: "symbol-variable", ctx: "env" },
};

/** Cached creds expiry text per file (read asynchronously, then the node is repainted). */
const expiryCache = new Map<string, { text?: string; at: number }>();
function credsExpiryText(file: string, repaint: () => void): string | undefined {
  const hit = expiryCache.get(file);
  if (hit && Date.now() - hit.at < 300_000) return hit.text;
  if (!hit) {
    expiryCache.set(file, { at: Date.now() });
    void credsInfo(file).then((info) => {
      const exp = expiryStatus(info?.expires);
      const text = exp ? exp.text : info?.expires ? `credentials valid until ${info.expires.toLocaleString()}` : info ? "credentials do not expire" : undefined;
      expiryCache.set(file, { text, at: Date.now() });
      repaint();
    });
  }
  return hit?.text;
}

// --- connection -----------------------------------------------------------------

const STATE_ICON: Record<ConnState, [string, string | undefined]> = {
  connected: ["circle-filled", "testing.iconPassed"],
  connecting: ["loading~spin", undefined],
  reconnecting: ["sync~spin", "editorWarning.foreground"],
  error: ["error", "errorForeground"],
  disconnected: ["circle-outline", undefined],
};

export class ConnectionNode extends CachedNode {
  constructor(
    public profile: ConnectionProfile,
    private readonly ctx: Ctx,
  ) {
    super(profile.id, undefined);
  }

  get live(): LiveConnection | undefined {
    return this.ctx.manager.get(this.profile.id);
  }

  getTreeItem(): vscode.TreeItem {
    const p = this.profile;
    const { state, error } = this.ctx.manager.stateOf(p.id);
    const isLive = state === "connected" || state === "reconnecting";
    const ti = new vscode.TreeItem(p.name, isLive ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    // Different ids for live/offline so VS Code honours the new collapsible state.
    ti.id = `conn:${p.id}:${isLive ? "live" : "off"}`;
    ti.resourceUri = nodeUri(p.id, "/");
    const [icon, color] = STATE_ICON[state];
    ti.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    const info = this.live?.info;
    const active = this.ctx.manager.activeId === p.id && this.ctx.manager.connected().length > 1;
    const selected = this.ctx.store.isSelectedContext(p);
    const warning = this.ctx.store.warningFor(p.id);
    const env = ENVIRONMENTS.find((e) => e.id === p.environment);
    const tags = [
      env?.id === "prod" ? "PROD" : env?.id,
      p.readOnly ? "read-only" : undefined,
      ORIGIN_TAG[p.origin ?? "manual"].short,
    ].filter(Boolean);
    const status = state === "connected" && info ? `${info.server_name} · v${info.version}` : state === "disconnected" ? describeServers(p) : state;
    ti.description = `${active ? "● " : ""}${selected ? "★ " : ""}${tags.length ? `[${tags.join(" · ")}] ` : ""}${status}`;
    const expiry = p.auth.kind === "creds" && p.auth.credsFile ? credsExpiryText(p.auth.credsFile, () => explorerRef?.repaint(this)) : undefined;
    ti.tooltip = md([
      `**${p.name}** — ${state}${env ? ` · ${env.label}` : ""}${p.readOnly ? " · $(lock) read-only" : ""}`,
      p.description && `_${p.description}_`,
      `$(server) ${describeServers(p)}`,
      `$(key) auth: ${p.auth.kind}${p.auth.username ? ` (${p.auth.username})` : ""}${p.tls?.enabled ? " · TLS" : ""}${p.inboxPrefix ? ` · inbox ${p.inboxPrefix}` : ""}`,
      expiry && `$(watch) ${expiry}`,
      `$(${ORIGIN_TAG[p.origin ?? "manual"].icon}) ${ORIGIN_TAG[p.origin ?? "manual"].label}${p.contextFile ? ` — \`${p.contextFile}\`` : ""}${selected ? " · selected in the nats CLI" : ""}`,
      info && `$(info) ${info.server_name} v${info.version} · go ${info.go} · JetStream ${info.jetstream ? "on" : "off"}`,
      info?.cluster && `$(organization) cluster ${info.cluster}`,
      warning && `$(warning) ${warning}`,
      error && `$(error) ${error}`,
      state === "disconnected" && "_Click to connect_",
    ]);
    ti.contextValue = `connection.${state}.${ORIGIN_TAG[p.origin ?? "manual"].ctx}${p.readOnly ? ".ro" : ""}${env?.id === "prod" ? ".prod" : ""}`;
    if (!isLive && state !== "connecting") {
      ti.command = { command: "nats.connect", title: "Connect", arguments: [this] };
    }
    return ti;
  }

  protected async load(): Promise<NatsNode[]> {
    const lc = this.live;
    if (!lc) return [];
    const nodes: NatsNode[] = [new ServerNode(this.connId, this, lc)];
    if (await lc.hasJetStream()) {
      nodes.push(new StreamsFolder(this.connId, this, lc), new KvFolder(this.connId, this, lc), new ObjFolder(this.connId, this, lc));
    } else {
      nodes.push(new MessageNode(this.connId, this, "JetStream not available for this account", "circle-slash", undefined, "Streams, KV and Object Store require JetStream (nats-server -js)."));
    }
    nodes.push(new ServicesFolder(this.connId, this, lc));
    nodes.push(...(await treeHooks.connectionChildren({ connId: this.connId, parent: this, lc })));
    return nodes;
  }
}

export class ServerNode extends NatsNode {
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
  ) {
    super(connId, parent);
  }
  getTreeItem(): vscode.TreeItem {
    const info = this.lc.info;
    const ti = new vscode.TreeItem("Server", vscode.TreeItemCollapsibleState.None);
    ti.id = `${this.connId}/server`;
    ti.resourceUri = nodeUri(this.connId, "/server");
    ti.iconPath = new vscode.ThemeIcon("server-environment");
    ti.description = info ? `${this.lc.nc.getServer()}` : "";
    ti.tooltip = md([
      info && `**${info.server_name}** (${info.server_id.slice(0, 12)}…)`,
      info && `version ${info.version} · proto ${info.proto} · go ${info.go}`,
      info && `max payload ${fmtBytes(info.max_payload)}`,
      info?.cluster && `cluster ${info.cluster}`,
      info && `TLS ${info.tls_required ? "required" : "off"} · auth ${info.auth_required ? "required" : "off"}`,
      "_Click to open the server dashboard_",
    ]);
    ti.contextValue = "server";
    ti.command = { command: "nats.openDashboard", title: "Open Dashboard", arguments: [this] };
    return ti;
  }
}

// --- folders --------------------------------------------------------------------------

abstract class FolderNode extends CachedNode {
  protected count?: number;
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    readonly kind: "streams" | "kv" | "obj" | "services",
    private readonly label: string,
    private readonly icon: string,
  ) {
    super(connId, parent);
  }
  getTreeItem(): vscode.TreeItem {
    const ti = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
    ti.id = `${this.connId}/${this.kind}`;
    ti.iconPath = new vscode.ThemeIcon(this.icon);
    ti.description = this.count !== undefined ? String(this.count) : undefined;
    ti.contextValue = `folder.${this.kind}`;
    return ti;
  }
  protected setCount(n: number): void {
    if (this.count !== n) {
      this.count = n;
      // Update the label's count without refetching children.
      setTimeout(() => explorerRef?.repaint(this), 0);
    }
  }
}

let explorerRef: NatsExplorer | undefined;

export class StreamsFolder extends FolderNode {
  constructor(connId: string, parent: NatsNode, lc: LiveConnection) {
    super(connId, parent, lc, "streams", "Streams", "database");
  }
  protected async load(): Promise<NatsNode[]> {
    const jsm = await this.lc.jsm();
    const streams = await listStreams(jsm, cfg("explorer.showInternalStreams", false));
    this.setCount(streams.length);
    if (!streams.length) {
      return [new MessageNode(this.connId, this, "No streams — create one", "add", { command: "nats.createStream", title: "Create Stream", arguments: [this] })];
    }
    return streams.map((si) => new StreamNode(this.connId, this, this.lc, si));
  }
}

export class StreamNode extends CachedNode {
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    readonly info: StreamInfo,
  ) {
    super(connId, parent);
  }
  get name(): string {
    return this.info.config.name;
  }
  getTreeItem(): vscode.TreeItem {
    const { config: c, state: st } = this.info;
    const hasConsumers = st.consumer_count > 0;
    const ti = new vscode.TreeItem(c.name, hasConsumers || treeHooks.hasStreamChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    ti.id = `${this.connId}/stream/${c.name}`;
    ti.resourceUri = nodeUri(this.connId, `/stream/${c.name}`);
    ti.iconPath = new vscode.ThemeIcon(c.mirror ? "mirror" : c.sources?.length ? "merge" : "database");
    ti.description = `${fmtCompact(st.messages)} msgs · ${fmtBytes(st.bytes)}${hasConsumers ? ` · ${st.consumer_count} cons` : ""}`;
    ti.tooltip = md([
      `**${c.name}**${c.description ? ` — ${c.description}` : ""}`,
      `$(symbol-namespace) subjects: \`${(c.subjects ?? []).join("`, `") || "—"}\``,
      `retention **${c.retention}** · storage **${c.storage}** · replicas ${c.num_replicas} · discard ${c.discard}`,
      `messages ${fmtNumber(st.messages)} · ${fmtBytes(st.bytes)} · seq ${st.first_seq}…${st.last_seq}`,
      `limits: age ${fmtNanos(c.max_age)} · msgs ${c.max_msgs < 0 ? "∞" : fmtNumber(c.max_msgs)} · bytes ${fmtBytes(c.max_bytes)}`,
      c.mirror && `$(mirror) mirror of ${c.mirror.name}`,
      c.sealed && "$(lock) sealed",
      `created ${new Date(this.info.created).toLocaleString()}`,
    ]);
    ti.contextValue = "stream";
    return ti;
  }
  protected async load(): Promise<NatsNode[]> {
    const jsm = await this.lc.jsm();
    const [extra, consumers] = await Promise.all([
      treeHooks.streamChildren({ connId: this.connId, parent: this, lc: this.lc, info: this.info }),
      this.info.state.consumer_count > 0 ? listConsumers(jsm, this.name) : Promise.resolve([]),
    ]);
    return [...extra, ...consumers.map((ci) => new ConsumerNode(this.connId, this, this.lc, this.name, ci))];
  }
}

export class ConsumerNode extends NatsNode {
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    readonly stream: string,
    readonly info: ConsumerInfo,
  ) {
    super(connId, parent);
  }
  get name(): string {
    return this.info.name;
  }
  get isPush(): boolean {
    return Boolean(this.info.config.deliver_subject);
  }
  getTreeItem(): vscode.TreeItem {
    const ci = this.info;
    const c = ci.config;
    const ti = new vscode.TreeItem(ci.name, vscode.TreeItemCollapsibleState.None);
    ti.id = `${this.connId}/stream/${this.stream}/consumer/${ci.name}`;
    ti.resourceUri = nodeUri(this.connId, `/consumer/${this.stream}/${ci.name}`);
    const stalled = ci.num_ack_pending > 0 && ci.num_redelivered > 0;
    ti.iconPath = new vscode.ThemeIcon(this.isPush ? "arrow-circle-right" : "arrow-circle-down", stalled ? new vscode.ThemeColor("editorWarning.foreground") : undefined);
    ti.description = `${this.isPush ? "push" : "pull"} · pending ${fmtCompact(ci.num_pending)}${ci.num_ack_pending ? ` · unacked ${fmtCompact(ci.num_ack_pending)}` : ""}`;
    ti.tooltip = md([
      `**${ci.name}** (${this.isPush ? "push" : "pull"}${c.durable_name ? ", durable" : ", ephemeral"})${c.description ? ` — ${c.description}` : ""}`,
      c.filter_subject && `filter \`${c.filter_subject}\``,
      (c.filter_subjects?.length ?? 0) > 0 && `filters \`${c.filter_subjects!.join("`, `")}\``,
      `deliver **${c.deliver_policy}** · ack **${c.ack_policy}** · wait ${fmtNanos(c.ack_wait)} · max deliver ${c.max_deliver === -1 ? "∞" : c.max_deliver}`,
      `pending ${fmtNumber(ci.num_pending)} · ack pending ${fmtNumber(ci.num_ack_pending)} · redelivered ${fmtNumber(ci.num_redelivered)} · waiting ${fmtNumber(ci.num_waiting)}`,
      `delivered stream seq ${ci.delivered.stream_seq} · ack floor ${ci.ack_floor.stream_seq}`,
      c.deliver_subject && `deliver subject \`${c.deliver_subject}\``,
      ci.paused && "$(debug-pause) paused",
    ]);
    ti.contextValue = "consumer";
    ti.command = { command: "nats.consumerInfo", title: "Consumer Info", arguments: [this] };
    return ti;
  }
}

// --- Key-Value ---------------------------------------------------------------------------

export class KvFolder extends FolderNode {
  constructor(connId: string, parent: NatsNode, lc: LiveConnection) {
    super(connId, parent, lc, "kv", "Key-Value", "symbol-key");
  }
  protected async load(): Promise<NatsNode[]> {
    const buckets = await listBuckets(this.lc.kvm());
    this.setCount(buckets.length);
    if (!buckets.length) {
      return [new MessageNode(this.connId, this, "No KV buckets — create one", "add", { command: "nats.createKvBucket", title: "Create Bucket", arguments: [this] })];
    }
    return buckets.map((b) => new KvBucketNode(this.connId, this, this.lc, b));
  }
}

const kvFilters = new Map<string, string>();

export class KvBucketNode extends CachedNode {
  keyTree?: KeyTreeNode;
  truncated = false;
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    readonly bucket: KvBucketDTO,
  ) {
    super(connId, parent);
  }
  get name(): string {
    return this.bucket.bucket;
  }
  get filter(): string | undefined {
    return kvFilters.get(`${this.connId}/${this.name}`);
  }
  set filter(f: string | undefined) {
    if (f) kvFilters.set(`${this.connId}/${this.name}`, f);
    else kvFilters.delete(`${this.connId}/${this.name}`);
  }
  get separator(): string {
    return cfg("kv.keySeparator", ".");
  }
  getTreeItem(): vscode.TreeItem {
    const b = this.bucket;
    const ti = new vscode.TreeItem(b.bucket, vscode.TreeItemCollapsibleState.Collapsed);
    ti.id = `${this.connId}/kv/${b.bucket}`;
    ti.resourceUri = nodeUri(this.connId, `/kv/${b.bucket}`);
    ti.iconPath = new vscode.ThemeIcon("database");
    const f = this.filter;
    ti.description = `${f ? `filter: ${f} · ` : ""}${fmtCompact(b.values)} vals · ${fmtBytes(b.bytes)}`;
    ti.tooltip = md([
      `**${b.bucket}**${b.description ? ` — ${b.description}` : ""}`,
      `history ${b.history} · TTL ${b.ttlMs ? fmtMillis(b.ttlMs) : "∞"} · storage ${b.storage} · replicas ${b.replicas}`,
      `${fmtNumber(b.values)} stored values (incl. history) · ${fmtBytes(b.bytes)}`,
      f && `$(filter) key filter \`${f}\``,
    ]);
    ti.contextValue = f ? "kvBucket.filtered" : "kvBucket";
    return ti;
  }
  protected async load(): Promise<NatsNode[]> {
    const kv = await this.lc.kvm().open(this.name);
    const max = cfg("kv.maxKeys", 5000);
    const { keys, truncated } = await listKeys(kv, this.filter, max);
    this.truncated = truncated;
    this.keyTree = buildKeyTree(keys, this.separator);
    const nodes: NatsNode[] = sortedChildren(this.keyTree).map((n) => new KvKeyNode(this.connId, this, this, n));
    if (!keys.length) {
      nodes.push(
        new MessageNode(this.connId, this, this.filter ? `No keys match "${this.filter}"` : "Empty bucket — add a key", this.filter ? "filter" : "add", {
          command: this.filter ? "nats.kvFilterKeys" : "nats.kvAddKey",
          title: "",
          arguments: [this],
        }),
      );
    }
    if (truncated) {
      nodes.push(
        new MessageNode(this.connId, this, `Showing first ${max} keys — refine with a filter or open the KV Browser`, "warning", {
          command: "nats.openKvBrowser",
          title: "Open KV Browser",
          arguments: [this],
        }),
      );
    }
    return nodes;
  }
}

/** A key, a folder (key prefix), or both (e.g. "app.db" when "app.db.host" also exists). */
export class KvKeyNode extends NatsNode {
  constructor(
    connId: string,
    parent: NatsNode,
    readonly bucketNode: KvBucketNode,
    readonly node: KeyTreeNode,
  ) {
    super(connId, parent);
  }
  get bucket(): string {
    return this.bucketNode.name;
  }
  get key(): string {
    return this.node.path;
  }
  get isFolder(): boolean {
    return this.node.children.size > 0;
  }
  getTreeItem(): vscode.TreeItem {
    const n = this.node;
    const ti = new vscode.TreeItem(n.name || "(empty token)", this.isFolder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    ti.id = `${this.connId}/kv/${this.bucket}/k/${n.path}`;
    if (this.isFolder) {
      ti.iconPath = new vscode.ThemeIcon(n.isKey ? "symbol-object" : "folder");
      ti.description = `${n.count} key${n.count === 1 ? "" : "s"}${n.isKey ? " · has value" : ""}`;
      ti.contextValue = n.isKey ? "kvKeyFolder" : "kvFolder";
    } else {
      ti.iconPath = new vscode.ThemeIcon("symbol-field");
      ti.contextValue = "kvKey";
    }
    ti.tooltip = md([`\`${n.path}\``, this.isFolder ? `${n.count} keys under this prefix` : undefined, n.isKey ? "_Click to open the value_" : undefined]);
    if (n.isKey) ti.command = { command: "nats.kvOpenKey", title: "Open Value", arguments: [this] };
    return ti;
  }
  override async getChildren(): Promise<NatsNode[]> {
    return sortedChildren(this.node).map((c) => new KvKeyNode(this.connId, this, this.bucketNode, c));
  }
}

// --- Object Store -------------------------------------------------------------------------

export class ObjFolder extends FolderNode {
  constructor(connId: string, parent: NatsNode, lc: LiveConnection) {
    super(connId, parent, lc, "obj", "Object Store", "files");
  }
  protected async load(): Promise<NatsNode[]> {
    const buckets = await listObjBuckets(this.lc.objm());
    this.setCount(buckets.length);
    if (!buckets.length) {
      return [new MessageNode(this.connId, this, "No object stores — create one", "add", { command: "nats.createObjBucket", title: "Create Bucket", arguments: [this] })];
    }
    return buckets.map((b) => new ObjBucketNode(this.connId, this, this.lc, b));
  }
}

export class ObjBucketNode extends CachedNode {
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    readonly status: ObjectStoreStatus,
  ) {
    super(connId, parent);
  }
  get name(): string {
    return this.status.bucket;
  }
  getTreeItem(): vscode.TreeItem {
    const s = this.status;
    const ti = new vscode.TreeItem(s.bucket, vscode.TreeItemCollapsibleState.Collapsed);
    ti.id = `${this.connId}/obj/${s.bucket}`;
    ti.resourceUri = nodeUri(this.connId, `/obj/${s.bucket}`);
    ti.iconPath = new vscode.ThemeIcon(s.sealed ? "lock" : "archive");
    ti.description = fmtBytes(s.size);
    ti.tooltip = md([
      `**${s.bucket}**${s.description ? ` — ${s.description}` : ""}`,
      `storage ${s.storage} · replicas ${s.replicas} · TTL ${fmtNanos(s.ttl)}${s.sealed ? " · sealed" : ""}${s.compression ? " · compressed" : ""}`,
      `${fmtBytes(s.size)} stored`,
    ]);
    ti.contextValue = "objBucket";
    return ti;
  }
  protected async load(): Promise<NatsNode[]> {
    const os = await this.lc.objm().open(this.name);
    const objects = await listObjects(os);
    if (!objects.length) {
      return [new MessageNode(this.connId, this, "Empty — upload a file", "cloud-upload", { command: "nats.objUpload", title: "Upload", arguments: [this] })];
    }
    return objects.map((o) => new ObjectNode(this.connId, this, this.lc, this.name, o));
  }
}

export class ObjectNode extends NatsNode {
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    readonly bucket: string,
    readonly info: ObjectInfo,
  ) {
    super(connId, parent);
  }
  get name(): string {
    return this.info.name;
  }
  getTreeItem(): vscode.TreeItem {
    const o = this.info;
    const ti = new vscode.TreeItem(o.name, vscode.TreeItemCollapsibleState.None);
    ti.id = `${this.connId}/obj/${this.bucket}/o/${o.name}`;
    ti.resourceUri = vscode.Uri.parse(`nats-obj-icon:/${encodeURIComponent(o.name.split("/").pop() ?? o.name)}`);
    ti.iconPath = o.options?.link ? new vscode.ThemeIcon("link") : vscode.ThemeIcon.File;
    ti.description = `${fmtBytes(o.size)}`;
    ti.tooltip = md([
      `**${o.name}**${o.description ? ` — ${o.description}` : ""}`,
      `${fmtBytes(o.size)} in ${o.chunks} chunk${o.chunks === 1 ? "" : "s"}`,
      `modified ${new Date(o.mtime).toLocaleString()}`,
      o.digest && `digest \`${o.digest}\``,
    ]);
    ti.contextValue = "object";
    ti.command = { command: "nats.objOpen", title: "Open", arguments: [this] };
    return ti;
  }
}

// --- services ------------------------------------------------------------------------------

export class ServicesFolder extends FolderNode {
  constructor(connId: string, parent: NatsNode, lc: LiveConnection) {
    super(connId, parent, lc, "services", "Services", "symbol-interface");
  }
  protected async load(): Promise<NatsNode[]> {
    const services = await discoverServices(this.lc.svcm(), 1500);
    this.setCount(services.length);
    if (!services.length) {
      return [new MessageNode(this.connId, this, "No micro-services responded to $SRV.INFO", "info", undefined, "Only services built with the NATS micro-services framework register on $SRV.")];
    }
    return services.map((s) => new ServiceNode(this.connId, this, this.lc, s));
  }
}

export class ServiceNode extends NatsNode {
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    readonly service: ServiceView,
  ) {
    super(connId, parent);
  }
  getTreeItem(): vscode.TreeItem {
    const s = this.service;
    const ti = new vscode.TreeItem(s.name, s.endpoints.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    ti.id = `${this.connId}/svc/${s.name}`;
    ti.resourceUri = nodeUri(this.connId, `/service/${s.name}`);
    ti.iconPath = new vscode.ThemeIcon("symbol-method");
    ti.description = `v${s.versions.join(", v")} · ${s.instances.length} instance${s.instances.length === 1 ? "" : "s"}`;
    ti.tooltip = md([
      `**${s.name}**${s.description ? ` — ${s.description}` : ""}`,
      ...s.instances.map((i) => `$(vm) \`${i.id}\` v${i.version}${i.started ? ` · started ${new Date(i.started).toLocaleString()}` : ""}`),
    ]);
    ti.contextValue = "service";
    return ti;
  }
  override async getChildren(): Promise<NatsNode[]> {
    return this.service.endpoints.map((e) => new ServiceEndpointNode(this.connId, this, this.lc, this.service, e));
  }
}

export class ServiceEndpointNode extends NatsNode {
  constructor(
    connId: string,
    parent: NatsNode,
    readonly lc: LiveConnection,
    readonly service: ServiceView,
    readonly endpoint: EndpointView,
  ) {
    super(connId, parent);
  }
  getTreeItem(): vscode.TreeItem {
    const e = this.endpoint;
    const ti = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.None);
    ti.id = `${this.connId}/svc/${this.service.name}/ep/${e.name}/${e.subject}`;
    ti.iconPath = new vscode.ThemeIcon("symbol-event", e.numErrors ? new vscode.ThemeColor("editorWarning.foreground") : undefined);
    ti.description = `${e.subject}${e.numRequests !== undefined ? ` · ${fmtCompact(e.numRequests)} req` : ""}${e.numErrors ? ` · ${e.numErrors} err` : ""}`;
    ti.tooltip = md([
      `**${e.name}** → \`${e.subject}\``,
      e.queueGroup && `queue group \`${e.queueGroup}\``,
      e.numRequests !== undefined && `requests ${fmtNumber(e.numRequests)} · errors ${fmtNumber(e.numErrors ?? 0)}`,
      e.averageProcessingTimeNs !== undefined && `avg processing ${fmtNanos(e.averageProcessingTimeNs)}`,
      e.lastError && `$(error) last error: ${e.lastError}`,
      "_Use the inline action to send a request_",
    ]);
    ti.contextValue = "serviceEndpoint";
    return ti;
  }
}

// --- provider -------------------------------------------------------------------------------

export class NatsExplorer implements vscode.TreeDataProvider<NatsNode>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<NatsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly connNodes = new Map<string, ConnectionNode>();
  private readonly disposables: vscode.Disposable[] = [];
  view?: vscode.TreeView<NatsNode>;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
  ) {
    explorerRef = this;
    this.disposables.push(
      // Profile changes affect labels / root membership only: repaint, keep loaded children.
      store.onDidChange(() => this._onDidChange.fire(undefined)),
      manager.onDidChangeState(({ profileId }) => {
        const node = this.connNodes.get(profileId);
        node?.invalidate();
        this._onDidChange.fire(node);
      }),
      manager.onDidChangeActive(() => this._onDidChange.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nats.explorer") || e.affectsConfiguration("nats.kv")) this.refresh();
      }),
    );
  }

  getTreeItem(node: NatsNode): vscode.TreeItem {
    return node.getTreeItem();
  }

  getParent(node: NatsNode): NatsNode | undefined {
    return node.parent;
  }

  async getChildren(node?: NatsNode): Promise<NatsNode[]> {
    if (node) return node.getChildren();
    const profiles = [...this.store.list()].sort((a, b) => a.name.localeCompare(b.name));
    const next = new Map<string, ConnectionNode>();
    for (const p of profiles) {
      const existing = this.connNodes.get(p.id);
      // Reuse nodes so cached children (and targeted refreshes) survive re-renders.
      if (existing) existing.profile = p;
      next.set(p.id, existing ?? new ConnectionNode(p, { manager: this.manager, store: this.store, explorer: this }));
    }
    this.connNodes.clear();
    for (const [k, v] of next) this.connNodes.set(k, v);
    return [...next.values()];
  }

  /** Refetch a node's children (or everything). */
  refresh(node?: NatsNode): void {
    if (!node) {
      for (const n of this.connNodes.values()) n.invalidate();
      this.connNodes.clear();
    } else {
      node.invalidate();
    }
    this._onDidChange.fire(node);
  }

  /** Re-render a node's label without refetching its children. */
  repaint(node: NatsNode): void {
    this._onDidChange.fire(node);
  }

  connectionNode(profileId: string): ConnectionNode | undefined {
    return this.connNodes.get(profileId);
  }

  /** Refresh the folder of the given kind under a connection (after create/delete). */
  refreshFolder(connId: string, kind: "streams" | "kv" | "obj" | "services"): void {
    const conn = this.connNodes.get(connId);
    if (!conn) return;
    void conn.getChildren().then((children) => {
      const folder = children.find((c) => c instanceof FolderNode && c.kind === kind);
      if (folder) this.refresh(folder);
      else this.refresh(conn);
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}

export { FolderNode, NatsNode, MessageNode, CachedNode };

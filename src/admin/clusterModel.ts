// Cluster overview model: the snapshot DTO sent to webview/cluster.tsx, conversions from
// $SYS statsz / routez / gatewayz / leafz / healthz and HTTP /varz, totals, per-second
// rates, server health tones and the cluster-diagram layout. Pure (no vscode / node / DOM):
// shared by the host (src/admin/clusterData.ts) and the webview, unit tested.

import {
  parseGoDuration,
  summarizePermissions,
  uptimeMs,
  type Gatewayz,
  type Healthz,
  type Leafz,
  type PermissionSummary,
  type Routez,
  type ServerStatsMsg,
  type SysEnvelope,
  type UserInfo,
} from "../nats/system";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

/** system: $SYS statsz of every server · monitor: HTTP monitoring of the connected server · basic: INFO only. */
export type ClusterMode = "system" | "monitor" | "basic";

export interface JsUsage {
  memory: number;
  storage: number;
  maxMemory: number;
  maxStorage: number;
  reservedMemory?: number;
  reservedStorage?: number;
  accounts?: number;
  haAssets?: number;
  apiTotal?: number;
  apiErrors?: number;
}

export interface ServerRow {
  id: string;
  name: string;
  host?: string;
  cluster?: string;
  domain?: string;
  version: string;
  jetstream: boolean;
  tags?: string[];
  start?: string;
  uptimeMs?: number;
  /** Process CPU in % of one core (can exceed 100 on multi-core hosts). */
  cpu?: number;
  cores?: number;
  /** Resident memory in bytes. */
  mem?: number;
  connections?: number;
  totalConnections?: number;
  subscriptions?: number;
  slowConsumers?: number;
  activeAccounts?: number;
  /** Cumulative counters (rates are computed in the webview). */
  inMsgs?: number;
  outMsgs?: number;
  inBytes?: number;
  outBytes?: number;
  /** Unique route peers (server names). */
  routePeers: string[];
  /** Remote gateway (cluster) names. */
  gateways: string[];
  leafs?: number;
  js?: JsUsage;
  health?: { status: "ok" | "error" | "unknown"; detail?: string };
  metaLeader?: boolean;
  /** The server this client is connected to. */
  connected?: boolean;
  /** Known only by reference (a route peer seen from the connected server's monitoring endpoint). */
  ghost?: boolean;
}

export interface RouteRow {
  serverId: string;
  serverName: string;
  remoteId?: string;
  remoteName?: string;
  ip?: string;
  port?: number;
  rttMs?: number;
  uptime?: string;
  /** Pooled connections to this peer. */
  connections: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
  pending: number;
  subscriptions: number;
  compression?: string;
  solicited?: boolean;
}

export interface GatewayRow {
  serverId: string;
  serverName: string;
  cluster?: string;
  remote: string;
  direction: "outbound" | "inbound";
  ip?: string;
  port?: number;
  rttMs?: number;
  uptime?: string;
  inMsgs?: number;
  outMsgs?: number;
  inBytes?: number;
  outBytes?: number;
  configured?: boolean;
}

export interface LeafRow {
  serverId: string;
  serverName: string;
  name?: string;
  account?: string;
  ip?: string;
  port?: number;
  rttMs?: number;
  isSpoke?: boolean;
  inMsgs?: number;
  outMsgs?: number;
  subscriptions?: number;
  compression?: string;
}

export interface WhoAmIView {
  available: boolean;
  user?: string;
  account?: string;
  accountName?: string;
  permissions: PermissionSummary;
  expires?: string;
  server?: string;
}

export interface ClusterSnapshot {
  at: number;
  mode: ClusterMode;
  connectedServerId?: string;
  connectedServerName?: string;
  connectedUrl?: string;
  rttMs?: number;
  servers: ServerRow[];
  /** active_servers reported by statsz (servers that should answer). */
  expectedServers?: number;
  routes: RouteRow[];
  gateways: GatewayRow[];
  leafs: LeafRow[];
  /** When routes / gateways / leafs / health were fetched. */
  topologyAt?: number;
  meta?: { leader?: string; clusterSize?: number; name?: string };
  monitorUrl?: string;
  monitorError?: string;
  /** Why the system view is unavailable (shown with the explanation). */
  sysNote?: string;
  user?: WhoAmIView;
}

// ---------------------------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------------------------

function jsFrom(js: { config?: { max_memory?: number; max_storage?: number }; stats?: { memory?: number; storage?: number; reserved_memory?: number; reserved_storage?: number; accounts?: number; ha_assets?: number; api?: { total?: number; errors?: number } } } | undefined): JsUsage | undefined {
  if (!js || (!js.config && !js.stats)) return undefined;
  return {
    memory: js.stats?.memory ?? 0,
    storage: js.stats?.storage ?? 0,
    maxMemory: js.config?.max_memory ?? 0,
    maxStorage: js.config?.max_storage ?? 0,
    reservedMemory: js.stats?.reserved_memory,
    reservedStorage: js.stats?.reserved_storage,
    accounts: js.stats?.accounts,
    haAssets: js.stats?.ha_assets,
    apiTotal: js.stats?.api?.total,
    apiErrors: js.stats?.api?.errors,
  };
}

export function serverRowFromStatsz(m: ServerStatsMsg, now = Date.now()): ServerRow {
  const s = m.statsz;
  const peers = new Set<string>();
  for (const r of s.routes ?? []) if (r.name) peers.add(r.name);
  const gws = new Set<string>();
  for (const g of s.gateways ?? []) if (g.name) gws.add(g.name);
  return {
    id: m.server.id,
    name: m.server.name || m.server.id,
    host: m.server.host,
    cluster: m.server.cluster || undefined,
    domain: m.server.domain || undefined,
    version: m.server.ver,
    jetstream: !!m.server.jetstream,
    tags: m.server.tags?.length ? m.server.tags : undefined,
    start: s.start,
    uptimeMs: uptimeMs(s.start, now),
    cpu: s.cpu,
    cores: s.cores,
    mem: s.mem,
    connections: s.connections,
    totalConnections: s.total_connections,
    subscriptions: s.subscriptions,
    slowConsumers: s.slow_consumers,
    activeAccounts: s.active_accounts,
    inMsgs: s.received?.msgs,
    outMsgs: s.sent?.msgs,
    inBytes: s.received?.bytes,
    outBytes: s.sent?.bytes,
    routePeers: [...peers].sort(),
    gateways: [...gws].sort(),
    js: m.server.jetstream ? jsFrom(s.jetstream) : undefined,
    metaLeader: !!s.jetstream?.meta?.leader && s.jetstream.meta.leader === (m.server.name || m.server.id),
  };
}

/** Subset of /varz used by the monitoring fallback. */
export interface VarzLike {
  server_id: string;
  server_name?: string;
  version: string;
  host?: string;
  start?: string;
  now?: string;
  uptime?: string;
  cpu?: number;
  cores?: number;
  mem?: number;
  connections?: number;
  total_connections?: number;
  subscriptions?: number;
  slow_consumers?: number;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  leafnodes?: number;
  cluster?: { name?: string };
  gateway?: { name?: string };
  tags?: string[];
  jetstream?: { config?: { max_memory?: number; max_storage?: number; domain?: string }; stats?: { memory?: number; storage?: number }; meta?: { leader?: string; cluster_size?: number; name?: string } };
}

export function serverRowFromVarz(v: VarzLike, now = Date.now()): ServerRow {
  const name = v.server_name || v.server_id;
  return {
    id: v.server_id,
    name,
    host: v.host,
    cluster: v.cluster?.name || undefined,
    domain: v.jetstream?.config?.domain || undefined,
    version: v.version,
    jetstream: !!v.jetstream?.config,
    tags: v.tags?.length ? v.tags : undefined,
    start: v.start,
    uptimeMs: uptimeMs(v.start, v.now ? Date.parse(v.now) || now : now) ?? parseGoDuration(v.uptime),
    cpu: v.cpu,
    cores: v.cores,
    mem: v.mem,
    connections: v.connections,
    totalConnections: v.total_connections,
    subscriptions: v.subscriptions,
    slowConsumers: v.slow_consumers,
    inMsgs: v.in_msgs,
    outMsgs: v.out_msgs,
    inBytes: v.in_bytes,
    outBytes: v.out_bytes,
    leafs: v.leafnodes,
    routePeers: [],
    gateways: [],
    js: jsFrom(v.jetstream),
    metaLeader: !!v.jetstream?.meta?.leader && v.jetstream.meta.leader === name,
  };
}

/** Pooled route connections are merged per (server, peer). */
export function routesFromRoutez(list: { server: { id: string; name: string }; data?: Routez }[]): RouteRow[] {
  const out = new Map<string, RouteRow>();
  for (const env of list) {
    for (const r of env.data?.routes ?? []) {
      const peer = r.remote_id ?? r.remote_name ?? `${r.ip}:${r.port}`;
      const key = `${env.server.id}|${peer}`;
      const rtt = parseGoDuration(r.rtt);
      const row = out.get(key);
      if (!row) {
        out.set(key, {
          serverId: env.server.id,
          serverName: env.server.name,
          remoteId: r.remote_id,
          remoteName: r.remote_name,
          ip: r.ip,
          port: r.port,
          rttMs: rtt,
          uptime: r.uptime,
          connections: 1,
          inMsgs: r.in_msgs ?? 0,
          outMsgs: r.out_msgs ?? 0,
          inBytes: r.in_bytes ?? 0,
          outBytes: r.out_bytes ?? 0,
          pending: r.pending_size ?? 0,
          subscriptions: r.subscriptions ?? 0,
          compression: r.compression,
          solicited: r.did_solicit,
        });
      } else {
        row.connections++;
        row.inMsgs += r.in_msgs ?? 0;
        row.outMsgs += r.out_msgs ?? 0;
        row.inBytes += r.in_bytes ?? 0;
        row.outBytes += r.out_bytes ?? 0;
        row.pending += r.pending_size ?? 0;
        row.subscriptions += r.subscriptions ?? 0;
        if (rtt !== undefined) row.rttMs = row.rttMs === undefined ? rtt : Math.min(row.rttMs, rtt);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.serverName.localeCompare(b.serverName, undefined, { numeric: true }) || (a.remoteName ?? "").localeCompare(b.remoteName ?? "", undefined, { numeric: true }));
}

export function gatewaysFromGatewayz(list: { server: { id: string; name: string; cluster?: string }; data?: Gatewayz }[]): GatewayRow[] {
  const out: GatewayRow[] = [];
  for (const env of list) {
    const d = env.data;
    if (!d) continue;
    for (const [remote, gw] of Object.entries(d.outbound_gateways ?? {})) {
      const c = gw.connection;
      out.push({ serverId: env.server.id, serverName: env.server.name, cluster: env.server.cluster ?? d.name, remote, direction: "outbound", ip: c?.ip, port: c?.port, rttMs: parseGoDuration(c?.rtt), uptime: c?.uptime, inMsgs: c?.in_msgs, outMsgs: c?.out_msgs, inBytes: c?.in_bytes, outBytes: c?.out_bytes, configured: gw.configured });
    }
    for (const [remote, conns] of Object.entries(d.inbound_gateways ?? {})) {
      for (const gw of conns ?? []) {
        const c = gw.connection;
        out.push({ serverId: env.server.id, serverName: env.server.name, cluster: env.server.cluster ?? d.name, remote, direction: "inbound", ip: c?.ip, port: c?.port, rttMs: parseGoDuration(c?.rtt), uptime: c?.uptime, inMsgs: c?.in_msgs, outMsgs: c?.out_msgs, inBytes: c?.in_bytes, outBytes: c?.out_bytes, configured: gw.configured });
      }
    }
  }
  return out.sort((a, b) => a.serverName.localeCompare(b.serverName, undefined, { numeric: true }) || a.remote.localeCompare(b.remote) || a.direction.localeCompare(b.direction));
}

export function leafsFromLeafz(list: { server: { id: string; name: string }; data?: Leafz }[]): LeafRow[] {
  const out: LeafRow[] = [];
  for (const env of list)
    for (const l of env.data?.leafs ?? [])
      out.push({ serverId: env.server.id, serverName: env.server.name, name: l.name, account: l.account, ip: l.ip, port: l.port, rttMs: parseGoDuration(l.rtt), isSpoke: l.is_spoke, inMsgs: l.in_msgs, outMsgs: l.out_msgs, subscriptions: l.subscriptions, compression: l.compression });
  return out.sort((a, b) => a.serverName.localeCompare(b.serverName, undefined, { numeric: true }) || (a.name ?? "").localeCompare(b.name ?? ""));
}

export function healthFrom(h: Healthz | undefined): ServerRow["health"] {
  if (!h) return { status: "unknown" };
  const ok = h.status === "ok" || h.status_code === 200;
  const detail = h.error || h.errors?.map((e) => e.error ?? e.type).filter(Boolean).join("; ") || (ok ? undefined : h.status);
  return { status: ok ? "ok" : "error", detail };
}

export function applyHealth(rows: ServerRow[], list: SysEnvelope<Healthz>[]): void {
  const byId = new Map(list.map((e) => [e.server.id, e]));
  for (const r of rows) {
    const env = byId.get(r.id);
    if (!env) continue;
    r.health = env.error ? { status: "error", detail: env.error.description } : healthFrom(env.data);
  }
}

export function whoAmIView(info: UserInfo | undefined, now = Date.now()): WhoAmIView {
  if (!info) return { available: false, permissions: summarizePermissions(undefined) };
  return {
    available: true,
    user: info.user,
    account: info.account,
    accountName: info.account_name && info.account_name !== info.account ? info.account_name : undefined,
    permissions: summarizePermissions(info.permissions),
    expires: userExpiry(info.expires, now),
    server: info.server?.name,
  };
}

/** USER.INFO `expires` is a Go duration in ns until the credentials expire (0 / absent = never). */
export function userExpiry(expires: number | string | undefined, now = Date.now()): string | undefined {
  if (expires === undefined || expires === "" || expires === 0) return undefined;
  if (typeof expires === "number") return Number.isFinite(expires) && expires > 0 ? new Date(now + expires / 1e6).toISOString() : undefined;
  const t = Date.parse(expires);
  return Number.isFinite(t) ? new Date(t).toISOString() : expires;
}

// ---------------------------------------------------------------------------------------------
// Totals, rates, tones
// ---------------------------------------------------------------------------------------------

export interface ClusterTotals {
  servers: number;
  clusters: string[];
  versions: string[];
  connections: number;
  subscriptions: number;
  slowConsumers: number;
  jsServers: number;
  jsMemory: number;
  jsStorage: number;
  jsMaxMemory: number;
  jsMaxStorage: number;
  healthy: number;
  unhealthy: number;
  unknownHealth: number;
  memory: number;
  maxCpuPct: number;
}

export function clusterTotals(rows: readonly ServerRow[]): ClusterTotals {
  const real = rows.filter((r) => !r.ghost);
  const sum = (f: (r: ServerRow) => number | undefined) => real.reduce((s, r) => s + (f(r) ?? 0), 0);
  return {
    servers: real.length,
    clusters: [...new Set(real.map((r) => r.cluster ?? "").filter(Boolean))].sort(),
    versions: [...new Set(real.map((r) => r.version).filter(Boolean))].sort(),
    connections: sum((r) => r.connections),
    subscriptions: sum((r) => r.subscriptions),
    slowConsumers: sum((r) => r.slowConsumers),
    jsServers: real.filter((r) => r.js).length,
    jsMemory: sum((r) => r.js?.memory),
    jsStorage: sum((r) => r.js?.storage),
    jsMaxMemory: sum((r) => r.js?.maxMemory),
    jsMaxStorage: sum((r) => r.js?.maxStorage),
    healthy: real.filter((r) => r.health?.status === "ok").length,
    unhealthy: real.filter((r) => r.health?.status === "error").length,
    unknownHealth: real.filter((r) => !r.health || r.health.status === "unknown").length,
    memory: sum((r) => r.mem),
    maxCpuPct: Math.max(0, ...real.map((r) => (r.cpu ?? 0) / Math.max(1, r.cores ?? 1))),
  };
}

export interface CounterSample {
  at: number;
  counters: Record<string, { inMsgs?: number; outMsgs?: number; inBytes?: number; outBytes?: number }>;
}

export interface Rates {
  inMsgs: number | null;
  outMsgs: number | null;
  inBytes: number | null;
  outBytes: number | null;
}

/**
 * Per-second rates per server between two samples. A counter that went down (restart / failover)
 * or a server missing from the previous sample yields null for that server.
 */
export function computeRates(prev: CounterSample | undefined, cur: CounterSample): { perServer: Record<string, Rates>; total: Rates } | undefined {
  if (!prev) return undefined;
  const dt = (cur.at - prev.at) / 1000;
  if (!(dt > 0)) return undefined;
  const perServer: Record<string, Rates> = {};
  const total: Rates = { inMsgs: 0, outMsgs: 0, inBytes: 0, outBytes: 0 };
  let any = false;
  const keys: (keyof Rates)[] = ["inMsgs", "outMsgs", "inBytes", "outBytes"];
  for (const [id, c] of Object.entries(cur.counters)) {
    const p = prev.counters[id];
    const r: Rates = { inMsgs: null, outMsgs: null, inBytes: null, outBytes: null };
    for (const k of keys) {
      const a = p?.[k];
      const b = c[k];
      if (typeof a === "number" && typeof b === "number" && b >= a) {
        r[k] = (b - a) / dt;
        total[k] = (total[k] ?? 0) + r[k]!;
        any = true;
      }
    }
    perServer[id] = r;
  }
  if (!any) for (const k of keys) total[k] = null;
  return { perServer, total };
}

export function counterSample(at: number, rows: readonly ServerRow[]): CounterSample {
  const counters: CounterSample["counters"] = {};
  for (const r of rows) if (!r.ghost) counters[r.id] = { inMsgs: r.inMsgs, outMsgs: r.outMsgs, inBytes: r.inBytes, outBytes: r.outBytes };
  return { at, counters };
}

export interface ServerThresholds {
  /** CPU as a fraction of all cores. */
  cpuWarn: number;
  cpuDanger: number;
  /** JetStream storage / memory usage fraction. */
  jsWarn: number;
  jsDanger: number;
}

export const DEFAULT_SERVER_THRESHOLDS: ServerThresholds = { cpuWarn: 0.75, cpuDanger: 0.9, jsWarn: 0.8, jsDanger: 0.95 };

export function cpuFraction(r: Pick<ServerRow, "cpu" | "cores">): number | undefined {
  if (r.cpu === undefined) return undefined;
  return r.cpu / 100 / Math.max(1, r.cores ?? 1);
}

/** Server status from health, slow consumers, CPU and JetStream usage (reasons included). */
export function serverTone(r: ServerRow, t: ServerThresholds = DEFAULT_SERVER_THRESHOLDS): { tone: Tone; issues: string[] } {
  if (r.ghost) return { tone: "neutral", issues: ["Known only as a route peer of the connected server"] };
  const issues: string[] = [];
  let tone: Tone = r.health?.status === "ok" ? "ok" : "neutral";
  const bump = (to: Tone) => {
    const rank: Record<Tone, number> = { neutral: 0, info: 0, ok: 1, warn: 2, danger: 3 };
    if (rank[to] > rank[tone]) tone = to;
  };
  if (r.health?.status === "error") {
    bump("danger");
    issues.push(`Health check failed${r.health.detail ? `: ${r.health.detail}` : ""}`);
  }
  if ((r.slowConsumers ?? 0) > 0) {
    bump("warn");
    issues.push(`${r.slowConsumers} slow consumer${r.slowConsumers === 1 ? "" : "s"}`);
  }
  const cpu = cpuFraction(r);
  if (cpu !== undefined) {
    if (cpu >= t.cpuDanger) {
      bump("danger");
      issues.push(`CPU at ${Math.round(cpu * 100)}% of ${r.cores ?? 1} cores`);
    } else if (cpu >= t.cpuWarn) {
      bump("warn");
      issues.push(`CPU at ${Math.round(cpu * 100)}% of ${r.cores ?? 1} cores`);
    }
  }
  if (r.js) {
    const st = r.js.maxStorage > 0 ? r.js.storage / r.js.maxStorage : 0;
    const mem = r.js.maxMemory > 0 ? r.js.memory / r.js.maxMemory : 0;
    const u = Math.max(st, mem);
    if (u >= t.jsDanger) {
      bump("danger");
      issues.push(`JetStream ${st >= mem ? "storage" : "memory"} at ${Math.round(u * 100)}%`);
    } else if (u >= t.jsWarn) {
      bump("warn");
      issues.push(`JetStream ${st >= mem ? "storage" : "memory"} at ${Math.round(u * 100)}%`);
    }
  }
  if (tone === "neutral" && r.cpu !== undefined) tone = "ok";
  return { tone, issues };
}

// ---------------------------------------------------------------------------------------------
// Cluster diagram
// ---------------------------------------------------------------------------------------------

export interface ClusterGraph {
  clusters: { name: string; label: string; serverIds: string[]; remote: boolean }[];
  servers: ServerRow[];
  routes: { a: string; b: string }[];
  gateways: { a: string; b: string }[];
  leafs: { id: string; hub: string; label: string; account?: string }[];
}

const NO_CLUSTER = "\u0000standalone";

/**
 * Clusters (connected server's first), route pairs (undirected, by server id), gateway pairs
 * (by cluster) and leaf connections. Route peers are matched by server name.
 */
export function buildClusterGraph(snap: Pick<ClusterSnapshot, "servers" | "gateways" | "leafs" | "connectedServerId">): ClusterGraph {
  const servers = [...snap.servers];
  const byName = new Map<string, ServerRow>();
  for (const s of servers) byName.set(s.name, s);
  const groups = new Map<string, string[]>();
  for (const s of servers) {
    const key = s.cluster ?? `${NO_CLUSTER}:${s.id}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s.id);
  }
  const gwPairs = new Set<string>();
  const remoteClusters = new Set<string>();
  const addGw = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    gwPairs.add([a, b].sort().join("\u0000"));
  };
  for (const s of servers) for (const g of s.gateways) if (s.cluster) addGw(s.cluster, g);
  for (const g of snap.gateways) if (g.cluster) addGw(g.cluster, g.remote);
  for (const pair of gwPairs) for (const c of pair.split("\u0000")) if (!groups.has(c)) remoteClusters.add(c);
  const connectedCluster = servers.find((s) => s.id === snap.connectedServerId)?.cluster;
  const clusterKeys = [...groups.keys(), ...remoteClusters].sort((a, b) => {
    const ca = a === connectedCluster || groups.get(a)?.includes(snap.connectedServerId ?? "\u0001") ? 0 : 1;
    const cb = b === connectedCluster || groups.get(b)?.includes(snap.connectedServerId ?? "\u0001") ? 0 : 1;
    return ca - cb || a.localeCompare(b, undefined, { numeric: true });
  });
  const clusters = clusterKeys.map((k) => {
    const ids = groups.get(k) ?? [];
    const label = k.startsWith(NO_CLUSTER) ? "standalone" : k;
    return { name: k, label, serverIds: [...ids].sort((a, b) => (byIdName(servers, a) ?? a).localeCompare(byIdName(servers, b) ?? b, undefined, { numeric: true })), remote: !groups.has(k) };
  });
  const routeSet = new Set<string>();
  const routes: { a: string; b: string }[] = [];
  for (const s of servers) {
    for (const peer of s.routePeers) {
      const p = byName.get(peer) ?? servers.find((x) => x.id === peer);
      if (!p || p.id === s.id) continue;
      const key = [s.id, p.id].sort().join("\u0000");
      if (routeSet.has(key)) continue;
      routeSet.add(key);
      const [a, b] = key.split("\u0000");
      routes.push({ a, b });
    }
  }
  const leafs = snap.leafs.map((l, i) => ({ id: `leaf:${l.serverId}:${i}`, hub: l.serverId, label: l.name || l.ip || "leaf", account: l.account }));
  const gateways = [...gwPairs].sort().map((p) => {
    const [a, b] = p.split("\u0000");
    return { a, b };
  });
  return { clusters, servers, routes, gateways, leafs };
}

function byIdName(servers: ServerRow[], id: string): string | undefined {
  return servers.find((s) => s.id === id)?.name;
}

export interface ClusterLayout {
  width: number;
  height: number;
  clusters: { name: string; label: string; x: number; y: number; w: number; h: number; remote: boolean; count: number }[];
  servers: { id: string; x: number; y: number; w: number; h: number }[];
  routes: { a: string; b: string; x1: number; y1: number; x2: number; y2: number }[];
  gateways: { a: string; b: string; d: string; lx: number; ly: number }[];
  leafs: { id: string; hub: string; label: string; account?: string; x: number; y: number; w: number; h: number; hx: number; hy: number }[];
  /** Leaves hidden past the per-cluster cap. */
  hiddenLeafs: number;
}

export interface ClusterLayoutOptions {
  /** Wrap clusters into rows above this width (default 1000). */
  maxWidth?: number;
  nodeW?: number;
  nodeH?: number;
  leafW?: number;
  leafH?: number;
  /** Leaves drawn per cluster (default 8). */
  maxLeafs?: number;
}

/** Deterministic diagram layout: clusters side by side (wrapping), servers on an ellipse inside. */
export function layoutClusterGraph(g: ClusterGraph, opts: ClusterLayoutOptions = {}): ClusterLayout {
  const maxWidth = opts.maxWidth ?? 1000;
  const nodeW = opts.nodeW ?? 136;
  const nodeH = opts.nodeH ?? 40;
  const leafW = opts.leafW ?? 112;
  const leafH = opts.leafH ?? 24;
  const maxLeafs = opts.maxLeafs ?? 8;
  const pad = 20;
  const head = 26;
  const gapX = 84;
  const gapY = 56;
  const remoteW = 150;
  const remoteH = 76;

  type Box = { name: string; label: string; w: number; h: number; remote: boolean; count: number; local: { id: string; x: number; y: number }[]; leafs: ClusterGraph["leafs"]; leafRows: number };
  const boxes: Box[] = g.clusters.map((c) => {
    const n = c.serverIds.length;
    const local: { id: string; x: number; y: number }[] = [];
    let innerW = 0;
    let innerH = 0;
    if (c.remote || n === 0) {
      innerW = remoteW - pad * 2;
      innerH = remoteH - pad * 2 - head;
    } else if (n <= 2) {
      c.serverIds.forEach((id, i) => local.push({ id, x: i * (nodeW + 48), y: 0 }));
      innerW = n * nodeW + (n - 1) * 48;
      innerH = nodeH;
    } else if (n <= 10) {
      const rx = Math.max(nodeW * 0.62, (n * (nodeW + 24)) / (2 * Math.PI));
      const ry = Math.max(nodeH * 1.6, rx * 0.55);
      c.serverIds.forEach((id, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        local.push({ id, x: rx + rx * Math.cos(a), y: ry + ry * Math.sin(a) });
      });
      innerW = 2 * rx + nodeW;
      innerH = 2 * ry + nodeH;
    } else {
      const cols = Math.ceil(Math.sqrt(n * 1.6));
      c.serverIds.forEach((id, i) => local.push({ id, x: (i % cols) * (nodeW + 20), y: Math.floor(i / cols) * (nodeH + 20) }));
      innerW = cols * (nodeW + 20) - 20;
      innerH = Math.ceil(n / cols) * (nodeH + 20) - 20;
    }
    const ids = new Set(c.serverIds);
    const leafs = g.leafs.filter((l) => ids.has(l.hub));
    const shownLeafs = leafs.slice(0, maxLeafs);
    const w = Math.max(innerW + pad * 2, 140);
    const perRow = Math.max(1, Math.floor((w - 8) / (leafW + 8)));
    const leafRows = shownLeafs.length ? Math.ceil(shownLeafs.length / perRow) : 0;
    return { name: c.name, label: c.label, w, h: c.remote ? remoteH : innerH + pad * 2 + head, remote: c.remote, count: n, local: local.map((p) => ({ ...p, x: p.x + (w - innerW) / 2, y: p.y + pad + head })), leafs: shownLeafs, leafRows };
  });

  const out: ClusterLayout = { width: 0, height: 0, clusters: [], servers: [], routes: [], gateways: [], leafs: [], hiddenLeafs: g.leafs.length };
  let x = 0;
  let y = 0;
  let rowH = 0;
  const leafBand = (b: Box) => (b.leafRows ? 30 + b.leafRows * (leafH + 8) : 0);
  const centers = new Map<string, { x: number; y: number }>();
  for (const b of boxes) {
    if (x > 0 && x + b.w > maxWidth) {
      x = 0;
      y += rowH + gapY;
      rowH = 0;
    }
    const by = y + (b.remote ? 20 : 0);
    out.clusters.push({ name: b.name, label: b.label, x, y: by, w: b.w, h: b.h, remote: b.remote, count: b.count });
    for (const p of b.local) {
      out.servers.push({ id: p.id, x: x + p.x, y: by + p.y, w: nodeW, h: nodeH });
      centers.set(p.id, { x: x + p.x + nodeW / 2, y: by + p.y + nodeH / 2 });
    }
    const perRow = Math.max(1, Math.floor((b.w - 8) / (leafW + 8)));
    b.leafs.forEach((l, i) => {
      const lx = x + 4 + (i % perRow) * (leafW + 8) + ((b.w - 8 - Math.min(perRow, b.leafs.length) * (leafW + 8) + 8) / 2);
      const ly = by + b.h + 30 + Math.floor(i / perRow) * (leafH + 8);
      const hub = centers.get(l.hub) ?? { x: x + b.w / 2, y: by + b.h };
      out.leafs.push({ id: l.id, hub: l.hub, label: l.label, account: l.account, x: lx, y: ly, w: leafW, h: leafH, hx: hub.x, hy: hub.y });
    });
    out.hiddenLeafs -= b.leafs.length;
    rowH = Math.max(rowH, by - y + b.h + leafBand(b));
    out.width = Math.max(out.width, x + b.w);
    x += b.w + gapX;
  }
  out.height = y + rowH;
  for (const r of g.routes) {
    const a = centers.get(r.a);
    const b = centers.get(r.b);
    if (a && b) out.routes.push({ a: r.a, b: r.b, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  const boxOf = new Map(out.clusters.map((c) => [c.name, c]));
  g.gateways.forEach((gw, i) => {
    const A = boxOf.get(gw.a);
    const B = boxOf.get(gw.b);
    if (!A || !B) return;
    const [L, R] = A.x <= B.x ? [A, B] : [B, A];
    const sameRow = Math.abs(L.y - R.y) < 40;
    if (sameRow && R.x - (L.x + L.w) <= gapX + 1) {
      const y1 = L.y + L.h / 2;
      const y2 = R.y + R.h / 2;
      const x1 = L.x + L.w;
      const x2 = R.x;
      out.gateways.push({ a: gw.a, b: gw.b, d: `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 6 });
    } else if (sameRow) {
      // arc above both boxes (staggered so parallel arcs do not overlap)
      const x1 = L.x + L.w / 2;
      const x2 = R.x + R.w / 2;
      const top = Math.min(L.y, R.y) - 18 - (i % 3) * 10;
      out.gateways.push({ a: gw.a, b: gw.b, d: `M${x1},${L.y} C${x1},${top} ${x2},${top} ${x2},${R.y}`, lx: (x1 + x2) / 2, ly: top + 2 });
    } else {
      // different rows: leave both boxes on their left edge and curve around the left margin
      const [U, D] = A.y <= B.y ? [A, B] : [B, A];
      const y1 = U.y + U.h / 2;
      const y2 = D.y + D.h / 2;
      const bend = Math.min(U.x, D.x) - 36 - (i % 3) * 10;
      out.gateways.push({ a: gw.a, b: gw.b, d: `M${U.x},${y1} C${bend},${y1} ${bend},${y2} ${D.x},${y2}`, lx: bend + 6, ly: (y1 + y2) / 2 });
    }
  });
  // arcs may go above y=0 / left of x=0: shift everything so the diagram starts at 0,0
  const minY = Math.min(0, ...out.gateways.map((g2) => g2.ly - 14));
  const minX = Math.min(0, ...out.gateways.map((g2) => g2.lx - 30));
  if (minX < 0) {
    const dx = -minX;
    for (const c of out.clusters) c.x += dx;
    for (const s2 of out.servers) s2.x += dx;
    for (const r of out.routes) {
      r.x1 += dx;
      r.x2 += dx;
    }
    for (const l of out.leafs) {
      l.x += dx;
      l.hx += dx;
    }
    for (const g2 of out.gateways) {
      g2.lx += dx;
      g2.d = g2.d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_m, a: string, b: string) => `${Number(a) + dx},${b}`);
    }
    out.width += dx;
  }
  if (minY < 0) {
    const dy = -minY;
    for (const c of out.clusters) c.y += dy;
    for (const s of out.servers) s.y += dy;
    for (const r of out.routes) {
      r.y1 += dy;
      r.y2 += dy;
    }
    for (const l of out.leafs) {
      l.y += dy;
      l.hy += dy;
    }
    for (const g2 of out.gateways) {
      g2.ly += dy;
      g2.d = g2.d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_m, a: string, b: string) => `${a},${Number(b) + dy}`);
    }
    out.height += dy;
  }
  out.width = Math.ceil(out.width);
  out.height = Math.ceil(out.height);
  return out;
}

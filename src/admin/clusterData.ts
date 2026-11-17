// Collects ClusterSnapshot data: $SYS statsz scatter-gather (+ routez / gatewayz / leafz /
// healthz) with system-account access, otherwise the connected server's HTTP monitoring
// endpoint, otherwise the INFO block only. Pure NATS / HTTP logic — no vscode imports.

import type { NatsConnection, ServerInfo } from "@nats-io/nats-core";
import { fetchMonitor } from "../nats/monitor";
import { deriveMonitorUrl, type ConnectionProfile } from "../core/profile";
import { pingAll, pingServers, uniqueRoutePeers, type Gatewayz, type Healthz, type Leafz, type Routez } from "../nats/system";
import {
  applyHealth,
  gatewaysFromGatewayz,
  healthFrom,
  leafsFromLeafz,
  routesFromRoutez,
  serverRowFromStatsz,
  serverRowFromVarz,
  type ClusterSnapshot,
  type ServerRow,
  type VarzLike,
} from "./clusterModel";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SystemCollectOptions {
  /** Also fetch routez / gatewayz / leafz / healthz (slower; default true). */
  topology?: boolean;
  /** Scatter-gather upper bound in ms (default 1500). */
  maxWait?: number;
}

type Partial0 = Pick<ClusterSnapshot, "servers" | "routes" | "gateways" | "leafs" | "expectedServers" | "meta" | "topologyAt">;

/** Statsz of every server (throws SystemAccessError without access). */
export async function collectSystem(nc: NatsConnection, opts: SystemCollectOptions = {}): Promise<Partial0> {
  const maxWait = opts.maxWait ?? 1500;
  const stats = await pingServers(nc, { maxWait });
  const now = Date.now();
  const servers = stats.map((m) => serverRowFromStatsz(m, now));
  const expected = Math.max(stats.length, ...stats.map((m) => m.statsz.active_servers ?? 0));
  const metaSrc = stats.find((m) => m.statsz.jetstream?.meta?.leader);
  const out: Partial0 = {
    servers,
    routes: [],
    gateways: [],
    leafs: [],
    expectedServers: expected || undefined,
    meta: metaSrc ? { leader: metaSrc.statsz.jetstream!.meta!.leader, clusterSize: metaSrc.statsz.jetstream!.meta!.cluster_size, name: metaSrc.statsz.jetstream!.meta!.name } : undefined,
  };
  if (opts.topology !== false) {
    const want = stats.length || undefined;
    const safe = <T>(p: Promise<T[]>) => p.catch(() => [] as T[]);
    const [routez, gatewayz, leafz, healthz] = await Promise.all([
      safe(pingAll<Routez>(nc, "ROUTEZ", {}, maxWait, want)),
      safe(pingAll<Gatewayz>(nc, "GATEWAYZ", {}, maxWait, want)),
      safe(pingAll<Leafz>(nc, "LEAFZ", {}, maxWait, want)),
      safe(pingAll<Healthz>(nc, "HEALTHZ", {}, maxWait, want)),
    ]);
    out.routes = routesFromRoutez(routez);
    out.gateways = gatewaysFromGatewayz(gatewayz.map((g) => ({ ...g, server: { ...g.server, cluster: g.server.cluster } })));
    out.leafs = leafsFromLeafz(leafz);
    applyHealth(servers, healthz);
    const leafCount = new Map<string, number>();
    for (const l of out.leafs) leafCount.set(l.serverId, (leafCount.get(l.serverId) ?? 0) + 1);
    for (const s of servers) if (leafz.some((l) => l.server.id === s.id)) s.leafs = leafCount.get(s.id) ?? 0;
    out.topologyAt = Date.now();
  }
  return out;
}

/**
 * Monitoring URLs to try, best first. An explicit monitorUrl wins. Otherwise the connected
 * server's host (the client may have failed over away from the first configured server), then
 * the first configured server. WebSocket-only profiles have no derivable URL.
 */
export function monitorCandidates(profile: ConnectionProfile, connectedServer?: string): string[] {
  if (profile.monitorUrl?.trim()) return [deriveMonitorUrl(profile)!];
  const out: string[] = [];
  const add = (u: string | undefined) => {
    if (u && !out.includes(u)) out.push(u);
  };
  if (connectedServer) add(deriveMonitorUrl({ ...profile, servers: [connectedServer] }));
  add(deriveMonitorUrl(profile));
  return out;
}

/**
 * One server via HTTP monitoring (/varz, /routez, /gatewayz, /leafz, /healthz). It is marked
 * `connected` only when its id matches `connectedServerId` (a monitoring URL may point at a
 * different server than the one this client is connected to); without an id it is assumed.
 */
export async function collectMonitor(monitorUrl: string, timeoutMs = 2500, connectedServerId?: string): Promise<Partial0> {
  const varz = await fetchMonitor<VarzLike>(monitorUrl, "varz", {}, timeoutMs);
  const now = Date.now();
  const row = serverRowFromVarz(varz, now);
  const [routez, gatewayz, leafz, healthz] = await Promise.all([
    fetchMonitor<Routez>(monitorUrl, "routez", {}, timeoutMs).catch(() => undefined),
    fetchMonitor<Gatewayz>(monitorUrl, "gatewayz", {}, timeoutMs).catch(() => undefined),
    fetchMonitor<Leafz>(monitorUrl, "leafz", {}, timeoutMs).catch(() => undefined),
    fetchMonitor<Healthz>(monitorUrl, "healthz", {}, timeoutMs).catch(() => undefined),
  ]);
  const server = { id: row.id, name: row.name, cluster: row.cluster };
  const routes = routez ? routesFromRoutez([{ server, data: routez }]) : [];
  const gateways = gatewayz ? gatewaysFromGatewayz([{ server, data: gatewayz }]) : [];
  const leafs = leafz ? leafsFromLeafz([{ server, data: leafz }]) : [];
  row.health = healthz ? healthFrom(healthz) : { status: "unknown" };
  row.routePeers = uniqueRoutePeers(routez?.routes?.map((r) => ({ remote_name: r.remote_name ?? r.remote_id }))).filter(Boolean);
  row.gateways = [...new Set(gateways.filter((g) => g.direction === "outbound").map((g) => g.remote))].sort();
  row.leafs = leafs.length;
  row.connected = connectedServerId ? row.id === connectedServerId : true;
  // Route peers are only known by name / id: show them as "ghost" servers of the same cluster.
  const ghosts: ServerRow[] = [];
  for (const r of routes) {
    const name = r.remoteName ?? r.remoteId;
    if (!name || ghosts.some((g) => g.name === name)) continue;
    ghosts.push({ id: r.remoteId ?? name, name, cluster: row.cluster, version: "", jetstream: false, routePeers: [row.name], gateways: [], ghost: true });
  }
  const meta = varz.jetstream?.meta?.leader ? { leader: varz.jetstream.meta.leader, clusterSize: varz.jetstream.meta.cluster_size, name: varz.jetstream.meta.name } : undefined;
  return { servers: [row, ...ghosts], routes, gateways, leafs, meta, topologyAt: now };
}

/** Last resort: what the INFO block tells us about the connected server. */
export function basicFromInfo(info: ServerInfo | undefined): Pick<ClusterSnapshot, "servers" | "routes" | "gateways" | "leafs"> {
  if (!info) return { servers: [], routes: [], gateways: [], leafs: [] };
  return {
    servers: [
      {
        id: info.server_id,
        name: info.server_name || info.server_id,
        host: info.host,
        cluster: info.cluster || undefined,
        version: info.version,
        jetstream: !!info.jetstream,
        routePeers: [],
        gateways: [],
        connected: true,
        health: { status: "unknown" },
      },
    ],
    routes: [],
    gateways: [],
    leafs: [],
  };
}

export { errText };

// Read-only JSON documents: "who am I" (user, account, permissions, connection details) and
// per-server details ($SYS statsz + VARZ + JSZ + HEALTHZ). No vscode imports.

import type { NatsConnection, ServerInfo } from "@nats-io/nats-core";
import type { JetStreamManager } from "@nats-io/jetstream";
import type { ConnectionProfile } from "../core/profile";
import { fetchUserInfo, hasSystemAccess, pingServers, serverRequest, summarizePermissions, type Healthz } from "../nats/system";
import { userExpiry } from "./clusterModel";

export interface WhoAmISource {
  nc: NatsConnection;
  profile: ConnectionProfile;
  info?: ServerInfo;
  hasJetStream(): Promise<boolean>;
  jsm(): Promise<JetStreamManager>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function buildWhoAmI(src: WhoAmISource): Promise<Record<string, unknown>> {
  const { nc, profile } = src;
  const info = src.info ?? nc.info;
  const [user, rtt, sys, js] = await Promise.all([
    fetchUserInfo(nc),
    nc.rtt().catch(() => undefined),
    hasSystemAccess(nc, 10_000),
    src.hasJetStream(),
  ]);
  let jetstream: unknown = "not available for this account";
  if (js) {
    try {
      const ai = await (await src.jsm()).getAccountInfo();
      jetstream = {
        domain: ai.domain,
        memory: ai.memory,
        storage: ai.storage,
        streams: ai.streams,
        consumers: ai.consumers,
        limits: ai.limits,
        api: ai.api,
      };
    } catch (e) {
      jetstream = { error: errText(e) };
    }
  }
  const perms = summarizePermissions(user?.permissions);
  return {
    $comment: "Read-only. User and permissions come from $SYS.REQ.USER.INFO (nats-server ≥ 2.10).",
    user: user?.user ?? profile.auth.username ?? (user ? undefined : "unknown — $SYS.REQ.USER.INFO not available"),
    account: user?.account,
    accountName: user?.account_name,
    expires: userExpiry(user?.expires),
    permissions: user ? (user.permissions ?? "unrestricted") : "unknown",
    permissionsSummary: user ? perms.lines : undefined,
    systemAccountAccess: sys,
    connection: {
      profile: profile.name,
      environment: profile.environment ?? null,
      readOnly: !!profile.readOnly,
      origin: profile.origin ?? "manual",
      authKind: profile.auth.kind,
      configuredServers: profile.servers,
      connectedUrl: nc.getServer(),
      rttMs: rtt !== undefined ? Math.round(rtt * 100) / 100 : undefined,
      clientId: info?.client_id,
      clientIp: info?.client_ip,
      inboxPrefix: profile.inboxPrefix || "_INBOX",
      tls: {
        configured: !!profile.tls?.enabled,
        serverRequires: !!info?.tls_required,
        serverVerifiesClientCert: !!info?.tls_verify,
        serverOffers: !!info?.tls_available,
        handshakeFirst: !!profile.tls?.handshakeFirst,
      },
      headers: info?.headers,
      maxPayload: info?.max_payload,
      jetstreamDomain: profile.jsDomain,
      stats: nc.stats(),
    },
    server: info
      ? {
          name: info.server_name,
          id: info.server_id,
          version: info.version,
          go: info.go,
          host: info.host,
          port: info.port,
          proto: info.proto,
          cluster: info.cluster,
          jetstream: !!info.jetstream,
          authRequired: !!info.auth_required,
          lameDuck: !!info.ldm,
          connectUrls: info.connect_urls,
        }
      : undefined,
    jetstream,
  };
}

/** Everything the $SYS API knows about one server. */
export async function buildServerDetails(nc: NatsConnection, serverId: string): Promise<Record<string, unknown>> {
  const safe = async <T>(p: Promise<T>): Promise<T | { error: string }> => {
    try {
      return await p;
    } catch (e) {
      return { error: errText(e) };
    }
  };
  const [stats, varz, jsz, healthz] = await Promise.all([
    safe(pingServers(nc, { maxWait: 1200 }).then((all) => all.find((s) => s.server.id === serverId))),
    safe(serverRequest<Record<string, unknown>>(nc, serverId, "VARZ").then((e) => e.data)),
    safe(serverRequest<Record<string, unknown>>(nc, serverId, "JSZ").then((e) => e.data)),
    safe(serverRequest<Healthz>(nc, serverId, "HEALTHZ").then((e) => e.data)),
  ]);
  const identity = stats && !("error" in stats) ? stats.server : undefined;
  return {
    $comment: `Read-only snapshot from $SYS.REQ.SERVER.${serverId}.* at ${new Date().toISOString()}. Use "Refresh" to update.`,
    server: identity ?? { id: serverId },
    health: healthz,
    statsz: stats && !("error" in stats) ? stats.statsz : stats,
    varz,
    jsz,
  };
}

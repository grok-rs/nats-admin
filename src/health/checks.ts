// JetStream health doctor: pure analysis of a HealthSnapshot against NATS best
// practices. No vscode / Node imports — unit tested in test/health.test.ts.
//
//   analyze(snapshot, thresholds) → Finding[] (sorted, most important first)

import type { ConsumerInfo, StreamInfo, StreamSourceInfo } from "@nats-io/jetstream";
import { fmtBytes, fmtMillis, fmtNumber } from "../shared/format";
import {
  compareFindings,
  KV_PREFIX,
  OBJ_PREFIX,
  targetKey,
  type Category,
  type CheckThresholds,
  type Finding,
  type FindingFix,
  type FindingTarget,
  type HealthSnapshot,
  type Severity,
} from "./model";

const DOCS = {
  streams: "https://docs.nats.io/nats-concepts/jetstream/streams",
  consumers: "https://docs.nats.io/nats-concepts/jetstream/consumers",
  kv: "https://docs.nats.io/nats-concepts/jetstream/key-value-store",
  obj: "https://docs.nats.io/nats-concepts/jetstream/obj_store",
  clustering: "https://docs.nats.io/running-a-nats-service/configuration/clustering/jetstream_clustering",
  mirrors: "https://docs.nats.io/nats-concepts/jetstream/source_and_mirror",
  monitoring: "https://docs.nats.io/running-a-nats-service/nats_admin/monitoring",
  slowConsumers: "https://docs.nats.io/running-a-nats-service/nats_admin/slow_consumers",
  limits: "https://docs.nats.io/running-a-nats-service/configuration/resource_management",
  upgrading: "https://docs.nats.io/running-a-nats-service/nats_admin/upgrading_cluster",
  jetstream: "https://docs.nats.io/running-a-nats-service/configuration/resource_management#jetstream",
};

/** Mirrors / sources that have not been active for this long are reported (ms). */
const SOURCE_INACTIVE_MS = 5 * 60_000;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const pct = (f: number): string => `${f * 100 < 10 && f > 0 ? (f * 100).toFixed(1) : Math.floor(f * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${fmtNumber(n)} ${n === 1 ? one : many}`;

/** Compare dotted versions ("2.10.14-beta.1"): negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10));
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Epoch ms of a JetStream timestamp (ISO string; Go's zero time and non-strings → undefined). */
export function parseActive(v: unknown): number | undefined {
  if (typeof v !== "string" || !v || v.startsWith("0001-")) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** used / limit when the limit is set (> 0), else undefined. */
export function limitRatio(used: number | undefined, limit: number | undefined): number | undefined {
  if (!limit || limit <= 0 || used === undefined || !Number.isFinite(used)) return undefined;
  return used / limit;
}

/** Severity for a usage fraction: error ≥ errorRatio, warning ≥ warningRatio. */
export function usageSeverity(ratio: number | undefined, t: Pick<CheckThresholds, "storageWarningRatio" | "storageErrorRatio">): Severity | undefined {
  if (ratio === undefined) return undefined;
  if (ratio >= t.storageErrorRatio) return "error";
  if (ratio >= t.storageWarningRatio) return "warning";
  return undefined;
}

/** Ephemeral consumers without acks (ordered consumers, KV watchers, message browsers) are transient. */
export function isTransientConsumer(ci: ConsumerInfo): boolean {
  return !ci.config.durable_name && str(ci.config.ack_policy) === "none";
}

export function isPullConsumer(ci: ConsumerInfo): boolean {
  return !ci.config.deliver_subject;
}

interface StreamKind {
  category: Category;
  /** Check id prefix: "stream" | "kv" | "objectstore". */
  prefix: string;
  target: FindingTarget;
  /** Display name: "ORDERS", "KV bucket config". */
  label: string;
}

function streamKind(connId: string, name: string): StreamKind {
  if (name.startsWith(KV_PREFIX)) {
    const bucket = name.slice(KV_PREFIX.length);
    return { category: "kv", prefix: "kv", target: { kind: "kv", connId, bucket, stream: name }, label: `KV bucket ${bucket}` };
  }
  if (name.startsWith(OBJ_PREFIX)) {
    const bucket = name.slice(OBJ_PREFIX.length);
    return { category: "objectstore", prefix: "objectstore", target: { kind: "objectstore", connId, bucket, stream: name }, label: `Object store ${bucket}` };
  }
  return { category: "stream", prefix: "stream", target: { kind: "stream", connId, stream: name }, label: `Stream ${name}` };
}

type Draft = Omit<Finding, "key">;

class FindingList {
  readonly items: Finding[] = [];
  private readonly seen = new Set<string>();
  /** `discriminator` keeps several findings of one check on one target apart (e.g. one per stream source). */
  add(f: Draft, discriminator?: string): void {
    const key = `${f.id}@${targetKey(f.target)}${discriminator ? `#${discriminator}` : ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push({ ...f, key });
  }
}

// ---- fixes (arguments accepted by nats.healthFix; see src/health/fixes.ts) --------------------

const fix = {
  editStream: (connId: string, stream: string, label = "Edit stream config"): FindingFix => ({ label, command: "nats.editStreamConfig", args: { connId, stream } }),
  streamInfo: (connId: string, stream: string, label = "Show stream info"): FindingFix => ({ label, command: "nats.streamInfo", args: { connId, stream } }),
  browse: (connId: string, stream: string): FindingFix => ({ label: "Browse messages", command: "nats.browseMessages", args: { connId, stream } }),
  consumerInfo: (connId: string, stream: string, consumer: string): FindingFix => ({ label: "Show consumer info", command: "nats.consumerInfo", args: { connId, stream, consumer } }),
  editConsumer: (connId: string, stream: string, consumer: string, label = "Edit consumer config"): FindingFix => ({ label, command: "nats.editConsumerConfig", args: { connId, stream, consumer } }),
  lab: (connId: string, stream: string, consumer: string): FindingFix => ({ label: "Open Consumer Lab", command: "nats.openConsumerLab", args: { connId, stream, consumer } }),
  kvInfo: (connId: string, bucket: string): FindingFix => ({ label: "Show bucket status", command: "nats.kvBucketInfo", args: { connId, bucket } }),
  objInfo: (connId: string, bucket: string): FindingFix => ({ label: "Show store status", command: "nats.objBucketInfo", args: { connId, bucket } }),
  serverInfo: (connId: string, label = "Show server & account info"): FindingFix => ({ label, command: "nats.serverInfo", args: { connId } }),
  dashboard: (connId: string): FindingFix => ({ label: "Open Server Dashboard", command: "nats.openDashboard", args: { connId } }),
  editConnection: (connId: string, label = "Edit connection"): FindingFix => ({ label, command: "nats.editConnection", args: { connId } }),
};

function infoFixFor(k: StreamKind, connId: string): FindingFix {
  if (k.category === "kv") return fix.kvInfo(connId, k.target.bucket!);
  if (k.category === "objectstore") return fix.objInfo(connId, k.target.bucket!);
  return fix.streamInfo(connId, k.target.stream!);
}

function editFixFor(k: StreamKind, connId: string, label: string): FindingFix {
  const stream = k.target.stream!;
  return fix.editStream(connId, stream, k.category === "stream" ? label : `${label} (${stream})`);
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function analyze(snap: HealthSnapshot, t: CheckThresholds): Finding[] {
  const out = new FindingList();
  checkConnection(snap, t, out);
  checkServer(snap, t, out);
  checkAccount(snap, t, out);
  const clustered = !!(snap.server?.cluster || snap.monitor.varz?.cluster?.name);
  for (const si of snap.streams) {
    checkStream(snap, si, t, clustered, out);
    for (const ci of snap.consumers[si.config.name] ?? []) checkConsumer(snap, si, ci, t, out);
  }
  checkNotes(snap, out);
  return out.items.sort(compareFindings);
}

// ---------------------------------------------------------------------------------------------
// Connection and server
// ---------------------------------------------------------------------------------------------

function checkConnection(snap: HealthSnapshot, t: CheckThresholds, out: FindingList): void {
  const connId = snap.connId;
  if (snap.rttMs !== undefined && snap.rttMs > t.rttWarningMs) {
    out.add({
      id: "connection.rtt-high",
      severity: "warning",
      category: "connection",
      target: { kind: "connection", connId },
      title: `High round-trip time: ${fmtMillis(snap.rttMs)}`,
      detail: `The client ↔ server round trip took ${fmtMillis(snap.rttMs)} (threshold ${fmtMillis(t.rttWarningMs)}) to ${snap.connectedUrl ?? "the server"}.`,
      recommendation:
        "Every request/reply, JetStream publish acknowledgement and KV operation pays this latency at least once. Connect applications to the closest server (list all cluster URLs so clients pick a nearby one), use leaf nodes for remote sites, and check for overloaded servers or saturated links.",
      fix: fix.dashboard(connId),
      docs: DOCS.monitoring,
      metric: { label: "RTT", value: snap.rttMs, limit: t.rttWarningMs, unit: "ms" },
    });
  }
}

function checkServer(snap: HealthSnapshot, t: CheckThresholds, out: FindingList): void {
  const connId = snap.connId;
  const server = { kind: "server" as const, connId };
  const version = snap.server?.version ?? snap.monitor.varz?.version;
  if (version && compareVersions(version, t.minServerVersion) < 0) {
    out.add({
      id: "server.version-old",
      severity: "warning",
      category: "server",
      target: server,
      title: `Server v${version} is older than ${t.minServerVersion.replace(/\.0$/, "")}`,
      detail: `${snap.server?.name ?? "The server"} runs nats-server v${version}.`,
      recommendation:
        "Releases before 2.10 no longer receive fixes and miss important JetStream improvements (faster stream recovery, multi-filter consumers, subject transforms, compression, better cluster stability). Plan a rolling upgrade: one server at a time, using lame duck mode, waiting for streams to be current before moving on.",
      fix: fix.serverInfo(connId, "Show server info"),
      docs: DOCS.upgrading,
    });
  }

  if (!snap.jetstream.enabled && !snap.jetstream.permissionDenied && !snap.jetstream.failed) {
    const serverHasJs = snap.server?.jetstream !== false;
    out.add({
      id: "server.jetstream-disabled",
      severity: "info",
      category: serverHasJs ? "account" : "server",
      target: serverHasJs ? { kind: "account", connId } : server,
      title: serverHasJs ? "JetStream is not enabled for this account" : "JetStream is not enabled on this server",
      detail: `${snap.jetstream.reason ? `${snap.jetstream.reason}. ` : ""}Stream, consumer, KV and object store checks were skipped.`,
      recommendation: serverHasJs
        ? "The server runs JetStream but this account has no JetStream limits. Enable it for the account (account `jetstream: enabled` in the server config, or JetStream limits in the account JWT) if it needs persistence."
        : "Core NATS works without JetStream, but streams, KV and object stores need it. Start the server with `-js` or a `jetstream {}` block, with explicit `max_memory_store` / `max_file_store` limits.",
      fix: fix.serverInfo(connId, "Show server info"),
      docs: DOCS.jetstream,
      weight: 0.5,
    });
  }

  const m = snap.monitor;
  if (m.url && !m.reachable) {
    out.add({
      id: "server.monitor-unreachable",
      severity: "info",
      category: "server",
      target: server,
      title: "Monitoring endpoint unreachable",
      detail: `${m.url} did not respond${m.error ? ` (${m.error})` : ""}. Server-level checks (healthz, slow consumers, connection and storage limits) were skipped.`,
      recommendation:
        "Enable the HTTP monitoring port (`-m 8222` or `http_port`) and make it reachable from operators and your metrics system (e.g. the Prometheus NATS exporter). Set the monitoring URL in the connection settings if it is not on <host>:8222.",
      fix: fix.editConnection(connId, "Set monitoring URL"),
      docs: DOCS.monitoring,
      weight: 0.3,
    });
  }

  if (m.healthz && m.healthz.status && m.healthz.status.toLowerCase() !== "ok") {
    out.add({
      id: "server.healthz",
      severity: "error",
      category: "server",
      target: server,
      title: `Server health check reports “${m.healthz.status}”`,
      detail: `/healthz returned ${m.healthz.status}${m.healthz.error ? `: ${m.healthz.error}` : ""}.`,
      recommendation:
        "/healthz fails when the server or JetStream is not ready: streams or consumers still recovering, not current with their RAFT group, or meta leader missing. Check the server log; during rolling restarts wait until /healthz is ok before restarting the next server.",
      fix: fix.dashboard(connId),
      docs: `${DOCS.monitoring}#health`,
    });
  }

  const v = m.varz;
  if (!v) return;
  if ((v.slow_consumers ?? 0) > 0) {
    const s = v.slow_consumer_stats;
    const split = s ? [s.clients && `${s.clients} clients`, s.routes && `${s.routes} routes`, s.gateways && `${s.gateways} gateways`, s.leafs && `${s.leafs} leaf nodes`].filter(Boolean).join(", ") : "";
    out.add({
      id: "server.slow-consumers",
      severity: "warning",
      category: "server",
      target: server,
      title: `${plural(v.slow_consumers!, "slow consumer event")} since server start`,
      detail: `/varz reports ${fmtNumber(v.slow_consumers)} slow consumers${split ? ` (${split})` : ""}. The server dropped messages or disconnected clients that could not keep up.`,
      recommendation:
        "Slow consumers lose core NATS messages. Scale subscribers horizontally with queue groups, keep message handlers fast (hand off work), raise client pending limits only with care, and use JetStream pull consumers where flow control and redelivery are needed.",
      fix: fix.dashboard(connId),
      docs: DOCS.slowConsumers,
      metric: { label: "Slow consumers", value: v.slow_consumers!, unit: "count" },
    });
  }
  const connRatio = limitRatio(v.connections, v.max_connections);
  const connSev = usageSeverity(connRatio, t);
  if (connSev) {
    out.add({
      id: "server.connections-near-limit",
      severity: connSev,
      category: "server",
      target: server,
      title: `Client connections at ${pct(connRatio!)} of max_connections`,
      detail: `${fmtNumber(v.connections)} of ${fmtNumber(v.max_connections)} connections are in use.`,
      recommendation: "New clients are rejected once max_connections is reached. Raise the limit, spread clients over more servers, and look for connection leaks (clients that reconnect without closing).",
      fix: fix.dashboard(connId),
      docs: DOCS.limits,
      metric: { label: "Connections", value: v.connections ?? 0, limit: v.max_connections, unit: "count" },
    });
  }
  const jsCfg = v.jetstream?.config;
  const jsStats = v.jetstream?.stats;
  for (const [kind, used, max] of [
    ["storage", jsStats?.storage, jsCfg?.max_storage],
    ["memory", jsStats?.memory, jsCfg?.max_memory],
  ] as const) {
    const ratio = limitRatio(used, max);
    const sev = usageSeverity(ratio, t);
    if (!sev) continue;
    out.add({
      id: `server.js-${kind}-near-limit`,
      severity: sev,
      category: "server",
      target: server,
      title: `Server JetStream ${kind} at ${pct(ratio!)} of its limit`,
      detail: `${fmtBytes(used)} of ${fmtBytes(max)} ${kind === "storage" ? "file storage" : "memory storage"} configured for JetStream on ${v.server_name ?? "this server"}.`,
      recommendation: `When the server's JetStream ${kind} is exhausted, new streams cannot be placed and writes fail with "insufficient resources". Increase ${kind === "storage" ? "max_file_store" : "max_memory_store"}, add servers, or bound streams with max_age / max_bytes.`,
      fix: fix.dashboard(connId),
      docs: DOCS.jetstream,
      metric: { label: `JetStream ${kind}`, value: used ?? 0, limit: max, unit: "bytes" },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// JetStream account
// ---------------------------------------------------------------------------------------------

function checkAccount(snap: HealthSnapshot, t: CheckThresholds, out: FindingList): void {
  const a = snap.account;
  if (!a) return;
  const connId = snap.connId;
  const target: FindingTarget = { kind: "account", connId };
  const scopes: { label: string; suffix: string; u: typeof a }[] = [{ label: "", suffix: "", u: a }];
  for (const [tier, u] of Object.entries(a.tiers ?? {})) if (u) scopes.push({ label: ` (${tier} tier)`, suffix: `-${tier}`, u: u as typeof a });

  for (const { label, suffix, u } of scopes) {
    const limits = u.limits ?? ({} as typeof a.limits);
    const byteChecks = [
      { kind: "storage", used: u.storage, max: limits.max_storage },
      { kind: "memory", used: u.memory, max: limits.max_memory },
    ];
    for (const c of byteChecks) {
      const ratio = limitRatio(c.used, c.max);
      const sev = usageSeverity(ratio, t);
      if (!sev) continue;
      out.add({
        id: `account.${c.kind}-near-limit${suffix}`,
        severity: sev,
        category: "account",
        target,
        title: `JetStream account ${c.kind}${label} at ${pct(ratio!)} of its limit`,
        detail: `${fmtBytes(c.used)} of ${fmtBytes(c.max)} ${c.kind === "storage" ? "file" : "memory"} storage used by ${plural(u.streams, "stream")}.`,
        recommendation:
          "When the account limit is reached, publishes to every stream of the account fail with “insufficient resources”, not just the largest one. Give each stream a max_bytes (and max_age) so one stream cannot starve the others, purge data that is no longer needed, or raise the account limit (server config or account JWT).",
        fix: fix.serverInfo(connId),
        docs: DOCS.limits,
        metric: { label: `Account ${c.kind}`, value: c.used, limit: c.max, unit: "bytes" },
      });
    }
    const countChecks = [
      { kind: "streams", used: u.streams, max: limits.max_streams },
      { kind: "consumers", used: u.consumers, max: limits.max_consumers },
    ];
    for (const c of countChecks) {
      const ratio = limitRatio(c.used, c.max);
      const sev = usageSeverity(ratio, t);
      if (!sev) continue;
      out.add({
        id: `account.${c.kind}-near-limit${suffix}`,
        severity: sev,
        category: "account",
        target,
        title: `${c.kind === "streams" ? "Streams" : "Consumers"}${label} at ${pct(ratio!)} of the account limit`,
        detail: `${fmtNumber(c.used)} of ${fmtNumber(c.max)} ${c.kind} allowed for this account.`,
        recommendation:
          c.kind === "streams"
            ? "Creating streams (and KV buckets / object stores, which are streams) fails once the limit is reached. Remove unused streams or raise max_streams for the account."
            : "Creating consumers fails once the limit is reached — ephemeral consumers created by clients will start failing first. Delete abandoned durables, set inactive_threshold on ephemeral consumers, or raise max_consumers.",
        fix: fix.serverInfo(connId),
        docs: DOCS.limits,
        metric: { label: c.kind, value: c.used, limit: c.max, unit: "count" },
      });
    }
  }

  const api = a.api;
  if (api && api.total >= 100) {
    const ratio = api.errors / api.total;
    if (ratio >= t.apiErrorRatio) {
      out.add({
        id: "account.api-errors",
        severity: "warning",
        category: "account",
        target,
        title: `${pct(ratio)} of JetStream API requests failed`,
        detail: `${fmtNumber(api.errors)} errors out of ${fmtNumber(api.total)} JetStream API requests for this account since the server started.`,
        recommendation:
          "A high API error rate usually means clients look up streams or consumers that do not exist, lack permissions, or hit limits. Check the server log and subscribe to $JS.EVENT.ADVISORY.API to see failing requests; fix client configuration rather than retrying blindly.",
        fix: fix.serverInfo(connId),
        docs: DOCS.monitoring,
        metric: { label: "API error ratio", value: ratio, limit: t.apiErrorRatio, unit: "ratio" },
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Streams (including KV / object store backing streams)
// ---------------------------------------------------------------------------------------------

function checkStream(snap: HealthSnapshot, si: StreamInfo, t: CheckThresholds, clustered: boolean, out: FindingList): void {
  const connId = snap.connId;
  const c = si.config;
  const name = c.name;
  const k = streamKind(connId, name);
  const retention = str(c.retention) || "limits";
  const discard = str(c.discard) || "old";
  const storage = str(c.storage) || "file";
  const replicas = c.num_replicas || 1;
  const st = si.state;
  const docs = k.category === "kv" ? DOCS.kv : k.category === "objectstore" ? DOCS.obj : DOCS.streams;
  const base = { category: k.category, target: k.target, docs };

  // Unbounded limits-retention streams (regular streams only: KV keeps `history` per key).
  if (k.category === "stream" && retention === "limits" && !c.sealed) {
    const unbounded = !(c.max_age > 0) && !(c.max_bytes > 0) && !(c.max_msgs > 0) && !((c.max_msgs_per_subject ?? 0) > 0);
    if (unbounded) {
      out.add({
        ...base,
        id: "stream.unbounded",
        severity: "warning",
        title: "Stream has no retention limits",
        detail: `Limits retention without max_age, max_bytes, max_msgs or max_msgs_per_subject: the ${storage} stream grows until the server or account runs out of ${storage === "memory" ? "memory" : "storage"}. It holds ${plural(st.messages, "message")} (${fmtBytes(st.bytes)}).`,
        recommendation:
          "Bound every limits-based stream. Set max_age for time-based data (e.g. 7d) and max_bytes as a safety net, so one stream cannot exhaust JetStream storage for every other stream on the server or account.",
        fix: fix.editStream(connId, name, "Set retention limits"),
        metric: { label: "Stored", value: st.bytes, unit: "bytes" },
      });
    }
  }

  // Near limits. discard=new rejects publishes; work queue / interest streams with discard=old drop unprocessed data.
  const bytesRatio = limitRatio(st.bytes, c.max_bytes);
  const msgsRatio = limitRatio(st.messages, c.max_msgs);
  const ratio = Math.max(bytesRatio ?? 0, msgsRatio ?? 0);
  const which = (bytesRatio ?? 0) >= (msgsRatio ?? 0) ? "max_bytes" : "max_msgs";
  const usedText = which === "max_bytes" ? `${fmtBytes(st.bytes)} of ${fmtBytes(c.max_bytes)}` : `${fmtNumber(st.messages)} of ${fmtNumber(c.max_msgs)} messages`;
  const dropsData = discard === "old" && (retention === "workqueue" || retention === "interest");
  if (ratio > 0 && (discard === "new" || dropsData)) {
    const sev = dropsData ? (ratio >= t.storageWarningRatio ? "warning" : undefined) : usageSeverity(ratio, t);
    if (sev) {
      out.add({
        ...base,
        id: `${k.prefix}.near-limit`,
        severity: sev,
        title: `${k.category === "stream" ? "Stream" : k.category === "kv" ? "Bucket" : "Object store"} at ${pct(ratio)} of ${which}`,
        detail: dropsData
          ? `${usedText}. With ${retention} retention and discard: old the server deletes the oldest messages at the limit — messages that were never processed.`
          : `${usedText}. With discard: new the server rejects new ${k.category === "kv" ? "puts" : k.category === "objectstore" ? "uploads" : "publishes"} once the limit is reached (“maximum ${which === "max_bytes" ? "bytes" : "messages"} exceeded”).`,
        recommendation: dropsData
          ? "Consumers are not keeping up with the producers. Scale the consumers or raise the limit; use discard: new if producers should get back-pressure instead of losing work."
          : `Raise ${which}, let old data expire with max_age, or purge what is no longer needed. Alert at ${pct(t.storageWarningRatio)} so there is time to act before writes fail.`,
        fix: editFixFor(k, connId, "Raise limits"),
        metric: which === "max_bytes" ? { label: "Stored", value: st.bytes, limit: c.max_bytes, unit: "bytes" } : { label: "Messages", value: st.messages, limit: c.max_msgs, unit: "count" },
      });
    }
  }

  // Replication.
  if (clustered && replicas === 1) {
    out.add({
      ...base,
      docs: DOCS.clustering,
      id: `${k.prefix}.replicas-1`,
      severity: "warning",
      title: "Single replica in a clustered deployment",
      detail: `${k.label} uses num_replicas: 1 on cluster ${snap.server?.cluster ?? snap.monitor.varz?.cluster?.name ?? ""}. If the server that hosts it goes down it is unavailable; losing its disk loses the data.`,
      recommendation: "Use num_replicas: 3 for production data in a cluster (tolerates one server failure) and 5 for the most critical data. Replicas can be changed online by editing the configuration.",
      fix: editFixFor(k, connId, "Edit replicas"),
    });
  }
  if (replicas > 1 && replicas % 2 === 0) {
    out.add({
      ...base,
      docs: DOCS.clustering,
      id: `${k.prefix}.replicas-even`,
      severity: "warning",
      title: `Even replica count (R${replicas})`,
      detail: `${k.label} uses num_replicas: ${replicas}. RAFT needs a majority (${Math.floor(replicas / 2) + 1} of ${replicas}), so R${replicas} tolerates no more failures than R${replicas - 1} while costing an extra copy.`,
      recommendation: "Use an odd number of replicas: R3 (tolerates 1 failure) or R5 (tolerates 2).",
      fix: editFixFor(k, connId, "Edit replicas"),
    });
  }

  const cl = si.cluster;
  if (cl && replicas > 1 && !cl.leader) {
    out.add({
      ...base,
      docs: DOCS.clustering,
      id: `${k.prefix}.no-leader`,
      severity: "error",
      title: "No RAFT leader",
      detail: `${k.label} (R${replicas}) has no elected leader${cl.name ? ` in cluster ${cl.name}` : ""}: reads and writes fail until a leader is elected.`,
      recommendation: "A replicated asset without a leader has lost quorum — typically too many of its servers are offline or partitioned. Bring the peers back, check routes between servers and the server logs; as a last resort use `nats stream cluster step-down` or peer removal.",
      fix: infoFixFor(k, connId),
    });
  }
  const peers = cl?.replicas ?? [];
  const offline = peers.filter((p) => p.offline);
  const lagging = peers.filter((p) => !p.offline && !p.current);
  if (offline.length) {
    out.add({
      ...base,
      docs: DOCS.clustering,
      id: `${k.prefix}.replica-offline`,
      severity: "error",
      title: `${plural(offline.length, "replica")} offline`,
      detail: `Offline peers of ${k.label}: ${offline.map((p) => p.name).join(", ")}. The asset has less redundancy than configured (R${replicas}).`,
      recommendation: "Restore the offline servers. If a server is gone for good, remove it as a peer so JetStream places a new replica on a healthy server.",
      fix: infoFixFor(k, connId),
    });
  }
  if (lagging.length) {
    out.add({
      ...base,
      docs: DOCS.clustering,
      id: `${k.prefix}.replica-lagging`,
      severity: "warning",
      title: `${plural(lagging.length, "replica")} not current`,
      detail: `Replicas of ${k.label} catching up: ${lagging.map((p) => `${p.name} (lag ${fmtNumber(p.lag ?? 0)} ops${p.active ? `, seen ${fmtMillis(p.active / 1e6)} ago` : ""})`).join(", ")}.`,
      recommendation: "Lagging replicas cannot take over without data loss risk. Persistent lag points at a slow disk, network saturation between servers or an overloaded peer — check server CPU, disk latency and route health.",
      fix: infoFixFor(k, connId),
      metric: { label: "Max lag", value: Math.max(...lagging.map((p) => p.lag ?? 0)), unit: "count" },
    });
  }

  // Mirrors and sources.
  const checkSource = (src: StreamSourceInfo, kind: "mirror" | "source", index = 0) => {
    const label = kind === "mirror" ? `Mirror of ${src.name}` : `Source ${src.name}`;
    const activeMs = typeof src.active === "number" && src.active > 0 ? src.active / 1e6 : undefined;
    // A stream can have many sources (even the same stream twice, with other filters or domains):
    // one finding per source, not just the first.
    const discriminator = kind === "source" ? `${index}:${src.name}` : undefined;
    if (src.error) {
      out.add({
        ...base,
        docs: DOCS.mirrors,
        id: `${k.prefix}.${kind}-error`,
        severity: "error",
        target: k.target,
        title: `${label} is failing`,
        detail: `${k.label}: ${src.error.description ?? "error"}${src.error.code ? ` (code ${src.error.code})` : ""}.`,
        recommendation: "The upstream stream may be missing, renamed or unreachable (domain / API prefix, permissions, gateway or leaf node down). Fix the upstream reference in the configuration.",
        fix: infoFixFor(k, connId),
      }, discriminator);
      return;
    }
    const lagHigh = (src.lag ?? 0) > t.pendingWarning;
    const inactive = activeMs !== undefined && activeMs > SOURCE_INACTIVE_MS;
    if (lagHigh || inactive) {
      out.add({
        ...base,
        docs: DOCS.mirrors,
        id: `${k.prefix}.${kind}-lag`,
        severity: "warning",
        title: lagHigh ? `${label} is ${plural(src.lag, "message")} behind` : `${label} inactive for ${fmtMillis(activeMs!)}`,
        detail: `${k.label}: lag ${fmtNumber(src.lag ?? 0)} messages, last activity ${activeMs !== undefined ? `${fmtMillis(activeMs)} ago` : "unknown"}.`,
        recommendation:
          "Mirrors and sources replicate asynchronously. Growing lag or no activity means the replication consumer is stalled — check connectivity to the origin (gateways, leaf nodes), permissions and the origin stream's health. Readers of the copy see stale data meanwhile.",
        fix: infoFixFor(k, connId),
        metric: { label: "Lag", value: src.lag ?? 0, limit: t.pendingWarning, unit: "count" },
      }, discriminator);
    }
  };
  if (si.mirror) checkSource(si.mirror, "mirror");
  (si.sources ?? []).forEach((src, i) => checkSource(src, "source", i));

  // Retention vs consumers.
  const consumerCount = st.consumer_count ?? (snap.consumers[name]?.length ?? 0);
  if (k.category === "stream" && retention === "interest" && consumerCount === 0) {
    out.add({
      ...base,
      id: "stream.interest-no-consumers",
      severity: "warning",
      title: "Interest stream without consumers",
      detail: "Interest retention keeps messages only while a consumer is interested in them: with no consumers every published message is discarded immediately.",
      recommendation: "Create the durable consumers before producers start publishing, or switch to limits retention (with max_age) if the data must be kept regardless of consumers.",
      fix: fix.streamInfo(connId, name),
    });
  }
  if (k.category === "stream" && retention === "workqueue" && consumerCount === 0 && st.messages > 0) {
    out.add({
      ...base,
      id: "stream.workqueue-no-consumers",
      severity: "warning",
      title: `${plural(st.messages, "work item")} waiting with no consumer`,
      detail: `Work queue stream with ${fmtNumber(st.messages)} messages (${fmtBytes(st.bytes)}) and no consumer to process them.`,
      recommendation: "Work queue messages are removed only when a consumer acknowledges them. Start the workers (one pull consumer shared by all workers), or purge the queue if the work is obsolete.",
      fix: fix.browse(connId, name),
      metric: { label: "Messages", value: st.messages, unit: "count" },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Consumers
// ---------------------------------------------------------------------------------------------

function checkConsumer(snap: HealthSnapshot, si: StreamInfo, ci: ConsumerInfo, t: CheckThresholds, out: FindingList): void {
  if (isTransientConsumer(ci)) return;
  const connId = snap.connId;
  const stream = si.config.name;
  const name = ci.name;
  const cfg = ci.config;
  const pull = isPullConsumer(ci);
  const target: FindingTarget = { kind: "consumer", connId, stream, consumer: name };
  const base = { category: "consumer" as const, target, docs: DOCS.consumers };
  const workFix = pull ? fix.lab(connId, stream, name) : fix.consumerInfo(connId, stream, name);
  const ackPolicy = str(cfg.ack_policy) || "explicit";
  const pending = ci.num_pending ?? 0;
  const ackPending = ci.num_ack_pending ?? 0;
  const redelivered = ci.num_redelivered ?? 0;
  const lastActive = parseActive(ci.delivered?.last_active);
  const idleMs = lastActive !== undefined ? snap.at - lastActive : undefined;

  if (ci.paused) {
    const remaining = typeof ci.pause_remaining === "number" && ci.pause_remaining > 0 ? fmtMillis(ci.pause_remaining / 1e6) : undefined;
    out.add({
      ...base,
      id: "consumer.paused",
      severity: pending > 0 ? "warning" : "info",
      title: "Consumer is paused",
      detail: `Paused${remaining ? ` (resumes automatically in ${remaining})` : ""} with ${plural(pending, "pending message")}.`,
      recommendation: "A paused consumer delivers nothing until it is resumed or its pause deadline passes. Resume it when the maintenance is done (Connections view → consumer → Resume Consumer).",
      fix: fix.consumerInfo(connId, stream, name),
    });
  }

  if (pending > t.pendingWarning) {
    out.add({
      ...base,
      id: "consumer.pending-high",
      severity: pending >= t.pendingWarning * 10 ? "error" : "warning",
      title: `${plural(pending, "message")} behind`,
      detail: `${fmtNumber(pending)} messages in ${stream} have not been delivered to this consumer yet (threshold ${fmtNumber(t.pendingWarning)}).`,
      recommendation:
        "Pending grows when processing is slower than publishing. Scale out (more pull workers sharing the consumer, or more queue-group members for push), fetch larger batches, keep handlers fast, and alert on a growing num_pending.",
      fix: workFix,
      metric: { label: "Pending", value: pending, limit: t.pendingWarning, unit: "count" },
    });
  }

  const maxAckPending = cfg.max_ack_pending ?? 0;
  if (ackPolicy !== "none" && maxAckPending > 0 && ackPending >= maxAckPending * t.ackPendingRatio) {
    const full = ackPending >= maxAckPending;
    out.add({
      ...base,
      id: "consumer.ack-pending-stalled",
      severity: full ? "error" : "warning",
      title: full ? "Ack pending limit reached — delivery stalled" : `Ack pending at ${pct(ackPending / maxAckPending)} of max_ack_pending`,
      detail: `${fmtNumber(ackPending)} delivered messages await acknowledgement (max_ack_pending ${fmtNumber(maxAckPending)}).${full ? " The server delivers nothing new until acks arrive." : ""}`,
      recommendation:
        "The server stops delivering once max_ack_pending messages are unacknowledged. Make sure every message is acked, nak'ed or terminated (including on errors), use in-progress acks for long jobs, and raise max_ack_pending only if workers can really handle more in parallel.",
      fix: workFix,
      metric: { label: "Ack pending", value: ackPending, limit: maxAckPending, unit: "count" },
    });
  }

  if (redelivered > 0) {
    out.add({
      ...base,
      id: "consumer.redeliveries",
      severity: redelivered >= 100 ? "warning" : "info",
      weight: redelivered >= 100 ? 1 : 0.5,
      title: `${plural(redelivered, "message")} redelivered`,
      detail: `${fmtNumber(redelivered)} outstanding messages have been delivered more than once (ack_wait ${cfg.ack_wait ? fmtMillis(cfg.ack_wait / 1e6) : "30s"}, max_deliver ${cfg.max_deliver && cfg.max_deliver > 0 ? cfg.max_deliver : "unlimited"}).`,
      recommendation:
        "Redeliveries happen when ack_wait expires or a client naks. Persistent redeliveries mean failing handlers, poison messages or an ack_wait shorter than the processing time. Send in-progress acks for long work, use backoff, and set max_deliver so failures end up as MAX_DELIVERIES advisories (Dead Letter Monitor).",
      fix: workFix,
      metric: { label: "Redelivered", value: redelivered, unit: "count" },
    });
  }

  const maxDeliver = cfg.max_deliver ?? -1;
  if ((ackPolicy === "explicit" || ackPolicy === "all") && maxDeliver <= 0) {
    out.add({
      ...base,
      id: "consumer.max-deliver-unlimited",
      severity: redelivered > 0 ? "warning" : "info",
      weight: redelivered > 0 ? 1 : 0.5,
      title: "Unlimited redelivery (max_deliver −1)",
      detail: `Ack policy ${ackPolicy} without a max_deliver limit${redelivered > 0 ? `; ${plural(redelivered, "message is", "messages are")} already being redelivered` : ""}.`,
      recommendation:
        "A message that always fails (a poison message) is redelivered forever, burning capacity and — with max_ack_pending — eventually blocking the consumer. Set max_deliver (e.g. 5–10) with a backoff and dead-letter failed messages by handling the MAX_DELIVERIES advisory.",
      fix: fix.editConsumer(connId, stream, name, "Set max_deliver"),
    });
  }

  if (!pull && !ci.push_bound) {
    out.add({
      ...base,
      id: "consumer.push-unbound",
      severity: pending > 0 ? "warning" : "info",
      title: "Push consumer has no active subscriber",
      detail: `Nobody is subscribed to the deliver subject ${cfg.deliver_subject}${cfg.deliver_group ? ` (queue ${cfg.deliver_group})` : ""}; ${plural(pending, "message")} pending.`,
      recommendation: "Start the subscriber (with the matching deliver_group for queue groups) or delete the consumer if it is obsolete. Prefer pull consumers for new services: they scale horizontally and give explicit flow control.",
      fix: fix.consumerInfo(connId, stream, name),
    });
  }

  if (pull && !ci.paused && pending > 0 && (ci.num_waiting ?? 0) === 0 && (idleMs === undefined || idleMs > t.idleConsumerMs)) {
    out.add({
      ...base,
      id: "consumer.pull-idle",
      severity: "warning",
      title: "Pending messages but no active pullers",
      detail: `${fmtNumber(pending)} pending, no waiting pull requests, last delivery ${idleMs !== undefined ? `${fmtMillis(idleMs)} ago` : "never"}.`,
      recommendation:
        "No client is fetching from this pull consumer. Check that the workers are running and bind to the right durable name and stream; use inactive_threshold to clean up consumers that are no longer used.",
      fix: fix.lab(connId, stream, name),
      metric: idleMs !== undefined ? { label: "Idle", value: idleMs, limit: t.idleConsumerMs, unit: "ms" } : undefined,
    });
  }

  if (ci.cluster && (cfg.num_replicas ?? 0) !== 1 && (si.config.num_replicas ?? 1) > 1 && !ci.cluster.leader) {
    out.add({
      ...base,
      docs: DOCS.clustering,
      id: "consumer.no-leader",
      severity: "error",
      title: "Consumer has no RAFT leader",
      detail: `No leader is elected for this consumer${ci.cluster.name ? ` in cluster ${ci.cluster.name}` : ""}; it delivers nothing until one is.`,
      recommendation: "Replicated consumers need a quorum of their peers. Bring offline servers back and check the server logs for RAFT errors.",
      fix: fix.consumerInfo(connId, stream, name),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Collection notes (permission errors etc.)
// ---------------------------------------------------------------------------------------------

function checkNotes(snap: HealthSnapshot, out: FindingList): void {
  const connId = snap.connId;
  const target: FindingTarget = { kind: "connection", connId };
  const consumerNotes = snap.notes.filter((n) => n.scope === "consumers");
  for (const n of snap.notes) {
    if (n.scope === "monitor" || n.scope === "consumers") continue; // monitor → server.monitor-unreachable
    if (n.scope === "jetstream" && !n.permission && !snap.jetstream.failed) continue; // → server.jetstream-disabled
    const what = { rtt: "measure the round-trip time", jetstream: "access the JetStream API", account: "read JetStream account info", streams: "list streams" }[n.scope];
    out.add({
      id: `collect.${n.scope}`,
      severity: "info",
      category: "connection",
      target,
      title: `Could not ${what}`,
      detail: n.message,
      recommendation: n.permission
        ? "The health check runs with this connection's permissions. Allow subscribe to _INBOX.> and publish to $JS.API.INFO, $JS.API.STREAM.LIST / INFO and $JS.API.CONSUMER.LIST / INFO for complete results."
        : "Results for this area are incomplete. Re-run the check; if it keeps failing, check the server log.",
      fix: fix.editConnection(connId),
      weight: 0.5,
    });
  }
  if (consumerNotes.length) {
    const streams = consumerNotes.map((n) => n.stream).filter(Boolean) as string[];
    const permission = consumerNotes.some((n) => n.permission);
    out.add({
      id: "collect.consumers",
      severity: "info",
      category: "connection",
      target,
      title: `Could not list consumers of ${plural(streams.length || consumerNotes.length, "stream")}`,
      detail: `${streams.slice(0, 5).join(", ")}${streams.length > 5 ? ` and ${streams.length - 5} more` : ""}: ${consumerNotes[0].message}`,
      recommendation: permission
        ? "The health check runs with this connection's permissions. Allow publish to $JS.API.CONSUMER.LIST.> and $JS.API.CONSUMER.INFO.> to analyse consumers."
        : "Consumer checks for these streams were skipped. Re-run the check; if it keeps failing, check the server log.",
      weight: 0.5,
    });
  }
  if (snap.skippedStreams) {
    out.add({
      id: "collect.truncated",
      severity: "info",
      category: "connection",
      target,
      title: `${plural(snap.skippedStreams, "stream")} not analysed`,
      detail: `The account has more streams than the health check analyses in one run; ${fmtNumber(snap.skippedStreams)} were skipped.`,
      recommendation: "Very large accounts are better monitored continuously with the Prometheus NATS exporter / Surveyor and alert rules.",
      weight: 0.3,
    });
  }
}

// Stream dashboard model: DTOs exchanged between the panel and its webview, the mapping from
// nats.js StreamInfo / ConsumerInfo, and the pure analysis (rates between polls, consumer
// status, limit usage and policy notes). No vscode / node imports: the webview bundles it too.

import type { ConsumerInfo, StreamInfo, StreamSourceInfo } from "@nats-io/jetstream";
import type { TreemapNode, SubjectCount } from "../nats/subjects";
import type { MessageDTO } from "../shared/dto";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";
export type ConnState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type EnvironmentId = "dev" | "test" | "staging" | "prod";

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

export interface StreamDashboardInit {
  profileId: string;
  connectionName: string;
  stream: string;
  environment?: EnvironmentId;
  readOnly?: boolean;
  connState: ConnState;
  connError?: string;
  /** Polling interval (nats.dashboard.refreshInterval), ms. */
  refreshInterval: number;
  /** nats.explorer.maxSubjects. */
  maxSubjects: number;
  /** Whether the panel is currently visible (polling runs only while it is). */
  visible?: boolean;
}

export interface StreamConfigView {
  retention: string;
  storage: string;
  replicas: number;
  discard: string;
  discardNewPerSubject: boolean;
  maxMsgs: number;
  maxBytes: number;
  /** ms; 0 = unlimited. */
  maxAgeMs: number;
  maxMsgsPerSubject: number;
  maxMsgSize: number;
  maxConsumers: number;
  /** ms; 0 = off. */
  duplicateWindowMs: number;
  compression?: string;
  sealed: boolean;
  denyDelete: boolean;
  denyPurge: boolean;
  allowRollup: boolean;
  allowDirect: boolean;
  mirrorDirect: boolean;
  allowMsgTtl?: boolean;
  noAck?: boolean;
  placementCluster?: string;
  placementTags?: string[];
  republish?: { src?: string; dest: string; headersOnly?: boolean };
  subjectTransform?: { src?: string; dest: string };
  mirrorOf?: string;
  sourceNames?: string[];
  metadata?: Record<string, string>;
}

export interface StreamStateView {
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  firstTs?: string;
  lastTs?: string;
  numDeleted: number;
  numSubjects?: number;
  consumerCount: number;
}

export interface PeerView {
  name: string;
  leader: boolean;
  current: boolean;
  offline: boolean;
  /** ms since the peer was last seen (undefined for the leader). */
  activeMs?: number;
  /** Uncommitted operations behind the leader. */
  lag: number;
}

export interface ClusterView {
  name?: string;
  leader?: string;
  leaderSince?: string;
  raftGroup?: string;
  peers: PeerView[];
}

export interface SourceView {
  name: string;
  /** Messages behind the origin. */
  lag: number;
  /** ms since last activity; undefined = never active. */
  activeMs?: number;
  error?: string;
  filter?: string;
  external?: string;
}

export interface StreamView {
  name: string;
  description?: string;
  subjects: string[];
  created: string;
  config: StreamConfigView;
  state: StreamStateView;
  cluster?: ClusterView;
  mirror?: SourceView;
  sources: SourceView[];
}

export interface ConsumerRow {
  name: string;
  description?: string;
  kind: "pull" | "push";
  durable: boolean;
  paused: boolean;
  pushBound: boolean;
  filters: string[];
  ackPolicy: string;
  deliverPolicy: string;
  numPending: number;
  numAckPending: number;
  numRedelivered: number;
  numWaiting: number;
  maxAckPending: number;
  maxDeliver: number;
  /** ms; 0 = default. */
  ackWaitMs: number;
  deliveredStreamSeq: number;
  deliveredConsumerSeq: number;
  ackFloorStreamSeq: number;
  ackFloorConsumerSeq: number;
  /** ISO time of the last delivery. */
  lastActive?: string;
  created: string;
  replicas?: number;
}

export interface StreamSnapshot {
  /** Host time of the poll (epoch ms). */
  at: number;
  /** Server time of the stream info (epoch ms), when reported. */
  serverAt?: number;
  stream: StreamView;
  consumers: ConsumerRow[];
  /** Total consumers when the list was capped. */
  consumersTotal: number;
}

export interface SubjectStats {
  at: number;
  total: number;
  truncated: boolean;
  max: number;
  /** Subjects analysed (≤ max). */
  kept: number;
  streamMessages: number;
  keptMessages: number;
  /** Top subjects (most messages first). */
  top: SubjectCount[];
  /** Messages on the busiest subject (for max_msgs_per_subject). */
  largest?: SubjectCount;
  tree: TreemapNode[];
  /** Common prefix skipped at the top of the treemap ("orders"), "" when none. */
  treePrefix: string;
  /** Top-level tokens (for the treemap's table view). */
  roots: { label: string; value: number; subjects: number }[];
}

export interface RecentMessages {
  at: number;
  lastSeq: number;
  /** Newest first. */
  messages: MessageDTO[];
  /** Fewer than requested because the newest sequences are mostly deleted / acknowledged. */
  partial?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Mapping from nats.js types
// ---------------------------------------------------------------------------------------------

const NS_PER_MS = 1e6;

const nsToMs = (ns: number | undefined): number => (typeof ns === "number" && ns > 0 ? ns / NS_PER_MS : 0);

/** Timestamps typed as Nanos in nats.js arrive as RFC3339 strings from the server. */
function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || v.startsWith("0001-01-01")) return undefined;
  return Number.isFinite(Date.parse(v)) ? v : undefined;
}

function sourceView(si: StreamSourceInfo, cfg?: { filter_subject?: string; external?: { api: string } }): SourceView {
  const active = typeof si.active === "number" && si.active >= 0 ? si.active / NS_PER_MS : undefined;
  return {
    name: si.name,
    lag: si.lag ?? 0,
    activeMs: active,
    error: si.error ? si.error.description || `error ${si.error.code}` : undefined,
    filter: cfg?.filter_subject || undefined,
    external: cfg?.external?.api || undefined,
  };
}

export function streamView(si: StreamInfo): StreamView {
  const c = si.config;
  const st = si.state;
  const cluster = si.cluster;
  const peers: PeerView[] = [];
  if (cluster?.leader) peers.push({ name: cluster.leader, leader: true, current: true, offline: false, lag: 0 });
  for (const p of cluster?.replicas ?? []) {
    peers.push({ name: p.name, leader: false, current: !!p.current, offline: !!p.offline, activeMs: nsToMs(p.active) || undefined, lag: p.lag ?? 0 });
  }
  return {
    name: c.name,
    description: c.description || undefined,
    subjects: c.subjects ?? [],
    created: si.created,
    config: {
      retention: String(c.retention),
      storage: String(c.storage),
      replicas: c.num_replicas ?? 1,
      discard: String(c.discard ?? "old"),
      discardNewPerSubject: !!c.discard_new_per_subject,
      maxMsgs: c.max_msgs ?? -1,
      maxBytes: c.max_bytes ?? -1,
      maxAgeMs: nsToMs(c.max_age),
      maxMsgsPerSubject: c.max_msgs_per_subject ?? -1,
      maxMsgSize: c.max_msg_size ?? -1,
      maxConsumers: c.max_consumers ?? -1,
      duplicateWindowMs: nsToMs(c.duplicate_window),
      compression: c.compression && String(c.compression) !== "none" ? String(c.compression) : undefined,
      sealed: !!c.sealed,
      denyDelete: !!c.deny_delete,
      denyPurge: !!c.deny_purge,
      allowRollup: !!c.allow_rollup_hdrs,
      allowDirect: !!c.allow_direct,
      mirrorDirect: !!c.mirror_direct,
      allowMsgTtl: c.allow_msg_ttl || undefined,
      noAck: c.no_ack || undefined,
      placementCluster: c.placement?.cluster || undefined,
      placementTags: c.placement?.tags?.length ? c.placement.tags : undefined,
      republish: c.republish ? { src: c.republish.src, dest: c.republish.dest, headersOnly: c.republish.headers_only } : undefined,
      subjectTransform: c.subject_transform ? { src: c.subject_transform.src, dest: c.subject_transform.dest } : undefined,
      mirrorOf: c.mirror?.name,
      sourceNames: c.sources?.length ? c.sources.map((x) => x.name) : undefined,
      metadata: c.metadata && Object.keys(c.metadata).length ? c.metadata : undefined,
    },
    state: {
      messages: st.messages,
      bytes: st.bytes,
      firstSeq: st.first_seq,
      lastSeq: st.last_seq,
      firstTs: st.messages > 0 ? isoOrUndefined(st.first_ts) : undefined,
      lastTs: isoOrUndefined(st.last_ts),
      numDeleted: st.num_deleted ?? 0,
      numSubjects: st.num_subjects,
      consumerCount: st.consumer_count,
    },
    cluster: cluster && (cluster.leader || cluster.replicas?.length) ? { name: cluster.name, leader: cluster.leader, leaderSince: isoOrUndefined(cluster.leader_since), raftGroup: cluster.raft_group, peers } : undefined,
    mirror: si.mirror ? sourceView(si.mirror, c.mirror) : undefined,
    sources: (si.sources ?? []).map((x) => sourceView(x, c.sources?.find((cfg) => cfg.name === x.name))),
  };
}

export function consumerRow(ci: ConsumerInfo): ConsumerRow {
  const c = ci.config;
  const filters = c.filter_subjects?.length ? c.filter_subjects : c.filter_subject ? [c.filter_subject] : [];
  return {
    name: ci.name,
    description: c.description || undefined,
    kind: c.deliver_subject ? "push" : "pull",
    durable: !!c.durable_name,
    paused: !!ci.paused,
    pushBound: !!ci.push_bound,
    filters,
    ackPolicy: String(c.ack_policy),
    deliverPolicy: String(c.deliver_policy),
    numPending: ci.num_pending ?? 0,
    numAckPending: ci.num_ack_pending ?? 0,
    numRedelivered: ci.num_redelivered ?? 0,
    numWaiting: ci.num_waiting ?? 0,
    maxAckPending: c.max_ack_pending ?? -1,
    maxDeliver: c.max_deliver ?? -1,
    ackWaitMs: nsToMs(c.ack_wait),
    deliveredStreamSeq: ci.delivered?.stream_seq ?? 0,
    deliveredConsumerSeq: ci.delivered?.consumer_seq ?? 0,
    ackFloorStreamSeq: ci.ack_floor?.stream_seq ?? 0,
    ackFloorConsumerSeq: ci.ack_floor?.consumer_seq ?? 0,
    lastActive: isoOrUndefined(ci.delivered?.last_active as unknown),
    created: ci.created,
    replicas: c.num_replicas || undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Rates between two polls
// ---------------------------------------------------------------------------------------------

export interface Rates {
  /** Elapsed seconds between the samples. */
  dt: number;
  /** Messages appended per second (Δ last_seq). null after a sequence reset. */
  ingest: number | null;
  /** Estimated ingest bytes per second (ingest × average stored message size). */
  ingestBytes: number | null;
  /** Net change of stored bytes per second (negative when limits remove more than arrives). */
  storedBytes: number | null;
  /** Deliveries per second per consumer (Δ delivered.consumer_seq, includes redeliveries). */
  delivered: Record<string, number | null>;
}

/** Per-second rates between two snapshots of the same stream; undefined without a usable interval. */
export function deriveRates(prev: StreamSnapshot | undefined, cur: StreamSnapshot): Rates | undefined {
  if (!prev || prev.stream.name !== cur.stream.name) return undefined;
  const t0 = prev.serverAt && cur.serverAt ? prev.serverAt : prev.at;
  const t1 = prev.serverAt && cur.serverAt ? cur.serverAt : cur.at;
  const dt = (t1 - t0) / 1000;
  if (!(dt > 0)) return undefined;
  const a = prev.stream.state;
  const b = cur.stream.state;
  const dSeq = b.lastSeq - a.lastSeq;
  const ingest = dSeq >= 0 ? dSeq / dt : null;
  const avg = b.messages > 0 ? b.bytes / b.messages : a.messages > 0 ? a.bytes / a.messages : 0;
  const delivered: Record<string, number | null> = {};
  const before = new Map(prev.consumers.map((c) => [c.name, c]));
  for (const c of cur.consumers) {
    const p = before.get(c.name);
    if (!p || p.created !== c.created) continue;
    const d = c.deliveredConsumerSeq - p.deliveredConsumerSeq;
    delivered[c.name] = d >= 0 ? d / dt : null;
  }
  return { dt, ingest, ingestBytes: ingest === null ? null : ingest * avg, storedBytes: (b.bytes - a.bytes) / dt, delivered };
}

/**
 * Seconds until `current` reaches `limit` growing at `ratePerSec`. undefined when there is no
 * limit, no growth or the limit is already reached.
 */
export function timeToLimit(current: number, limit: number, ratePerSec: number | null | undefined): number | undefined {
  if (!(limit > 0) || typeof ratePerSec !== "number" || !(ratePerSec > 0) || current >= limit) return undefined;
  return (limit - current) / ratePerSec;
}

// ---------------------------------------------------------------------------------------------
// Consumer status and lag
// ---------------------------------------------------------------------------------------------

export interface ConsumerStatus {
  tone: Tone;
  label: string;
  /** Why (shown as tooltip). */
  reason: string;
  /** Sort weight: higher = needs more attention. */
  severity: number;
}

/** A consumer with pending messages and no delivery for this long is "stalled". */
export const STALL_MS = 5 * 60_000;

export function consumerStatus(c: ConsumerRow, now: number): ConsumerStatus {
  const idleMs = c.lastActive ? now - Date.parse(c.lastActive) : undefined;
  // A consumer that never delivered gets the same grace period from its creation time, so a
  // consumer created seconds ago is not "stalled" before any client had a chance to fetch.
  const createdMs = Date.parse(c.created);
  const sinceCreated = Number.isFinite(createdMs) ? now - createdMs : undefined;
  const backlog = c.numPending + c.numAckPending;
  if (c.paused) return { tone: "neutral", label: "Paused", reason: "The consumer is paused: no messages are delivered until it resumes.", severity: 1 };
  if (c.maxAckPending > 0 && c.numAckPending >= c.maxAckPending)
    return { tone: "danger", label: "Blocked", reason: `${c.numAckPending} unacknowledged deliveries reached max_ack_pending (${c.maxAckPending}): no new messages are delivered until clients ack.`, severity: 5 };
  if (c.kind === "push" && !c.pushBound && backlog > 0)
    return { tone: "warn", label: "No subscriber", reason: "Push consumer without an active subscription on its deliver subject: messages are not being delivered.", severity: 4 };
  if (c.numPending > 0 && (idleMs !== undefined ? idleMs > STALL_MS : sinceCreated === undefined || sinceCreated > STALL_MS))
    return { tone: "warn", label: "Stalled", reason: `${c.numPending} pending with ${idleMs === undefined ? "no delivery since the consumer was created" : "no delivery in the last 5 minutes"}. Are any clients fetching?`, severity: 4 };
  if (c.maxAckPending > 0 && c.numAckPending >= c.maxAckPending * 0.8)
    return { tone: "warn", label: "Near ack limit", reason: `${c.numAckPending} of max_ack_pending ${c.maxAckPending} in flight: delivery stops at the limit.`, severity: 3 };
  if (c.numRedelivered > 0)
    return { tone: "warn", label: "Redelivering", reason: `${c.numRedelivered} messages were redelivered: clients nak, time out (ack_wait) or crash before acking.`, severity: 2 };
  if (backlog === 0) return { tone: "ok", label: "Caught up", reason: "Nothing pending or awaiting acknowledgement.", severity: 0 };
  if (idleMs === undefined && c.numPending > 0)
    return { tone: "neutral", label: "Not started", reason: `${c.numPending} pending; the consumer was created recently and has not delivered yet. It turns "Stalled" after 5 minutes without a delivery.`, severity: 1 };
  return { tone: "ok", label: "Processing", reason: `${backlog} messages pending or in flight; deliveries are flowing.`, severity: 0 };
}

export interface LagSegments {
  /** Stream messages at or below the ack floor (sequence range). */
  acked: number;
  ackPending: number;
  pending: number;
  /** Stored sequence range of the stream (last − first + 1). */
  total: number;
}

/**
 * Consumer position relative to the stream: acked up to the ack floor (sequence range from the
 * first stored message), ack pending and pending counts, against the stream's stored range.
 */
export function lagSegments(c: ConsumerRow, s: StreamStateView): LagSegments {
  const base = Math.max(0, s.firstSeq - 1);
  const total = Math.max(0, s.lastSeq - base);
  const acked = Math.min(total, Math.max(0, c.ackFloorStreamSeq - base));
  return { acked, ackPending: Math.max(0, c.numAckPending), pending: Math.max(0, c.numPending), total };
}

// ---------------------------------------------------------------------------------------------
// Limits and policies
// ---------------------------------------------------------------------------------------------

export type LimitId = "msgs" | "bytes" | "age" | "perSubject" | "consumers";

export interface LimitUsage {
  id: LimitId;
  label: string;
  value: number;
  /** ≤ 0 = unlimited. */
  max: number;
  unit: "msgs" | "bytes" | "ms" | "count";
  /** Rolling limits (discard old, max age) are normal operation at 100%: never alarming. */
  rolling: boolean;
  hint: string;
}

/** Usage of every stream limit. `largestSubject` = messages on the busiest subject, when known. */
export function limitUsages(v: StreamView, now: number, largestSubject?: number): LimitUsage[] {
  const c = v.config;
  const s = v.state;
  const discardNew = c.discard === "new";
  const ageMs = s.messages > 0 && s.firstTs ? Math.max(0, now - Date.parse(s.firstTs)) : 0;
  return [
    {
      id: "msgs",
      label: "Messages",
      value: s.messages,
      max: c.maxMsgs,
      unit: "msgs",
      rolling: !discardNew,
      hint: c.maxMsgs > 0 ? (discardNew ? "max_msgs: new publishes are rejected at the limit" : "max_msgs: the oldest messages are removed at the limit") : "max_msgs not set",
    },
    {
      id: "bytes",
      label: "Size",
      value: s.bytes,
      max: c.maxBytes,
      unit: "bytes",
      rolling: !discardNew,
      hint: c.maxBytes > 0 ? (discardNew ? "max_bytes: new publishes are rejected at the limit" : "max_bytes: the oldest messages are removed at the limit") : "max_bytes not set",
    },
    { id: "age", label: "Oldest message age", value: ageMs, max: c.maxAgeMs, unit: "ms", rolling: true, hint: c.maxAgeMs > 0 ? "max_age: messages older than this expire" : "max_age not set" },
    {
      id: "perSubject",
      label: "Busiest subject",
      value: largestSubject ?? 0,
      max: c.maxMsgsPerSubject,
      unit: "msgs",
      rolling: !(discardNew && c.discardNewPerSubject),
      hint:
        c.maxMsgsPerSubject > 0
          ? discardNew && c.discardNewPerSubject
            ? "max_msgs_per_subject with discard_new_per_subject: publishes to a full subject are rejected"
            : "max_msgs_per_subject: the oldest message of the subject is removed at the limit"
          : "max_msgs_per_subject not set",
    },
    { id: "consumers", label: "Consumers", value: s.consumerCount, max: c.maxConsumers, unit: "count", rolling: false, hint: c.maxConsumers > 0 ? "max_consumers: creating more consumers fails" : "max_consumers not set" },
  ];
}

/** Tone override for a limit gauge: rolling limits stay informational even when full. */
export function limitTone(u: LimitUsage): Tone | undefined {
  if (!(u.max > 0)) return "info";
  if (u.rolling) return "info";
  return undefined;
}

export function discardNote(c: StreamConfigView): string {
  if (c.discard === "new") {
    return c.discardNewPerSubject
      ? "Discard new (per subject): at a limit, new publishes are rejected with an error, including publishes to a subject at max_msgs_per_subject. Stored messages are kept."
      : "Discard new: at a limit, new publishes are rejected with an error. Stored messages are kept.";
  }
  return "Discard old: at a limit, the oldest messages are removed to make room. Publishes keep succeeding.";
}

export function retentionNote(c: StreamConfigView): string {
  switch (c.retention) {
    case "interest":
      return "Interest retention: a message is removed once every consumer has acknowledged it (or a limit removes it). Without consumers, nothing is kept.";
    case "workqueue":
      return "Work-queue retention: each message is removed as soon as one consumer acknowledges it. Consumer filters must not overlap.";
    default:
      return "Limits retention: messages are kept until a limit (count, size, age) removes them.";
  }
}

/** Overall stream tone from consumers, replication and sources. */
export function streamStatus(snap: StreamSnapshot, now: number): { tone: Tone; label: string } {
  const worst = snap.consumers.map((c) => consumerStatus(c, now)).reduce((m, s) => Math.max(m, s.severity), 0);
  const offline = snap.stream.cluster?.peers.some((p) => p.offline || !p.current);
  const sourceErr = [snap.stream.mirror, ...snap.stream.sources].some((x) => x?.error);
  if (worst >= 5 || sourceErr) return { tone: "danger", label: sourceErr ? "Source error" : "Consumer blocked" };
  if (offline) return { tone: "warn", label: "Replica behind" };
  if (worst >= 2) return { tone: "warn", label: "Needs attention" };
  return { tone: "ok", label: "Healthy" };
}

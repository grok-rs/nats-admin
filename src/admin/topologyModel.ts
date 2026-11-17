// JetStream topology model: the data the host collects (TopologyData) and the pure graph
// builder the webview uses (subjects → streams → consumers, mirror/source edges, service
// endpoints). No vscode / node imports: bundled into webview/topology.tsx and unit tested.

import { subjectsOverlap } from "../shared/subjects";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

// ---------------------------------------------------------------------------------------------
// Data collected on the host
// ---------------------------------------------------------------------------------------------

export type StreamKind = "stream" | "kv" | "obj";

export interface TopoOrigin {
  /** Origin stream name. */
  name: string;
  /** External API prefix / domain when the origin lives in another account or domain. */
  external?: string;
  /** Messages behind the origin. */
  lag?: number;
  /** ms since the origin was last seen (−1 / undefined = unknown). */
  activeMs?: number;
  filter?: string;
  error?: string;
}

export interface TopoStream {
  name: string;
  kind: StreamKind;
  /** Bucket name for KV / Object Store backing streams. */
  bucket?: string;
  description?: string;
  subjects: string[];
  messages: number;
  bytes: number;
  consumerCount: number;
  firstSeq?: number;
  lastSeq?: number;
  lastTs?: string;
  storage: string;
  retention: string;
  replicas: number;
  maxBytes: number;
  maxMsgs: number;
  sealed?: boolean;
  mirror?: TopoOrigin;
  sources?: TopoOrigin[];
  cluster?: { name?: string; leader?: string; replicasCurrent?: number; replicasTotal?: number };
  created?: string;
}

export interface TopoConsumer {
  stream: string;
  name: string;
  durable: boolean;
  kind: "pull" | "push";
  /** num_pending: messages not yet delivered. */
  pending: number;
  /** num_ack_pending: delivered, awaiting ack. */
  ackPending: number;
  redelivered: number;
  /** num_waiting: pull requests waiting. */
  waiting: number;
  maxAckPending: number;
  ackPolicy: string;
  deliverPolicy?: string;
  filterSubjects: string[];
  deliverSubject?: string;
  deliverGroup?: string;
  pushBound?: boolean;
  paused?: boolean;
  lastActive?: string;
}

export interface TopoEndpoint {
  service: string;
  version: string;
  name: string;
  subject: string;
  queueGroup?: string;
  instances: number;
  requests: number;
  errors: number;
  avgLatencyNs?: number;
  lastError?: string;
}

export interface TopologyData {
  at: number;
  jetstream: boolean;
  jetstreamError?: string;
  account?: string;
  streams: TopoStream[];
  consumers: TopoConsumer[];
  endpoints: TopoEndpoint[];
  /** Non-fatal problems (e.g. services discovery failed). */
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------------------------

export type NodeKind = "subject" | "stream" | "kv" | "obj" | "consumer" | "endpoint" | "external";
export type EdgeKind = "capture" | "consume" | "mirror" | "source" | "serves";

export interface NodeRef {
  stream?: string;
  consumer?: string;
  bucket?: string;
  subject?: string;
  service?: string;
  endpoint?: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Second line (stats). */
  sub?: string;
  /** Badge at the right edge, e.g. pending count. */
  badge?: { text: string; tone: Tone; title: string };
  tone: Tone;
  /** Why the tone is not ok (shown in hover cards and the issues list). */
  issues: string[];
  /** Flags such as "mirror", "sourced", "push", "pull", "sealed", "paused", "more". */
  flags: string[];
  ref: NodeRef;
  /** Key stats for hover cards: [label, value, hint?]. */
  stats: [string, string][];
  /** Lower-cased text used by search. */
  search: string;
  /** Deterministic ordering key (type, name). */
  order: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  tone?: Tone;
  title?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilters {
  subjects: boolean;
  consumers: boolean;
  kv: boolean;
  obj: boolean;
  services: boolean;
}

export const DEFAULT_FILTERS: GraphFilters = { subjects: true, consumers: true, kv: true, obj: true, services: true };

export interface HealthThresholds {
  /** Consumer pending above this → warn (nats.health.pendingWarning). */
  pendingWarning: number;
  /** ack pending / max_ack_pending at or above this → warn (nats.health.ackPendingRatio). */
  ackPendingRatio: number;
  /** Stream bytes or msgs / limit at or above → warn / danger. */
  storageWarningRatio: number;
  storageErrorRatio: number;
  /** Mirror / source lag above this → warn. */
  lagWarning: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = { pendingWarning: 10_000, ackPendingRatio: 0.9, storageWarningRatio: 0.8, storageErrorRatio: 0.95, lagWarning: 1000 };

/** Subject nodes shown per stream before folding the rest into "+N more". */
export const MAX_SUBJECTS_PER_STREAM = 6;

/**
 * Consumer nodes shown per stream before folding the rest into "+N more consumers". Consumers
 * over a threshold are always shown (they may exceed the cap), so no issue is ever folded away.
 */
export const MAX_CONSUMERS_PER_STREAM = 12;

// ---- small formatters (kept local so the model stays dependency-free) ----

export function fmtCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "–";
  if (Math.abs(n) < 10_000) return Math.round(n).toLocaleString("en-US");
  const units = ["k", "M", "G", "T"];
  let v = n;
  let i = -1;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${units[i]}`;
}

export function fmtSize(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "–";
  if (n < 0) return "∞";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtAgoMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "never";
  const s = Math.round(ms / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "12s ago" relative to `now`, falling back to the raw value when unparsable. */
export function fmtWhen(iso: string, now: number): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? fmtAgoMs(Math.max(0, now - t)) : iso;
}

const worse = (a: Tone, b: Tone): Tone => {
  const rank: Record<Tone, number> = { neutral: 0, info: 0, ok: 1, warn: 2, danger: 3 };
  return rank[b] > rank[a] ? b : a;
};

export function streamKind(name: string): { kind: StreamKind; bucket?: string } {
  if (name.startsWith("KV_")) return { kind: "kv", bucket: name.slice(3) };
  if (name.startsWith("OBJ_")) return { kind: "obj", bucket: name.slice(4) };
  return { kind: "stream" };
}

function streamTone(s: TopoStream, t: HealthThresholds): { tone: Tone; issues: string[] } {
  let tone: Tone = "ok";
  const issues: string[] = [];
  const ratio = (v: number, max: number) => (max > 0 ? v / max : 0);
  const usage = Math.max(ratio(s.bytes, s.maxBytes), ratio(s.messages, s.maxMsgs));
  if (usage >= t.storageErrorRatio) {
    tone = "danger";
    issues.push(`At ${Math.round(usage * 100)}% of its ${ratio(s.bytes, s.maxBytes) >= ratio(s.messages, s.maxMsgs) ? "max_bytes" : "max_msgs"} limit`);
  } else if (usage >= t.storageWarningRatio) {
    tone = "warn";
    issues.push(`At ${Math.round(usage * 100)}% of its ${ratio(s.bytes, s.maxBytes) >= ratio(s.messages, s.maxMsgs) ? "max_bytes" : "max_msgs"} limit`);
  }
  const origins = [...(s.mirror ? [s.mirror] : []), ...(s.sources ?? [])];
  for (const o of origins) {
    if (o.error) {
      tone = worse(tone, "danger");
      issues.push(`${s.mirror === o ? "Mirror" : "Source"} ${o.name}: ${o.error}`);
    } else if ((o.lag ?? 0) > t.lagWarning) {
      tone = worse(tone, "warn");
      issues.push(`${s.mirror === o ? "Mirror" : "Source"} ${o.name} is ${fmtCount(o.lag)} msgs behind`);
    }
  }
  const c = s.cluster;
  if (c && c.replicasTotal !== undefined && c.replicasCurrent !== undefined && c.replicasCurrent < c.replicasTotal) {
    tone = worse(tone, "warn");
    issues.push(`${c.replicasTotal - c.replicasCurrent} of ${c.replicasTotal} replicas not current`);
  }
  if (c && s.replicas > 1 && !c.leader) {
    tone = worse(tone, "danger");
    issues.push("No stream leader");
  }
  return { tone, issues };
}

function consumerTone(c: TopoConsumer, t: HealthThresholds): { tone: Tone; issues: string[] } {
  let tone: Tone = "ok";
  const issues: string[] = [];
  if (c.pending > t.pendingWarning) {
    tone = "warn";
    issues.push(`${fmtCount(c.pending)} pending (warning above ${t.pendingWarning.toLocaleString("en-US")})`);
  }
  if (c.maxAckPending > 0 && c.ackPending / c.maxAckPending >= t.ackPendingRatio) {
    tone = worse(tone, c.ackPending >= c.maxAckPending ? "danger" : "warn");
    issues.push(`Ack pending ${fmtCount(c.ackPending)} of max ${fmtCount(c.maxAckPending)}`);
  }
  if (c.kind === "push" && c.pushBound === false && c.durable) {
    tone = worse(tone, "warn");
    issues.push("Push consumer has no active subscriber");
  }
  if (c.paused) {
    tone = worse(tone, "info");
    issues.push("Paused");
  }
  return { tone, issues };
}

function endpointTone(e: TopoEndpoint): { tone: Tone; issues: string[] } {
  if (e.errors > 0) {
    const rate = e.requests > 0 ? e.errors / e.requests : 1;
    return { tone: rate >= 0.05 ? "danger" : "warn", issues: [`${fmtCount(e.errors)} errors of ${fmtCount(e.requests)} requests${e.lastError ? ` — last: ${e.lastError}` : ""}`] };
  }
  return { tone: "ok", issues: [] };
}

const KIND_ORDER: Record<NodeKind, number> = { subject: 0, external: 1, stream: 2, kv: 3, obj: 4, consumer: 5, endpoint: 6 };

export const streamNodeId = (name: string) => `stream:${name}`;
export const consumerNodeId = (stream: string, name: string) => `cons:${stream}/${name}`;
export const subjectNodeId = (stream: string, subject: string) => `subj:${stream}:${subject}`;
export const endpointNodeId = (e: { service: string; subject: string; name: string }) => `ep:${e.service}:${e.name}:${e.subject}`;
export const externalNodeId = (o: TopoOrigin) => `ext:${o.name}@${o.external ?? ""}`;
/** The "+N more consumers" node of a stream (a distinct prefix: it can never clash with a consumer name). */
export const moreConsumersNodeId = (stream: string) => `cons+more:${stream}`;

function streamLabel(s: TopoStream): string {
  return s.bucket ?? s.name;
}

/**
 * Build the graph from collected data. Deterministic: the same data and filters always give the
 * same nodes and edges in the same order.
 */
export function buildGraph(data: TopologyData, filters: GraphFilters = DEFAULT_FILTERS, thresholds: HealthThresholds = DEFAULT_THRESHOLDS): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byId = new Map<string, GraphNode>();
  const add = (n: GraphNode) => {
    if (byId.has(n.id)) return byId.get(n.id)!;
    byId.set(n.id, n);
    nodes.push(n);
    return n;
  };
  const visible = (s: TopoStream) => (s.kind === "kv" ? filters.kv : s.kind === "obj" ? filters.obj : true);
  const streams = [...data.streams].sort((a, b) => a.name.localeCompare(b.name));
  const streamNames = new Set(streams.filter(visible).map((s) => s.name));

  for (const s of streams) {
    if (!visible(s)) continue;
    const { tone, issues } = streamTone(s, thresholds);
    const flags: string[] = [];
    if (s.mirror) flags.push("mirror");
    if (s.sources?.length) flags.push("sourced");
    if (s.sealed) flags.push("sealed");
    if (s.storage === "memory") flags.push("memory");
    const kindLabel = s.kind === "kv" ? "KV bucket" : s.kind === "obj" ? "Object store" : s.mirror ? "Mirror stream" : s.sources?.length ? "Sourced stream" : "Stream";
    const stats: [string, string][] = [
      ["Type", kindLabel],
      ...(s.bucket ? ([["Backing stream", s.name]] as [string, string][]) : []),
      ["Messages", fmtCount(s.messages)],
      ["Size", fmtSize(s.bytes)],
      ["Consumers", fmtCount(s.consumerCount)],
      ["Storage", `${s.storage} · R${s.replicas}`],
      ["Retention", s.retention],
    ];
    if (s.maxBytes > 0) stats.push(["Max bytes", fmtSize(s.maxBytes)]);
    if (s.maxMsgs > 0) stats.push(["Max msgs", fmtCount(s.maxMsgs)]);
    if (s.lastTs) stats.push(["Last message", fmtWhen(s.lastTs, data.at)]);
    if (s.cluster?.leader) stats.push(["Leader", s.cluster.leader]);
    add({
      id: streamNodeId(s.name),
      kind: s.kind,
      label: streamLabel(s),
      sub: `${fmtCount(s.messages)} msgs · ${fmtSize(s.bytes)}`,
      tone,
      issues,
      flags,
      ref: { stream: s.name, bucket: s.bucket },
      stats,
      search: [s.name, s.bucket, s.description, ...s.subjects].filter(Boolean).join(" ").toLowerCase(),
      order: `${KIND_ORDER[s.kind]}:${s.name}`,
    });

    if (filters.subjects) {
      const shown = s.subjects.slice(0, MAX_SUBJECTS_PER_STREAM);
      const rest = s.subjects.slice(MAX_SUBJECTS_PER_STREAM);
      for (const subj of shown) {
        const id = subjectNodeId(s.name, subj);
        add({
          id,
          kind: "subject",
          label: subj,
          tone: "neutral",
          issues: [],
          flags: [],
          ref: { subject: subj, stream: s.name },
          stats: [
            ["Subject pattern", subj],
            ["Captured by", s.name],
          ],
          search: `${subj} ${s.name}`.toLowerCase(),
          order: `0:${s.name}:${subj}`,
        });
        edges.push({ id: `e:${id}->${s.name}`, from: id, to: streamNodeId(s.name), kind: "capture", title: `${subj} is stored in ${s.name}` });
      }
      if (rest.length) {
        const id = `subj:${s.name}:+more`;
        add({
          id,
          kind: "subject",
          label: `+${rest.length} more`,
          tone: "neutral",
          issues: [],
          flags: ["more"],
          ref: { stream: s.name },
          stats: [["Subjects", `${rest.slice(0, 12).join(", ")}${rest.length > 12 ? `, … (${rest.length - 12} more)` : ""}`]],
          search: rest.join(" ").toLowerCase(),
          order: `0:${s.name}:~`,
        });
        edges.push({ id: `e:${id}->${s.name}`, from: id, to: streamNodeId(s.name), kind: "capture", title: `${rest.length} more subjects stored in ${s.name}` });
      }
    }
  }

  // Mirror / source edges (origin → target). Origins outside the account become "external" nodes.
  for (const s of streams) {
    if (!streamNames.has(s.name)) continue;
    const origins: [TopoOrigin, EdgeKind][] = [...(s.mirror ? [[s.mirror, "mirror"] as [TopoOrigin, EdgeKind]] : []), ...(s.sources ?? []).map((o) => [o, "source"] as [TopoOrigin, EdgeKind])];
    for (const [o, kind] of origins) {
      let from: string;
      if (!o.external && streamNames.has(o.name)) from = streamNodeId(o.name);
      else if (!o.external && data.streams.some((x) => x.name === o.name)) continue; // origin hidden by a filter
      else {
        from = externalNodeId(o);
        add({
          id: from,
          kind: "external",
          label: o.name,
          sub: o.external ? `via ${o.external}` : "not in this account",
          tone: "neutral",
          issues: [],
          flags: [],
          ref: {},
          stats: [
            ["Origin stream", o.name],
            ["Location", o.external ? `external API ${o.external}` : "not found in this account"],
          ],
          search: `${o.name} ${o.external ?? ""}`.toLowerCase(),
          order: `1:${o.name}`,
        });
      }
      const lagTone: Tone = o.error ? "danger" : (o.lag ?? 0) > thresholds.lagWarning ? "warn" : "ok";
      edges.push({
        id: `e:${from}->${s.name}:${kind}`,
        from,
        to: streamNodeId(s.name),
        kind,
        label: o.lag !== undefined ? `lag ${fmtCount(o.lag)}` : undefined,
        tone: lagTone,
        title: `${kind === "mirror" ? "Mirrored" : "Sourced"} from ${o.name}${o.filter ? ` (filter ${o.filter})` : ""}${o.lag !== undefined ? ` · ${fmtCount(o.lag)} msgs behind` : ""}${o.activeMs !== undefined && o.activeMs >= 0 ? ` · active ${fmtAgoMs(o.activeMs)}` : ""}${o.error ? ` · ${o.error}` : ""}`,
      });
    }
  }

  if (filters.consumers) {
    const consumers = [...data.consumers].sort((a, b) => a.stream.localeCompare(b.stream) || a.name.localeCompare(b.name));
    const byStream = new Map<string, { c: TopoConsumer; tone: Tone; issues: string[] }[]>();
    for (const c of consumers) {
      if (!streamNames.has(c.stream)) continue;
      const list = byStream.get(c.stream) ?? byStream.set(c.stream, []).get(c.stream)!;
      list.push({ c, ...consumerTone(c, thresholds) });
    }
    for (const [stream, list] of byStream) {
      const flagged = list.filter((x) => x.tone === "warn" || x.tone === "danger");
      const room = Math.max(0, MAX_CONSUMERS_PER_STREAM - flagged.length);
      const shown = new Set([...flagged, ...list.filter((x) => !flagged.includes(x)).slice(0, room)]);
      const folded = list.filter((x) => !shown.has(x));
      for (const x of list) if (shown.has(x)) addConsumer(x.c, x.tone, x.issues);
      if (folded.length) {
        const id = moreConsumersNodeId(stream);
        const pending = folded.reduce((a, x) => a + x.c.pending, 0);
        const ackPending = folded.reduce((a, x) => a + x.c.ackPending, 0);
        const names = folded.map((x) => x.c.name);
        add({
          id,
          kind: "consumer",
          label: `+${folded.length} more consumers`,
          sub: `${fmtCount(pending)} pending · ${fmtCount(ackPending)} ack pending`,
          badge: { text: fmtCount(pending), tone: pending > 0 ? "info" : "neutral", title: `${pending.toLocaleString("en-US")} pending messages across ${folded.length} folded consumers` },
          tone: "ok",
          issues: [],
          flags: ["more"],
          ref: { stream },
          stats: [
            ["Folded consumers", `${names.slice(0, 12).join(", ")}${names.length > 12 ? `, … (${names.length - 12} more)` : ""}`],
            ["Pending", fmtCount(pending)],
            ["Ack pending", fmtCount(ackPending)],
          ],
          search: `${names.join(" ")} ${stream}`.toLowerCase(),
          order: `5:${stream}:~`,
        });
        edges.push({ id: `e:${stream}->${id}`, from: streamNodeId(stream), to: id, kind: "consume", title: `${folded.length} more consumers read ${stream} (none over a threshold)` });
      }
    }
  }

  function addConsumer(c: TopoConsumer, tone: Tone, issues: string[]): void {
    const id = consumerNodeId(c.stream, c.name);
    const flags: string[] = [c.kind];
    if (c.paused) flags.push("paused");
    if (!c.durable) flags.push("ephemeral");
    const stats: [string, string][] = [
      ["Type", `${c.kind} · ${c.durable ? "durable" : "ephemeral"}`],
      ["Pending", fmtCount(c.pending)],
      ["Ack pending", `${fmtCount(c.ackPending)}${c.maxAckPending > 0 ? ` / ${fmtCount(c.maxAckPending)}` : ""}`],
      ["Redelivered", fmtCount(c.redelivered)],
      ["Ack policy", c.ackPolicy],
    ];
    if (c.kind === "pull") stats.push(["Waiting pulls", fmtCount(c.waiting)]);
    if (c.deliverSubject) stats.push(["Deliver subject", c.deliverSubject]);
    if (c.filterSubjects.length) stats.push(["Filter", c.filterSubjects.join(", ")]);
    if (c.lastActive) stats.push(["Last delivery", fmtWhen(c.lastActive, data.at)]);
    add({
      id,
      kind: "consumer",
      label: c.name,
      sub: `${c.kind}${c.filterSubjects.length ? ` · ${c.filterSubjects[0]}${c.filterSubjects.length > 1 ? ` +${c.filterSubjects.length - 1}` : ""}` : ""}`,
      badge: { text: fmtCount(c.pending), tone: tone === "ok" ? (c.pending > 0 ? "info" : "neutral") : tone, title: `${c.pending.toLocaleString("en-US")} pending messages` },
      tone,
      issues,
      flags,
      ref: { stream: c.stream, consumer: c.name },
      stats,
      search: `${c.name} ${c.stream} ${c.filterSubjects.join(" ")} ${c.deliverSubject ?? ""}`.toLowerCase(),
      order: `5:${c.stream}:${c.name}`,
    });
    edges.push({ id: `e:${c.stream}->${id}`, from: streamNodeId(c.stream), to: id, kind: "consume", title: `${c.name} reads ${c.stream}` });
  }

  if (filters.services) {
    const visibleStreams = streams.filter((s) => streamNames.has(s.name));
    const eps = [...data.endpoints].sort((a, b) => a.service.localeCompare(b.service) || a.subject.localeCompare(b.subject) || a.name.localeCompare(b.name));
    for (const e of eps) {
      const id = endpointNodeId(e);
      const { tone, issues } = endpointTone(e);
      const stats: [string, string][] = [
        ["Service", `${e.service} v${e.version}`],
        ["Endpoint", e.name],
        ["Subject", e.subject],
        ["Instances", fmtCount(e.instances)],
        ["Requests", fmtCount(e.requests)],
        ["Errors", fmtCount(e.errors)],
      ];
      if (e.avgLatencyNs !== undefined) stats.push(["Avg latency", `${(e.avgLatencyNs / 1e6).toFixed(2)} ms`]);
      if (e.queueGroup) stats.push(["Queue group", e.queueGroup]);
      add({
        id,
        kind: "endpoint",
        label: `${e.service} · ${e.name}`,
        sub: e.subject,
        badge: e.errors > 0 ? { text: fmtCount(e.errors), tone, title: `${e.errors} errors` } : undefined,
        tone,
        issues,
        flags: [],
        ref: { service: e.service, endpoint: e.name, subject: e.subject },
        stats,
        search: `${e.service} ${e.name} ${e.subject}`.toLowerCase(),
        order: `6:${e.service}:${e.subject}`,
      });
      for (const s of visibleStreams) {
        const hit = s.subjects.find((p) => subjectsOverlap(p, e.subject));
        if (hit) edges.push({ id: `e:${s.name}->${id}`, from: streamNodeId(s.name), to: id, kind: "serves", label: undefined, title: `${e.subject} overlaps ${hit} (stored in ${s.name})` });
      }
    }
  }

  return { nodes, edges };
}

/** Nodes upstream and downstream of `id` (inclusive): the lineage highlighted on hover. */
export function lineage(graph: Graph, id: string): Set<string> {
  const out = new Set<string>([id]);
  const fwd = new Map<string, string[]>();
  const back = new Map<string, string[]>();
  for (const e of graph.edges) {
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
    (back.get(e.to) ?? back.set(e.to, []).get(e.to)!).push(e.from);
  }
  const walk = (start: string, adj: Map<string, string[]>) => {
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of adj.get(n) ?? []) {
        if (!out.has(m)) {
          out.add(m);
          stack.push(m);
        }
      }
    }
  };
  walk(id, fwd);
  walk(id, back);
  return out;
}

export interface TopologyTotals {
  streams: number;
  kv: number;
  obj: number;
  consumers: number;
  subjects: number;
  endpoints: number;
  services: number;
  messages: number;
  bytes: number;
  pending: number;
  ackPending: number;
  issues: { warn: number; danger: number };
}

export function topologyTotals(data: TopologyData, graph?: Graph): TopologyTotals {
  const g = graph ?? buildGraph(data);
  let warn = 0;
  let danger = 0;
  for (const n of g.nodes) {
    if (n.tone === "warn") warn++;
    else if (n.tone === "danger") danger++;
  }
  return {
    streams: data.streams.filter((s) => s.kind === "stream").length,
    kv: data.streams.filter((s) => s.kind === "kv").length,
    obj: data.streams.filter((s) => s.kind === "obj").length,
    consumers: data.consumers.length,
    subjects: data.streams.reduce((a, s) => a + s.subjects.length, 0),
    endpoints: data.endpoints.length,
    services: new Set(data.endpoints.map((e) => e.service)).size,
    messages: data.streams.reduce((a, s) => a + s.messages, 0),
    bytes: data.streams.reduce((a, s) => a + s.bytes, 0),
    pending: data.consumers.reduce((a, c) => a + c.pending, 0),
    ackPending: data.consumers.reduce((a, c) => a + c.ackPending, 0),
    issues: { warn, danger },
  };
}

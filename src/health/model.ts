// Health doctor data model, shared by the extension host, the unit tests and the
// Health Dashboard webview. Pure: type-only imports, no vscode, no Node APIs.

import type { ConsumerInfo, JetStreamAccountStats, StreamInfo } from "@nats-io/jetstream";

export type Severity = "error" | "warning" | "info";
export type Category = "stream" | "consumer" | "kv" | "objectstore" | "account" | "server" | "connection";
export type TargetKind = Category;

export const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];
export const CATEGORIES: readonly Category[] = ["connection", "server", "account", "stream", "consumer", "kv", "objectstore"];

export const SEVERITY_LABEL: Record<Severity, string> = { error: "Error", warning: "Warning", info: "Info" };
export const SEVERITY_PLURAL: Record<Severity, string> = { error: "Errors", warning: "Warnings", info: "Info" };
export const CATEGORY_LABEL: Record<Category, string> = {
  stream: "Streams",
  consumer: "Consumers",
  kv: "Key-Value",
  objectstore: "Object Store",
  account: "JetStream account",
  server: "Server",
  connection: "Connection",
};

/** The resource a finding is about. */
export interface FindingTarget {
  kind: TargetKind;
  connId: string;
  stream?: string;
  consumer?: string;
  bucket?: string;
}

/** Suggested action: an existing NATS Admin command and the argument object it is run with. */
export interface FindingFix {
  label: string;
  command: string;
  args: { connId: string; stream?: string; consumer?: string; bucket?: string };
}

export interface Finding {
  /** Unique within a report: `<id>@<targetKey>`. */
  key: string;
  /** Check id, e.g. "stream.unbounded". */
  id: string;
  severity: Severity;
  category: Category;
  target: FindingTarget;
  title: string;
  /** What was observed, with numbers. */
  detail: string;
  /** Why it matters and the NATS best practice. */
  recommendation: string;
  fix?: FindingFix;
  /** Documentation link for the best practice. */
  docs?: string;
  /** Score weight multiplier (default 1). */
  weight?: number;
  /** Quantity behind the finding (used for sorting and the dashboard). */
  metric?: { label: string; value: number; limit?: number; unit?: "count" | "bytes" | "ms" | "ratio" };
}

/** Thresholds from the nats.health.* settings (plus a few fixed ones). */
export interface CheckThresholds {
  /** Consumer pending (undelivered) messages above which to warn. */
  pendingWarning: number;
  /** Fraction of max_ack_pending at which delivery is considered stalled. */
  ackPendingRatio: number;
  storageWarningRatio: number;
  storageErrorRatio: number;
  rttWarningMs: number;
  /** A pull consumer with pending messages and no delivery for this long is idle (ms). */
  idleConsumerMs: number;
  /** JetStream API error ratio that triggers a warning. */
  apiErrorRatio: number;
  /** Oldest server version considered current. */
  minServerVersion: string;
}

export const DEFAULT_THRESHOLDS: CheckThresholds = {
  pendingWarning: 10_000,
  ackPendingRatio: 0.9,
  storageWarningRatio: 0.8,
  storageErrorRatio: 0.95,
  rttWarningMs: 100,
  idleConsumerMs: 5 * 60_000,
  apiErrorRatio: 0.05,
  minServerVersion: "2.10.0",
};

/** Something the collector could not read (permissions, missing JetStream, unreachable monitoring). */
export interface CollectNote {
  scope: "rtt" | "jetstream" | "account" | "streams" | "consumers" | "monitor";
  message: string;
  /** Affected stream (consumer listing). */
  stream?: string;
  permission?: boolean;
}

export interface VarzSubset {
  server_name?: string;
  version?: string;
  connections?: number;
  max_connections?: number;
  slow_consumers?: number;
  slow_consumer_stats?: { clients?: number; routes?: number; gateways?: number; leafs?: number };
  cpu?: number;
  mem?: number;
  cores?: number;
  cluster?: { name?: string; urls?: string[] };
  jetstream?: {
    config?: { max_memory?: number; max_storage?: number };
    stats?: { memory?: number; storage?: number };
  };
}

/** Everything a health run reads from the server (input of the pure checks). */
export interface HealthSnapshot {
  connId: string;
  connName: string;
  /** Epoch ms when collection started. */
  at: number;
  durationMs: number;
  server?: { name: string; id: string; version: string; cluster?: string; jetstream: boolean; host?: string; port?: number };
  connectedUrl?: string;
  rttMs?: number;
  /**
   * enabled = the JetStream API answered. When it did not: permissionDenied = the user may not use it,
   * failed = it could not be determined (timeout, other error), neither = JetStream is not enabled.
   */
  jetstream: { enabled: boolean; reason?: string; permissionDenied?: boolean; failed?: boolean };
  account?: JetStreamAccountStats;
  /** All streams, including KV_ / OBJ_ backing streams. */
  streams: StreamInfo[];
  /** Consumers by stream name. */
  consumers: Record<string, ConsumerInfo[]>;
  monitor: { url?: string; reachable: boolean; error?: string; varz?: VarzSubset; healthz?: { status: string; error?: string } };
  notes: CollectNote[];
  /** Streams beyond the collection cap that were not analysed. */
  skippedStreams?: number;
}

export interface CategorySummary {
  category: Category;
  label: string;
  count: number;
  errors: number;
  warnings: number;
  infos: number;
  score: number;
}

export interface ResourceRow {
  key: string;
  kind: TargetKind;
  name: string;
  /** Stream of a consumer. */
  parent?: string;
  target: FindingTarget;
  worst?: Severity;
  errors: number;
  warnings: number;
  infos: number;
  /** Short metrics line, e.g. "1,204 msgs · 3.2 MiB · R3". */
  summary: string;
  messages?: number;
  bytes?: number;
  pending?: number;
  replicas?: number;
}

export interface AccountUsage {
  memory: number;
  storage: number;
  maxMemory: number;
  maxStorage: number;
  streams: number;
  maxStreams: number;
  consumers: number;
  maxConsumers: number;
  apiTotal: number;
  apiErrors: number;
}

/** Result of one health run, as shown in the tree, the dashboard and the Markdown report. */
export interface HealthReport {
  connId: string;
  connName: string;
  at: number;
  durationMs: number;
  score: number;
  counts: Record<Severity, number>;
  findings: Finding[];
  categories: CategorySummary[];
  resources: ResourceRow[];
  server?: HealthSnapshot["server"];
  connectedUrl?: string;
  rttMs?: number;
  jetstream: HealthSnapshot["jetstream"];
  account?: AccountUsage;
  inventory: { streams: number; consumers: number; kv: number; obj: number };
  monitor: { url?: string; reachable: boolean; error?: string; healthz?: string; slowConsumers?: number };
  notes: CollectNote[];
  thresholds: CheckThresholds;
}

export type ConnStateLite = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type EnvironmentLite = "dev" | "test" | "staging" | "prod";

/** Everything the Health Dashboard webview renders (init data and "update" events). */
export interface HealthViewModel {
  connId: string;
  connName: string;
  environment?: EnvironmentLite;
  readOnly?: boolean;
  state: ConnStateLite;
  running: boolean;
  /** Last run failure (the previous report, if any, stays visible). */
  error?: string;
  report?: HealthReport;
  /** Scores of recent runs (oldest first) for the trend sparkline. */
  history: { at: number; score: number }[];
  /** Connections to switch between (connected or with results). */
  connections: { id: string; name: string; state: ConnStateLite; score?: number; environment?: EnvironmentLite }[];
  autoRun: boolean;
  intervalMinutes: number;
}

// ---------------------------------------------------------------------------------------------
// Target helpers
// ---------------------------------------------------------------------------------------------

export const KV_PREFIX = "KV_";
export const OBJ_PREFIX = "OBJ_";

/** Stable key of a target within a connection: "stream/ORDERS", "consumer/ORDERS/billing", "kv/config", "server". */
export function targetKey(t: FindingTarget): string {
  switch (t.kind) {
    case "stream":
      return `stream/${t.stream ?? ""}`;
    case "consumer":
      return `consumer/${t.stream ?? ""}/${t.consumer ?? ""}`;
    case "kv":
      return `kv/${t.bucket ?? ""}`;
    case "objectstore":
      return `obj/${t.bucket ?? ""}`;
    default:
      return t.kind;
  }
}

/** Human label: "ORDERS", "ORDERS › billing", "KV config", "Object store files", "Server". */
export function targetLabel(t: FindingTarget): string {
  switch (t.kind) {
    case "stream":
      return t.stream ?? "stream";
    case "consumer":
      return `${t.stream ?? "?"} › ${t.consumer ?? "?"}`;
    case "kv":
      return `KV ${t.bucket ?? ""}`.trim();
    case "objectstore":
      return `Object store ${t.bucket ?? ""}`.trim();
    case "account":
      return "JetStream account";
    case "server":
      return "Server";
    case "connection":
      return "Connection";
  }
}

const SEV_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function severityRank(s: Severity): number {
  return SEV_RANK[s];
}

export function worstOf(list: readonly { severity: Severity }[]): Severity | undefined {
  let worst: Severity | undefined;
  for (const f of list) if (!worst || SEV_RANK[f.severity] < SEV_RANK[worst]) worst = f.severity;
  return worst;
}

export function countBySeverity(list: readonly { severity: Severity }[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of list) c[f.severity]++;
  return c;
}

/** Most important first: severity, then category order, then target label. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
    CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
    targetLabel(a.target).localeCompare(targetLabel(b.target), undefined, { numeric: true }) ||
    a.id.localeCompare(b.id)
  );
}

/** "1 error · 3 warnings · 2 info" (empty parts omitted; "no findings" when all zero). */
export function countsText(c: Record<Severity, number>): string {
  const parts: string[] = [];
  if (c.error) parts.push(`${c.error} ${c.error === 1 ? "error" : "errors"}`);
  if (c.warning) parts.push(`${c.warning} ${c.warning === 1 ? "warning" : "warnings"}`);
  if (c.info) parts.push(`${c.info} info`);
  return parts.length ? parts.join(" · ") : "no findings";
}

/** Score 0–100 → "Healthy" (≥90) / "Degraded" (≥60) / "Critical". */
export function scoreLabel(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) return "Unknown";
  return score >= 90 ? "Healthy" : score >= 60 ? "Degraded" : "Critical";
}

/** Explorer node paths (nats-node://<connId><path>) a finding decorates; KV / object store findings also mark their backing stream. */
export function nodePathsFor(f: Pick<Finding, "target">): string[] {
  const t = f.target;
  switch (t.kind) {
    case "stream":
      return t.stream ? [`/stream/${t.stream}`] : [];
    case "consumer":
      return t.stream && t.consumer ? [`/consumer/${t.stream}/${t.consumer}`] : [];
    case "kv":
      return t.bucket ? [`/kv/${t.bucket}`, `/stream/${t.stream ?? KV_PREFIX + t.bucket}`] : [];
    case "objectstore":
      return t.bucket ? [`/obj/${t.bucket}`, `/stream/${t.stream ?? OBJ_PREFIX + t.bucket}`] : [];
    default:
      return ["/server"];
  }
}

/** Explorer decoration data for one node path. */
export interface DecorationMark {
  errors: number;
  warnings: number;
  /** Finding titles (consumer findings rolled up to their stream are prefixed with the consumer name). */
  titles: string[];
}

/**
 * Error / warning marks per explorer node path (info findings are not decorated). Consumer findings
 * also mark their stream: consumer nodes sit collapsed under it, and a stalled consumer must be
 * visible without expanding every stream.
 */
export function decorationMarks(findings: readonly Finding[]): Map<string, DecorationMark> {
  const out = new Map<string, DecorationMark>();
  const add = (path: string, f: Finding, title: string) => {
    let m = out.get(path);
    if (!m) out.set(path, (m = { errors: 0, warnings: 0, titles: [] }));
    if (f.severity === "error") m.errors++;
    else m.warnings++;
    m.titles.push(title);
  };
  for (const f of findings) {
    if (f.severity === "info") continue;
    for (const p of nodePathsFor(f)) add(p, f, f.title);
    if (f.target.kind === "consumer" && f.target.stream && f.target.consumer) add(`/stream/${f.target.stream}`, f, `consumer ${f.target.consumer}: ${f.title}`);
  }
  return out;
}

/** Decoration badge: "!" for a single problem, the count up to 9, then "9+". */
export function badgeFor(n: number): string {
  return n <= 1 ? "!" : n > 9 ? "9+" : String(n);
}

/** Extract a Finding from a command argument (the finding, a tree node with `.finding`, or { finding }). */
export function findingOf(arg: unknown): Finding | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const o = arg as { finding?: unknown; key?: unknown; id?: unknown; target?: unknown; severity?: unknown };
  if (o.finding && typeof o.finding === "object") return findingOf(o.finding);
  if (typeof o.key === "string" && typeof o.id === "string" && o.target && typeof o.severity === "string") return arg as Finding;
  return undefined;
}

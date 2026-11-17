// Collects a HealthSnapshot from a live connection: server info, RTT, JetStream
// account info, every stream (incl. KV_ / OBJ_), consumers per stream and the
// optional HTTP monitoring endpoint (varz / healthz). Never throws for partial
// failures (permissions, JetStream disabled, monitoring unreachable): those are
// recorded as notes and turned into findings by the checks.
// No vscode import — LiveConnection satisfies CollectSource structurally.

import type { NatsConnection, ServerInfo } from "@nats-io/nats-core";
import type { ConsumerInfo, JetStreamManager, StreamInfo } from "@nats-io/jetstream";
import { listConsumers, listStreams } from "../nats/streams";
import { fetchMonitor } from "../nats/monitor";
import type { CollectNote, HealthSnapshot, VarzSubset } from "./model";

export interface CollectSource {
  readonly nc: NatsConnection;
  readonly info?: ServerInfo;
  jsm(): Promise<JetStreamManager>;
}

export interface CollectOptions {
  connId: string;
  connName: string;
  /** HTTP monitoring base URL (e.g. http://127.0.0.1:8222); skipped when undefined. */
  monitorUrl?: string;
  monitorTimeoutMs?: number;
  /** Per-request timeout for RTT / JetStream API calls (ms, default 10s). */
  timeoutMs?: number;
  /** Maximum number of streams analysed (default 5000). */
  maxStreams?: number;
  /** Parallel consumer listings (default 8). */
  concurrency?: number;
  now?: () => number;
}

export function messageOf(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !e.message.includes(cause.message)) return `${e.message}: ${cause.message}`;
    return e.message || e.name;
  }
  return String(e);
}

export function isPermissionError(e: unknown): boolean {
  return /permission|authori[sz]ation|not authorized|403/i.test(messageOf(e));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, t]).finally(() => timer && clearTimeout(timer));
}

/** Run `fn` over items with at most `limit` in flight. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

async function collectMonitor(url: string, timeoutMs: number): Promise<HealthSnapshot["monitor"]> {
  const [varz, healthz] = await Promise.allSettled([fetchMonitor<VarzSubset>(url, "varz", {}, timeoutMs), fetchMonitor<{ status?: string; error?: string }>(url, "healthz", {}, timeoutMs)]);
  if (varz.status === "rejected") {
    const err = messageOf(varz.reason);
    return { url, reachable: false, error: /abort|timeout/i.test(err) ? `no response within ${Math.round(timeoutMs / 1000)}s` : err };
  }
  const v = varz.value;
  const pick: VarzSubset = {
    server_name: v.server_name,
    version: v.version,
    connections: v.connections,
    max_connections: v.max_connections,
    slow_consumers: v.slow_consumers,
    slow_consumer_stats: v.slow_consumer_stats,
    cpu: v.cpu,
    mem: v.mem,
    cores: v.cores,
    cluster: v.cluster?.name ? { name: v.cluster.name, urls: v.cluster.urls } : undefined,
    jetstream: v.jetstream ? { config: v.jetstream.config, stats: v.jetstream.stats } : undefined,
  };
  const h = healthz.status === "fulfilled" && healthz.value && typeof healthz.value.status === "string" ? { status: healthz.value.status, error: healthz.value.error } : undefined;
  return { url, reachable: true, varz: pick, healthz: h };
}

export async function collectSnapshot(src: CollectSource, o: CollectOptions): Promise<HealthSnapshot> {
  const now = o.now ?? Date.now;
  const at = now();
  const timeout = o.timeoutMs ?? 10_000;
  const notes: CollectNote[] = [];
  const info = src.info;
  const snap: HealthSnapshot = {
    connId: o.connId,
    connName: o.connName,
    at,
    durationMs: 0,
    server: info ? { name: info.server_name, id: info.server_id, version: info.version, cluster: info.cluster || undefined, jetstream: !!info.jetstream, host: info.host, port: info.port } : undefined,
    connectedUrl: safeServer(src.nc),
    jetstream: { enabled: false },
    streams: [],
    consumers: {},
    monitor: { url: o.monitorUrl, reachable: false },
    notes,
  };

  const monitorP = o.monitorUrl ? collectMonitor(o.monitorUrl, o.monitorTimeoutMs ?? 2500).catch((e) => ({ url: o.monitorUrl, reachable: false, error: messageOf(e) })) : undefined;

  try {
    snap.rttMs = await withTimeout(src.nc.rtt(), timeout, "RTT");
  } catch (e) {
    notes.push({ scope: "rtt", message: messageOf(e), permission: isPermissionError(e) });
  }

  let jsm: JetStreamManager | undefined;
  try {
    jsm = await withTimeout(src.jsm(), timeout, "JetStream");
    snap.jetstream = { enabled: true };
  } catch (e) {
    const permission = isPermissionError(e);
    // Only "no responders" / "not enabled" mean JetStream is off; a timeout or other error leaves it unknown.
    const failed = !permission && !isJsNotEnabled(e);
    snap.jetstream = { enabled: false, reason: describeJsError(e), permissionDenied: permission || undefined, failed: failed || undefined };
    notes.push({ scope: "jetstream", message: messageOf(e), permission });
  }

  if (jsm) {
    const mgr = jsm;
    try {
      snap.account = await withTimeout(mgr.getAccountInfo(), timeout, "Account info");
    } catch (e) {
      notes.push({ scope: "account", message: messageOf(e), permission: isPermissionError(e) });
    }
    let streams: StreamInfo[] = [];
    try {
      streams = await withTimeout(listStreams(mgr, true), timeout * 3, "Stream listing");
    } catch (e) {
      notes.push({ scope: "streams", message: messageOf(e), permission: isPermissionError(e) });
    }
    const max = o.maxStreams ?? 5000;
    if (streams.length > max) {
      snap.skippedStreams = streams.length - max;
      streams = streams.slice(0, max);
    }
    snap.streams = streams;
    const withConsumers = streams.filter((s) => (s.state.consumer_count ?? 1) > 0);
    await mapPool(withConsumers, o.concurrency ?? 8, async (si) => {
      try {
        const list: ConsumerInfo[] = await withTimeout(listConsumers(mgr, si.config.name), timeout, `Consumers of ${si.config.name}`);
        snap.consumers[si.config.name] = list;
      } catch (e) {
        notes.push({ scope: "consumers", stream: si.config.name, message: messageOf(e), permission: isPermissionError(e) });
      }
    });
  }

  if (monitorP) {
    snap.monitor = await monitorP;
    if (!snap.monitor.reachable) notes.push({ scope: "monitor", message: snap.monitor.error ?? "unreachable" });
  }
  snap.durationMs = Math.max(0, now() - at);
  return snap;
}

function safeServer(nc: NatsConnection): string | undefined {
  try {
    return nc.getServer();
  } catch {
    return undefined;
  }
}

/** The JetStream API is not served for this account (no responders / 503 / "not enabled"). */
export function isJsNotEnabled(e: unknown): boolean {
  return /503|no responders|not enabled/i.test(messageOf(e));
}

function describeJsError(e: unknown): string {
  if (isJsNotEnabled(e)) return "JetStream is not enabled (no responders for $JS.API)";
  return messageOf(e);
}

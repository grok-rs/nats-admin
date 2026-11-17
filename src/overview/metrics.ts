// Collects a compact metrics sample for one live connection (server identity, RTT, client
// counters, /varz when the monitoring endpoint answers, JetStream account usage and stream
// kinds) and turns successive samples into rates + a short history (MetricsTracker).
//
// No vscode import: the connection is passed structurally (LiveConnection satisfies
// MetricsSource), so test/overview.test.ts exercises this against a real nats-server.

import type { NatsConnection } from "@nats-io/nats-core";
import type { JetStreamManager } from "@nats-io/jetstream";
import { fetchMonitor, type VarzLite } from "../nats/monitor";
import {
  appendHistory,
  countStreamKinds,
  RateSampler,
  resolveLimit,
  type Counters,
  type JetStreamSummary,
  type LiveMetrics,
  type MonitorSummary,
  type RateSource,
  type ServerSummary,
  type VarzSummary,
} from "./model";

export interface MetricsSource {
  readonly nc: NatsConnection;
  jsm(): Promise<JetStreamManager>;
  hasJetStream(): Promise<boolean>;
}

export interface CollectOptions {
  /** HTTP monitoring base URL (http://host:8222); omitted → client counters only. */
  monitorUrl?: string;
  /** Skip the monitoring endpoint this time (backoff after failures). */
  skipMonitor?: boolean;
  /** Per-request timeout in ms (default 2500). */
  timeoutMs?: number;
  /** Collect JetStream account usage (default true). */
  jetstream?: boolean;
  /** Also list stream names to count streams / KV buckets / object stores (one paged API call). */
  countKinds?: boolean;
}

export interface RawSample {
  at: number;
  connectedUrl?: string;
  server?: ServerSummary;
  rttMs?: number;
  client: Counters;
  /** Server counters from /varz, the server's own clock and its id. */
  serverCounters?: { t: number; c: Counters; serverId?: string };
  varz?: VarzSummary;
  monitor: MonitorSummary;
  jetstream?: JetStreamSummary;
  /** Stream kinds when countKinds was requested and succeeded. */
  kinds?: { streams: number; kv: number; obj: number; total: number };
}

/** Reject after `ms` (the timer is cleared when `p` settles first). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

function message(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return cause instanceof Error && cause.message && !e.message.includes(cause.message) ? `${e.message}: ${cause.message}` : e.message || e.name;
  }
  return String(e);
}

export function serverSummary(info: NatsConnection["info"]): ServerSummary | undefined {
  if (!info) return undefined;
  return {
    name: info.server_name,
    id: info.server_id,
    version: info.version,
    cluster: info.cluster,
    jetstream: Boolean(info.jetstream),
    clientId: info.client_id,
    clientIp: info.client_ip,
    domain: (info as { domain?: string }).domain,
    tlsRequired: Boolean(info.tls_required),
    authRequired: Boolean(info.auth_required),
  };
}

export function varzSummary(v: VarzLite & { max_connections?: number; routes?: number; leafnodes?: number }): VarzSummary {
  return {
    connections: v.connections,
    totalConnections: v.total_connections,
    maxConnections: v.max_connections,
    subscriptions: v.subscriptions,
    slowConsumers: v.slow_consumers,
    cpu: v.cpu,
    mem: v.mem,
    cores: v.cores,
    uptime: v.uptime,
    start: v.start,
    routes: v.routes,
    leafnodes: v.leafnodes,
  };
}

async function collectJetStream(src: MetricsSource, countKinds: boolean, serverCfg: { max_memory?: number; max_storage?: number } | undefined, timeoutMs: number): Promise<{ js: JetStreamSummary; kinds?: RawSample["kinds"] }> {
  // A reconnecting client would otherwise wait for the full JetStream request timeout (10 s).
  let enabled: boolean;
  try {
    enabled = await withTimeout(src.hasJetStream(), timeoutMs * 2, "JetStream");
  } catch (e) {
    return { js: { enabled: true, error: message(e) } };
  }
  if (!enabled) return { js: { enabled: false } };
  try {
    const jsm = await src.jsm();
    const ai = await withTimeout(jsm.getAccountInfo(), timeoutMs * 2, "JetStream account info");
    const tiers = Object.values(ai.tiers ?? {});
    const mem = resolveLimit(ai.limits?.max_memory, tiers.map((t) => t?.limits?.max_memory), serverCfg?.max_memory);
    const sto = resolveLimit(ai.limits?.max_storage, tiers.map((t) => t?.limits?.max_storage), serverCfg?.max_storage);
    const js: JetStreamSummary = {
      enabled: true,
      totalStreams: ai.streams,
      consumers: ai.consumers,
      memory: ai.memory,
      storage: ai.storage,
      maxMemory: mem.max,
      maxStorage: sto.max,
      memorySource: mem.source,
      storageSource: sto.source,
      maxStreams: ai.limits?.max_streams > 0 ? ai.limits.max_streams : undefined,
      maxConsumers: ai.limits?.max_consumers > 0 ? ai.limits.max_consumers : undefined,
      api: ai.api ? { total: ai.api.total, errors: ai.api.errors } : undefined,
      domain: ai.domain,
    };
    let kinds: RawSample["kinds"];
    if (countKinds) {
      try {
        const names: string[] = [];
        await withTimeout(
          (async () => {
            for await (const n of jsm.streams.names()) names.push(n);
          })(),
          timeoutMs * 2,
          "stream list",
        );
        kinds = countStreamKinds(names);
      } catch {
        /* keep the previous counts */
      }
    }
    return { js, kinds };
  } catch (e) {
    return { js: { enabled: true, error: message(e) } };
  }
}

/** One sample. Never throws: failures are reported per part (monitor.error, jetstream.error). */
export async function collectSample(src: MetricsSource, opts: CollectOptions = {}): Promise<RawSample> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const at = Date.now();
  const nc = src.nc;
  const stats = nc.stats();
  const sample: RawSample = {
    at,
    connectedUrl: nc.getServer(),
    server: serverSummary(nc.info),
    client: { inMsgs: stats.inMsgs, outMsgs: stats.outMsgs, inBytes: stats.inBytes, outBytes: stats.outBytes },
    monitor: { url: opts.monitorUrl, ok: false },
  };

  const varzTask: Promise<(VarzLite & Record<string, any>) | undefined> =
    opts.monitorUrl && !opts.skipMonitor
      ? fetchMonitor<VarzLite & Record<string, any>>(opts.monitorUrl, "varz", {}, timeoutMs).catch((e) => {
          sample.monitor.error = message(e);
          return undefined;
        })
      : Promise.resolve(undefined);
  if (!opts.monitorUrl) sample.monitor.error = "No monitoring URL (WebSocket connections need an explicit Monitor URL)";
  else if (opts.skipMonitor) sample.monitor.error = "Monitoring endpoint unreachable (retrying shortly)";

  const rttTask = withTimeout(nc.rtt(), timeoutMs, "RTT").catch(() => undefined);
  const varz = await varzTask;
  if (varz && typeof varz.in_msgs === "number") {
    sample.monitor.ok = true;
    sample.monitor.error = undefined;
    sample.varz = varzSummary(varz);
    sample.serverCounters = { t: Date.parse(varz.now) || at, c: { inMsgs: varz.in_msgs, outMsgs: varz.out_msgs, inBytes: varz.in_bytes, outBytes: varz.out_bytes }, serverId: varz.server_id };
  } else if (varz) {
    sample.monitor.error = "Unexpected /varz response";
  }
  const serverCfg = varz?.jetstream?.config as { max_memory?: number; max_storage?: number } | undefined;
  const [rtt, js] = await Promise.all([rttTask, opts.jetstream === false ? Promise.resolve(undefined) : collectJetStream(src, !!opts.countKinds, serverCfg, timeoutMs)]);
  sample.rttMs = rtt;
  if (js) {
    sample.jetstream = js.js;
    sample.kinds = js.kinds;
  }
  return sample;
}

/**
 * Turns raw samples into LiveMetrics: per-second rates (server counters when monitoring is up,
 * else this client's counters), stream-kind counts carried over between listings, and a short
 * history for sparklines. One tracker serves every profile.
 */
export class MetricsTracker {
  private readonly rates = new RateSampler();
  private readonly state = new Map<string, { history: LiveMetrics["history"]; kinds?: RawSample["kinds"]; kindsAt?: number }>();

  constructor(
    private readonly historyCap = 90,
    /** Re-list stream names at most this often (ms). */
    private readonly kindsTtlMs = 20_000,
  ) {}

  needsKinds(profileId: string, now = Date.now()): boolean {
    const st = this.state.get(profileId);
    return !st?.kindsAt || now - st.kindsAt >= this.kindsTtlMs;
  }

  /** Force a fresh stream listing on the next sample (after create/delete). */
  invalidateKinds(profileId: string): void {
    const st = this.state.get(profileId);
    if (st) st.kindsAt = undefined;
  }

  ingest(profileId: string, raw: RawSample): LiveMetrics {
    let st = this.state.get(profileId);
    if (!st) this.state.set(profileId, (st = { history: [] }));
    const source: RateSource = raw.serverCounters ? "server" : "client";
    const counters = raw.serverCounters ?? { t: raw.at, c: raw.client };
    const r = this.rates.update(profileId, source, counters.t, counters.c, raw.serverCounters?.serverId);
    if (raw.kinds) {
      st.kinds = raw.kinds;
      st.kindsAt = raw.at;
    }
    let js = raw.jetstream;
    if (js?.enabled && !js.error) {
      const k = st.kinds;
      js = { ...js, streams: k ? k.streams : js.totalStreams, kv: k?.kv, obj: k?.obj };
    }
    st.history = appendHistory(st.history, { t: raw.at, rtt: raw.rttMs, msgsIn: r?.msgsIn, msgsOut: r?.msgsOut, bytesIn: r?.bytesIn, bytesOut: r?.bytesOut, cpu: raw.varz?.cpu }, this.historyCap);
    return {
      profileId,
      at: raw.at,
      connectedUrl: raw.connectedUrl,
      server: raw.server,
      rttMs: raw.rttMs,
      rates: r ? { ...r, source } : undefined,
      client: raw.client,
      varz: raw.varz,
      monitor: raw.monitor,
      jetstream: js,
      history: st.history,
    };
  }

  forget(profileId: string): void {
    this.rates.forget(profileId);
    this.state.delete(profileId);
  }
}

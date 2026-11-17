// Collects the JetStream topology of an account (streams with mirror/source info, consumers,
// micro-service endpoints) as a TopologyData snapshot. Pure NATS logic — no vscode imports.

import type { ConsumerInfo, JetStreamManager, StreamInfo, StreamSource } from "@nats-io/jetstream";
import type { Svcm } from "@nats-io/services";
import { discoverServices } from "../nats/services";
import { streamKind, type TopoConsumer, type TopoEndpoint, type TopologyData, type TopoOrigin, type TopoStream } from "./topologyModel";

export interface TopologySource {
  jsm(): Promise<JetStreamManager>;
  svcm(): Svcm;
  hasJetStream(): Promise<boolean>;
}

export interface CollectTopologyOptions {
  /** Max wait for $SRV discovery (default 1200 ms). */
  servicesWaitMs?: number;
  /** Parallel consumer listings (default 6). */
  concurrency?: number;
  /** Skip service discovery. */
  noServices?: boolean;
  /** Streams listed at most (default 2000); the rest is reported as a warning. */
  maxStreams?: number;
  /** Consumers listed per stream at most (default 200); the rest is reported as a warning. */
  maxConsumersPerStream?: number;
}

export const DEFAULT_MAX_STREAMS = 2000;
export const DEFAULT_MAX_CONSUMERS_PER_STREAM = 200;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function origin(cfg: StreamSource | undefined, info: { name: string; lag: number; active: number; error?: { description?: string; code?: number } } | undefined): TopoOrigin | undefined {
  if (!cfg && !info) return undefined;
  const ext = cfg?.external?.api ?? (cfg as { domain?: string } | undefined)?.domain;
  return {
    name: cfg?.name ?? info!.name,
    external: ext || undefined,
    lag: info?.lag,
    activeMs: info && info.active >= 0 ? info.active / 1e6 : undefined,
    filter: cfg?.filter_subject || cfg?.subject_transforms?.map((t) => t.src).join(", ") || undefined,
    error: info?.error ? (info.error.description ?? `error ${info.error.code}`) : undefined,
  };
}

export function streamToTopo(si: StreamInfo): TopoStream {
  const c = si.config;
  const { kind, bucket } = streamKind(c.name);
  const sourcesCfg = c.sources ?? [];
  const sourcesInfo = si.sources ?? [];
  const sources = sourcesCfg.length || sourcesInfo.length
    ? (sourcesCfg.length ? sourcesCfg : sourcesInfo.map((x) => ({ name: x.name }) as StreamSource)).map((sc, i) => origin(sc, sourcesInfo.find((x) => x.name === sc.name) ?? sourcesInfo[i])!)
    : undefined;
  const replicas = si.cluster?.replicas ?? [];
  return {
    name: c.name,
    kind,
    bucket,
    description: c.description || undefined,
    subjects: c.subjects ?? [],
    messages: si.state.messages,
    bytes: si.state.bytes,
    consumerCount: si.state.consumer_count,
    firstSeq: si.state.first_seq,
    lastSeq: si.state.last_seq,
    lastTs: si.state.last_ts && !si.state.last_ts.startsWith("0001") ? si.state.last_ts : undefined,
    storage: String(c.storage),
    retention: String(c.retention),
    replicas: c.num_replicas ?? 1,
    maxBytes: c.max_bytes ?? -1,
    maxMsgs: c.max_msgs ?? -1,
    sealed: c.sealed || undefined,
    mirror: c.mirror || si.mirror ? origin(c.mirror, si.mirror) : undefined,
    sources,
    // replicas lists the followers only: the leader (when there is one) is the +1
    cluster: si.cluster
      ? {
          name: si.cluster.name,
          leader: si.cluster.leader,
          replicasCurrent: replicas.length ? replicas.filter((r) => r.current && !r.offline).length + (si.cluster.leader ? 1 : 0) : undefined,
          replicasTotal: replicas.length ? replicas.length + 1 : undefined,
        }
      : undefined,
    created: si.created,
  };
}

export function consumerToTopo(ci: ConsumerInfo): TopoConsumer {
  const c = ci.config;
  const filters = c.filter_subjects?.length ? c.filter_subjects : c.filter_subject ? [c.filter_subject] : [];
  return {
    stream: ci.stream_name,
    name: ci.name,
    durable: !!c.durable_name,
    kind: c.deliver_subject ? "push" : "pull",
    pending: ci.num_pending ?? 0,
    ackPending: ci.num_ack_pending ?? 0,
    redelivered: ci.num_redelivered ?? 0,
    waiting: ci.num_waiting ?? 0,
    maxAckPending: c.max_ack_pending ?? -1,
    ackPolicy: String(c.ack_policy),
    deliverPolicy: c.deliver_policy ? String(c.deliver_policy) : undefined,
    filterSubjects: filters,
    deliverSubject: c.deliver_subject || undefined,
    deliverGroup: c.deliver_group || undefined,
    pushBound: c.deliver_subject ? !!ci.push_bound : undefined,
    paused: ci.paused || undefined,
    lastActive: isoOrUndefined(ci.delivered?.last_active),
  };
}

/** last_active is typed as Nanos but servers send an ISO timestamp. */
function isoOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v && !v.startsWith("0001") ? v : undefined;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Snapshot of the account's streams, consumers and service endpoints. Partial failures become warnings. */
export async function collectTopology(src: TopologySource, opts: CollectTopologyOptions = {}): Promise<TopologyData> {
  const data: TopologyData = { at: Date.now(), jetstream: false, streams: [], consumers: [], endpoints: [], warnings: [] };
  const servicesP: Promise<TopoEndpoint[]> = opts.noServices
    ? Promise.resolve([])
    : discoverServices(src.svcm(), opts.servicesWaitMs ?? 1200)
        .then((svcs) =>
          svcs.flatMap((svc) =>
            svc.endpoints.map((ep) => ({
              service: svc.name,
              version: svc.versions.join(", "),
              name: ep.name,
              subject: ep.subject,
              queueGroup: ep.queueGroup,
              instances: svc.instances.filter((i) => i.endpoints.some((x) => x.subject === ep.subject && x.name === ep.name)).length,
              requests: ep.numRequests ?? 0,
              errors: ep.numErrors ?? 0,
              avgLatencyNs: avgLatency(svc.instances.flatMap((i) => i.endpoints.filter((x) => x.subject === ep.subject && x.name === ep.name))),
              lastError: ep.lastError,
            })),
          ),
        )
        .catch((e) => {
          data.warnings.push(`Service discovery failed: ${errText(e)}`);
          return [];
        });

  let jsm: JetStreamManager | undefined;
  try {
    jsm = await src.jsm();
    data.jetstream = true;
  } catch (e) {
    data.jetstreamError = errText(e);
  }
  if (jsm) {
    const maxStreams = Math.max(1, opts.maxStreams ?? DEFAULT_MAX_STREAMS);
    const maxConsumers = Math.max(1, opts.maxConsumersPerStream ?? DEFAULT_MAX_CONSUMERS_PER_STREAM);
    let moreStreams = false;
    try {
      for await (const si of jsm.streams.list()) {
        if (data.streams.length >= maxStreams) {
          moreStreams = true;
          break;
        }
        data.streams.push(streamToTopo(si));
      }
      data.streams.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      data.warnings.push(`Listing streams failed: ${errText(e)}`);
    }
    if (moreStreams) data.warnings.push(`This account has more than ${maxStreams.toLocaleString("en-US")} streams: only the first ${maxStreams.toLocaleString("en-US")} are shown.`);
    const capped: string[] = [];
    const lists = await mapLimit(
      data.streams.filter((s) => s.consumerCount > 0),
      opts.concurrency ?? 6,
      async (s) => {
        const out: TopoConsumer[] = [];
        try {
          for await (const ci of jsm!.consumers.list(s.name)) {
            if (out.length >= maxConsumers) {
              capped.push(s.name);
              break;
            }
            out.push(consumerToTopo(ci));
          }
        } catch (e) {
          data.warnings.push(`Listing consumers of ${s.name} failed: ${errText(e)}`);
        }
        return out;
      },
    );
    if (capped.length)
      data.warnings.push(`Only the first ${maxConsumers.toLocaleString("en-US")} consumers are listed for ${capped.sort().slice(0, 5).join(", ")}${capped.length > 5 ? ` and ${capped.length - 5} more streams` : ""}.`);
    data.consumers = lists.flat().sort((a, b) => a.stream.localeCompare(b.stream) || a.name.localeCompare(b.name));
  }
  data.endpoints = await servicesP;
  return data;
}

function avgLatency(eps: { numRequests?: number; averageProcessingTimeNs?: number }[]): number | undefined {
  let n = 0;
  let total = 0;
  for (const e of eps) {
    if (e.averageProcessingTimeNs === undefined) continue;
    const w = Math.max(1, e.numRequests ?? 0);
    n += w;
    total += e.averageProcessingTimeNs * w;
  }
  return n ? total / n : undefined;
}

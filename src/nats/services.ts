// NATS micro-service discovery via the $SRV.INFO / $SRV.STATS protocol.

import type { Svcm, ServiceInfo, ServiceStats } from "@nats-io/services";

export interface EndpointView {
  name: string;
  subject: string;
  queueGroup?: string;
  metadata?: Record<string, string>;
  numRequests?: number;
  numErrors?: number;
  lastError?: string;
  averageProcessingTimeNs?: number;
}

export interface ServiceInstanceView {
  id: string;
  version: string;
  started?: string;
  metadata?: Record<string, string>;
  endpoints: EndpointView[];
}

export interface ServiceView {
  name: string;
  description?: string;
  versions: string[];
  instances: ServiceInstanceView[];
  /** Endpoints merged across instances (by subject), with summed stats. */
  endpoints: EndpointView[];
}

async function collect<T>(p: Promise<AsyncIterable<T>>): Promise<T[]> {
  const out: T[] = [];
  try {
    for await (const v of await p) out.push(v);
  } catch {
    /* no responders / timeout → empty */
  }
  return out;
}

export async function discoverServices(svcm: Svcm, maxWaitMs = 1500): Promise<ServiceView[]> {
  const client = svcm.client({ maxWait: maxWaitMs, strategy: "timer" } as never);
  const [infos, stats] = await Promise.all([collect<ServiceInfo>(client.info()), collect<ServiceStats>(client.stats())]);
  const statsById = new Map(stats.map((s) => [s.id, s]));
  const byName = new Map<string, ServiceView>();
  for (const info of infos) {
    let svc = byName.get(info.name);
    if (!svc) {
      svc = { name: info.name, description: info.description || undefined, versions: [], instances: [], endpoints: [] };
      byName.set(info.name, svc);
    }
    if (!svc.versions.includes(info.version)) svc.versions.push(info.version);
    const st = statsById.get(info.id);
    const endpoints: EndpointView[] = (info.endpoints ?? []).map((ep) => {
      const es = st?.endpoints?.find((x) => x.subject === ep.subject && x.name === ep.name);
      return {
        name: ep.name,
        subject: ep.subject,
        queueGroup: ep.queue_group,
        metadata: ep.metadata ?? undefined,
        numRequests: es?.num_requests,
        numErrors: es?.num_errors,
        lastError: es?.last_error || undefined,
        averageProcessingTimeNs: es?.average_processing_time,
      };
    });
    svc.instances.push({ id: info.id, version: info.version, started: st?.started, metadata: info.metadata ?? undefined, endpoints });
    for (const ep of endpoints) {
      const merged = svc.endpoints.find((x) => x.subject === ep.subject && x.name === ep.name);
      if (!merged) svc.endpoints.push({ ...ep });
      else {
        merged.numRequests = (merged.numRequests ?? 0) + (ep.numRequests ?? 0);
        merged.numErrors = (merged.numErrors ?? 0) + (ep.numErrors ?? 0);
        merged.lastError = ep.lastError ?? merged.lastError;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

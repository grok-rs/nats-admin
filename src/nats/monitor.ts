// NATS server HTTP monitoring endpoint client (/varz, /connz, /jsz, /healthz).

export type MonitorEndpoint = "varz" | "connz" | "jsz" | "healthz" | "subsz" | "accountz" | "routez" | "leafz" | "gatewayz";

export async function fetchMonitor<T = Record<string, unknown>>(
  baseUrl: string,
  endpoint: MonitorEndpoint,
  query: Record<string, string | number | boolean> = {},
  timeoutMs = 3000,
): Promise<T> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${endpoint}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok && endpoint !== "healthz") throw new Error(`${endpoint}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface VarzLite {
  server_name: string;
  server_id: string;
  version: string;
  go: string;
  host: string;
  port: number;
  uptime: string;
  start: string;
  now: string;
  cpu: number;
  mem: number;
  cores: number;
  connections: number;
  total_connections: number;
  subscriptions: number;
  slow_consumers: number;
  in_msgs: number;
  out_msgs: number;
  in_bytes: number;
  out_bytes: number;
  max_payload: number;
  cluster?: { name?: string; urls?: string[] };
  jetstream?: { config?: Record<string, unknown>; stats?: Record<string, unknown> };
}

export interface ConnzLite {
  num_connections: number;
  total: number;
  connections: Array<{
    cid: number;
    kind?: string;
    name?: string;
    ip: string;
    port: number;
    lang?: string;
    version?: string;
    uptime: string;
    idle?: string;
    rtt?: string;
    subscriptions: number;
    in_msgs: number;
    out_msgs: number;
    in_bytes: number;
    out_bytes: number;
    pending_bytes?: number;
    account?: string;
    authorized_user?: string;
  }>;
}

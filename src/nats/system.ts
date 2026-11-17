// System-account ($SYS) requests: server statsz scatter-gather, per-server monitoring
// endpoints over NATS (VARZ / JSZ / HEALTHZ / ROUTEZ / GATEWAYZ / LEAFZ), user info and
// detection of system-account access. Every call uses short timeouts and fails gracefully.
// Pure NATS logic — no vscode imports (unit tested in test/admin.test.ts).

import type { NatsConnection } from "@nats-io/nats-core";

// ---------------------------------------------------------------------------------------------
// Wire types (subset of what nats-server sends; unknown fields are kept as-is)
// ---------------------------------------------------------------------------------------------

/** The `server` block every $SYS response carries. */
export interface SysServerInfo {
  name: string;
  host?: string;
  id: string;
  cluster?: string;
  domain?: string;
  ver: string;
  tags?: string[];
  jetstream?: boolean;
  flags?: number;
  seq?: number;
  time?: string;
}

export interface DataStats {
  msgs: number;
  bytes: number;
}

export interface RouteStat {
  rid: number;
  name?: string;
  sent?: DataStats;
  received?: DataStats;
  pending?: number;
}

export interface GatewayStat {
  gwid: number;
  name: string;
  sent?: DataStats;
  received?: DataStats;
  inbound_connections?: number;
}

export interface JetStreamStatsz {
  config?: { max_memory?: number; max_storage?: number; store_dir?: string; domain?: string };
  stats?: {
    memory?: number;
    storage?: number;
    reserved_memory?: number;
    reserved_storage?: number;
    accounts?: number;
    ha_assets?: number;
    api?: { total?: number; errors?: number; level?: number; inflight?: number };
  };
  meta?: { name?: string; leader?: string; peer?: string; cluster_size?: number; pending?: number; replicas?: { name: string; current?: boolean; active?: number; lag?: number; offline?: boolean }[] };
}

export interface Statsz {
  start: string;
  mem: number;
  cores: number;
  cpu: number;
  connections: number;
  total_connections: number;
  active_accounts?: number;
  subscriptions: number;
  sent: DataStats;
  received: DataStats;
  slow_consumers: number;
  routes?: RouteStat[];
  gateways?: GatewayStat[];
  active_servers?: number;
  jetstream?: JetStreamStatsz;
  gomaxprocs?: number;
}

export interface ServerStatsMsg {
  server: SysServerInfo;
  statsz: Statsz;
}

/** Envelope of $SYS.REQ.SERVER.* replies: { server, data } or { server, error }. */
export interface SysEnvelope<T> {
  server: SysServerInfo;
  data?: T;
  error?: { code?: number; description?: string };
}

export interface SubjectPermission {
  allow?: string[];
  deny?: string[];
}

export interface UserPermissions {
  publish?: SubjectPermission;
  subscribe?: SubjectPermission;
  responses?: { max?: number; ttl?: number };
}

export interface UserInfo {
  user?: string;
  account?: string;
  account_name?: string;
  permissions?: UserPermissions;
  expires?: number | string;
  /** Server that answered. */
  server?: SysServerInfo;
}

export interface RoutezRoute {
  rid: number;
  remote_id?: string;
  remote_name?: string;
  did_solicit?: boolean;
  is_configured?: boolean;
  ip?: string;
  port?: number;
  rtt?: string;
  uptime?: string;
  pending_size?: number;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  subscriptions?: number;
  compression?: string;
}

export interface Routez {
  server_id?: string;
  server_name?: string;
  num_routes?: number;
  routes?: RoutezRoute[];
}

export interface GatewayConn {
  name?: string;
  configured?: boolean;
  connection?: { cid?: number; ip?: string; port?: number; rtt?: string; uptime?: string; in_msgs?: number; out_msgs?: number; in_bytes?: number; out_bytes?: number; name?: string };
}

export interface Gatewayz {
  server_id?: string;
  name?: string;
  outbound_gateways?: Record<string, GatewayConn>;
  inbound_gateways?: Record<string, GatewayConn[]>;
}

export interface LeafInfo {
  name?: string;
  is_spoke?: boolean;
  account?: string;
  ip?: string;
  port?: number;
  rtt?: string;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  subscriptions?: number;
  compression?: string;
}

export interface Leafz {
  server_id?: string;
  leafnodes?: number;
  leafs?: LeafInfo[];
}

export interface Healthz {
  status: string;
  status_code?: number;
  error?: string;
  errors?: { type?: string; error?: string }[];
}

export type SysEndpoint = "VARZ" | "JSZ" | "HEALTHZ" | "ROUTEZ" | "GATEWAYZ" | "LEAFZ" | "CONNZ" | "SUBSZ" | "ACCOUNTZ" | "STATSZ";

export const SYS_SUBJECTS = {
  ping: "$SYS.REQ.SERVER.PING",
  pingKind: (kind: SysEndpoint) => `$SYS.REQ.SERVER.PING.${kind}`,
  server: (id: string, kind: SysEndpoint) => `$SYS.REQ.SERVER.${id}.${kind}`,
  userInfo: "$SYS.REQ.USER.INFO",
} as const;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function payload(opts?: Record<string, unknown>): Uint8Array {
  return opts && Object.keys(opts).length ? enc.encode(JSON.stringify(opts)) : new Uint8Array();
}

function parse<T>(data: Uint8Array): T | undefined {
  try {
    return JSON.parse(dec.decode(data)) as T;
  } catch {
    return undefined;
  }
}

/** True when an error means "no system-account access" (nobody answers / not allowed). */
export function isNoAccessError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message} ${String((e as { code?: unknown }).code ?? "")}` : String(e);
  return /no ?responders|503|permission|authoriz|timeout|timed out/i.test(msg);
}

export class SystemAccessError extends Error {
  constructor(detail?: string) {
    super(`No system-account access${detail ? ` (${detail})` : ""}. Connect with a user of the server's system_account to see every server.`);
    this.name = "SystemAccessError";
  }
}

function wrap(e: unknown): Error {
  if (isNoAccessError(e)) return new SystemAccessError(e instanceof Error ? e.message : String(e));
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Scatter-gather: publish once, collect every reply until `maxWait` ms (timer strategy) or until
 * `expected(first reply)` replies arrived. Throws SystemAccessError on no responders / denied.
 */
async function gather<T>(nc: NatsConnection, subject: string, body: Uint8Array, maxWait: number, expected?: (first: T) => number | undefined): Promise<T[]> {
  const out: T[] = [];
  let want: number | undefined;
  let it: AsyncIterable<{ data: Uint8Array }>;
  try {
    it = await nc.requestMany(subject, body, { strategy: "timer", maxWait });
  } catch (e) {
    throw wrap(e);
  }
  try {
    for await (const m of it) {
      const v = parse<T>(m.data);
      if (v === undefined) continue;
      out.push(v);
      if (want === undefined && expected) want = expected(v);
      if (want !== undefined && want > 0 && out.length >= want) break;
    }
  } catch (e) {
    if (!out.length) throw wrap(e);
  }
  return out;
}

export interface PingOptions {
  /** Upper bound in ms (default 1500). Returns early once every active server answered. */
  maxWait?: number;
}

/** $SYS.REQ.SERVER.PING → statsz of every server in the cluster / super-cluster, sorted by name. */
export async function pingServers(nc: NatsConnection, opts: PingOptions = {}): Promise<ServerStatsMsg[]> {
  const res = await gather<ServerStatsMsg>(nc, SYS_SUBJECTS.ping, new Uint8Array(), opts.maxWait ?? 1500, (m) => m.statsz?.active_servers);
  return dedupeById(res.filter((r) => r?.server?.id && r.statsz)).sort((a, b) => a.server.name.localeCompare(b.server.name, undefined, { numeric: true }));
}

/** $SYS.REQ.SERVER.PING.<KIND> → one envelope per server. `expected` stops early when known. */
export async function pingAll<T>(nc: NatsConnection, kind: SysEndpoint, opts: Record<string, unknown> = {}, maxWait = 1500, expected?: number): Promise<SysEnvelope<T>[]> {
  const res = await gather<SysEnvelope<T>>(nc, SYS_SUBJECTS.pingKind(kind), payload(opts), maxWait, () => expected);
  return dedupeById(res.filter((r) => r?.server?.id)).sort((a, b) => a.server.name.localeCompare(b.server.name, undefined, { numeric: true }));
}

/** $SYS.REQ.SERVER.<id>.<KIND> → data of one server (throws on an error reply). */
export async function serverRequest<T>(nc: NatsConnection, serverId: string, kind: SysEndpoint, opts: Record<string, unknown> = {}, timeout = 2000): Promise<SysEnvelope<T>> {
  let m;
  try {
    m = await nc.request(SYS_SUBJECTS.server(serverId, kind), payload(opts), { timeout });
  } catch (e) {
    throw wrap(e);
  }
  const env = parse<SysEnvelope<T>>(m.data);
  if (!env) throw new Error(`${kind}: invalid reply`);
  if (env.error) throw new Error(`${kind}: ${env.error.description ?? `error ${env.error.code}`}`);
  return env;
}

/**
 * $SYS.REQ.USER.INFO: user, account and permissions of this connection. Works for ordinary
 * users on nats-server ≥ 2.10. Returns undefined when unavailable (old server, denied, timeout).
 */
export async function fetchUserInfo(nc: NatsConnection, timeout = 2000): Promise<UserInfo | undefined> {
  try {
    const m = await nc.request(SYS_SUBJECTS.userInfo, new Uint8Array(), { timeout });
    const env = parse<SysEnvelope<UserInfo>>(m.data);
    if (!env || env.error || !env.data) return undefined;
    return { ...env.data, server: env.server };
  } catch {
    return undefined;
  }
}

/** Probe for system-account access: true when any server answers $SYS.REQ.SERVER.PING. Never throws. */
export async function detectSystemAccess(nc: NatsConnection, timeout = 1500): Promise<boolean> {
  if (nc.isClosed()) return false;
  try {
    const m = await nc.request(SYS_SUBJECTS.ping, new Uint8Array(), { timeout });
    const v = parse<ServerStatsMsg>(m.data);
    return !!v?.server?.id;
  } catch {
    return false;
  }
}

const accessCache = new WeakMap<object, { at: number; p: Promise<boolean> }>();

/** Cached detectSystemAccess per connection (default max age 60 s). */
export function hasSystemAccess(nc: NatsConnection, maxAgeMs = 60_000): Promise<boolean> {
  const hit = accessCache.get(nc);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.p;
  const p = detectSystemAccess(nc);
  accessCache.set(nc, { at: Date.now(), p });
  return p;
}

export function forgetSystemAccess(nc: NatsConnection): void {
  accessCache.delete(nc);
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function dedupeById<T extends { server: SysServerInfo }>(list: T[]): T[] {
  const seen = new Map<string, T>();
  for (const r of list) {
    const prev = seen.get(r.server.id);
    if (!prev || (r.server.seq ?? 0) >= (prev.server.seq ?? 0)) seen.set(r.server.id, r);
  }
  return [...seen.values()];
}

const DUR_UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, "μs": 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, y: 31_536_000_000 };

/**
 * Parse Go / nats-server durations ("1.5ms", "221µs", "3m10s", "2d4h3m", "1y2d") into ms.
 * Returns undefined for empty / malformed input.
 */
export function parseGoDuration(input: string | undefined | null): number | undefined {
  if (!input) return undefined;
  const s = input.trim();
  if (s === "0") return 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h|d|y)/gy;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(s))) {
    total += Number(m[1]) * DUR_UNITS[m[2]];
    matched = re.lastIndex;
  }
  return matched === s.length && matched > 0 ? total : undefined;
}

/** Milliseconds between an ISO start time and `now` (undefined when unparsable). */
export function uptimeMs(start: string | undefined, now = Date.now()): number | undefined {
  if (!start) return undefined;
  const t = Date.parse(start);
  return Number.isFinite(t) ? Math.max(0, now - t) : undefined;
}

export interface PermissionSummary {
  /** No publish/subscribe restrictions at all. */
  unrestricted: boolean;
  publish: { allow: string[]; deny: string[] };
  subscribe: { allow: string[]; deny: string[] };
  responses?: { max?: number; ttlMs?: number };
  /** One line per direction, e.g. "Publish: allow orders.>, deny secret.>". */
  lines: string[];
  /** Very short form for chips: "pub ✓ > ✗ secret.> · sub ✓ >". */
  short: string;
}

function list(v: string[] | undefined): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
}

function describeDir(name: string, p: { allow: string[]; deny: string[] }): string {
  if (!p.allow.length && !p.deny.length) return `${name}: unrestricted`;
  const parts: string[] = [];
  if (p.allow.length) parts.push(`allow ${p.allow.join(", ")}`);
  else parts.push("allow all");
  if (p.deny.length) parts.push(`deny ${p.deny.join(", ")}`);
  return `${name}: ${parts.join("; ")}`;
}

function shortDir(name: string, p: { allow: string[]; deny: string[] }, maxItems: number): string {
  if (!p.allow.length && !p.deny.length) return `${name} any`;
  const cut = (xs: string[]) => (xs.length > maxItems ? `${xs.slice(0, maxItems).join(" ")} +${xs.length - maxItems}` : xs.join(" "));
  const bits = [p.allow.length ? `✓ ${cut(p.allow)}` : "✓ any", p.deny.length ? `✗ ${cut(p.deny)}` : ""].filter(Boolean);
  return `${name} ${bits.join(" ")}`;
}

/** Human summary of $SYS.REQ.USER.INFO permissions (undefined permissions = unrestricted). */
export function summarizePermissions(p: UserPermissions | undefined, maxItems = 2): PermissionSummary {
  const publish = { allow: list(p?.publish?.allow), deny: list(p?.publish?.deny) };
  const subscribe = { allow: list(p?.subscribe?.allow), deny: list(p?.subscribe?.deny) };
  const unrestricted = !publish.allow.length && !publish.deny.length && !subscribe.allow.length && !subscribe.deny.length && !p?.responses;
  const responses = p?.responses ? { max: p.responses.max, ttlMs: p.responses.ttl !== undefined ? p.responses.ttl / 1e6 : undefined } : undefined;
  const lines = unrestricted ? ["Publish and subscribe: unrestricted"] : [describeDir("Publish", publish), describeDir("Subscribe", subscribe)];
  if (responses) lines.push(`Responses: allowed${responses.max ? `, max ${responses.max}` : ""}${responses.ttlMs ? `, ttl ${responses.ttlMs}ms` : ""}`);
  const short = unrestricted ? "unrestricted" : `${shortDir("pub", publish, maxItems)} · ${shortDir("sub", subscribe, maxItems)}`;
  return { unrestricted, publish, subscribe, responses, lines, short };
}

/** Pooled routes (route pooling opens several connections per peer) → unique peers. */
export function uniqueRoutePeers(routes: { name?: string; remote_name?: string; remote_id?: string }[] | undefined): string[] {
  const out = new Set<string>();
  for (const r of routes ?? []) {
    const k = r.remote_id ?? r.remote_name ?? r.name;
    if (k) out.add(k);
  }
  return [...out].sort();
}

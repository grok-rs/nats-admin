// Pure model shared by the Overview sidebar, the Home (fleet) panel and the server dashboard:
// the DTOs exchanged with their webviews plus the small calculations behind them (counter
// rates, history, environment grouping, fleet search/summary, JetStream limits, tones).
//
// No vscode import and no runtime imports at all: the webviews import this module directly and
// test/overview.test.ts unit tests it.

export type ConnState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type Environment = "dev" | "test" | "staging" | "prod";
export type EnvKey = Environment | "none";
export type ProfileOrigin = "manual" | "nats-context" | "workspace" | "env";
export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

// ---------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------

export interface ProfileSummary {
  id: string;
  name: string;
  servers: string[];
  environment?: Environment;
  readOnly: boolean;
  origin: ProfileOrigin;
  /** NATS CLI context name (nats-context profiles). */
  contextName?: string;
  description?: string;
  autoConnect: boolean;
  /** Context selected with `nats context select`. */
  selectedContext: boolean;
  /** Stored by the extension itself (editable / removable). */
  managed: boolean;
  /** Problem that prevents connecting (unsupported context options…). */
  warning?: string;
  state: ConnState;
  error?: string;
  /** The active connection (status bar / default for commands). */
  active: boolean;
  auth: string;
  tls: boolean;
}

export const ORIGIN_META: Record<ProfileOrigin, { label: string; short: string; icon: string; hint: string }> = {
  manual: { label: "Saved in VS Code", short: "manual", icon: "save", hint: "Created in VS Code; secrets live in the OS keychain (SecretStorage)." },
  "nats-context": { label: "NATS CLI context", short: "context", icon: "terminal", hint: "Read live from the NATS CLI context directory (~/.config/nats/context)." },
  workspace: { label: "Workspace", short: "workspace", icon: "folder", hint: "Shared with the team through the workspace setting nats.connections." },
  env: { label: "Environment", short: "env", icon: "symbol-variable", hint: "Built from NATS_URL / NATS_USER / NATS_CREDS in the VS Code process environment." },
};

/** Group order: production first (what DevOps watch most), unlabelled last. */
export const ENV_ORDER: readonly EnvKey[] = ["prod", "staging", "test", "dev", "none"];

export const ENV_LABEL: Record<EnvKey, string> = {
  prod: "Production",
  staging: "Staging",
  test: "Test",
  dev: "Development",
  none: "No environment",
};

export interface EnvGroup<T> {
  env: EnvKey;
  label: string;
  items: T[];
}

/** Group items by environment in ENV_ORDER, dropping empty groups. Items keep their relative order unless `sort` is given. */
export function groupByEnvironment<T>(items: readonly T[], envOf: (t: T) => Environment | undefined, sort?: (a: T, b: T) => number): EnvGroup<T>[] {
  const buckets = new Map<EnvKey, T[]>();
  for (const it of items) {
    const raw = envOf(it);
    const key: EnvKey = raw && raw in ENV_LABEL ? raw : "none";
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(it);
  }
  const out: EnvGroup<T>[] = [];
  for (const env of ENV_ORDER) {
    const list = buckets.get(env);
    if (!list?.length) continue;
    out.push({ env, label: ENV_LABEL[env], items: sort ? [...list].sort(sort) : list });
  }
  return out;
}

const STATE_RANK: Record<ConnState, number> = { connected: 0, reconnecting: 1, connecting: 2, error: 3, disconnected: 4 };

/** Live connections first, then by name (natural order). */
export function compareProfiles(a: ProfileSummary, b: ProfileSummary): number {
  return STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function isLive(state: ConnState): boolean {
  return state === "connected" || state === "reconnecting";
}

export function stateTone(state: ConnState): Tone {
  switch (state) {
    case "connected":
      return "ok";
    case "connecting":
      return "info";
    case "reconnecting":
      return "warn";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

export function stateLabel(state: ConnState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return "Error";
    default:
      return "Disconnected";
  }
}

/** Round-trip time → tone: ≥ warnMs warn, ≥ 4 × warnMs danger. */
export function rttTone(ms: number | undefined, warnMs = 100): Tone {
  if (ms === undefined || !Number.isFinite(ms)) return "neutral";
  if (ms >= warnMs * 4) return "danger";
  if (ms >= warnMs) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------------------------
// Health (mirror of src/core/healthBus.ts HealthSummary, which imports vscode)
// ---------------------------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

export interface HealthDTO {
  connId: string;
  score: number;
  errors: number;
  warnings: number;
  infos: number;
  at: string;
  top: { severity: Severity; title: string }[];
}

/** Critical score or any error finding. */
export function isUnhealthy(h: HealthDTO | undefined, warnBelow = 60): boolean {
  return !!h && (h.score < warnBelow || h.errors > 0);
}

/** Degraded but not unhealthy. */
export function isDegraded(h: HealthDTO | undefined, okAt = 90, warnBelow = 60): boolean {
  return !!h && !isUnhealthy(h, warnBelow) && (h.score < okAt || h.warnings > 0);
}

export function severityTone(s: Severity): Tone {
  return s === "error" ? "danger" : s === "warning" ? "warn" : "info";
}

// ---------------------------------------------------------------------------------------------
// Counters → rates, history
// ---------------------------------------------------------------------------------------------

export interface Counters {
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
}

export interface Rates {
  msgsIn: number;
  msgsOut: number;
  bytesIn: number;
  bytesOut: number;
}

/** "server": /varz (all clients of the server); "client": this extension's own connection (nc.stats()). */
export type RateSource = "server" | "client";

/**
 * Per-second rates between two counter samples. undefined for a non-increasing time or when any
 * counter went down (server restart / failover): the caller shows a gap instead of a spike.
 */
export function counterRates(prev: { t: number; c: Counters } | undefined, cur: { t: number; c: Counters }): Rates | undefined {
  if (!prev) return undefined;
  const dt = (cur.t - prev.t) / 1000;
  if (!(dt > 0)) return undefined;
  const p = prev.c;
  const c = cur.c;
  const vals = [c.inMsgs - p.inMsgs, c.outMsgs - p.outMsgs, c.inBytes - p.inBytes, c.outBytes - p.outBytes];
  if (vals.some((v) => !Number.isFinite(v) || v < 0)) return undefined;
  return { msgsIn: vals[0] / dt, msgsOut: vals[1] / dt, bytesIn: vals[2] / dt, bytesOut: vals[3] / dt };
}

/**
 * Keeps the previous counter sample per key (profile id) and turns new samples into rates.
 * Switching the source (monitoring became reachable / unreachable) restarts the series so a
 * server-wide counter is never subtracted from a client counter. So does a change of `origin`
 * (the server id behind /varz): a monitoring URL behind a load balancer (e.g. a Kubernetes
 * Service on :8222) answers from a different cluster member on each poll, and their counters
 * must not be mixed.
 */
export class RateSampler {
  private readonly prev = new Map<string, { source: RateSource; origin?: string; t: number; c: Counters }>();

  update(key: string, source: RateSource, t: number, c: Counters, origin?: string): Rates | undefined {
    const p = this.prev.get(key);
    const same = !!p && p.source === source && p.origin === origin;
    if (same && !(t > p!.t)) return undefined; // same / older sample: keep the baseline
    this.prev.set(key, { source, origin, t, c });
    if (!same) return undefined;
    return counterRates(p, { t, c });
  }

  forget(key: string): void {
    this.prev.delete(key);
  }

  clear(): void {
    this.prev.clear();
  }
}

export interface HistoryPoint {
  t: number;
  rtt?: number;
  msgsIn?: number;
  msgsOut?: number;
  bytesIn?: number;
  bytesOut?: number;
  cpu?: number;
}

/** Append and keep the newest `cap` points (returns a new array; out-of-order points are dropped). */
export function appendHistory(h: readonly HistoryPoint[], p: HistoryPoint, cap = 90): HistoryPoint[] {
  const last = h[h.length - 1];
  if (last && p.t <= last.t) return h.slice(-cap);
  const next = [...h, p];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Values of one history field (undefined → null gap) as TimePoints. */
export function historySeries(h: readonly HistoryPoint[], key: Exclude<keyof HistoryPoint, "t">): { t: number; v: number | null }[] {
  return h.map((p) => ({ t: p.t, v: typeof p[key] === "number" && Number.isFinite(p[key]) ? (p[key] as number) : null }));
}

// ---------------------------------------------------------------------------------------------
// Live metrics DTO (one connection)
// ---------------------------------------------------------------------------------------------

export interface ServerSummary {
  name: string;
  id: string;
  version: string;
  cluster?: string;
  jetstream: boolean;
  clientId?: number;
  clientIp?: string;
  domain?: string;
  tlsRequired: boolean;
  authRequired: boolean;
}

export interface VarzSummary {
  connections: number;
  totalConnections: number;
  maxConnections?: number;
  subscriptions: number;
  slowConsumers: number;
  /** Process CPU in percent of one core (can exceed 100 on multi-core hosts). */
  cpu: number;
  /** Resident memory in bytes. */
  mem: number;
  cores: number;
  uptime: string;
  start: string;
  routes?: number;
  leafnodes?: number;
}

export interface MonitorSummary {
  url?: string;
  ok: boolean;
  error?: string;
  /** Monitoring is not polled until this time after a failure (epoch ms). */
  retryAt?: number;
}

export type LimitSource = "account" | "tiers" | "server" | "none";

export interface JetStreamSummary {
  enabled: boolean;
  error?: string;
  /** User streams (without the KV_ / OBJ_ streams backing buckets). */
  streams?: number;
  /** Every stream of the account (account info). */
  totalStreams?: number;
  consumers?: number;
  kv?: number;
  obj?: number;
  memory?: number;
  storage?: number;
  maxMemory?: number;
  maxStorage?: number;
  memorySource?: LimitSource;
  storageSource?: LimitSource;
  maxStreams?: number;
  maxConsumers?: number;
  api?: { total: number; errors: number };
  domain?: string;
}

export interface LiveMetrics {
  profileId: string;
  /** Sample time (epoch ms). */
  at: number;
  connectedUrl?: string;
  server?: ServerSummary;
  rttMs?: number;
  rates?: Rates & { source: RateSource };
  /** Client counters of this connection (nc.stats()). */
  client?: Counters;
  varz?: VarzSummary;
  monitor: MonitorSummary;
  jetstream?: JetStreamSummary;
  /** Recent samples (RTT, rates, CPU) for sparklines. */
  history: HistoryPoint[];
}

// ---------------------------------------------------------------------------------------------
// JetStream helpers
// ---------------------------------------------------------------------------------------------

export function countStreamKinds(names: Iterable<string>): { streams: number; kv: number; obj: number; total: number } {
  let kv = 0;
  let obj = 0;
  let total = 0;
  for (const n of names) {
    total++;
    if (n.startsWith("KV_")) kv++;
    else if (n.startsWith("OBJ_")) obj++;
  }
  return { streams: total - kv - obj, kv, obj, total };
}

/**
 * Effective limit for a JetStream resource: a positive account limit wins, then the sum of
 * positive tier limits (R1/R3 tiered accounts), then the server's configured maximum, else
 * unlimited (max undefined, source "none"). NATS uses -1 / 0 for "no limit".
 */
export function resolveLimit(account: number | undefined, tiers: readonly (number | undefined)[] = [], server?: number): { max?: number; source: LimitSource } {
  if (typeof account === "number" && account > 0) return { max: account, source: "account" };
  const t = tiers.filter((x): x is number => typeof x === "number" && x > 0);
  if (t.length) return { max: t.reduce((a, b) => a + b, 0), source: "tiers" };
  if (typeof server === "number" && server > 0) return { max: server, source: "server" };
  return { source: "none" };
}

export const LIMIT_SOURCE_LABEL: Record<LimitSource, string> = {
  account: "account limit",
  tiers: "tiered account limits",
  server: "server maximum",
  none: "no limit",
};

/** Used fraction (0..1+) or undefined when unlimited. */
export function usageFraction(used: number | undefined, max: number | undefined): number | undefined {
  if (typeof used !== "number" || typeof max !== "number" || !(max > 0)) return undefined;
  return Math.max(0, used) / max;
}

// ---------------------------------------------------------------------------------------------
// Fleet (Home panel)
// ---------------------------------------------------------------------------------------------

export interface FleetRow {
  profile: ProfileSummary;
  metrics?: LiveMetrics;
  health?: HealthDTO;
}

export interface FleetSummary {
  profiles: number;
  connected: number;
  connecting: number;
  errors: number;
  unhealthy: number;
  degraded: number;
  /** Live connections without a health check yet. */
  unchecked: number;
  streams: number;
  consumers: number;
  kv: number;
  obj: number;
  msgsIn: number;
  msgsOut: number;
  /** Live connections that reported rates. */
  withRates: number;
  byEnv: Record<EnvKey, number>;
}

export function summarizeFleet(rows: readonly FleetRow[]): FleetSummary {
  const s: FleetSummary = {
    profiles: rows.length,
    connected: 0,
    connecting: 0,
    errors: 0,
    unhealthy: 0,
    degraded: 0,
    unchecked: 0,
    streams: 0,
    consumers: 0,
    kv: 0,
    obj: 0,
    msgsIn: 0,
    msgsOut: 0,
    withRates: 0,
    byEnv: { prod: 0, staging: 0, test: 0, dev: 0, none: 0 },
  };
  for (const r of rows) {
    const st = r.profile.state;
    s.byEnv[r.profile.environment ?? "none"]++;
    if (st === "error") s.errors++;
    if (st === "connecting" || st === "reconnecting") s.connecting++;
    if (!isLive(st)) continue;
    if (st === "connected") s.connected++;
    if (!r.health) s.unchecked++;
    else if (isUnhealthy(r.health)) s.unhealthy++;
    else if (isDegraded(r.health)) s.degraded++;
    const js = r.metrics?.jetstream;
    if (js?.enabled) {
      s.streams += js.streams ?? js.totalStreams ?? 0;
      s.consumers += js.consumers ?? 0;
      s.kv += js.kv ?? 0;
      s.obj += js.obj ?? 0;
    }
    const rt = r.metrics?.rates;
    if (rt) {
      s.withRates++;
      s.msgsIn += rt.msgsIn;
      s.msgsOut += rt.msgsOut;
    }
  }
  return s;
}

export type EnvFilter = EnvKey | "all";
export type StateFilter = "all" | "live" | "offline" | "attention";

/** Lower-cased search text for a fleet row (name, servers, origin, environment, server identity…). */
export function fleetHaystack(r: FleetRow): string {
  const p = r.profile;
  const sv = r.metrics?.server;
  return [
    p.name,
    ...p.servers,
    p.description,
    p.contextName,
    ORIGIN_META[p.origin]?.label,
    ORIGIN_META[p.origin]?.short,
    p.environment ? ENV_LABEL[p.environment] : ENV_LABEL.none,
    p.environment,
    stateLabel(p.state),
    p.readOnly ? "read-only readonly" : "",
    sv?.name,
    sv?.version && `v${sv.version}`,
    sv?.cluster,
    r.metrics?.connectedUrl,
  ]
    .filter(Boolean)
    .join(" \u0000 ")
    .toLowerCase();
}

export function needsAttention(r: FleetRow): boolean {
  return r.profile.state === "error" || r.profile.state === "reconnecting" || !!r.profile.warning || isUnhealthy(r.health) || isDegraded(r.health);
}

/** Multi-term, case-insensitive search plus environment and state filters. */
export function filterFleet(rows: readonly FleetRow[], f: { query?: string; env?: EnvFilter; state?: StateFilter }): FleetRow[] {
  const terms = (f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.env && f.env !== "all" && (r.profile.environment ?? "none") !== f.env) return false;
    switch (f.state ?? "all") {
      case "live":
        if (!isLive(r.profile.state)) return false;
        break;
      case "offline":
        if (isLive(r.profile.state)) return false;
        break;
      case "attention":
        if (!needsAttention(r)) return false;
        break;
      default:
        break;
    }
    if (!terms.length) return true;
    const hay = fleetHaystack(r);
    return terms.every((t) => hay.includes(t));
  });
}

// ---------------------------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------------------------

/** Parse Go duration strings such as "1d2h3m4s", "20m2s", "1.5ms", "250µs". Returns ms (0 for empty / unparseable). */
export function parseGoDuration(s: string | undefined | null): number {
  if (!s) return 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h|d|y)/g;
  const mult: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, μs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, y: 31_536_000_000 };
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) total += Number(m[1]) * mult[m[2]];
  return total;
}

/**
 * The cid of this VS Code connection in a /connz listing, or undefined when the listing may be
 * from another server. Client ids are only unique per server, and the monitoring URL is derived
 * from the first configured server while the NATS connection may have landed on any cluster
 * member, so the server ids must match before a cid can be called "you".
 */
export function ownConnectionCid(connected: { id?: string; clientId?: number } | undefined, monitoredServerId: string | undefined): number | undefined {
  if (!connected?.id || !monitoredServerId || connected.id !== monitoredServerId) return undefined;
  return typeof connected.clientId === "number" ? connected.clientId : undefined;
}

/**
 * Increase of a cumulative counter across a window of samples (last minus first non-null value).
 * undefined with fewer than two values or when the counter went down (server restart).
 */
export function counterIncrease(points: readonly { v: number | null }[]): number | undefined {
  let first: number | undefined;
  let last: number | undefined;
  for (const p of points) {
    if (typeof p.v !== "number" || !Number.isFinite(p.v)) continue;
    if (first === undefined) first = p.v;
    else if (p.v < (last ?? first)) return undefined;
    last = p.v;
  }
  return first === undefined || last === undefined ? undefined : last - first;
}

export interface ConnCounters {
  cid: number;
  in_msgs: number;
  out_msgs: number;
  in_bytes: number;
  out_bytes: number;
}

/**
 * Per-client rates from two /connz samples, keyed by cid. Clients missing from either sample,
 * or whose counters went down (cid reuse after a restart), are left out.
 */
export function connectionRates(prev: { t: number; conns: readonly ConnCounters[] } | undefined, cur: { t: number; conns: readonly ConnCounters[] }): Map<number, Rates> {
  const out = new Map<number, Rates>();
  if (!prev) return out;
  const before = new Map(prev.conns.map((c) => [c.cid, c]));
  for (const c of cur.conns) {
    const p = before.get(c.cid);
    if (!p) continue;
    const r = counterRates({ t: prev.t, c: { inMsgs: p.in_msgs, outMsgs: p.out_msgs, inBytes: p.in_bytes, outBytes: p.out_bytes } }, { t: cur.t, c: { inMsgs: c.in_msgs, outMsgs: c.out_msgs, inBytes: c.in_bytes, outBytes: c.out_bytes } });
    if (r) out.set(c.cid, r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Commands the webviews may run (host whitelist) and external links
// ---------------------------------------------------------------------------------------------

/**
 * How the host passes the profile to each command:
 *  "node" — the explorer ConnectionNode (falls back to { connId }); understood by every command that takes a tree node,
 *  "id"   — the profile id string,
 *  "none" — no argument.
 */
export const ALLOWED_COMMANDS = {
  "nats.connect": "id",
  "nats.disconnect": "id",
  "nats.openDashboard": "node",
  "nats.serverInfo": "node",
  "nats.editConnection": "node",
  "nats.subscribe": "node",
  "nats.publish": "node",
  "nats.request": "node",
  "nats.deadLetters": "node",
  "nats.openTopology": "node",
  "nats.openCluster": "node",
  "nats.openHealthDashboard": "node",
  "nats.runHealthCheck": "node",
  "nats.whoAmI": "node",
  "nats.openTerminal": "node",
  "nats.setEnvironment": "node",
  "nats.toggleReadOnly": "node",
  "nats.openHome": "none",
  "nats.selectActiveConnection": "none",
  "nats.addConnection": "none",
  "nats.importContexts": "none",
  "nats.connectLocal": "none",
  "nats.showHiddenConnections": "none",
  "nats.newPlaybook": "none",
} as const;

export type AllowedCommand = keyof typeof ALLOWED_COMMANDS;

export function isAllowedCommand(id: unknown): id is AllowedCommand {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, id);
}

/** Commands that change something on the server (blocked for read-only profiles in the UI). */
export const WRITE_COMMANDS: ReadonlySet<AllowedCommand> = new Set<AllowedCommand>(["nats.publish", "nats.request"]);

export const DOCS_LINKS = {
  home: "https://docs.nats.io",
  monitoring: "https://docs.nats.io/running-a-nats-service/nats_admin/monitoring",
  cli: "https://docs.nats.io/using-nats/nats-tools/nats_cli",
  contexts: "https://docs.nats.io/using-nats/nats-tools/nats_cli#nats-contexts",
  jetstream: "https://docs.nats.io/nats-concepts/jetstream",
} as const;

export function isDocsLink(url: unknown): url is string {
  return typeof url === "string" && (Object.values(DOCS_LINKS) as string[]).includes(url);
}

// ---------------------------------------------------------------------------------------------
// Snapshots sent to the webviews
// ---------------------------------------------------------------------------------------------

export interface OverviewInit {
  refreshInterval: number;
  visible: boolean;
  rttWarnMs: number;
}

export interface OverviewSnapshot {
  at: number;
  profiles: ProfileSummary[];
  /** Connection shown in the header (active one, or the first live one). */
  active?: FleetRow;
  /** Other live connections (for quick switching). */
  live: ProfileSummary[];
}

export interface HomeInit {
  refreshInterval: number;
  rttWarnMs: number;
}

export interface HomeSnapshot {
  at: number;
  rows: FleetRow[];
  /** Hidden discovered profiles (Show Hidden Connections). */
  hidden: number;
}

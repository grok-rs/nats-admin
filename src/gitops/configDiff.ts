// Key-level diff between a local config file and the server's config. Pure module.
//
// Semantics (same as `streams.update` / `consumers.update`, which merge with the current
// config): keys absent from the local file keep their server value and are ignored here.
// Server-populated `_nats*` metadata is ignored. Values the server normalises (0 → -1 for
// limits, 0 → server default) compare equal, and Go `omitempty` fields compare equal to
// their zero value (false / 0 / "" / [] / {}).
//
// Immutable rules were verified against nats-server 2.14 (see test/gitops.test.ts).

import { fieldsFor, isPlainObject, unitFor, type FieldSpec } from "./configFiles";
import { fmtMillis } from "../shared/format";
import type { ConfigChange, ResourceKind } from "./types";

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const RECREATE_STREAM = "create a new stream and move the data (for example with a source), then switch over";
const RECREATE_CONSUMER = "delete and recreate the consumer (its delivery position and pending acks are lost)";

/** Why the server would reject changing `path` from `from` to `to`; undefined when allowed. */
export function immutableReason(kind: ResourceKind, path: string, from: unknown, to: unknown): string | undefined {
  const top = path.split(/[.[]/)[0];
  if (kind === "stream") {
    switch (top) {
      case "storage":
        return `Storage type cannot change on an existing stream — ${RECREATE_STREAM}`;
      case "persist_mode":
        return `Persist mode cannot change on an existing stream — ${RECREATE_STREAM}`;
      case "allow_msg_counter":
        return `The message counter setting cannot change on an existing stream — ${RECREATE_STREAM}`;
      case "mirror":
        return `Mirror configuration cannot be updated — ${RECREATE_STREAM}`;
      case "retention":
        if (from === "workqueue" || to === "workqueue") return `Retention cannot change to or from "workqueue" (limits ↔ interest is allowed) — ${RECREATE_STREAM}`;
        return undefined;
      case "sealed":
        return from === true && to !== true ? "A sealed stream cannot be unsealed" : undefined;
      case "deny_delete":
      case "deny_purge":
      case "allow_msg_ttl":
      case "allow_msg_schedules":
        return from === true && to !== true ? `"${top}" cannot be turned off once enabled` : undefined;
      default:
        return undefined;
    }
  }
  if (kind === "consumer") {
    switch (top) {
      case "deliver_policy":
      case "opt_start_seq":
      case "opt_start_time":
      case "ack_policy":
      case "replay_policy":
      case "max_waiting":
      case "mem_storage":
      case "idle_heartbeat":
      case "flow_control":
        return `"${top}" cannot change on an existing consumer — ${RECREATE_CONSUMER}`;
      case "deliver_subject": {
        const wasPush = typeof from === "string" && from !== "";
        const isPush = typeof to === "string" && to !== "";
        return wasPush !== isPush ? `A ${wasPush ? "push" : "pull"} consumer cannot become a ${isPush ? "push" : "pull"} consumer — ${RECREATE_CONSUMER}` : undefined;
      }
      default:
        return undefined;
    }
  }
  if (top === "storage") return "Storage type cannot change on an existing bucket — create a new bucket and copy the keys (Export / Import Keys)";
  return undefined;
}

function n(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Tighter limit: positive and (previously unlimited or lower than before). */
function tightened(from: unknown, to: unknown): boolean {
  const t = n(to);
  const f = n(from);
  return t !== undefined && t > 0 && (f === undefined || f <= 0 || t < f);
}

/** Side effects worth flagging (message loss, irreversible switches). */
export function riskOf(kind: ResourceKind, path: string, from: unknown, to: unknown): string | undefined {
  if (kind === "stream") {
    switch (path) {
      case "max_age":
        return tightened(from, to) ? `Messages older than ${fmtMillis(n(to)! / 1e6)} will be deleted` : undefined;
      case "max_msgs":
      case "max_bytes":
      case "max_msgs_per_subject":
        return tightened(from, to) ? "Messages above the new limit will be deleted (or new ones rejected with discard \"new\")" : undefined;
      case "subjects": {
        const before = Array.isArray(from) ? (from as string[]) : [];
        const removed = before.filter((s) => !(Array.isArray(to) && to.includes(s)));
        return removed.length ? `Stops capturing ${removed.map((s) => `"${s}"`).join(", ")}` : undefined;
      }
      case "retention":
        return from === "limits" && to === "interest" ? "Messages without consumer interest will be removed" : undefined;
      case "discard":
        return from === "old" && to === "new" ? "Publishes are rejected when the stream is full instead of dropping old messages" : undefined;
      case "sealed":
      case "deny_delete":
      case "deny_purge":
      case "allow_msg_ttl":
      case "allow_msg_schedules":
        return from !== true && to === true ? "Irreversible: cannot be turned off later" : undefined;
      case "num_replicas":
        return n(to) !== undefined && n(from) !== undefined && n(to)! < n(from)! ? "Fewer replicas: lower fault tolerance" : undefined;
      default:
        return undefined;
    }
  }
  if (kind === "kv") {
    switch (path) {
      case "history":
        return n(to) !== undefined && n(from) !== undefined && n(to)! < n(from)! ? "Older revisions beyond the new history will be removed" : undefined;
      case "ttl":
        return tightened(from, to) ? `Keys not updated for ${fmtMillis(n(to)!)} will expire` : undefined;
      case "max_bytes":
        return tightened(from, to) ? "Puts are rejected once the bucket reaches the new size" : undefined;
      default:
        return undefined;
    }
  }
  if (path === "max_deliver" && tightened(from, to)) return "Messages that already reached the new limit stop being redelivered";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Normalisation and equality
// ---------------------------------------------------------------------------------------------

function isEmptyish(v: unknown): boolean {
  return v === undefined || v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0);
}

function stripNats(md: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(md)) if (!k.startsWith("_nats")) out[k] = v;
  return out;
}

const TIME_KEY = /(_time|pause_until)$/;

function normalize(path: string, v: unknown, spec: FieldSpec | undefined): unknown {
  if (v === undefined || v === null) return undefined;
  if (spec?.zero === "unlimited" && v === 0) return -1;
  if (spec?.set && Array.isArray(v)) return [...v].map(String).sort();
  if (typeof v === "string" && TIME_KEY.test(path)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : v;
  }
  if (/(^|\.)metadata$/.test(path) && isPlainObject(v)) return stripNats(v);
  return v;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function same(a: unknown, b: unknown): boolean {
  return deepEqual(a, b) || (isEmptyish(a) && isEmptyish(b));
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}["${key}"]`;
}

/** Fields the server owns: never compared. */
const IGNORED: Record<ResourceKind, Set<string>> = {
  stream: new Set(["name"]),
  consumer: new Set(["name", "durable_name"]),
  kv: new Set(["bucket"]),
};

/**
 * Key-level changes needed to make `server` match `local`. Keys absent from `local` are
 * ignored. With no server config every local key is an `add` (see createFields).
 */
export function configDiff(kind: ResourceKind, local: Record<string, unknown>, server: Record<string, unknown> | undefined): ConfigChange[] {
  const specs = fieldsFor(kind);
  const out: ConfigChange[] = [];
  const srv = server ?? {};

  const visit = (path: string, l: unknown, s: unknown, spec: FieldSpec | undefined) => {
    if (l === undefined) return;
    const ln = normalize(path, l, spec);
    const sn = normalize(path, s, spec);
    if (spec?.zero === "default" && l === 0) return; // 0 = "server default": nothing to compare
    if (same(ln, sn)) return;
    if (isPlainObject(ln) && isPlainObject(sn)) {
      for (const k of Object.keys(ln)) visit(childPath(path, k), ln[k], sn[k], undefined);
      return;
    }
    if (Array.isArray(ln) && Array.isArray(sn) && !spec?.set && ln.length === sn.length && ln.every(isPlainObject) && sn.every(isPlainObject)) {
      ln.forEach((x, i) => visit(`${path}[${i}]`, x, sn[i], undefined));
      return;
    }
    const from = isEmptyish(s) && s !== 0 && s !== false ? undefined : /(^|\.)metadata$/.test(path) && isPlainObject(s) ? stripNats(s) : s;
    const to = /(^|\.)metadata$/.test(path) && isPlainObject(l) ? stripNats(l) : l;
    const change: ConfigChange = { path, op: from === undefined ? "add" : "change", from, to };
    const unit = unitFor(kind, path);
    if (unit) change.unit = unit;
    if (server) {
      const im = immutableReason(kind, path, s, l);
      if (im) change.immutable = im;
      const risk = riskOf(kind, path, s, l);
      if (risk) change.risk = risk;
    }
    out.push(change);
  };

  // With a backoff the server sets ack_wait to backoff[0] and ignores the configured value,
  // so comparing ack_wait would report a change that never converges.
  const backoff = kind === "consumer" ? (Array.isArray(local.backoff) ? local.backoff : srv.backoff) : undefined;
  const ackWaitDerived = Array.isArray(backoff) && backoff.length > 0;

  for (const [key, l] of Object.entries(local)) {
    if (IGNORED[kind].has(key) || key === "$schema") continue;
    if (key === "ack_wait" && ackWaitDerived) continue;
    visit(key, l, srv[key], specs[key]);
  }
  return out;
}

/** Every local field as an `add` line (plan output for resources that will be created). */
export function createFields(kind: ResourceKind, local: Record<string, unknown>): ConfigChange[] {
  const out: ConfigChange[] = [];
  for (const [key, v] of Object.entries(local)) {
    if (v === undefined || key === "$schema" || IGNORED[kind].has(key)) continue;
    const to = key === "metadata" && isPlainObject(v) ? stripNats(v) : v;
    if (key === "metadata" && isPlainObject(to) && !Object.keys(to).length) continue;
    const c: ConfigChange = { path: key, op: "add", to };
    const unit = unitFor(kind, key);
    if (unit) c.unit = unit;
    out.push(c);
  }
  return out;
}

/**
 * Update payload for the keys present locally: nested objects (metadata, placement,
 * consumer_limits…) are merged into the server's so keys omitted locally are kept, matching
 * the diff semantics (the client libraries only merge top-level keys).
 */
export function mergeForUpdate(server: Record<string, unknown> | undefined, local: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, l] of Object.entries(local)) {
    if (l === undefined || k === "$schema") continue;
    const s = server?.[k];
    if (isPlainObject(l) && isPlainObject(s) && k !== "mirror") {
      const base = k === "metadata" ? stripNats(s) : s;
      out[k] = mergeForUpdate(base, l);
      for (const [bk, bv] of Object.entries(base)) if (!(bk in l)) (out[k] as Record<string, unknown>)[bk] = bv;
    } else {
      out[k] = l;
    }
  }
  return out;
}

/**
 * The server rejects a stream whose duplicate window is larger than a non-zero max_age
 * ("duplicates window can not be larger then max age"). On create it shrinks the default
 * window itself, but an update keeps the current window (2 min by default), so lowering
 * max_age / a KV ttl below it fails. Returns the duplicate_window (ns) the update must send,
 * or undefined when nothing needs to change (or the file sets duplicate_window explicitly).
 */
export function fitDuplicateWindow(maxAgeNs: unknown, localDupNs: unknown, serverDupNs: unknown): number | undefined {
  if (typeof maxAgeNs !== "number" || maxAgeNs <= 0) return undefined;
  if (typeof localDupNs === "number" && localDupNs > 0) return undefined;
  if (typeof serverDupNs !== "number" || serverDupNs <= maxAgeNs) return undefined;
  return maxAgeNs;
}

export function blockedReason(changes: readonly ConfigChange[]): string | undefined {
  const im = changes.filter((c) => c.immutable);
  if (!im.length) return undefined;
  return `${im.map((c) => c.path).join(", ")} cannot be changed on the existing resource`;
}

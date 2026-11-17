// Config-as-code file conventions, validation and conversions. Pure module (no vscode).
//
//   <STREAM>.stream.json             StreamConfig (same JSON as `nats stream add --config`)
//   <STREAM>.<CONSUMER>.consumer.json ConsumerConfig; the stream comes from the file name
//   <BUCKET>.kv.json                 { bucket, description, history, ttl, storage, replicas,
//                                      max_bytes, max_value_size, compression, metadata }
//
// Durations in stream / consumer files are nanoseconds (JetStream API unit). KV `ttl` is
// milliseconds or a duration string such as "24h".

import { parseDuration } from "../shared/format";
import type { ResourceKind, ValueUnit } from "./types";

export const CONFIG_FILE_RE = /\.(stream|consumer|kv)\.json$/i;
export const CONFIG_GLOB = "**/*.{stream,consumer,kv}.json";

export const KIND_ORDER: Record<ResourceKind, number> = { stream: 0, kv: 1, consumer: 2 };

export function resourceId(kind: ResourceKind, name: string, stream?: string): string {
  return kind === "consumer" ? `consumer:${stream}/${name}` : `${kind}:${name}`;
}

export function fileNameFor(kind: ResourceKind, name: string, stream?: string): string {
  return kind === "consumer" ? `${stream}.${name}.consumer.json` : `${name}.${kind}.json`;
}

/** Stream / consumer names: no whitespace, dots, wildcards or path separators. */
export function validateResourceName(name: string, what: string): string | undefined {
  if (!name) return `${what} name is empty`;
  if (/[\s.*>/\\]/.test(name)) return `${what} name "${name}" cannot contain whitespace, ".", "*", ">", "/" or "\\"`;
  if (name.length > 255) return `${what} name is longer than 255 characters`;
  return undefined;
}

export function validateBucketName(name: string): string | undefined {
  if (!/^[-\w]+$/.test(name)) return `Bucket name "${name}" may only contain letters, digits, "-" and "_"`;
  return undefined;
}

export type FileClass =
  | { ok: true; kind: ResourceKind; name: string; stream?: string }
  | { ok: false; kind: ResourceKind; error: string; name?: string; stream?: string };

/** Classify a config file by its base name; undefined when it is not a config file at all. */
export function classifyFileName(baseName: string): FileClass | undefined {
  const m = CONFIG_FILE_RE.exec(baseName);
  if (!m) return undefined;
  const kind = m[1].toLowerCase() as ResourceKind;
  const stem = baseName.slice(0, m.index);
  if (kind === "consumer") {
    const parts = stem.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { ok: false, kind, error: `Consumer files must be named <STREAM>.<CONSUMER>.consumer.json (stream and consumer names cannot contain dots); got "${baseName}"` };
    }
    const err = validateResourceName(parts[0], "Stream") ?? validateResourceName(parts[1], "Consumer");
    return err ? { ok: false, kind, error: err, stream: parts[0], name: parts[1] } : { ok: true, kind, stream: parts[0], name: parts[1] };
  }
  if (kind === "kv") {
    const err = stem ? validateBucketName(stem) : "The file name has no bucket name";
    return err ? { ok: false, kind, error: err, name: stem } : { ok: true, kind, name: stem };
  }
  const err = stem.includes(".") ? `Stream files must be named <STREAM>.stream.json and stream names cannot contain dots; got "${baseName}"` : validateResourceName(stem, "Stream");
  return err ? { ok: false, kind, error: err, name: stem } : { ok: true, kind, name: stem };
}

// ---------------------------------------------------------------------------------------------
// Field specs (mirror @nats-io/jetstream jsapi_types StreamConfig / ConsumerConfig)
// ---------------------------------------------------------------------------------------------

export interface FieldSpec {
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  unit?: ValueUnit;
  enum?: readonly string[];
  /** 0 is normalised by the server: "unlimited" → -1, "default" → a server default (local 0 = unset). */
  zero?: "unlimited" | "default";
  /** Order-insensitive string list. */
  set?: boolean;
  /** Array element type (for validation). */
  items?: "string" | "integer";
}

export const STREAM_FIELDS: Record<string, FieldSpec> = {
  name: { type: "string" },
  description: { type: "string" },
  subjects: { type: "array", items: "string", set: true },
  retention: { type: "string", enum: ["limits", "interest", "workqueue"] },
  max_consumers: { type: "integer", zero: "unlimited" },
  max_msgs: { type: "integer", zero: "unlimited" },
  max_bytes: { type: "integer", unit: "bytes", zero: "unlimited" },
  max_age: { type: "integer", unit: "ns" },
  max_msgs_per_subject: { type: "integer", zero: "unlimited" },
  max_msg_size: { type: "integer", unit: "bytes", zero: "unlimited" },
  storage: { type: "string", enum: ["file", "memory"] },
  discard: { type: "string", enum: ["old", "new"] },
  discard_new_per_subject: { type: "boolean" },
  num_replicas: { type: "integer", zero: "default" },
  no_ack: { type: "boolean" },
  duplicate_window: { type: "integer", unit: "ns", zero: "default" },
  placement: { type: "object" },
  mirror: { type: "object" },
  sources: { type: "array" },
  sealed: { type: "boolean" },
  deny_delete: { type: "boolean" },
  deny_purge: { type: "boolean" },
  allow_rollup_hdrs: { type: "boolean" },
  allow_direct: { type: "boolean" },
  mirror_direct: { type: "boolean" },
  republish: { type: "object" },
  metadata: { type: "object" },
  subject_transform: { type: "object" },
  compression: { type: "string", enum: ["none", "s2"] },
  consumer_limits: { type: "object" },
  first_seq: { type: "integer" },
  subject_delete_marker_ttl: { type: "integer", unit: "ns" },
  allow_msg_ttl: { type: "boolean" },
  allow_msg_counter: { type: "boolean" },
  allow_msg_schedules: { type: "boolean" },
  allow_atomic: { type: "boolean" },
  allow_batched: { type: "boolean" },
  persist_mode: { type: "string", enum: ["default", "async"] },
};

export const CONSUMER_FIELDS: Record<string, FieldSpec> = {
  name: { type: "string" },
  durable_name: { type: "string" },
  description: { type: "string" },
  deliver_policy: { type: "string", enum: ["all", "last", "new", "by_start_sequence", "by_start_time", "last_per_subject"] },
  opt_start_seq: { type: "integer" },
  opt_start_time: { type: "string" },
  ack_policy: { type: "string", enum: ["none", "all", "explicit", "flow_control"] },
  ack_wait: { type: "integer", unit: "ns", zero: "default" },
  max_deliver: { type: "integer", zero: "unlimited" },
  backoff: { type: "array", items: "integer" },
  filter_subject: { type: "string" },
  filter_subjects: { type: "array", items: "string", set: true },
  replay_policy: { type: "string", enum: ["instant", "original"] },
  rate_limit_bps: { type: "integer" },
  sample_freq: { type: "string" },
  max_waiting: { type: "integer", zero: "default" },
  max_ack_pending: { type: "integer", zero: "default" },
  headers_only: { type: "boolean" },
  deliver_subject: { type: "string" },
  deliver_group: { type: "string" },
  flow_control: { type: "boolean" },
  idle_heartbeat: { type: "integer", unit: "ns" },
  max_batch: { type: "integer" },
  max_expires: { type: "integer", unit: "ns" },
  max_bytes: { type: "integer", unit: "bytes" },
  inactive_threshold: { type: "integer", unit: "ns" },
  num_replicas: { type: "integer" },
  mem_storage: { type: "boolean" },
  metadata: { type: "object" },
  pause_until: { type: "string" },
  priority_groups: { type: "array", items: "string" },
  priority_policy: { type: "string", enum: ["none", "overflow", "pinned_client", "prioritized"] },
  priority_timeout: { type: "integer", unit: "ns" },
};

/** Normalised KV definition (ttl in milliseconds). */
export const KV_FIELDS: Record<string, FieldSpec> = {
  bucket: { type: "string" },
  description: { type: "string" },
  history: { type: "integer", zero: "default" },
  ttl: { type: "integer", unit: "ms" },
  storage: { type: "string", enum: ["file", "memory"] },
  replicas: { type: "integer", zero: "default" },
  max_bytes: { type: "integer", unit: "bytes", zero: "unlimited" },
  max_value_size: { type: "integer", unit: "bytes", zero: "unlimited" },
  compression: { type: "boolean" },
  metadata: { type: "object" },
};

/** Units of nested fields (paths without array indexes). */
const NESTED_UNITS: Record<string, ValueUnit> = {
  "consumer_limits.inactive_threshold": "ns",
  backoff: "ns",
};

export function fieldsFor(kind: ResourceKind): Record<string, FieldSpec> {
  return kind === "stream" ? STREAM_FIELDS : kind === "consumer" ? CONSUMER_FIELDS : KV_FIELDS;
}

export function unitFor(kind: ResourceKind, path: string): ValueUnit | undefined {
  const bare = path.replace(/\[\d+\]/g, "");
  return NESTED_UNITS[bare] ?? (bare.includes(".") ? undefined : fieldsFor(kind)[bare]?.unit);
}

// ---------------------------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------------------------

const MS_UNITS: [string, number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1000],
  ["ms", 1],
];

/** Exact, lossless duration string for whole milliseconds: 90061001 → "1d1h1m1s1ms"; 0 → "0s". */
export function msToDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  let rest = Math.round(ms);
  if (rest === 0) return "0s";
  let out = "";
  for (const [u, size] of MS_UNITS) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      out += `${n}${u}`;
      rest -= n * size;
    }
  }
  return out;
}

/** "24h" → 86400000. Plain numbers are milliseconds. Returns undefined for invalid input. */
export function parseTtl(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || /^\d+(\.\d+)?$/.test(s)) return undefined; // ambiguous unit
  const ms = parseDuration(s);
  return ms === undefined ? undefined : Math.round(ms);
}

export const NS_PER_MS = 1_000_000;

// ---------------------------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------------------------

export interface ParsedOk {
  ok: true;
  id: string;
  kind: ResourceKind;
  name: string;
  stream?: string;
  /** Path relative to the planned folder (or the base name). */
  file: string;
  /** Stream / consumer config as written; KV: normalised definition (ttl in ms). */
  config: Record<string, unknown>;
  warnings: string[];
  unsaved?: boolean;
}

export interface ParsedError {
  ok: false;
  id: string;
  kind?: ResourceKind;
  name?: string;
  stream?: string;
  file: string;
  error: string;
  unsaved?: boolean;
}

export type ParsedConfig = ParsedOk | ParsedError;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Offset of the first JSON syntax error (undefined when the text is valid JSON). */
export function jsonErrorOffset(text: string): number | undefined {
  let i = 0;
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const string = () => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === '"') return void i++;
      else if (c < " ") fail();
      else i++;
    }
    fail();
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) return void i++;
      for (;;) {
        if (c === "{") {
          ws();
          if (text[i] !== '"') fail();
          string();
          ws();
          if (text[i] !== ":") fail();
          i++;
        }
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === close) return void i++;
        else fail();
      }
    }
    if (c === '"') return string();
    const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail();
    i += m![0].length;
  };
  try {
    value();
    ws();
    if (i < text.length) fail();
    return undefined;
  } catch (pos) {
    return typeof pos === "number" ? pos : undefined;
  }
}

/** Line/column of a JSON syntax error ("line 3, column 14"). */
export function jsonErrorLocation(text: string, message: string): string {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return `line ${lc[1]}, column ${lc[2]}`;
  const pos = /position (\d+)/.exec(message);
  const offset = pos ? Number(pos[1]) : jsonErrorOffset(text);
  if (offset === undefined) return "";
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const col = offset - before.lastIndexOf("\n");
  return `line ${line}, column ${col}`;
}

function typeOf(v: unknown): string {
  return Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
}

function nanosHint(key: string, v: unknown): string {
  if (typeof v === "string") {
    const ms = parseDuration(v);
    if (ms !== undefined) return ` — durations are nanoseconds, e.g. "${key}": ${Math.round(ms * NS_PER_MS)} for ${v}`;
  }
  return " — durations are nanoseconds, e.g. 3600000000000 for 1h";
}

/** Type / enum checks against the field specs. Returns [errors, warnings]. */
export function validateFields(kind: Exclude<ResourceKind, "kv">, cfg: Record<string, unknown>): [string[], string[]] {
  const specs = fieldsFor(kind);
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [key, v] of Object.entries(cfg)) {
    const spec = specs[key];
    if (!spec) {
      if (key !== "$schema") warnings.push(`Unknown field "${key}" — not part of the ${kind} config API (check the spelling)`);
      continue;
    }
    if (v === null || v === undefined) continue;
    const t = typeOf(v);
    const intOk = spec.type === "integer" && typeof v === "number" && Number.isInteger(v);
    if (spec.type === "integer" ? !intOk : spec.type === "number" ? t !== "number" : t !== spec.type) {
      const what = spec.type === "integer" ? "an integer" : spec.type === "object" ? "an object" : spec.type === "array" ? "an array" : `a ${spec.type}`;
      errors.push(`"${key}" must be ${what}, got ${t}${spec.unit === "ns" ? nanosHint(key, v) : ""}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(v as string)) errors.push(`"${key}" must be one of ${spec.enum.map((e) => `"${e}"`).join(", ")}; got "${String(v)}"`);
    if (spec.items && Array.isArray(v)) {
      const bad = v.find((x) => (spec.items === "string" ? typeof x !== "string" : !(typeof x === "number" && Number.isInteger(x))));
      if (bad !== undefined) errors.push(`"${key}" must contain only ${spec.items === "string" ? "strings" : "integers"}${spec.unit === "ns" || key === "backoff" ? nanosHint(key, bad) : ""}`);
    }
    if (spec.unit === "ns" && typeof v === "number" && v > 0 && v < 1_000_000) {
      warnings.push(`"${key}" is ${v} ns (${v / 1000} µs) — durations are nanoseconds; did you mean ${v * NS_PER_MS} (${v} ms) or ${v * 1e9} (${v} s)?`);
    }
  }
  if (kind === "consumer") {
    if (cfg.filter_subject && Array.isArray(cfg.filter_subjects) && cfg.filter_subjects.length) errors.push(`Use either "filter_subject" or "filter_subjects", not both`);
    if (cfg.deliver_policy === "by_start_sequence" && cfg.opt_start_seq === undefined) errors.push(`deliver_policy "by_start_sequence" requires "opt_start_seq"`);
    if (cfg.deliver_policy === "by_start_time" && cfg.opt_start_time === undefined) errors.push(`deliver_policy "by_start_time" requires "opt_start_time"`);
    const bo = cfg.backoff;
    if (Array.isArray(bo) && typeof bo[0] === "number" && typeof cfg.ack_wait === "number" && cfg.ack_wait !== 0 && cfg.ack_wait !== bo[0]) {
      warnings.push(`"ack_wait" is ignored while "backoff" is set: the server uses the first backoff step (${bo[0]} ns) as the ack wait`);
    }
  } else {
    if (cfg.mirror && Array.isArray(cfg.subjects) && cfg.subjects.length) errors.push(`A mirror stream cannot have "subjects"`);
    if (cfg.mirror && Array.isArray(cfg.sources) && cfg.sources.length) errors.push(`A stream cannot have both "mirror" and "sources"`);
    const age = cfg.max_age;
    const dup = cfg.duplicate_window;
    if (typeof age === "number" && age > 0 && typeof dup === "number" && dup > age) {
      errors.push(`"duplicate_window" (${dup} ns) cannot be larger than "max_age" (${age} ns) — lower duplicate_window to at most ${age}, or set it to 0 for the server default`);
    }
  }
  return [errors, warnings];
}

/** Validate and normalise a KV definition: ttl → ms, compression "s2"/"none" → boolean. */
export function normalizeKvDefinition(raw: Record<string, unknown>): { def: Record<string, unknown>; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const def: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (!(key in KV_FIELDS)) {
      if (key !== "$schema") warnings.push(`Unknown field "${key}" — KV definitions support ${Object.keys(KV_FIELDS).join(", ")}`);
      continue;
    }
    switch (key) {
      case "ttl": {
        const ms = parseTtl(v);
        if (ms === undefined) errors.push(`"ttl" must be milliseconds (a number) or a duration string such as "24h", "90m", "1h30m"; got ${JSON.stringify(v)}`);
        else def.ttl = ms;
        break;
      }
      case "compression":
        if (typeof v === "boolean") def.compression = v;
        else if (v === "s2" || v === "none") def.compression = v === "s2";
        else errors.push(`"compression" must be true / false; got ${JSON.stringify(v)}`);
        break;
      case "storage":
        if (v !== "file" && v !== "memory") errors.push(`"storage" must be "file" or "memory"; got ${JSON.stringify(v)}`);
        else def.storage = v;
        break;
      case "bucket":
      case "description":
        if (typeof v !== "string") errors.push(`"${key}" must be a string`);
        else def[key] = v;
        break;
      case "metadata":
        if (!isPlainObject(v) || Object.values(v).some((x) => typeof x !== "string")) errors.push(`"metadata" must be an object of string values`);
        else def.metadata = v;
        break;
      default: {
        if (typeof v !== "number" || !Number.isInteger(v)) {
          errors.push(`"${key}" must be an integer, got ${typeOf(v)}`);
          break;
        }
        if (key === "history" && (v < 0 || v > 64)) errors.push(`"history" must be between 1 and 64`);
        if (key === "replicas" && (v < 0 || v > 5)) errors.push(`"replicas" must be between 1 and 5`);
        def[key] = v;
      }
    }
  }
  return { def, errors, warnings };
}

/**
 * Parse one config file. `file` is the path shown to the user (relative to the folder);
 * the kind and names come from its base name.
 */
export function parseConfigFile(file: string, text: string): ParsedConfig {
  const cls = classifyFileName(baseName(file));
  if (!cls) return { ok: false, id: `file:${file}`, file, error: "Not a config file (expected *.stream.json, *.consumer.json or *.kv.json)" };
  const fallbackId = cls.name ? resourceId(cls.kind, cls.name, cls.stream) : `file:${file}`;
  const fail = (error: string, id = fallbackId): ParsedError => ({ ok: false, id, kind: cls.kind, name: cls.name, stream: cls.stream, file, error });
  if (!cls.ok) return fail(cls.error, `file:${file}`);

  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const loc = jsonErrorLocation(text, msg);
    const short = msg.replace(/^JSON\.parse: /, "").replace(/, ".*" is not valid JSON$/s, "").replace(/ in JSON at position \d+.*$/s, "");
    return fail(`Invalid JSON${loc ? ` at ${loc}` : ""}: ${short}`);
  }
  if (!isPlainObject(json)) return fail(`Expected a JSON object, got ${typeOf(json)}`);
  const { $schema: _schema, ...cfg } = json;

  if (cls.kind === "kv") {
    if (cfg.bucket !== undefined && cfg.bucket !== cls.name) return fail(`"bucket" is "${String(cfg.bucket)}" but the file name says "${cls.name}" — rename the file or fix the field`);
    const { def, errors, warnings } = normalizeKvDefinition(cfg);
    if (errors.length) return fail(errors.join("; "));
    def.bucket = cls.name;
    return { ok: true, id: fallbackId, kind: "kv", name: cls.name, file, config: def, warnings };
  }

  if (cls.kind === "stream") {
    if (cfg.name !== undefined && cfg.name !== cls.name) return fail(`"name" is "${String(cfg.name)}" but the file name says "${cls.name}" — rename the file or fix the field`);
    const [errors, warnings] = validateFields("stream", cfg);
    if (errors.length) return fail(errors.join("; "));
    if (/^(KV_|OBJ_)/.test(cls.name)) warnings.push(`"${cls.name}" is a KV / Object Store backing stream — prefer a <bucket>.kv.json definition`);
    return { ok: true, id: fallbackId, kind: "stream", name: cls.name, file, config: { ...cfg, name: cls.name }, warnings };
  }

  // consumer
  const durable = cfg.durable_name ?? cfg.name;
  if (cfg.durable_name !== undefined && cfg.durable_name !== cls.name) return fail(`"durable_name" is "${String(cfg.durable_name)}" but the file name says "${cls.name}" — rename the file or fix the field`);
  if (cfg.name !== undefined && cfg.name !== cls.name) return fail(`"name" is "${String(cfg.name)}" but the file name says "${cls.name}" — rename the file or fix the field`);
  const [errors, warnings] = validateFields("consumer", cfg);
  if (errors.length) return fail(errors.join("; "));
  if (durable === undefined) warnings.push(`No "durable_name": the consumer is created as durable "${cls.name}" (from the file name)`);
  return { ok: true, id: fallbackId, kind: "consumer", name: cls.name, stream: cls.stream, file, config: { ...cfg }, warnings };
}

// ---------------------------------------------------------------------------------------------
// KV definition ↔ backing stream
// ---------------------------------------------------------------------------------------------

/** Metadata without the server-managed `_nats*` keys (undefined when nothing is left). */
export function cleanMetadata(md: unknown): Record<string, string> | undefined {
  if (!isPlainObject(md)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(md)) if (!k.startsWith("_nats")) out[k] = String(v);
  return Object.keys(out).length ? out : undefined;
}

/** The normalised KV definition of a `KV_<bucket>` stream config (ttl in ms). */
export function kvFromStreamConfig(sc: Record<string, unknown>): Record<string, unknown> {
  const name = String(sc.name ?? "");
  const def: Record<string, unknown> = {
    bucket: name.startsWith("KV_") ? name.slice(3) : name,
    description: (sc.description as string | undefined) ?? "",
    history: (sc.max_msgs_per_subject as number | undefined) ?? 1,
    ttl: Math.round(((sc.max_age as number | undefined) ?? 0) / NS_PER_MS),
    storage: (sc.storage as string | undefined) ?? "file",
    replicas: (sc.num_replicas as number | undefined) ?? 1,
    max_bytes: (sc.max_bytes as number | undefined) ?? -1,
    max_value_size: (sc.max_msg_size as number | undefined) ?? -1,
    compression: sc.compression === "s2",
  };
  const md = cleanMetadata(sc.metadata);
  if (md) def.metadata = md;
  return def;
}

/** Options for `Kvm.create` from a normalised definition. */
export function kvCreateOptions(def: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (def.description !== undefined) o.description = def.description;
  if (def.history !== undefined && def.history !== 0) o.history = def.history;
  if (def.ttl !== undefined) o.ttl = def.ttl;
  if (def.storage !== undefined) o.storage = def.storage;
  if (def.replicas !== undefined && def.replicas !== 0) o.replicas = def.replicas;
  if (def.max_bytes !== undefined) o.max_bytes = def.max_bytes === 0 ? -1 : def.max_bytes;
  if (def.max_value_size !== undefined) o.maxValueSize = def.max_value_size === 0 ? -1 : def.max_value_size;
  if (def.compression !== undefined) o.compression = def.compression;
  if (def.metadata !== undefined) o.metadata = def.metadata;
  return o;
}

/** Backing-stream update fields for the keys present in a KV definition (storage is immutable). */
export function kvStreamUpdate(def: Record<string, unknown>): Record<string, unknown> {
  const u: Record<string, unknown> = {};
  if (def.description !== undefined) u.description = def.description;
  if (def.history !== undefined && def.history !== 0) u.max_msgs_per_subject = def.history;
  if (def.ttl !== undefined) u.max_age = (def.ttl as number) * NS_PER_MS;
  if (def.replicas !== undefined && def.replicas !== 0) u.num_replicas = def.replicas;
  if (def.max_bytes !== undefined) u.max_bytes = def.max_bytes === 0 ? -1 : def.max_bytes;
  if (def.max_value_size !== undefined) u.max_msg_size = def.max_value_size === 0 ? -1 : def.max_value_size;
  if (def.compression !== undefined) u.compression = def.compression ? "s2" : "none";
  if (def.metadata !== undefined) u.metadata = def.metadata;
  return u;
}

// ---------------------------------------------------------------------------------------------
// Export serialisers
// ---------------------------------------------------------------------------------------------

/** Server config → file content: `_nats*` metadata and empty objects removed, name first. */
export function cleanServerConfig(cfg: Record<string, unknown>, first: string[] = ["name"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = [...first.filter((k) => k in cfg), ...Object.keys(cfg).filter((k) => !first.includes(k))];
  for (const k of keys) {
    const v = cfg[k];
    if (v === undefined || v === null) continue;
    if (k === "metadata") {
      const md = cleanMetadata(v);
      if (md) out.metadata = md;
      continue;
    }
    if (isPlainObject(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

export function toFileContent(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

export function exportStreamConfig(cfg: Record<string, unknown>): string {
  return toFileContent(cleanServerConfig(cfg, ["name", "description", "subjects"]));
}

export function exportConsumerConfig(cfg: Record<string, unknown>): string {
  return toFileContent(cleanServerConfig(cfg, ["durable_name", "name", "description"]));
}

/** `KV_<bucket>` stream config → <bucket>.kv.json content (ttl as a duration string). */
export function kvFileObject(sc: Record<string, unknown>): Record<string, unknown> {
  const def = kvFromStreamConfig(sc);
  const out: Record<string, unknown> = {
    bucket: def.bucket,
    description: def.description,
    history: def.history,
    ttl: (def.ttl as number) > 0 ? msToDuration(def.ttl as number) : 0,
    storage: def.storage,
    replicas: def.replicas,
    max_bytes: def.max_bytes,
    max_value_size: def.max_value_size,
    compression: def.compression,
  };
  if (def.metadata) out.metadata = def.metadata;
  return out;
}

export function exportKvDefinition(sc: Record<string, unknown>): string {
  return toFileContent(kvFileObject(sc));
}

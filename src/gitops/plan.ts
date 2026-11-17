// Plan: compare a folder of config files with a server. No vscode imports.
//
//   readConfigFolder(dir)            → the folder's own config files (subfolders are separate
//                                      plans: each folder has its own target connection)
//   findConfigSubfolders(dir)        → subfolders that contain config files (for suggestions)
//   fetchServerState(jsm, streams)   → server configs (streams, durable consumers, KV buckets)
//   computePlan(parsed, state)       → create / update / unchanged / drift / error items (pure)

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { JetStreamManager } from "@nats-io/jetstream";
import { CONFIG_FILE_RE, KIND_ORDER, NS_PER_MS, cleanServerConfig, kvFromStreamConfig, parseConfigFile, resourceId, type ParsedConfig, type ParsedOk } from "./configFiles";
import { blockedReason, configDiff, createFields, fitDuplicateWindow } from "./configDiff";
import { fmtMillis } from "../shared/format";
import { PLAN_ACTIONS, type PlanAction, type PlanItem, type ResourceKind } from "./types";

export interface FolderFile {
  /** Path relative to the folder, with "/" separators. */
  file: string;
  absPath: string;
  text: string;
  unsaved?: boolean;
}

/**
 * Read the config files of `dir`. Subfolders are not included by default (`maxDepth` 0): a
 * repository usually keeps one folder per connection (nats/dev, nats/prod), and planning the
 * parent recursively would apply one environment's files to another's target.
 * `overrides` (abs path → text) supplies unsaved editor content.
 */
export async function readConfigFolder(dir: string, overrides: ReadonlyMap<string, string> = new Map(), maxDepth = 0): Promise<FolderFile[]> {
  const out: FolderFile[] = [];
  const walk = async (d: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !e.name.startsWith(".") && e.name !== "node_modules") await walk(abs, depth + 1);
      } else if (e.isFile() && CONFIG_FILE_RE.test(e.name)) {
        const override = overrides.get(abs);
        const text = override ?? (await readFile(abs, "utf8"));
        out.push({ file: relative(dir, abs).split(sep).join("/"), absPath: abs, text, unsaved: override !== undefined || undefined });
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Subfolders of `dir` (relative, "/" separators) that directly contain config files. */
export async function findConfigSubfolders(dir: string, maxDepth = 3, limit = 20): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (d !== dir && entries.some((e) => e.isFile() && CONFIG_FILE_RE.test(e.name))) out.push(relative(dir, d).split(sep).join("/"));
    if (depth >= maxDepth) return;
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") await walk(join(d, e.name), depth + 1);
    }
  };
  await walk(dir, 0);
  return out.slice(0, limit);
}

export function parseFolderFiles(files: readonly FolderFile[]): ParsedConfig[] {
  return files.map((f) => {
    const p = parseConfigFile(f.file, f.text);
    if (f.unsaved) p.unsaved = true;
    return p;
  });
}

export interface ServerState {
  jetstream: boolean;
  /** Every stream config by name (internal KV_/OBJ_ streams included). */
  streams: Map<string, Record<string, unknown>>;
  /** Durable consumer configs by stream → name (only for the streams that were asked for). */
  consumers: Map<string, Map<string, Record<string, unknown>>>;
  /** Normalised KV definitions by bucket. */
  kv: Map<string, Record<string, unknown>>;
}

export const INTERNAL_STREAM_RE = /^(KV_|OBJ_|\$MQTT_)/;

/** JetStream is off for the account / server (as opposed to a timeout or permission error). */
export function isJetStreamUnavailable(e: unknown): boolean {
  if (e instanceof Error && e.name === "JetStreamNotEnabled") return true;
  return /jetstream (is )?not enabled|no responders/i.test(e instanceof Error ? e.message : String(e));
}

/** Is a consumer durable (survives without subscribers)? */
export function isDurable(cfg: Record<string, unknown>): boolean {
  return typeof cfg.durable_name === "string" && cfg.durable_name !== "";
}

export async function fetchServerState(jsm: JetStreamManager, consumerStreams: Iterable<string>): Promise<ServerState> {
  const streams = new Map<string, Record<string, unknown>>();
  const kv = new Map<string, Record<string, unknown>>();
  for await (const si of jsm.streams.list()) {
    const cfg = si.config as unknown as Record<string, unknown>;
    streams.set(si.config.name, cfg);
    if (si.config.name.startsWith("KV_")) kv.set(si.config.name.slice(3), kvFromStreamConfig(cfg));
  }
  const consumers = new Map<string, Map<string, Record<string, unknown>>>();
  for (const stream of new Set(consumerStreams)) {
    if (!streams.has(stream)) continue;
    const m = new Map<string, Record<string, unknown>>();
    for await (const ci of jsm.consumers.list(stream)) {
      const cfg = ci.config as unknown as Record<string, unknown>;
      if (isDurable(cfg)) m.set(ci.name, cfg);
    }
    consumers.set(stream, m);
  }
  return { jetstream: true, streams, consumers, kv };
}

/** Server config of one resource (undefined when it does not exist). */
export async function fetchServerConfig(jsm: JetStreamManager, kind: ResourceKind, name: string, stream?: string): Promise<Record<string, unknown> | undefined> {
  const notFound = (e: unknown) => /not found|10059|10014/i.test(e instanceof Error ? e.message : String(e));
  try {
    if (kind === "stream") return (await jsm.streams.info(name)).config as unknown as Record<string, unknown>;
    if (kind === "consumer") return (await jsm.consumers.info(stream!, name)).config as unknown as Record<string, unknown>;
    return kvFromStreamConfig((await jsm.streams.info(`KV_${name}`)).config as unknown as Record<string, unknown>);
  } catch (e) {
    if (notFound(e)) return undefined;
    throw e;
  }
}

/** Streams whose consumers the plan needs (referenced by stream or consumer files). */
export function consumerStreamsOf(parsed: readonly ParsedConfig[]): string[] {
  const out = new Set<string>();
  for (const p of parsed) {
    if (p.kind === "stream" && p.name) out.add(p.name);
    if (p.kind === "consumer" && p.stream) out.add(p.stream);
  }
  return [...out];
}

function sortItems(items: PlanItem[]): PlanItem[] {
  const kindRank = (i: PlanItem) => (i.kind ? KIND_ORDER[i.kind] : 3);
  return items.sort((a, b) => kindRank(a) - kindRank(b) || (a.stream ?? a.name).localeCompare(b.stream ?? b.name) || (a.kind === "consumer" && b.kind === "consumer" ? a.name.localeCompare(b.name) : 0) || a.id.localeCompare(b.id));
}

export function countActions(items: readonly PlanItem[]): Record<PlanAction, number> {
  const counts = Object.fromEntries(PLAN_ACTIONS.map((a) => [a, 0])) as Record<PlanAction, number>;
  for (const i of items) counts[i.action]++;
  return counts;
}

function planOne(p: ParsedOk, server: Record<string, unknown> | undefined, serverDupNs?: unknown): PlanItem {
  const base: PlanItem = { id: p.id, kind: p.kind, name: p.name, stream: p.stream, file: p.file, action: "unchanged", changes: [], warnings: [...p.warnings], unsaved: p.unsaved };
  if (!server) {
    const item: PlanItem = { ...base, action: "create", fields: createFields(p.kind, p.config) };
    if (p.kind === "stream" && p.config.sealed === true) item.warnings.push("The server cannot create a sealed stream: it is created unsealed, then sealed by an update (irreversible)");
    return item;
  }
  const changes = configDiff(p.kind, p.config, server);
  if (!changes.length) return base;
  const item: PlanItem = { ...base, action: "update", changes };
  const blocked = blockedReason(changes);
  if (blocked) item.blocked = blocked;
  const maxAge = p.kind === "stream" ? p.config.max_age : p.kind === "kv" && typeof p.config.ttl === "number" ? p.config.ttl * NS_PER_MS : undefined;
  const dup = p.kind === "consumer" ? undefined : fitDuplicateWindow(maxAge, p.kind === "stream" ? p.config.duplicate_window : undefined, serverDupNs);
  if (dup !== undefined && changes.some((c) => c.path === (p.kind === "kv" ? "ttl" : "max_age"))) {
    item.warnings.push(`The duplicate window (${fmtNsShort(serverDupNs as number)}) is lowered to ${fmtNsShort(dup)}: the server does not accept a window larger than ${p.kind === "kv" ? "the TTL" : "max_age"}`);
  }
  return item;
}

/** Turn parsed files + server state into plan items. Pure. */
export function computePlan(parsed: readonly ParsedConfig[], state: ServerState): { items: PlanItem[]; scope: ResourceKind[] } {
  const items: PlanItem[] = [];
  const seen = new Map<string, string>();
  const scope = new Set<ResourceKind>();
  const created = new Set<string>();

  // Streams and KV first so consumers can depend on streams being created.
  const ordered = [...parsed].sort((a, b) => (a.kind ? KIND_ORDER[a.kind] : 3) - (b.kind ? KIND_ORDER[b.kind] : 3));
  for (const p of ordered) {
    if (p.kind) scope.add(p.kind);
    if (!p.ok) {
      items.push({ id: p.id.startsWith("file:") || seen.has(p.id) ? `file:${p.file}` : p.id, kind: p.kind, name: p.name ?? p.file, stream: p.stream, file: p.file, action: "error", changes: [], warnings: [], error: p.error, unsaved: p.unsaved });
      if (!p.id.startsWith("file:")) seen.set(p.id, p.file);
      continue;
    }
    const dup = seen.get(p.id);
    if (dup) {
      items.push({ id: `file:${p.file}`, kind: p.kind, name: p.name, stream: p.stream, file: p.file, action: "error", changes: [], warnings: [], error: `Duplicate definition: ${p.id.replace(":", " ")} is also defined in ${dup}` });
      continue;
    }
    seen.set(p.id, p.file);
    if (!state.jetstream) {
      items.push({ id: p.id, kind: p.kind, name: p.name, stream: p.stream, file: p.file, action: "error", changes: [], warnings: [], error: "JetStream is not enabled for this account" });
      continue;
    }
    if (p.kind === "stream") {
      const srv = state.streams.get(p.name);
      const item = planOne(p, srv, srv?.duplicate_window);
      if (item.action === "create") created.add(p.name);
      items.push(item);
    } else if (p.kind === "kv") {
      items.push(planOne(p, state.kv.get(p.name), state.streams.get(`KV_${p.name}`)?.duplicate_window));
    } else {
      const stream = p.stream!;
      if (!state.streams.has(stream)) {
        if (created.has(stream)) {
          const item = planOne(p, undefined);
          item.dependsOn = resourceId("stream", stream);
          items.push(item);
        } else {
          items.push({ id: p.id, kind: "consumer", name: p.name, stream, file: p.file, action: "error", changes: [], warnings: [...p.warnings], error: `Stream "${stream}" does not exist on the server and is not defined in this folder (add ${stream}.stream.json)` });
        }
        continue;
      }
      items.push(planOne(p, state.consumers.get(stream)?.get(p.name)));
    }
  }

  // Drift: server resources of the kinds this folder manages that have no local file.
  if (state.jetstream) {
    if (scope.has("stream")) {
      for (const [name, cfg] of state.streams) {
        if (INTERNAL_STREAM_RE.test(name) || seen.has(resourceId("stream", name))) continue;
        items.push(driftItem("stream", name, undefined, cfg));
      }
    }
    if (scope.has("stream") || scope.has("consumer")) {
      for (const [stream, m] of state.consumers) {
        for (const [name, cfg] of m) {
          if (seen.has(resourceId("consumer", name, stream))) continue;
          items.push(driftItem("consumer", name, stream, cfg));
        }
      }
    }
    if (scope.has("kv")) {
      for (const [bucket, def] of state.kv) {
        if (seen.has(resourceId("kv", bucket))) continue;
        items.push(driftItem("kv", bucket, undefined, def));
      }
    }
  }
  return { items: sortItems(items), scope: [...scope].sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b]) };
}

function driftItem(kind: ResourceKind, name: string, stream: string | undefined, cfg: Record<string, unknown>): PlanItem {
  const clean = kind === "kv" ? cfg : cleanServerConfig(cfg);
  return { id: resourceId(kind, name, stream), kind, name, stream, action: "drift", changes: [], fields: createFields(kind, clean), warnings: [] };
}

function fmtNsShort(ns: number): string {
  return fmtMillis(ns / NS_PER_MS);
}

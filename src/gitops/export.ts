// Export server JetStream resources as config files. No vscode imports.

import type { JetStreamManager } from "@nats-io/jetstream";
import { exportConsumerConfig, exportKvDefinition, exportStreamConfig, fileNameFor, resourceId } from "./configFiles";
import { INTERNAL_STREAM_RE, isDurable } from "./plan";
import type { ResourceKind } from "./types";

export interface InventoryEntry {
  id: string;
  kind: ResourceKind;
  name: string;
  stream?: string;
  /** Raw server config (stream / consumer config, or the KV_ backing stream config). */
  config: Record<string, unknown>;
  /** Short description for pickers ("orders.> · file · 3 consumers"). */
  detail: string;
}

export interface Inventory {
  entries: InventoryEntry[];
  /** Object stores are not exported (no definition format); reported in the summary. */
  objectStores: string[];
  /** Ephemeral consumers skipped. */
  ephemeral: number;
}

export async function collectInventory(jsm: JetStreamManager): Promise<Inventory> {
  const entries: InventoryEntry[] = [];
  const objectStores: string[] = [];
  let ephemeral = 0;
  const streams: { name: string; config: Record<string, unknown>; consumers: number; subjects: string[]; storage: string }[] = [];
  for await (const si of jsm.streams.list()) {
    const cfg = si.config as unknown as Record<string, unknown>;
    if (si.config.name.startsWith("OBJ_")) {
      objectStores.push(si.config.name.slice(4));
      continue;
    }
    if (si.config.name.startsWith("KV_")) {
      const bucket = si.config.name.slice(3);
      entries.push({
        id: resourceId("kv", bucket),
        kind: "kv",
        name: bucket,
        config: cfg,
        detail: `history ${si.config.max_msgs_per_subject} · ${si.state.messages} msgs · ${si.config.storage}`,
      });
      continue;
    }
    streams.push({ name: si.config.name, config: cfg, consumers: si.state.consumer_count, subjects: si.config.subjects ?? [], storage: si.config.storage });
  }
  for (const s of streams.sort((a, b) => a.name.localeCompare(b.name))) {
    entries.push({
      id: resourceId("stream", s.name),
      kind: "stream",
      name: s.name,
      config: s.config,
      detail: `${s.subjects.join(", ") || (s.config.mirror ? "mirror" : "sources")} · ${s.storage} · ${s.consumers} consumer${s.consumers === 1 ? "" : "s"}`,
    });
    if (!s.consumers) continue;
    for await (const ci of jsm.consumers.list(s.name)) {
      const cfg = ci.config as unknown as Record<string, unknown>;
      if (!isDurable(cfg)) {
        ephemeral++;
        continue;
      }
      entries.push({
        id: resourceId("consumer", ci.name, s.name),
        kind: "consumer",
        name: ci.name,
        stream: s.name,
        config: cfg,
        detail: `${ci.config.deliver_subject ? "push" : "pull"} · ${ci.config.ack_policy} ack${ci.config.filter_subject ? ` · ${ci.config.filter_subject}` : ""}`,
      });
    }
  }
  entries.sort((a, b) => {
    const rank = { stream: 0, consumer: 1, kv: 2 } as const;
    return rank[a.kind] - rank[b.kind] || (a.stream ?? a.name).localeCompare(b.stream ?? b.name) || a.name.localeCompare(b.name);
  });
  return { entries, objectStores: objectStores.sort(), ephemeral };
}

export interface ExportFile {
  id: string;
  kind: ResourceKind;
  /** File name (flat layout: everything in one folder). */
  path: string;
  content: string;
}

/** Config file for one inventory entry. Internal streams other than KV_ are never exported. */
export function exportFile(e: InventoryEntry): ExportFile | undefined {
  if (e.kind === "stream" && INTERNAL_STREAM_RE.test(e.name)) return undefined;
  const path = fileNameFor(e.kind, e.name, e.stream);
  const content = e.kind === "stream" ? exportStreamConfig(e.config) : e.kind === "consumer" ? exportConsumerConfig(e.config) : exportKvDefinition(e.config);
  return { id: e.id, kind: e.kind, path, content };
}

export function exportFiles(entries: readonly InventoryEntry[]): ExportFile[] {
  return entries.map(exportFile).filter((f): f is ExportFile => !!f);
}

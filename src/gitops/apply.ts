// Create or update one resource from a parsed config file. No vscode imports; callers must
// check write permissions (assertWritable) and confirm first.

import type { ConsumerConfig, JetStreamManager, StreamConfig, StreamUpdateConfig } from "@nats-io/jetstream";
import type { Kvm, KvOptions } from "@nats-io/kv";
import { kvCreateOptions, kvStreamUpdate, NS_PER_MS, type ParsedOk } from "./configFiles";
import { configDiff, fitDuplicateWindow, mergeForUpdate } from "./configDiff";
import { fetchServerConfig } from "./plan";

export type ApplyOutcome = "created" | "updated" | "unchanged";

export interface ApplyTarget {
  jsm: JetStreamManager;
  kvm: Kvm;
}

/**
 * Apply `item` against the server's current state (re-read here so a stale plan can't
 * overwrite concurrent changes with old values). Throws on server errors.
 */
export async function applyResource(t: ApplyTarget, item: ParsedOk): Promise<ApplyOutcome> {
  const server = await fetchServerConfig(t.jsm, item.kind, item.name, item.stream);
  if (server && configDiff(item.kind, item.config, server).length === 0) return "unchanged";

  if (item.kind === "stream") {
    if (!server) {
      const { sealed, ...cfg } = item.config;
      await t.jsm.streams.add({ ...cfg, name: item.name } as Partial<StreamConfig> as StreamConfig);
      // The server refuses to create sealed streams: seal with an update.
      if (sealed === true) await t.jsm.streams.update(item.name, { sealed: true } as Partial<StreamUpdateConfig>);
      return "created";
    }
    const { name: _n, ...payload } = mergeForUpdate(server, item.config);
    const dup = fitDuplicateWindow(item.config.max_age, item.config.duplicate_window, server.duplicate_window);
    if (dup !== undefined) payload.duplicate_window = dup;
    await t.jsm.streams.update(item.name, payload as Partial<StreamUpdateConfig>);
    return "updated";
  }

  if (item.kind === "consumer") {
    const stream = item.stream!;
    if (!server) {
      await t.jsm.consumers.add(stream, { ...item.config, durable_name: item.name } as Partial<ConsumerConfig>);
      return "created";
    }
    const { name: _n, durable_name: _d, ...payload } = mergeForUpdate(server, item.config);
    await t.jsm.consumers.update(stream, item.name, payload as Partial<ConsumerConfig>);
    return "updated";
  }

  // KV bucket
  if (!server) {
    await t.kvm.create(item.name, kvCreateOptions(item.config) as Partial<KvOptions>);
    return "created";
  }
  const merged = mergeForUpdate(server, item.config);
  const update = kvStreamUpdate(merged);
  if (typeof merged.ttl === "number" && merged.ttl > 0) {
    // The bucket's duplicate window (2 min unless created with a shorter TTL) must not exceed the new TTL.
    const raw = (await t.jsm.streams.info(`KV_${item.name}`)).config;
    const dup = fitDuplicateWindow(merged.ttl * NS_PER_MS, undefined, raw.duplicate_window);
    if (dup !== undefined) update.duplicate_window = dup;
  }
  await t.jsm.streams.update(`KV_${item.name}`, update as Partial<StreamUpdateConfig>);
  return "updated";
}

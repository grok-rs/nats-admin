// Key-Value operations. Pure NATS logic — no vscode imports.

import { KvWatchInclude, type KV, type KvEntry, type KvStatus, type Kvm } from "@nats-io/kv";
import type { KvBucketDTO, KvEntryDTO } from "../shared/dto";
import { bytesToBase64 } from "../shared/encoding";

export function bucketToDTO(s: KvStatus): KvBucketDTO {
  return {
    bucket: s.bucket,
    values: s.values,
    history: s.history,
    ttlMs: s.ttl,
    bytes: s.size,
    storage: String(s.storage ?? s.streamInfo?.config?.storage ?? "file"),
    replicas: s.replicas ?? s.streamInfo?.config?.num_replicas ?? 1,
    description: s.description || undefined,
  };
}

export async function listBuckets(kvm: Kvm): Promise<KvBucketDTO[]> {
  const out: KvBucketDTO[] = [];
  for await (const s of kvm.list()) out.push(bucketToDTO(s));
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export async function listKeys(kv: KV, filter: string | undefined, max: number): Promise<{ keys: string[]; truncated: boolean }> {
  const it = await kv.keys(filter?.trim() || ">");
  const keys: string[] = [];
  let truncated = false;
  for await (const k of it) {
    if (keys.length >= max) {
      truncated = true;
      it.stop();
      break;
    }
    keys.push(k);
  }
  return { keys, truncated };
}

export function entryToDTO(e: KvEntry, maxValueBytes = Infinity): KvEntryDTO {
  const big = e.value.length > maxValueBytes;
  return {
    key: e.key,
    revision: e.revision,
    created: e.created.toISOString(),
    operation: e.operation,
    size: e.length ?? e.value.length,
    data: big ? bytesToBase64(e.value.subarray(0, maxValueBytes)) : bytesToBase64(e.value),
    truncated: big || undefined,
    delta: e.delta,
  };
}

export async function history(kv: KV, key: string): Promise<KvEntry[]> {
  const it = await kv.history({ key });
  const out: KvEntry[] = [];
  for await (const e of it) out.push(e);
  return out.sort((a, b) => b.revision - a.revision);
}

export interface WatchHandle {
  stop(): void;
}

/**
 * Load the latest entry of every key (values included) and optionally keep
 * streaming updates. `onInitial` fires once with the snapshot; `onUpdate`
 * fires for each later change (including deletes/purges).
 */
export async function snapshotAndWatch(
  kv: KV,
  opts: {
    filter?: string;
    max: number;
    maxValueBytes: number;
    live: boolean;
    onInitial: (entries: KvEntryDTO[], truncated: boolean) => void;
    onUpdate?: (entry: KvEntryDTO) => void;
    onError?: (err: Error) => void;
  },
): Promise<WatchHandle> {
  const status = await kv.status();
  const it = await kv.watch({ key: opts.filter?.trim() || ">", include: KvWatchInclude.LastValue });
  const snapshot = new Map<string, KvEntryDTO>();
  let initialDone = false;
  let truncated = false;
  let stopped = false;
  const finishInitial = () => {
    if (initialDone) return;
    initialDone = true;
    opts.onInitial([...snapshot.values()], truncated);
    if (!opts.live) {
      stopped = true;
      it.stop();
    }
  };
  if (status.values === 0) finishInitial();
  void (async () => {
    try {
      for await (const e of it) {
        if (!initialDone) {
          if (e.operation === "PUT") {
            if (snapshot.size < opts.max) snapshot.set(e.key, entryToDTO(e, opts.maxValueBytes));
            else truncated = true;
          } else {
            snapshot.delete(e.key);
          }
          if ((e.delta ?? 0) === 0) finishInitial();
          continue;
        }
        opts.onUpdate?.(entryToDTO(e, opts.maxValueBytes));
      }
      if (!initialDone) finishInitial();
    } catch (err) {
      if (!stopped) opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return {
    stop: () => {
      stopped = true;
      it.stop();
    },
  };
}

// Key-Value operations. Pure NATS logic — no vscode imports.

import { KvWatchInclude, type KV, type KvEntry, type KvStatus, type Kvm } from "@nats-io/kv";
import { DeliverPolicy, type JetStreamClient, type JsMsg } from "@nats-io/jetstream";
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


// --- pull-based reads ---------------------------------------------------------
// nats.js reads keys / watches / history through *push* consumers with flow
// control, which require publish permission on $JS.FC.<stream>.> — restricted
// (read-only / audit) accounts usually lack it ("Permissions Violation for
// Publish to $JS.FC…"). Ordered *pull* consumers need no flow-control replies,
// so we use them first and fall back to the client's push readers.

interface BucketInternals {
  js: JetStreamClient;
  stream: string;
  prefixLen: number;
  subjectForKey(k: string): string;
  decodeKey(k: string): string;
}

function internals(kv: KV): BucketInternals | undefined {
  const b = kv as unknown as Partial<BucketInternals>;
  return b.js && b.stream && typeof b.prefixLen === "number" && typeof b.subjectForKey === "function" && typeof b.decodeKey === "function" ? (b as BucketInternals) : undefined;
}

function opOf(m: JsMsg): KvEntry["operation"] {
  const h = m.headers;
  if (h?.get("Nats-Marker-Reason") === "MaxAge") return "PURGE";
  const op = h?.get("KV-Operation");
  return op === "DEL" || op === "PURGE" ? op : "PUT";
}

function msgToEntry(b: BucketInternals, bucket: string, m: JsMsg): KvEntry {
  const rawKey = m.subject.substring(b.prefixLen);
  const sizeHdr = m.headers?.get("Nats-Msg-Size");
  const value = m.data;
  return {
    bucket,
    key: b.decodeKey(rawKey),
    rawKey,
    value,
    created: m.time,
    revision: m.seq,
    operation: opOf(m),
    length: sizeHdr ? Number(sizeHdr) : value.length,
    delta: m.info.pending,
    json: <T>() => JSON.parse(new TextDecoder().decode(value)) as T,
    string: () => new TextDecoder().decode(value),
  };
}

/** Read with a short-lived ordered pull consumer; `onMsg` returns false to stop. */
async function pullScan(b: BucketInternals, filter: string, deliver: DeliverPolicy, headersOnly: boolean, onMsg: (m: JsMsg) => boolean): Promise<void> {
  const c = await b.js.consumers.get(b.stream, {
    filter_subjects: b.subjectForKey(filter),
    deliver_policy: deliver,
    headers_only: headersOnly,
    inactive_threshold: 10_000_000_000,
  });
  try {
    for (;;) {
      const it = await c.fetch({ max_messages: 500, expires: 2000 });
      let got = 0;
      let done = false;
      for await (const m of it) {
        got++;
        if (!onMsg(m) || m.info.pending === 0) {
          done = true;
          break;
        }
      }
      if (done || got === 0) break;
    }
  } finally {
    c.delete().catch(() => undefined);
  }
}

/** Latest entry per key via pull (or undefined when pull reads aren't possible). */
async function pullLatest(kv: KV, filter: string | undefined, max: number, headersOnly: boolean): Promise<{ entries: KvEntry[]; truncated: boolean } | undefined> {
  const b = internals(kv);
  if (!b) return undefined;
  const status = await kv.status();
  if (status.values === 0) return { entries: [], truncated: false };
  const latest = new Map<string, KvEntry>();
  let truncated = false;
  await pullScan(b, filter?.trim() || ">", DeliverPolicy.LastPerSubject, headersOnly, (m) => {
    const e = msgToEntry(b, status.bucket, m);
    if (e.operation !== "PUT") latest.delete(e.key);
    else if (latest.size < max || latest.has(e.key)) latest.set(e.key, e);
    else truncated = true;
    return true;
  });
  return { entries: [...latest.values()], truncated };
}

export async function listKeys(kv: KV, filter: string | undefined, max: number): Promise<{ keys: string[]; truncated: boolean }> {
  try {
    const pulled = await pullLatest(kv, filter, max, true);
    if (pulled) return { keys: pulled.entries.map((e) => e.key), truncated: pulled.truncated };
  } catch {
    /* pull reads not permitted — fall back to the client's push-based reader */
  }
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

/** `headersOnly` entries carry no value: `data` stays undefined (= "not loaded"). */
export function entryToDTO(e: KvEntry, maxValueBytes = Infinity, headersOnly = false): KvEntryDTO {
  const big = e.value.length > maxValueBytes;
  if (headersOnly) {
    return { key: e.key, revision: e.revision, created: e.created.toISOString(), operation: e.operation, size: e.length ?? 0, delta: e.delta };
  }
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
  const b = internals(kv);
  if (b) {
    try {
      const out: KvEntry[] = [];
      const bucket = (await kv.status()).bucket;
      await pullScan(b, key, DeliverPolicy.All, false, (m) => (out.push(msgToEntry(b, bucket, m)), true));
      return out.sort((x, y) => y.revision - x.revision);
    } catch {
      /* fall back to push-based history */
    }
  }
  const it = await kv.history({ key });
  const out: KvEntry[] = [];
  for await (const e of it) out.push(e);
  return out.sort((a, b2) => b2.revision - a.revision);
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
    /** Load metadata only (key, revision, size, time); values are fetched on demand. */
    headersOnly?: boolean;
    onInitial: (entries: KvEntryDTO[], truncated: boolean) => void;
    onUpdate?: (entry: KvEntryDTO) => void;
    onError?: (err: Error) => void;
  },
): Promise<WatchHandle> {
  // Snapshot via pull (no flow control). When live, an updates-only watcher is
  // started *before* the snapshot and buffered, so nothing changed in between
  // is lost; buffered updates older than the snapshot entry are dropped.
  const key = opts.filter?.trim() || ">";
  let liveStopped = false;
  let watcher: Awaited<ReturnType<KV["watch"]>> | undefined;
  let delivered = false;
  const buffer: KvEntryDTO[] = [];
  if (opts.live) {
    try {
      watcher = await kv.watch({ key, include: KvWatchInclude.UpdatesOnly, headers_only: opts.headersOnly });
      const w = watcher;
      void (async () => {
        try {
          for await (const e of w) {
            const dto = entryToDTO(e, opts.maxValueBytes, opts.headersOnly);
            if (delivered) opts.onUpdate?.(dto);
            else buffer.push(dto);
          }
        } catch (err) {
          if (!liveStopped) opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
  let pulled: { entries: KvEntry[]; truncated: boolean } | undefined;
  try {
    pulled = await pullLatest(kv, opts.filter, opts.max, Boolean(opts.headersOnly));
  } catch {
    pulled = undefined;
  }
  if (pulled) {
    const snapshot = pulled.entries.map((e) => entryToDTO(e, opts.maxValueBytes, opts.headersOnly));
    opts.onInitial(snapshot, pulled.truncated);
    const seen = new Map(snapshot.map((e) => [e.key, e.revision]));
    delivered = true;
    for (const u of buffer.splice(0)) if (u.revision > (seen.get(u.key) ?? 0)) opts.onUpdate?.(u);
    return {
      stop: () => {
        liveStopped = true;
        watcher?.stop();
      },
    };
  }
  watcher?.stop();

  const status = await kv.status();
  const it = await kv.watch({ key: opts.filter?.trim() || ">", include: KvWatchInclude.LastValue, headers_only: opts.headersOnly });
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
            if (snapshot.size < opts.max) snapshot.set(e.key, entryToDTO(e, opts.maxValueBytes, opts.headersOnly));
            else truncated = true;
          } else {
            snapshot.delete(e.key);
          }
          if ((e.delta ?? 0) === 0) finishInitial();
          continue;
        }
        opts.onUpdate?.(entryToDTO(e, opts.maxValueBytes, opts.headersOnly));
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

/** Fetch current values for specific keys (direct gets, limited concurrency). */
export async function getValues(kv: KV, keys: string[], maxValueBytes: number, concurrency = 16): Promise<KvEntryDTO[]> {
  const out: KvEntryDTO[] = [];
  let i = 0;
  const worker = async () => {
    while (i < keys.length) {
      const k = keys[i++];
      try {
        const e = await kv.get(k);
        if (e && e.operation === "PUT") out.push(entryToDTO(e, maxValueBytes));
      } catch {
        /* deleted meanwhile / transient: skip */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  return out;
}

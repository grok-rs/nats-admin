// JetStream stream / consumer operations used by the tree, commands and the
// Message Browser. Pure NATS logic — no vscode imports.

import {
  DeliverPolicy,
  type ConsumerInfo,
  type JetStreamClient,
  type JetStreamManager,
  type OrderedConsumerOptions,
  type StoredMsg,
  type StreamInfo,
} from "@nats-io/jetstream";
import type { MessageDTO } from "../shared/dto";
import { subjectMatches } from "../shared/subjects";
import { jsMsgToDTO, storedMsgToDTO } from "./messages";

export const INTERNAL_STREAM = /^(KV_|OBJ_|\$MQTT_)/;

export async function listStreams(jsm: JetStreamManager, includeInternal: boolean): Promise<StreamInfo[]> {
  const out: StreamInfo[] = [];
  for await (const si of jsm.streams.list()) {
    if (includeInternal || !INTERNAL_STREAM.test(si.config.name)) out.push(si);
  }
  return out.sort((a, b) => a.config.name.localeCompare(b.config.name));
}

export async function listConsumers(jsm: JetStreamManager, stream: string): Promise<ConsumerInfo[]> {
  const out: ConsumerInfo[] = [];
  for await (const ci of jsm.consumers.list(stream)) out.push(ci);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface BrowseRequest {
  stream: string;
  /** Forward: first sequence to read. Backward: last sequence (inclusive). */
  seq?: number;
  /** ISO time to start reading from (forward only). */
  startTime?: string;
  filter?: string;
  limit: number;
  direction: "forward" | "backward";
}

export interface BrowseResult {
  messages: MessageDTO[];
  firstSeq: number;
  lastSeq: number;
  total: number;
  /** True when a backward filtered scan stopped at its safety cap. */
  partial?: boolean;
  /** True when there are no more messages after the page (forward). */
  atEnd: boolean;
  /** True when there are no more messages before the page. */
  atStart: boolean;
}

interface ScanOptions {
  startSeq?: number;
  startTime?: string;
  filter?: string;
  max: number;
  /** Stop once a message beyond this sequence is seen. */
  stopAfterSeq?: number;
}

/** Read messages with a short-lived ordered consumer. */
async function scanConsumer(js: JetStreamClient, stream: string, o: ScanOptions): Promise<{ messages: MessageDTO[]; exhausted: boolean }> {
  const opts: Partial<OrderedConsumerOptions> = { inactive_threshold: 10_000_000_000 }; // 10s in nanos
  if (o.filter) opts.filter_subjects = o.filter;
  if (o.startTime) {
    opts.deliver_policy = DeliverPolicy.StartTime;
    opts.opt_start_time = o.startTime;
  } else {
    opts.deliver_policy = DeliverPolicy.StartSequence;
    opts.opt_start_seq = Math.max(1, o.startSeq ?? 1);
  }
  const consumer = await js.consumers.get(stream, opts);
  const messages: MessageDTO[] = [];
  let exhausted = false;
  try {
    while (messages.length < o.max && !exhausted) {
      const batch = Math.min(500, o.max - messages.length);
      const iter = await consumer.fetch({ max_messages: batch, expires: 1500 });
      let got = 0;
      for await (const m of iter) {
        got++;
        if (o.stopAfterSeq !== undefined && m.seq > o.stopAfterSeq) {
          exhausted = true;
          break;
        }
        messages.push(jsMsgToDTO(m));
        if (m.info.pending === 0) {
          exhausted = true;
          break;
        }
        if (messages.length >= o.max) break;
      }
      if (got === 0) exhausted = true;
      if (got < batch && !exhausted) {
        // fetch ended early (expired) without reporting pending=0 — treat as end.
        exhausted = true;
      }
    }
  } finally {
    consumer.delete().catch(() => undefined);
  }
  return { messages, exhausted };
}

const BACKWARD_SCAN_CAP = 20_000;

/**
 * Fallback reader using per-sequence direct gets. Used when the server refuses
 * the temporary consumer (work-queue streams reject overlapping consumers, and
 * restricted users may lack consumer-create permission).
 */
async function scanDirect(jsm: JetStreamManager, stream: string, o: ScanOptions, lastSeq: number): Promise<{ messages: MessageDTO[]; exhausted: boolean }> {
  const messages: MessageDTO[] = [];
  const end = Math.min(o.stopAfterSeq ?? lastSeq, lastSeq);
  let seq = Math.max(1, o.startSeq ?? 1);
  const startMs = o.startTime ? Date.parse(o.startTime) : undefined;
  let scanned = 0;
  for (; seq <= end && messages.length < o.max && scanned < 5000; seq++, scanned++) {
    let m: StoredMsg | null = null;
    try {
      m = await jsm.streams.getMessage(stream, { seq });
    } catch {
      continue; // deleted / purged sequence
    }
    if (!m) continue;
    if (o.filter && !subjectMatches(o.filter, m.subject)) continue;
    if (startMs !== undefined && m.time.getTime() < startMs) continue;
    messages.push(storedMsgToDTO(m));
  }
  return { messages, exhausted: seq > end };
}

function consumerRefused(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /work ?queue|multiple non-filtered|filtered consumer not unique|overlap|permission|not authorized|10099|10100|10101/i.test(msg);
}

export async function browseMessages(jsm: JetStreamManager, js: JetStreamClient, req: BrowseRequest): Promise<BrowseResult> {
  const info = await jsm.streams.info(req.stream);
  const { first_seq: firstSeq, last_seq: lastSeq, messages: total } = info.state;
  const directOnly = info.config.retention === "workqueue";
  const scan = (j: JetStreamClient, stream: string, o: ScanOptions) =>
    directOnly ? scanDirect(jsm, stream, o, lastSeq) : scanConsumer(j, stream, o).catch((e) => (consumerRefused(e) ? scanDirect(jsm, stream, o, lastSeq) : Promise.reject(e)));
  const base = { firstSeq, lastSeq, total };
  if (total === 0) return { ...base, messages: [], atEnd: true, atStart: true };
  const limit = Math.max(1, req.limit);

  if (req.direction === "forward") {
    if (!req.startTime && (req.seq ?? firstSeq) > lastSeq) return { ...base, messages: [], atEnd: true, atStart: false };
    const { messages, exhausted } = await scan(js, req.stream, {
      startSeq: Math.max(req.seq ?? firstSeq, firstSeq),
      startTime: req.startTime,
      filter: req.filter,
      max: limit,
    });
    const last = messages.at(-1)?.seq ?? lastSeq;
    return { ...base, messages, atEnd: exhausted || last >= lastSeq, atStart: (messages[0]?.seq ?? firstSeq) <= firstSeq };
  }

  // Backward: the page ending at `seq` (inclusive).
  const end = Math.min(req.seq ?? lastSeq, lastSeq);
  if (end < firstSeq) return { ...base, messages: [], atEnd: false, atStart: true };
  if (!req.filter) {
    const start = Math.max(firstSeq, end - limit + 1);
    const { messages } = await scan(js, req.stream, { startSeq: start, max: end - start + 1, stopAfterSeq: end });
    return { ...base, messages, atEnd: end >= lastSeq, atStart: start <= firstSeq };
  }
  // Filtered backward paging: widen a window towards the start of the stream
  // until it holds `limit` matches (bounded by BACKWARD_SCAN_CAP messages).
  let window = limit * 4;
  let scanned = 0;
  for (;;) {
    const start = Math.max(firstSeq, end - window + 1);
    const { messages } = await scan(js, req.stream, { startSeq: start, filter: req.filter, max: window, stopAfterSeq: end });
    scanned += end - start + 1;
    if (messages.length >= limit || start <= firstSeq || scanned >= BACKWARD_SCAN_CAP) {
      const page = messages.slice(-limit);
      return {
        ...base,
        messages: page,
        atEnd: end >= lastSeq,
        atStart: start <= firstSeq && messages.length <= limit,
        partial: scanned >= BACKWARD_SCAN_CAP && start > firstSeq && messages.length < limit,
      };
    }
    window *= 4;
  }
}

export async function getStoredMessage(jsm: JetStreamManager, stream: string, seq: number): Promise<MessageDTO | null> {
  const m = await jsm.streams.getMessage(stream, { seq });
  return m ? storedMsgToDTO(m) : null;
}

/** Strip server-populated / read-only fields so the config can be re-submitted. */
export function editableStreamConfig(si: StreamInfo): Record<string, unknown> {
  const cfg = { ...(si.config as unknown as Record<string, unknown>) };
  return cfg;
}

export function editableConsumerConfig(ci: ConsumerInfo): Record<string, unknown> {
  return { ...(ci.config as unknown as Record<string, unknown>) };
}

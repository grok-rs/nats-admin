// Newest messages of a stream for the Stream Dashboard feed, read with STREAM.MSG.GET by
// sequence (backwards from last_seq). Unlike the Message Browser's ordered-consumer scan this
// creates no consumer: it works on work-queue streams (which reject AckNone consumers), does not
// show up as a phantom ephemeral consumer in the dashboard's own consumer list, emits no
// consumer advisories every few seconds and only needs the read-only MSG.GET permission.
// No vscode imports (unit tested against a live server).

import type { JetStreamManager, StoredMsg, StreamInfo } from "@nats-io/jetstream";
import type { MessageDTO } from "../shared/dto";
import { storedMsgToDTO } from "../nats/messages";

export interface RecentResult {
  firstSeq: number;
  lastSeq: number;
  /** Newest first. */
  messages: MessageDTO[];
  /** Sequences probed (deleted / acknowledged sequences are skipped). */
  probed: number;
  /** True when the probe budget ran out before `limit` messages were found (sparse streams). */
  partial: boolean;
}

/** Sequences to probe per round (requests run in parallel). */
const ROUND = 20;

/**
 * The newest `limit` messages of `stream`, newest first. Probes at most `maxProbes` sequences
 * below last_seq, so a stream whose tail is mostly deleted returns fewer messages (`partial`).
 * `info` skips the STREAM.INFO request when the caller already has fresh state.
 */
export async function recentMessages(
  jsm: JetStreamManager,
  stream: string,
  opts: { limit?: number; maxProbes?: number; info?: Pick<StreamInfo, "state"> } = {},
): Promise<RecentResult> {
  const limit = Math.max(1, Math.floor(opts.limit ?? 10));
  const maxProbes = Math.max(limit, Math.floor(opts.maxProbes ?? 200));
  const { first_seq: firstSeq, last_seq: lastSeq, messages: total } = (opts.info ?? (await jsm.streams.info(stream))).state;
  const want = Math.min(limit, total);
  const found: StoredMsg[] = [];
  let seq = lastSeq;
  let probed = 0;
  while (found.length < want && seq >= firstSeq && seq > 0 && probed < maxProbes) {
    const batch: number[] = [];
    const size = Math.min(ROUND, maxProbes - probed, Math.max(want - found.length, 1) + 4);
    while (batch.length < size && seq >= firstSeq && seq > 0) batch.push(seq--);
    probed += batch.length;
    const got = await Promise.all(batch.map((s) => jsm.streams.getMessage(stream, { seq: s })));
    for (const m of got) if (m && found.length < want) found.push(m);
  }
  return {
    firstSeq,
    lastSeq,
    messages: found.map(storedMsgToDTO),
    probed,
    partial: found.length < want,
  };
}

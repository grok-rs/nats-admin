// Consumer Lab session: pull-fetch messages from a consumer and acknowledge
// them interactively. Pure NATS logic — no vscode imports.

import type { ConsumerInfo, JetStreamClient, JsMsg, StreamInfo } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import type { MessageDTO } from "../shared/dto";
import { jsMsgToDTO } from "./messages";

export type AckState = NonNullable<MessageDTO["ackState"]>;
export type AckAction = "ack" | "nak" | "term" | "working";

export interface ConsumerView {
  name: string;
  stream: string;
  description?: string;
  durable: boolean;
  push: boolean;
  deliverSubject?: string;
  deliverGroup?: string;
  filterSubjects: string[];
  deliverPolicy: string;
  ackPolicy: string;
  replayPolicy: string;
  ackWaitNs?: number;
  maxDeliver: number;
  maxAckPending?: number;
  maxWaiting?: number;
  numPending: number;
  numAckPending: number;
  numRedelivered: number;
  numWaiting: number;
  deliveredStreamSeq: number;
  deliveredConsumerSeq: number;
  ackFloorStreamSeq: number;
  ackFloorConsumerSeq: number;
  lastActive?: string;
  streamFirstSeq?: number;
  streamLastSeq?: number;
  streamMessages?: number;
  paused?: boolean;
  created: string;
}

export function consumerView(ci: ConsumerInfo, si?: StreamInfo): ConsumerView {
  const c = ci.config;
  const filters = c.filter_subjects?.length ? c.filter_subjects : c.filter_subject ? [c.filter_subject] : [];
  return {
    name: ci.name,
    stream: ci.stream_name,
    description: c.description || undefined,
    durable: Boolean(c.durable_name),
    push: Boolean(c.deliver_subject),
    deliverSubject: c.deliver_subject || undefined,
    deliverGroup: c.deliver_group || undefined,
    filterSubjects: filters,
    deliverPolicy: String(c.deliver_policy),
    ackPolicy: String(c.ack_policy),
    replayPolicy: String(c.replay_policy),
    ackWaitNs: c.ack_wait,
    maxDeliver: c.max_deliver ?? -1,
    maxAckPending: c.max_ack_pending,
    maxWaiting: c.max_waiting,
    numPending: ci.num_pending,
    numAckPending: ci.num_ack_pending,
    numRedelivered: ci.num_redelivered,
    numWaiting: ci.num_waiting,
    deliveredStreamSeq: ci.delivered.stream_seq,
    deliveredConsumerSeq: ci.delivered.consumer_seq,
    ackFloorStreamSeq: ci.ack_floor.stream_seq,
    ackFloorConsumerSeq: ci.ack_floor.consumer_seq,
    // Typed as Nanos, but the server sends an RFC3339 timestamp.
    lastActive: typeof (ci.delivered.last_active as unknown) === "string" ? (ci.delivered.last_active as unknown as string) : undefined,
    streamFirstSeq: si?.state.first_seq,
    streamLastSeq: si?.state.last_seq,
    streamMessages: si?.state.messages,
    paused: ci.paused || undefined,
    created: ci.created,
  };
}

export interface FetchResult {
  messages: MessageDTO[];
  warnings: string[];
}

export interface ActResult {
  id: string;
  state: AckState;
  error?: string;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class LabSession {
  private readonly held = new Map<string, { m: JsMsg; state: AckState }>();

  constructor(
    private readonly js: () => JetStreamClient,
    private readonly nc: () => NatsConnection,
    readonly stream: string,
    readonly consumer: string,
  ) {}

  async fetch(batch: number, expiresMs: number): Promise<FetchResult> {
    const c = await this.js().consumers.get(this.stream, this.consumer);
    const iter = await c.fetch({ max_messages: Math.max(1, Math.min(1000, Math.floor(batch))), expires: Math.max(1000, Math.floor(expiresMs)) });
    const warnings: string[] = [];
    void (async () => {
      try {
        for await (const s of iter.status()) {
          if (s.type === "exceeded_limits") warnings.push(`Server limit: ${s.description || s.code} — ack or nak outstanding messages first.`);
          else if (s.type === "consumer_deleted") warnings.push("The consumer was deleted.");
          else if (s.type === "consumer_not_found") warnings.push("The consumer no longer exists.");
          else if (s.type === "stream_not_found") warnings.push("The stream no longer exists.");
        }
      } catch {
        /* status ends with the fetch */
      }
    })();
    const messages: MessageDTO[] = [];
    try {
      for await (const m of iter) {
        const dto = jsMsgToDTO(m, { ackState: "pending" });
        this.held.set(dto.id, { m, state: "pending" });
        messages.push(dto);
      }
    } catch (e) {
      if (!messages.length && !warnings.length) throw e;
      warnings.push(msgOf(e));
    }
    return { messages, warnings: [...new Set(warnings)] };
  }

  async act(ids: string[], action: AckAction, opts: { delayMs?: number; reason?: string } = {}): Promise<ActResult[]> {
    const results: ActResult[] = [];
    for (const id of ids) {
      const h = this.held.get(id);
      if (!h) {
        results.push({ id, state: "pending", error: "Message is no longer held by this session" });
        continue;
      }
      if (h.state !== "pending" && h.state !== "working") {
        results.push({ id, state: h.state, error: `Already ${h.state === "ack" ? "acknowledged" : h.state === "nak" ? "nak'd" : "terminated"}` });
        continue;
      }
      try {
        switch (action) {
          case "ack": {
            const ok = await h.m.ackAck({ timeout: 5000 });
            if (!ok) throw new Error("The server did not confirm the ack (ack wait may have expired)");
            h.state = "ack";
            break;
          }
          case "nak":
            h.m.nak(opts.delayMs && opts.delayMs > 0 ? opts.delayMs : undefined);
            h.state = "nak";
            break;
          case "term":
            h.m.term(opts.reason?.trim() || undefined);
            h.state = "term";
            break;
          case "working":
            h.m.working();
            h.state = "working";
            break;
        }
        results.push({ id, state: h.state });
      } catch (e) {
        results.push({ id, state: h.state, error: msgOf(e) });
      }
    }
    try {
      await this.nc().flush();
    } catch {
      /* connection gone: errors already reported per message */
    }
    return results;
  }

  /** Ids of messages that still await a decision. */
  openIds(): string[] {
    return [...this.held].filter(([, h]) => h.state === "pending" || h.state === "working").map(([id]) => id);
  }

  /** Forget settled messages (and optionally everything). Unsettled ones are simply released (redelivered after ack wait). */
  forget(ids?: string[]): void {
    if (!ids) this.held.clear();
    else ids.forEach((id) => this.held.delete(id));
  }
}

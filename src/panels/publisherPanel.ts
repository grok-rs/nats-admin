// Publisher / Request-Reply panel: subject, headers, payload (text, JSON,
// base64, hex) with {{templates}}, burst publishing, optional JetStream acks,
// and request/reply with latency. One panel per connection.

import * as vscode from "vscode";
import { assertWritable } from "../core/ui";
import { NoRespondersError, RequestError, TimeoutError } from "@nats-io/nats-core";
import type { PubAck } from "@nats-io/jetstream";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { errorMessage } from "../core/connectionManager";
import { cfg, validateSubject } from "../core/ui";
import { log } from "../core/log";
import type { MessageDTO } from "../shared/dto";
import { renderTemplate, TEMPLATE_HELP } from "../shared/template";
import { arrayToHeaders, msgToDTO } from "../nats/messages";
import { encodePayload, toPlaybookBlock, type PayloadEncoding } from "../nats/messaging";
import { WebviewPanelBase } from "./webviewHost";

export interface PublisherOptions {
  subject?: string;
  mode?: "publish" | "request";
  /** UTF-8 payload text to prefill (or base64 when payloadEncoding is "base64"). */
  payload?: string;
  payloadEncoding?: PayloadEncoding;
  headers?: [string, string][];
  /** Pre-check "JetStream publish (wait for PubAck)". */
  jetstream?: boolean;
}

export interface SendForm {
  subject: string;
  reply?: string;
  headers: [string, string][];
  payload: string;
  encoding: PayloadEncoding;
  count?: number;
  intervalMs?: number;
  jetstream?: boolean;
  timeoutMs?: number;
}

export interface PublishResult {
  sent: number;
  bytes: number;
  durationMs: number;
  cancelled?: boolean;
  acks?: { stream: string; seq: number; duplicate: boolean; domain?: string }[];
  firstSubject: string;
}

export interface RequestResult {
  reply: MessageDTO;
  latencyMs: number;
  requestBytes: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PublisherPanel extends WebviewPanelBase {
  private cancelBurst = false;
  private burstRunning = false;

  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    private readonly name: string,
    prefill?: PublisherOptions,
  ) {
    super(s.context, {
      viewType: "nats.publisher",
      key: PublisherPanel.key(profileId),
      title: `Publish · ${name}`,
      script: "publisher",
      init: {
        connectionName: name,
        defaultTimeout: cfg("request.timeout", 5000),
        templateHelp: TEMPLATE_HELP,
        prefill: prefill ?? null,
      },
    });
    this.disposables.push(
      { dispose: () => (this.cancelBurst = true) },
      s.manager.onDidChangeState((e) => {
        if (e.profileId === this.profileId) this.post("connection", { state: e.state });
      }),
    );
  }

  static key(profileId: string): string {
    return `publisher:${profileId}`;
  }

  prefill(opts: PublisherOptions): void {
    this.post("prefill", opts);
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error(`Not connected to "${this.name}" — connect from the NATS explorer first.`);
    return lc;
  }

  protected handlers() {
    return {
      publish: (f: SendForm) => {
        assertWritable(this.lc(), "publishing");
        return this.publish(f);
      },
      request: (f: SendForm) => this.request(f),
      cancel: () => {
        this.cancelBurst = true;
        return null;
      },
      copyPlaybook: async (p: { mode: "publish" | "request"; form: SendForm }) => {
        const f = p.form;
        const text = toPlaybookBlock({
          verb: p.mode === "publish" ? "PUB" : "REQ",
          subject: f.subject.trim(),
          headers: f.headers,
          body: f.encoding === "text" || f.encoding === "json" ? f.payload : "",
          options:
            p.mode === "publish"
              ? { count: (f.count ?? 1) > 1 ? f.count : undefined, reply: f.reply?.trim() || undefined }
              : { timeout: f.timeoutMs },
        });
        await vscode.env.clipboard.writeText(text);
        return text;
      },
    };
  }

  private render(f: SendForm, seq: number): { subject: string; data: Uint8Array; headers: [string, string][]; reply?: string } {
    const ctx = { seq };
    const subject = renderTemplate(f.subject.trim(), ctx);
    const invalid = validateSubject(subject, false);
    if (invalid) throw new Error(`Subject: ${invalid}`);
    const templated = f.encoding === "text" || f.encoding === "json";
    const payload = templated ? renderTemplate(f.payload, ctx) : f.payload;
    const data = encodePayload(payload, f.encoding);
    const headers = (f.headers ?? []).filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), renderTemplate(v, ctx)] as [string, string]);
    const reply = f.reply?.trim() ? renderTemplate(f.reply.trim(), ctx) : undefined;
    return { subject, data, headers, reply };
  }

  private async publish(f: SendForm): Promise<PublishResult> {
    if (this.burstRunning) throw new Error("A burst is already running — cancel it first");
    const lc = this.lc();
    const count = Math.max(1, Math.min(1_000_000, Math.floor(f.count ?? 1)));
    const interval = Math.max(0, Math.floor(f.intervalMs ?? 0));
    const started = Date.now();
    const acks: PublishResult["acks"] = [];
    let sent = 0;
    let bytes = 0;
    let firstSubject = "";
    let lastProgress = 0;
    this.cancelBurst = false;
    this.burstRunning = true;
    try {
      for (let i = 1; i <= count; i++) {
        if (this.cancelBurst) break;
        const m = this.render(f, i);
        if (i === 1) firstSubject = m.subject;
        const headers = arrayToHeaders(m.headers);
        if (f.jetstream) {
          const msgID = m.headers.find(([k]) => k.toLowerCase() === "nats-msg-id")?.[1];
          let ack: PubAck;
          try {
            ack = await lc.js().publish(m.subject, m.data, { headers, msgID, timeout: f.timeoutMs ?? 5000 });
          } catch (e) {
            // nats.js reports "no stream listens on this subject" as JetStreamNotEnabled / no responders.
            if (e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders()) || /no responders|jetstream is not enabled/i.test(errorMessage(e))) {
              throw new Error(`No stream captures "${m.subject}" (no JetStream responders). Publish without the JetStream option or create a stream for this subject.`);
            }
            throw e;
          }
          // Keep the first and the most recent acks only (bursts can be large).
          if (acks.length < 1) acks.push({ ...ack });
          else acks[1] = { ...ack };
        } else {
          lc.nc.publish(m.subject, m.data, { headers, reply: m.reply });
        }
        sent++;
        bytes += m.data.length;
        if (count > 1 && Date.now() - lastProgress > 250) {
          lastProgress = Date.now();
          this.post("progress", { sent, total: count });
        }
        if (interval > 0 && i < count) await sleep(interval);
        else if (!f.jetstream && i % 1000 === 0) await lc.nc.flush();
      }
      await lc.nc.flush();
    } finally {
      this.burstRunning = false;
    }
    log.info(`Published ${sent} message(s) to ${firstSubject}${f.jetstream ? " (JetStream)" : ""}`);
    return { sent, bytes, durationMs: Date.now() - started, cancelled: sent < count || undefined, acks: f.jetstream ? acks : undefined, firstSubject };
  }

  private async request(f: SendForm): Promise<RequestResult> {
    const lc = this.lc();
    const m = this.render(f, 1);
    const timeout = Math.max(50, Math.floor(f.timeoutMs ?? cfg("request.timeout", 5000)));
    const started = performance.now();
    try {
      const reply = await lc.nc.request(m.subject, m.data, { timeout, headers: arrayToHeaders(m.headers) });
      const latencyMs = performance.now() - started;
      return { reply: msgToDTO(reply), latencyMs, requestBytes: m.data.length };
    } catch (e) {
      throw new Error(explainRequestError(e, m.subject, timeout));
    }
  }
}

export function explainRequestError(e: unknown, subject: string, timeout: number): string {
  const cause = (e as { cause?: unknown })?.cause;
  if (e instanceof NoRespondersError || cause instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders())) {
    return `No responders: nothing is subscribed to "${subject}".`;
  }
  if (e instanceof TimeoutError || cause instanceof TimeoutError || /timeout/i.test(errorMessage(e))) {
    return `Request timed out after ${timeout} ms — a responder exists but did not reply in time.`;
  }
  return errorMessage(e);
}

/** Open the connection's publisher (or reuse it), optionally prefilled. */
export function openPublisher(s: Services, lc: LiveConnection, opts?: PublisherOptions): void {
  const existing = WebviewPanelBase.reveal<PublisherPanel>(PublisherPanel.key(lc.id));
  if (existing) {
    if (opts) existing.prefill(opts);
    return;
  }
  new PublisherPanel(s, lc.id, lc.profile.name, opts);
}

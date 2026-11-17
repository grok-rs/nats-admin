// Dead Letter Monitor: listens to JetStream consumer advisories for messages
// that exceeded max_deliver or were terminated, shows the original message and
// lets the user re-inject or delete it. One panel per connection.

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import { assertWritable } from "../core/ui";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { errorMessage } from "../core/connectionManager";
import { log } from "../core/log";
import type { MessageDTO } from "../shared/dto";
import { base64ToBytes } from "../shared/encoding";
import { getStoredMessage } from "../nats/streams";
import { arrayToHeaders } from "../nats/messages";
import { ADVISORY_SUBJECTS, parseAdvisory, republishHeaders, type DeadLetter } from "../nats/messaging";
import { WebviewPanelBase } from "./webviewHost";

class DeadLetterPanel extends WebviewPanelBase {
  private subs: Subscription[] = [];
  private subNc?: NatsConnection;
  private outbox: DeadLetter[] = [];
  private ready = false;
  private listenError?: string;

  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    private readonly name: string,
  ) {
    super(s.context, {
      viewType: "nats.deadLetters",
      key: DeadLetterPanel.key(profileId),
      title: `Dead Letters · ${name}`,
      script: "deadLetters",
      init: { connectionName: name, subjects: ADVISORY_SUBJECTS },
    });
    const flush = setInterval(() => this.flush(), 150);
    this.disposables.push(
      { dispose: () => clearInterval(flush) },
      { dispose: () => this.stop() },
      s.manager.onDidChangeState((e) => {
        if (e.profileId !== this.profileId) return;
        if (e.state === "connected") this.listen();
        this.post("connection", { state: e.state, listening: this.isListening() });
      }),
    );
    this.listen();
  }

  static key(profileId: string): string {
    return `deadLetters:${profileId}`;
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error(`Not connected to "${this.name}" — connect from the NATS explorer first.`);
    return lc;
  }

  private isListening(): boolean {
    return this.subs.length > 0 && !!this.subNc && !this.subNc.isClosed();
  }

  private listen(): void {
    const lc = this.s.manager.get(this.profileId);
    if (!lc || (this.subNc === lc.nc && this.subs.length)) return;
    this.stop();
    try {
      this.subs = ADVISORY_SUBJECTS.map((subject) =>
        lc.nc.subscribe(subject, {
          callback: (err, msg) => {
            if (err) {
              this.listenError = errorMessage(err);
              this.post("connection", { state: "connected", listening: false, error: this.listenError });
              return;
            }
            const dl = parseAdvisory(msg.subject, msg.data);
            if (dl) this.outbox.push(dl);
          },
        }),
      );
      this.subNc = lc.nc;
      this.listenError = undefined;
      log.info(`Dead Letter Monitor listening on ${ADVISORY_SUBJECTS.join(", ")}`);
    } catch (e) {
      this.listenError = errorMessage(e);
    }
  }

  private stop(): void {
    for (const s of this.subs) {
      try {
        s.unsubscribe();
      } catch {
        /* closed */
      }
    }
    this.subs = [];
  }

  private flush(): void {
    if (!this.ready || !this.outbox.length) return;
    const batch = this.outbox;
    this.outbox = [];
    this.post("advisories", batch);
  }

  protected handlers() {
    return {
      ready: () => {
        this.ready = true;
        return { listening: this.isListening(), error: this.listenError, connected: !!this.s.manager.get(this.profileId) };
      },
      getMessage: (p: { stream: string; seq: number }) => this.getMessage(p.stream, p.seq),
      republish: (p: { stream: string; seq: number }) => this.republish(p.stream, p.seq),
      deleteMessage: async (p: { stream: string; seq: number }) => {
        assertWritable(this.lc(), "deleting a message");
        const jsm = await this.lc().jsm();
        await jsm.streams.deleteMessage(p.stream, p.seq, false);
        log.info(`Deleted ${p.stream} #${p.seq} (dead letter)`);
        return { deleted: true };
      },
    };
  }

  private async getMessage(stream: string, seq: number): Promise<MessageDTO | null> {
    const jsm = await this.lc().jsm();
    try {
      return await getStoredMessage(jsm, stream, seq);
    } catch (e) {
      if (/no message found|not found|10037/i.test(errorMessage(e))) return null;
      throw e;
    }
  }

  private async republish(stream: string, seq: number): Promise<{ subject: string; stream?: string; seq?: number; duplicate?: boolean }> {
    const lc = this.lc();
    assertWritable(lc, "republishing");
    const msg = await this.getMessage(stream, seq);
    if (!msg) throw new Error(`Message #${seq} is no longer in stream ${stream}`);
    const headers = arrayToHeaders(republishHeaders(msg.headers, `${stream}/${seq}`));
    const data = base64ToBytes(msg.data);
    try {
      const ack = await lc.js().publish(msg.subject, data, { headers });
      log.info(`Republished ${stream} #${seq} → ${msg.subject} (now #${ack.seq} in ${ack.stream})`);
      return { subject: msg.subject, stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate };
    } catch (e) {
      // No stream captures the subject any more: fall back to a core publish.
      if (/no responders|jetstream is not enabled/i.test(errorMessage(e))) {
        lc.nc.publish(msg.subject, data, { headers });
        await lc.nc.flush();
        return { subject: msg.subject };
      }
      throw e;
    }
  }
}

export function openDeadLetters(s: Services, lc: LiveConnection): void {
  if (WebviewPanelBase.reveal(DeadLetterPanel.key(lc.id))) return;
  new DeadLetterPanel(s, lc.id, lc.profile.name);
}

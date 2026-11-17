// Consumer Lab: inspect a consumer's live state, pull-fetch batches and
// ack / nak / term / mark-in-progress messages one by one.

import * as vscode from "vscode";
import { assertWritable } from "../core/ui";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { log } from "../core/log";
import { consumerView, LabSession, type AckAction } from "../nats/consumerLab";
import { WebviewPanelBase, type RpcHandler } from "./webviewHost";
import { openLiveTail } from "./liveTailPanel";

export interface ConsumerLabInit {
  profileId: string;
  connectionName: string;
  stream: string;
  consumer: string;
}

const keyOf = (profileId: string, stream: string, consumer: string) => `consumerLab:${profileId}:${stream}:${consumer}`;

class ConsumerLabPanel extends WebviewPanelBase {
  private readonly session: LabSession;

  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    private readonly stream: string,
    private readonly consumer: string,
    init: ConsumerLabInit,
  ) {
    super(s.context, {
      viewType: "nats.consumerLab",
      key: keyOf(profileId, stream, consumer),
      title: `${consumer} · Consumer Lab`,
      script: "consumerLab",
      init,
    });
    this.session = new LabSession(
      () => this.lc().js(),
      () => this.lc().nc,
      stream,
      consumer,
    );
    this.disposables.push(
      s.manager.onDidChangeState((e) => {
        if (e.profileId !== profileId) return;
        // A fresh connection can't settle messages fetched on the old one.
        if (e.state === "disconnected" || e.state === "error") this.session.forget();
        this.post("connection", { state: e.state });
      }),
      this.panel.onDidChangeViewState((e) => this.post("visibility", { visible: e.webviewPanel.visible })),
      // Unsettled messages are released (not acked) and get redelivered after ack wait.
      { dispose: () => this.session.forget() },
    );
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error("Not connected — reconnect from the NATS explorer.");
    return lc;
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      info: async () => {
        const jsm = await this.lc().jsm();
        const [ci, si] = await Promise.all([jsm.consumers.info(this.stream, this.consumer), jsm.streams.info(this.stream).catch(() => undefined)]);
        return consumerView(ci, si);
      },

      fetch: async (p: { batch: number; expires: number }) => {
        assertWritable(this.lc(), "fetching (it delivers messages and changes the consumer's state)");
        const res = await this.session.fetch(Number(p.batch) || 10, Number(p.expires) || 2000);
        log.debug(`Consumer Lab ${this.stream}/${this.consumer}: fetched ${res.messages.length}`);
        return res;
      },

      act: async (p: { ids: string[]; action: AckAction; delayMs?: number; reason?: string }) => {
        if (!["ack", "nak", "term", "working"].includes(p.action)) throw new Error(`Unknown action ${p.action}`);
        assertWritable(this.lc(), p.action);
        return this.session.act(p.ids ?? [], p.action, { delayMs: Number(p.delayMs) || undefined, reason: p.reason });
      },

      forget: (p: { ids?: string[] }) => {
        this.session.forget(p.ids);
        return true;
      },

      openLiveTail: (p: { subject: string; queue?: string }) => {
        openLiveTail(this.s, this.lc(), { subject: p.subject, queue: p.queue || undefined });
        return true;
      },

      copy: async (p: { text: string }) => {
        await vscode.env.clipboard.writeText(String(p.text ?? ""));
        return true;
      },
    };
  }
}

export function openConsumerLab(s: Services, lc: LiveConnection, stream: string, consumer: string): void {
  if (WebviewPanelBase.reveal(keyOf(lc.id, stream, consumer))) return;
  new ConsumerLabPanel(s, lc.id, stream, consumer, { profileId: lc.id, connectionName: lc.profile.name, stream, consumer });
}

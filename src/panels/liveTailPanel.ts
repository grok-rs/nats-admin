// Live Tail: subscribe to one or more subjects and watch messages arrive.
// One panel per connection; messages are batched to the webview every 100ms.

import * as vscode from "vscode";
import { assertWritable } from "../core/ui";
import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { errorMessage } from "../core/connectionManager";
import { cfg, validateSubject } from "../core/ui";
import { log } from "../core/log";
import type { MessageDTO } from "../shared/dto";
import { base64ToBytes, utf8DecodeStrict } from "../shared/encoding";
import { arrayToHeaders, msgToDTO } from "../nats/messages";
import { messagesToCsv, messagesToJson, subscriptionColor } from "../nats/messaging";
import { WebviewPanelBase } from "./webviewHost";
import { openPublisher } from "./publisherPanel";

export interface SubInfo {
  id: string;
  subject: string;
  queue?: string;
  color: string;
  count: number;
  error?: string;
  active: boolean;
}

interface SubEntry extends SubInfo {
  sub?: Subscription;
  nc?: NatsConnection;
}

const FLUSH_MS = 100;

class LiveTailPanel extends WebviewPanelBase {
  private readonly subs = new Map<string, SubEntry>();
  private outbox: MessageDTO[] = [];
  private pausedQueue: MessageDTO[] = [];
  private paused = false;
  private total = 0;
  private secondCount = 0;
  private rate = 0;
  private subCounter = 0;
  private colorIndex = 0;
  private dirtySubs = false;
  /** The webview has mounted and asked for state; until then keep buffering. */
  private ready = false;

  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    private readonly name: string,
  ) {
    super(s.context, {
      viewType: "nats.liveTail",
      key: LiveTailPanel.key(profileId),
      title: `Live Tail · ${name}`,
      script: "liveTail",
      init: { connectionName: name, maxMessages: cfg("liveTail.maxMessages", 2000), subs: [] },
    });
    const flush = setInterval(() => this.flush(), FLUSH_MS);
    const tick = setInterval(() => {
      this.rate = this.secondCount;
      this.secondCount = 0;
      this.postStats();
    }, 1000);
    this.disposables.push(
      { dispose: () => (clearInterval(flush), clearInterval(tick)) },
      { dispose: () => this.unsubscribeAll() },
      s.manager.onDidChangeState((e) => {
        if (e.profileId !== this.profileId) return;
        this.post("connection", { state: e.state });
        if (e.state === "connected") this.resubscribeAll();
        else if (e.state === "disconnected" || e.state === "error") this.markInactive();
      }),
    );
  }

  static key(profileId: string): string {
    return `liveTail:${profileId}`;
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error(`Not connected to "${this.name}" — connect from the NATS explorer first.`);
    return lc;
  }

  protected handlers() {
    return {
      subscribe: (p: { subject: string; queue?: string }) => this.addSub(p.subject, p.queue),
      unsubscribe: (p: { id: string }) => this.removeSub(p.id),
      pause: (p: { paused: boolean }) => this.setPaused(p.paused),
      ready: () => {
        this.ready = true;
        return { subs: this.subList(), stats: { rate: this.rate, total: this.total, paused: this.paused, pausedCount: this.pausedQueue.length } };
      },
      reply: (p: { subject: string; data: string; headers: [string, string][]; serviceError?: { code: string; text: string } }) => this.reply(p),
      republish: (p: { message: MessageDTO }) => this.republish(p.message),
      export: (p: { format: "json" | "csv"; messages: MessageDTO[] }) => this.export(p.format, p.messages),
      clear: () => {
        this.pausedQueue = [];
        this.outbox = [];
        this.postStats();
      },
    };
  }

  /** Add a subscription (also used when openLiveTail targets an existing panel). */
  addSub(subject: string, queue?: string): SubInfo[] {
    const subj = subject.trim();
    const invalid = validateSubject(subj);
    if (invalid) throw new Error(invalid);
    const q = queue?.trim() || undefined;
    for (const e of this.subs.values()) {
      if (e.subject === subj && e.queue === q) throw new Error(`Already subscribed to ${subj}${q ? ` (queue ${q})` : ""}`);
    }
    const entry: SubEntry = {
      id: `s${++this.subCounter}`,
      subject: subj,
      queue: q,
      color: subscriptionColor(this.colorIndex++),
      count: 0,
      active: false,
    };
    this.subs.set(entry.id, entry);
    this.start(entry, this.lc().nc);
    this.dirtySubs = true;
    this.postSubs();
    return this.subList();
  }

  private start(entry: SubEntry, nc: NatsConnection): void {
    try {
      entry.sub = nc.subscribe(entry.subject, {
        queue: entry.queue,
        callback: (err, msg) => {
          if (err) {
            entry.error = errorMessage(err);
            entry.active = false;
            this.postSubs();
            return;
          }
          entry.count++;
          this.receive(msgToDTO(msg, { subId: entry.id }));
        },
      });
      entry.nc = nc;
      entry.active = true;
      entry.error = undefined;
      void entry.sub.closed.then((err) => {
        if (err && this.subs.get(entry.id) === entry) {
          entry.error = errorMessage(err);
          entry.active = false;
          this.postSubs();
        }
      });
      log.info(`Live Tail: subscribed to ${entry.subject}${entry.queue ? ` (queue ${entry.queue})` : ""}`);
    } catch (e) {
      entry.error = errorMessage(e);
      entry.active = false;
    }
  }

  private removeSub(id: string): SubInfo[] {
    const e = this.subs.get(id);
    if (e) {
      try {
        e.sub?.unsubscribe();
      } catch {
        /* already closed */
      }
      this.subs.delete(id);
      this.postSubs();
    }
    return this.subList();
  }

  private unsubscribeAll(): void {
    for (const e of this.subs.values()) {
      try {
        e.sub?.unsubscribe();
      } catch {
        /* ignore */
      }
    }
  }

  private resubscribeAll(): void {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) return;
    for (const e of this.subs.values()) {
      // Core subscriptions survive automatic reconnects; only re-create them on a new connection.
      if (e.nc !== lc.nc || !e.active) {
        try {
          e.sub?.unsubscribe();
        } catch {
          /* ignore */
        }
        this.start(e, lc.nc);
      }
    }
    this.postSubs();
  }

  private markInactive(): void {
    for (const e of this.subs.values()) e.active = false;
    this.postSubs();
  }

  private subList(): SubInfo[] {
    return [...this.subs.values()].map(({ id, subject, queue, color, count, error, active }) => ({ id, subject, queue, color, count, error, active }));
  }

  private postSubs(): void {
    this.dirtySubs = false;
    this.post("subs", this.subList());
  }

  private receive(m: MessageDTO): void {
    this.total++;
    this.secondCount++;
    const max = cfg("liveTail.maxMessages", 2000);
    if (this.paused) {
      this.pausedQueue.push(m);
      if (this.pausedQueue.length > max) this.pausedQueue.splice(0, this.pausedQueue.length - max);
    } else {
      this.outbox.push(m);
      if (this.outbox.length > max) this.outbox.splice(0, this.outbox.length - max);
    }
  }

  private flush(): void {
    if (!this.ready) return;
    if (this.outbox.length) {
      const batch = this.outbox;
      this.outbox = [];
      this.post("messages", batch);
      this.dirtySubs = true;
    }
    if (this.dirtySubs && this.subs.size) {
      // Refresh per-subscription counters at most every 100ms.
      this.postSubs();
    }
  }

  private postStats(): void {
    this.post("stats", { rate: this.rate, total: this.total, paused: this.paused, pausedCount: this.pausedQueue.length });
  }

  private setPaused(paused: boolean): { paused: boolean } {
    this.paused = paused;
    if (!paused && this.pausedQueue.length) {
      this.outbox.push(...this.pausedQueue);
      this.pausedQueue = [];
    }
    this.postStats();
    return { paused };
  }

  private async reply(p: { subject: string; data: string; headers: [string, string][]; serviceError?: { code: string; text: string } }): Promise<{ bytes: number }> {
    const lc = this.lc();
    assertWritable(lc, "replying");
    const headers = [...(p.headers ?? [])];
    if (p.serviceError) {
      headers.push(["Nats-Service-Error", p.serviceError.text || "error"]);
      headers.push(["Nats-Service-Error-Code", p.serviceError.code || "500"]);
    }
    const data = base64ToBytes(p.data);
    lc.nc.publish(p.subject, data, { headers: arrayToHeaders(headers) });
    await lc.nc.flush();
    return { bytes: data.length };
  }

  private republish(m: MessageDTO): void {
    const lc = this.lc();
    const bytes = base64ToBytes(m.data);
    const text = utf8DecodeStrict(bytes);
    openPublisher(this.s, lc, {
      mode: "publish",
      subject: m.subject,
      payload: text ?? m.data,
      payloadEncoding: text === null ? "base64" : undefined,
      headers: m.headers,
    });
  }

  private async export(format: "json" | "csv", messages: MessageDTO[]): Promise<string | null> {
    if (!messages.length) throw new Error("Nothing to export");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${defaultDir()}/live-tail-${stamp}.${format}`),
      filters: format === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
      saveLabel: "Export",
    });
    if (!target) return null;
    const content = format === "json" ? messagesToJson(messages) : messagesToCsv(messages);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
    void vscode.window.showInformationMessage(`Exported ${messages.length} messages to ${target.fsPath}`, "Open").then((c) => {
      if (c) void vscode.window.showTextDocument(target);
    });
    return target.fsPath;
  }
}

function defaultDir(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? ".";
}

/** Open the connection's Live Tail panel (or reuse it) and add a subscription. */
export function openLiveTail(s: Services, lc: LiveConnection, opts?: { subject?: string; queue?: string }): void {
  const existing = WebviewPanelBase.reveal<LiveTailPanel>(LiveTailPanel.key(lc.id));
  const panel = existing ?? new LiveTailPanel(s, lc.id, lc.profile.name);
  if (opts?.subject) {
    try {
      panel.addSub(opts.subject, opts.queue);
    } catch (e) {
      void vscode.window.showWarningMessage(errorMessage(e));
    }
  }
}

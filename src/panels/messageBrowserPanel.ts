// Message Browser: page through the messages stored in a JetStream stream,
// filter by subject, jump to a sequence or time, inspect payloads, republish,
// delete and export.

import * as vscode from "vscode";
import { assertWritable } from "../core/ui";
import { writeFile } from "node:fs/promises";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { cfg } from "../core/ui";
import { log } from "../core/log";
import { browseMessages, type BrowseRequest } from "../nats/streams";
import type { MessageDTO } from "../shared/dto";
import { base64ToBytes, utf8DecodeStrict } from "../shared/encoding";
import { WebviewPanelBase, type RpcHandler } from "./webviewHost";
import { openPublisher } from "./publisherPanel";
import { messagesToCsv, messagesToJson, messageToJsonDoc } from "../nats/messageExport";

export interface MessageBrowserInit {
  profileId: string;
  connectionName: string;
  stream: string;
  filter?: string;
  seq?: number;
  pageSize: number;
}

export interface StreamSummary {
  name: string;
  description?: string;
  subjects: string[];
  storage: string;
  retention: string;
  replicas: number;
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  firstTs?: string;
  lastTs?: string;
  consumers: number;
  numSubjects?: number;
  numDeleted?: number;
  sealed?: boolean;
  denyDelete?: boolean;
}

const keyOf = (profileId: string, stream: string) => `msgBrowser:${profileId}:${stream}`;

class MessageBrowserPanel extends WebviewPanelBase {
  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    private readonly stream: string,
    init: MessageBrowserInit,
  ) {
    super(s.context, {
      viewType: "nats.messageBrowser",
      key: keyOf(profileId, stream),
      title: `${stream} · Messages`,
      script: "messageBrowser",
      init,
    });
    this.disposables.push(
      s.manager.onDidChangeState((e) => {
        if (e.profileId === profileId) this.post("connection", { state: e.state });
      }),
    );
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error("Not connected — reconnect from the NATS explorer, then refresh.");
    return lc;
  }

  /** Apply a new filter / start sequence to an already open panel. */
  apply(opts: { filter?: string; seq?: number }): void {
    this.post("apply", opts);
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      browse: async (p: Omit<BrowseRequest, "stream">) => {
        const lc = this.lc();
        const jsm = await lc.jsm();
        const [page, info] = await Promise.all([
          browseMessages(jsm, lc.js(), {
            stream: this.stream,
            seq: p.seq,
            startTime: p.startTime,
            filter: p.filter?.trim() || undefined,
            limit: Math.min(1000, Math.max(1, Number(p.limit) || 50)),
            direction: p.direction === "backward" ? "backward" : "forward",
          }),
          jsm.streams.info(this.stream),
        ]);
        const c = info.config;
        const st = info.state;
        const summary: StreamSummary = {
          name: c.name,
          description: c.description || undefined,
          subjects: c.subjects ?? [],
          storage: String(c.storage),
          retention: String(c.retention),
          replicas: c.num_replicas,
          messages: st.messages,
          bytes: st.bytes,
          firstSeq: st.first_seq,
          lastSeq: st.last_seq,
          firstTs: st.first_ts,
          lastTs: st.last_ts,
          consumers: st.consumer_count,
          numSubjects: st.num_subjects,
          numDeleted: st.num_deleted,
          sealed: c.sealed || undefined,
          denyDelete: c.deny_delete || undefined,
        };
        return { page, summary };
      },

      deleteMessage: async (p: { seq: number; erase?: boolean }) => {
        assertWritable(this.lc(), "deleting a message");
        const jsm = await this.lc().jsm();
        const ok = await jsm.streams.deleteMessage(this.stream, Number(p.seq), Boolean(p.erase));
        if (!ok) throw new Error(`Message ${p.seq} could not be deleted`);
        log.info(`Deleted message ${p.seq} from stream ${this.stream}${p.erase ? " (erased)" : ""}`);
        return true;
      },

      republish: (p: { message: MessageDTO }) => {
        const lc = this.lc();
        const text = utf8DecodeStrict(base64ToBytes(p.message.data));
        if (text === null) {
          void vscode.window.showWarningMessage("The payload is binary, so it was not copied into the publisher. Subject and headers were.");
        }
        openPublisher(this.s, lc, {
          subject: p.message.subject,
          mode: "publish",
          payload: text ?? undefined,
          headers: p.message.headers.filter(([k]) => !/^Nats-(Msg-Id|Expected-|Sequence|Time-Stamp|Stream|Subject|Last-Sequence)/i.test(k)),
        });
        return true;
      },

      openJson: async (p: { message: MessageDTO }) => {
        const doc = await vscode.workspace.openTextDocument({ language: "json", content: messageToJsonDoc(this.stream, p.message) });
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        return true;
      },

      export: async (p: { format: "json" | "csv"; messages: MessageDTO[] }) => {
        if (!p.messages?.length) throw new Error("Nothing to export");
        const ext = p.format === "csv" ? "csv" : "json";
        const first = p.messages[0].seq ?? 0;
        const last = p.messages[p.messages.length - 1].seq ?? 0;
        const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? ".");
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(base, `${this.stream}-${Math.min(first, last)}-${Math.max(first, last)}.${ext}`),
          filters: p.format === "csv" ? { CSV: ["csv"] } : { JSON: ["json"] },
          saveLabel: "Export messages",
        });
        if (!target) return null;
        const content = p.format === "csv" ? messagesToCsv(p.messages) : messagesToJson(this.stream, p.messages);
        await writeFile(target.fsPath, content, "utf8");
        log.info(`Exported ${p.messages.length} messages from ${this.stream} to ${target.fsPath}`);
        return target.fsPath;
      },

      copy: async (p: { text: string }) => {
        await vscode.env.clipboard.writeText(String(p.text ?? ""));
        return true;
      },
    };
  }
}

export function openMessageBrowser(s: Services, lc: LiveConnection, stream: string, opts?: { filter?: string; seq?: number }): void {
  const existing = WebviewPanelBase.reveal<MessageBrowserPanel>(keyOf(lc.id, stream));
  if (existing) {
    if (opts && (opts.filter !== undefined || opts.seq !== undefined)) existing.apply(opts);
    return;
  }
  new MessageBrowserPanel(s, lc.id, stream, {
    profileId: lc.id,
    connectionName: lc.profile.name,
    stream,
    filter: opts?.filter,
    seq: opts?.seq,
    pageSize: cfg("messageBrowser.pageSize", 50),
  });
}

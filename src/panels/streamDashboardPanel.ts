// Stream Dashboard: live KPIs, limits, throughput, subject distribution, consumers, replication
// and recent messages of one JetStream stream. The webview polls `snapshot` while the panel is
// visible (nats.dashboard.refreshInterval); subject counts and the message feed are slower,
// separate calls. One panel per connection + stream.

import * as vscode from "vscode";
import type { JetStreamManager } from "@nats-io/jetstream";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { cfg } from "../core/ui";
import { WebviewPanelBase, type RpcHandler } from "./webviewHost";
import { openMessageBrowser } from "./messageBrowserPanel";
import { openConsumerLab } from "./consumerLabPanel";
import { openPublisher } from "./publisherPanel";
import { concreteSubject } from "../shared/subjects";
import { infoUri } from "../fs/infoDocs";
import { streamConfigUri } from "../fs/configFs";
import { buildSubjectTree, fetchSubjectCounts, subjectTreemap, treemapStart } from "../nats/subjects";
import { consumerRow, streamView, type ConsumerRow, type RecentMessages, type StreamDashboardInit, type StreamSnapshot, type SubjectStats } from "../insights/model";
import { recentMessages } from "../insights/recent";
import { base64ToBytes, bytesToBase64 } from "../shared/encoding";
import { StreamNode, StreamsFolder } from "../tree/explorer";

/** Consumers listed per snapshot (the table shows a "capped" note beyond this). */
const MAX_CONSUMERS = 500;
/** Payload bytes sent per recent message (preview only). */
const PREVIEW_BYTES = 512;
const RECENT_LIMIT = 10;

const keyOf = (profileId: string, stream: string) => `streamDashboard:${profileId}:${stream}`;

export function refreshIntervalSetting(): number {
  return Math.max(500, cfg("dashboard.refreshInterval", 2000));
}

function maxSubjectsSetting(): number {
  return Math.max(10, cfg("explorer.maxSubjects", 2000));
}

async function listConsumersCapped(jsm: JetStreamManager, stream: string, cap: number): Promise<ConsumerRow[]> {
  const out: ConsumerRow[] = [];
  for await (const ci of jsm.consumers.list(stream)) {
    out.push(consumerRow(ci));
    if (out.length >= cap) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

class StreamDashboardPanel extends WebviewPanelBase {
  constructor(
    private readonly s: Services,
    private readonly profileId: string,
    private readonly stream: string,
    init: StreamDashboardInit,
  ) {
    super(s.context, { viewType: "nats.streamDashboard", key: keyOf(profileId, stream), title: `${stream} · Dashboard`, script: "streamDashboard", init });
    this.disposables.push(
      this.panel.onDidChangeViewState(() => this.post("visibility", { visible: this.panel.visible })),
      s.manager.onDidChangeState((e) => {
        if (e.profileId === profileId) this.post("connection", { state: e.state, error: s.manager.stateOf(profileId).error });
      }),
      s.store.onDidChange(() => {
        const p = s.store.get(profileId);
        if (p) this.post("profile", { connectionName: p.name, environment: p.environment, readOnly: !!p.readOnly });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nats.dashboard.refreshInterval") || e.affectsConfiguration("nats.explorer.maxSubjects")) {
          this.post("config", { refreshInterval: refreshIntervalSetting(), maxSubjects: maxSubjectsSetting() });
        }
      }),
    );
  }

  private lc(): LiveConnection {
    const lc = this.s.manager.get(this.profileId);
    if (!lc) throw new Error("Not connected — reconnect to load the dashboard.");
    return lc;
  }

  /** The explorer's node for this stream (commands such as createConsumer expect it). */
  private async streamNode(): Promise<StreamNode | undefined> {
    const conn = this.s.explorer.connectionNode(this.profileId);
    if (!conn) return undefined;
    const folder = (await conn.getChildren()).find((c) => c instanceof StreamsFolder);
    if (!folder) return undefined;
    return (await folder.getChildren()).find((c): c is StreamNode => c instanceof StreamNode && c.name === this.stream);
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      snapshot: async (): Promise<StreamSnapshot> => {
        const jsm = await this.lc().jsm();
        const si = await jsm.streams.info(this.stream);
        const consumers = si.state.consumer_count > 0 ? await listConsumersCapped(jsm, this.stream, MAX_CONSUMERS) : [];
        const serverAt = si.ts ? Date.parse(si.ts) : NaN;
        return {
          at: Date.now(),
          serverAt: Number.isFinite(serverAt) ? serverAt : undefined,
          stream: streamView(si),
          consumers,
          consumersTotal: Math.max(si.state.consumer_count, consumers.length),
        };
      },
      subjects: async (): Promise<SubjectStats> => {
        const counts = await fetchSubjectCounts(await this.lc().jsm(), this.stream, { max: maxSubjectsSetting() });
        const root = buildSubjectTree(counts.subjects);
        const start = treemapStart(root);
        return {
          at: Date.now(),
          total: counts.total,
          truncated: counts.truncated,
          max: counts.max,
          kept: counts.subjects.length,
          streamMessages: counts.streamMessages,
          keptMessages: counts.keptMessages,
          top: counts.subjects.slice(0, 50),
          largest: counts.subjects[0],
          tree: subjectTreemap(start, { maxChildren: 24, maxDepth: 4 }),
          treePrefix: start.path,
          roots: root.children.map((c) => ({ label: c.children.length ? `${c.name}.>` : c.name, value: c.messages, subjects: c.subjects })),
        };
      },
      recent: async (): Promise<RecentMessages> => {
        // STREAM.MSG.GET by sequence, not an ordered consumer: works on work-queue streams and does
        // not add a short-lived consumer to the very list this dashboard polls.
        const r = await recentMessages(await this.lc().jsm(), this.stream, { limit: RECENT_LIMIT });
        const messages = r.messages.map((m) => {
          const bytes = base64ToBytes(m.data);
          return bytes.length > PREVIEW_BYTES ? { ...m, data: bytesToBase64(bytes.subarray(0, PREVIEW_BYTES)) } : m;
        });
        return { at: Date.now(), lastSeq: r.lastSeq, messages, partial: r.partial || undefined };
      },
      browseSubject: ({ filter }: { filter?: string }) => {
        openMessageBrowser(this.s, this.lc(), this.stream, { filter: filter && filter !== ">" ? filter : "" });
        return true;
      },
      openMessage: ({ seq }: { seq: number }) => {
        openMessageBrowser(this.s, this.lc(), this.stream, { seq: Number(seq) });
        return true;
      },
      openMessages: () => {
        openMessageBrowser(this.s, this.lc(), this.stream);
        return true;
      },
      consumerLab: ({ consumer }: { consumer: string }) => {
        openConsumerLab(this.s, this.lc(), this.stream, consumer);
        return true;
      },
      consumerInfo: async ({ consumer }: { consumer: string }) => {
        await this.s.infoDocs.show(infoUri(this.profileId, `/consumer/${this.stream}/${consumer}.json`), { column: vscode.ViewColumn.Beside });
        return true;
      },
      streamInfo: async () => {
        await this.s.infoDocs.show(infoUri(this.profileId, `/stream/${this.stream}.json`), { column: vscode.ViewColumn.Beside });
        return true;
      },
      editConfig: async () => {
        this.lc();
        const doc = await vscode.workspace.openTextDocument(streamConfigUri(this.profileId, this.stream));
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        return true;
      },
      createConsumer: async () => {
        await vscode.commands.executeCommand("nats.createConsumer", (await this.streamNode()) ?? { connId: this.profileId });
        return true;
      },
      publish: async () => {
        const node = await this.streamNode();
        if (node) {
          await vscode.commands.executeCommand("nats.publishToStream", node);
          return true;
        }
        const lc = this.lc();
        const subjects = (await (await lc.jsm()).streams.info(this.stream)).config.subjects ?? [];
        if (!subjects.length) throw new Error(`Stream ${this.stream} has no subjects (mirror/sourced streams cannot be published to directly)`);
        openPublisher(this.s, lc, { mode: "publish", subject: concreteSubject(subjects[0]), jetstream: true });
        return true;
      },
      reconnect: async () => {
        await this.s.manager.connect(this.profileId);
        return true;
      },
      openSetting: async ({ key }: { key: string }) => {
        await vscode.commands.executeCommand("workbench.action.openSettings", key);
        return true;
      },
      close: () => {
        this.dispose();
        return true;
      },
    };
  }
}

export function openStreamDashboard(s: Services, lc: LiveConnection, stream: string): void {
  if (WebviewPanelBase.reveal(keyOf(lc.id, stream))) return;
  const { state, error } = s.manager.stateOf(lc.id);
  new StreamDashboardPanel(s, lc.id, stream, {
    profileId: lc.id,
    connectionName: lc.profile.name,
    stream,
    environment: lc.profile.environment,
    readOnly: !!lc.profile.readOnly,
    connState: lc.nc.isClosed() ? "disconnected" : state === "disconnected" ? "connected" : state,
    connError: error,
    refreshInterval: refreshIntervalSetting(),
    maxSubjects: maxSubjectsSetting(),
    visible: true,
  });
}

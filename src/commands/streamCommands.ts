// Stream and consumer commands: create (wizards), info, edit config (JSON),
// purge, delete, Message Browser, Consumer Lab.

import * as vscode from "vscode";
import { AckPolicy, DeliverPolicy, DiscardPolicy, RetentionPolicy, StorageType, type ConsumerConfig, type StreamConfig } from "@nats-io/jetstream";
import type { Services } from "../services";
import { ConsumerNode, StreamNode, StreamsFolder, NatsNode } from "../tree/explorer";
import { assertWritable, confirmDanger, pickConnection, pickFrom, required, safe, validateName, validateSubject, withProgress } from "../core/ui";
import { profileIdOf } from "./connectionCommands";
import { infoUri } from "../fs/infoDocs";
import { ConfigFileSystem, CONFIG_SCHEME, consumerConfigUri, streamConfigUri } from "../fs/configFs";
import { listStreams } from "../nats/streams";
import { openMessageBrowser } from "../panels/messageBrowserPanel";
import { openConsumerLab } from "../panels/consumerLabPanel";
import { WebviewPanelBase } from "../panels/webviewHost";
import { parseDuration, fmtNumber } from "../shared/format";
import { subjectsOverlap } from "../shared/subjects";
import type { LiveConnection } from "../core/connectionManager";

export function registerStreamCommands(s: Services): void {
  const configFs = new ConfigFileSystem(s.manager, (connId) => s.explorer.refreshFolder(connId, "streams"));
  s.context.subscriptions.push(configFs, vscode.workspace.registerFileSystemProvider(CONFIG_SCHEME, configFs, { isCaseSensitive: true }));

  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id.replace("nats.", ""), fn)));

  /** Resolve a stream from a node, or ask for one. */
  const streamTarget = async (arg?: unknown): Promise<{ lc: LiveConnection; stream: string; node?: StreamNode }> => {
    if (arg instanceof StreamNode) return { lc: await pickConnection(s, arg.connId), stream: arg.name, node: arg };
    const lc = await pickConnection(s, profileIdOf(arg));
    const streams = await listStreams(await lc.jsm(), true);
    const si = await pickFrom(streams, (x) => x.config.name, "Select a stream", (x) => `${fmtNumber(x.state.messages)} msgs · ${(x.config.subjects ?? []).join(", ")}`);
    return { lc, stream: si.config.name };
  };

  reg("nats.createStream", async (arg?: unknown) => {
    const lc = await pickConnection(s, profileIdOf(arg));
    assertWritable(lc, "creating a stream");
    const jsm = await lc.jsm();
    const name = required(
      await vscode.window.showInputBox({ title: "Create Stream (1/5)", prompt: "Stream name", placeHolder: "ORDERS", validateInput: validateName, ignoreFocusOut: true }),
    ).trim();
    const subjectsRaw = required(
      await vscode.window.showInputBox({
        title: "Create Stream (2/5)",
        prompt: "Subjects captured by the stream (comma separated, wildcards allowed)",
        value: `${name.toLowerCase()}.>`,
        ignoreFocusOut: true,
        validateInput: (v) => v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => validateSubject(x)).find(Boolean),
      }),
    );
    const subjects = subjectsRaw.split(",").map((x) => x.trim()).filter(Boolean);
    const existing = await listStreams(jsm, true);
    const clash = existing.find((si) => (si.config.subjects ?? []).some((a) => subjects.some((b) => subjectsOverlap(a, b))));
    if (clash) {
      const go = await vscode.window.showWarningMessage(`These subjects overlap with stream "${clash.config.name}" (${clash.config.subjects?.join(", ")}). The server will reject overlapping subjects.`, "Continue anyway");
      if (!go) return;
    }
    const storage = required(
      await vscode.window.showQuickPick(
        [
          { label: "File", description: "persisted to disk", value: StorageType.File },
          { label: "Memory", description: "fast, lost on server restart", value: StorageType.Memory },
        ],
        { title: "Create Stream (3/5) — Storage" },
      ),
    ).value;
    const retention = required(
      await vscode.window.showQuickPick(
        [
          { label: "Limits", description: "keep messages until limits (age / count / size) are hit", value: RetentionPolicy.Limits },
          { label: "Interest", description: "keep messages while consumers have not acknowledged them", value: RetentionPolicy.Interest },
          { label: "Work Queue", description: "each message is consumed once, then removed", value: RetentionPolicy.Workqueue },
        ],
        { title: "Create Stream (4/5) — Retention" },
      ),
    ).value;
    const limits = required(
      await vscode.window.showInputBox({
        title: "Create Stream (5/5) — Max age",
        prompt: "Maximum message age (e.g. 30m, 24h, 7d). Leave empty for no limit. Edit the JSON config later for every other option.",
        placeHolder: "unlimited",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() && parseDuration(v) === undefined ? "Use a duration like 90s, 30m, 24h or 7d" : undefined),
      }),
    );
    const cfg: Partial<StreamConfig> & { name: string } = {
      name,
      subjects,
      storage,
      retention,
      discard: DiscardPolicy.Old,
      max_age: limits.trim() ? Math.round(parseDuration(limits)! * 1e6) : 0,
      num_replicas: 1,
    };
    await withProgress(`Creating stream ${name}…`, () => jsm.streams.add(cfg));
    s.explorer.refreshFolder(lc.id, "streams");
    const next = await vscode.window.showInformationMessage(`Stream "${name}" created.`, "Edit full config", "Browse messages");
    if (next === "Edit full config") await openConfig(streamConfigUri(lc.id, name));
    if (next === "Browse messages") openMessageBrowser(s, lc, name);
  });

  reg("nats.streamInfo", async (arg?: unknown) => {
    const { lc, stream } = await streamTarget(arg);
    await s.infoDocs.show(infoUri(lc.id, `/stream/${stream}.json`));
  });

  reg("nats.editStreamConfig", async (arg?: unknown) => {
    const { lc, stream } = await streamTarget(arg);
    await openConfig(streamConfigUri(lc.id, stream));
  });

  reg("nats.browseMessages", async (arg?: unknown) => {
    const { lc, stream } = await streamTarget(arg);
    openMessageBrowser(s, lc, stream);
  });

  reg("nats.purgeStream", async (arg?: unknown) => {
    const { lc, stream, node } = await streamTarget(arg);
    assertWritable(lc, "purging a stream");
    const jsm = await lc.jsm();
    const mode = required(
      await vscode.window.showQuickPick(
        [
          { label: "$(clear-all) All messages", id: "all" },
          { label: "$(symbol-namespace) Messages on a subject…", id: "subject" },
          { label: "$(history) Keep only the newest N…", id: "keep" },
          { label: "$(arrow-up) Everything below a sequence…", id: "seq" },
        ],
        { title: `Purge stream ${stream}` },
      ),
    ).id;
    const opts: Record<string, unknown> = {};
    let what = "all messages";
    if (mode === "subject") {
      const subjects = node?.info.config.subjects ?? [];
      opts.filter = required(await vscode.window.showInputBox({ prompt: "Purge messages matching subject (wildcards allowed)", value: subjects[0], validateInput: (v) => validateSubject(v) }));
      what = `messages on "${opts.filter}"`;
    }
    if (mode === "keep") {
      const n = required(await vscode.window.showInputBox({ prompt: "Number of newest messages to keep", value: "100", validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : "Enter a whole number") }));
      opts.keep = Number(n);
      what = `all but the newest ${n} messages`;
    }
    if (mode === "seq") {
      const n = required(await vscode.window.showInputBox({ prompt: "Purge all messages with a sequence lower than", validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : "Enter a sequence number") }));
      opts.seq = Number(n);
      what = `messages below sequence ${n}`;
    }
    if (!(await confirmDanger(`Purge ${what} from stream "${stream}"?`, "Purged messages cannot be recovered.", "Purge", { lc, typeToConfirm: stream }))) return;
    const res = await jsm.streams.purge(stream, opts as never);
    void vscode.window.showInformationMessage(`Purged ${fmtNumber(res.purged)} message${res.purged === 1 ? "" : "s"} from ${stream}.`);
    s.explorer.refreshFolder(lc.id, "streams");
  });

  reg("nats.deleteStream", async (arg?: unknown) => {
    const { lc, stream, node } = await streamTarget(arg);
    const msgs = node ? `${fmtNumber(node.info.state.messages)} messages and ${node.info.state.consumer_count} consumers` : "all messages and consumers";
    if (!(await confirmDanger(`Delete stream "${stream}"?`, `This permanently deletes ${msgs}.`, "Delete Stream", { lc, typeToConfirm: stream }))) return;
    await (await lc.jsm()).streams.delete(stream);
    WebviewPanelBase.disposeWhere((k) => k.startsWith(`msgBrowser:${lc.id}:${stream}`) || k.startsWith(`consumerLab:${lc.id}:${stream}:`));
    s.explorer.refreshFolder(lc.id, "streams");
  });

  reg("nats.createConsumer", async (arg?: unknown) => {
    const { lc, stream, node } = await streamTarget(arg);
    assertWritable(lc, "creating a consumer");
    const jsm = await lc.jsm();
    const streamSubjects = node?.info.config.subjects ?? (await jsm.streams.info(stream)).config.subjects ?? [];
    const kind = required(
      await vscode.window.showQuickPick(
        [
          { label: "Pull", description: "clients fetch batches (recommended)", value: "pull" as const },
          { label: "Push", description: "server delivers to a subject", value: "push" as const },
        ],
        { title: `Create consumer on ${stream} (1/5) — Type` },
      ),
    ).value;
    const name = required(await vscode.window.showInputBox({ title: "Create consumer (2/5)", prompt: "Durable name", validateInput: validateName, ignoreFocusOut: true })).trim();
    const filter = required(
      await vscode.window.showInputBox({
        title: "Create consumer (3/5)",
        prompt: `Filter subject (optional). Stream subjects: ${streamSubjects.join(", ")}`,
        placeHolder: "all subjects",
        ignoreFocusOut: true,
        validateInput: (v) => {
          if (!v.trim()) return undefined;
          const err = validateSubject(v);
          if (err) return err;
          return streamSubjects.length && !streamSubjects.some((ss) => subjectsOverlap(ss, v.trim())) ? { message: "This filter does not overlap the stream's subjects — the consumer would never receive messages", severity: vscode.InputBoxValidationSeverity.Warning } : undefined;
        },
      }),
    ).trim();
    const deliver = required(
      await vscode.window.showQuickPick(
        [
          { label: "All", description: "from the first message", value: DeliverPolicy.All },
          { label: "New", description: "only messages published after creation", value: DeliverPolicy.New },
          { label: "Last", description: "starting with the last message", value: DeliverPolicy.Last },
          { label: "Last per subject", description: "the latest message of every subject", value: DeliverPolicy.LastPerSubject },
          { label: "From sequence…", value: DeliverPolicy.StartSequence },
          { label: "From time…", value: DeliverPolicy.StartTime },
        ],
        { title: "Create consumer (4/5) — Deliver policy" },
      ),
    ).value;
    const cfg: Partial<ConsumerConfig> = { durable_name: name, deliver_policy: deliver };
    if (filter) cfg.filter_subject = filter;
    if (deliver === DeliverPolicy.StartSequence) {
      cfg.opt_start_seq = Number(required(await vscode.window.showInputBox({ prompt: "Start sequence", validateInput: (v) => (/^\d+$/.test(v) ? undefined : "Enter a number") })));
    }
    if (deliver === DeliverPolicy.StartTime) {
      const t = required(await vscode.window.showInputBox({ prompt: "Start time (ISO 8601)", value: new Date(Date.now() - 3600_000).toISOString(), validateInput: (v) => (Number.isNaN(Date.parse(v)) ? "Invalid date" : undefined) }));
      cfg.opt_start_time = new Date(t).toISOString();
    }
    cfg.ack_policy = required(
      await vscode.window.showQuickPick(
        [
          { label: "Explicit", description: "every message must be acknowledged", value: AckPolicy.Explicit },
          { label: "All", description: "acking a message acks all before it", value: AckPolicy.All },
          { label: "None", description: "no acknowledgements", value: AckPolicy.None },
        ],
        { title: "Create consumer (5/5) — Ack policy" },
      ),
    ).value;
    if (kind === "push") {
      const deliverSubject = required(
        await vscode.window.showInputBox({
          prompt: "Deliver subject for the push consumer",
          value: `deliver.${name}`,
          validateInput: (v) => validateSubject(v, false) ?? (streamSubjects.some((ss) => subjectsOverlap(ss, v.trim())) ? "The deliver subject overlaps the stream's subjects — this would create a delivery loop" : undefined),
        }),
      );
      cfg.deliver_subject = deliverSubject.trim();
      const group = await vscode.window.showInputBox({ prompt: "Deliver group / queue (optional)", placeHolder: "none" });
      if (group?.trim()) cfg.deliver_group = group.trim();
    }
    await withProgress(`Creating consumer ${name}…`, () => jsm.consumers.add(stream, cfg));
    s.explorer.refreshFolder(lc.id, "streams");
    const next = await vscode.window.showInformationMessage(`Consumer "${name}" created on ${stream}.`, kind === "pull" ? "Open Consumer Lab" : "Edit config");
    if (next === "Open Consumer Lab") openConsumerLab(s, lc, stream, name);
    if (next === "Edit config") await openConfig(consumerConfigUri(lc.id, stream, name));
  });

  const consumerTarget = async (arg?: unknown): Promise<{ lc: LiveConnection; stream: string; consumer: string; node?: ConsumerNode }> => {
    if (arg instanceof ConsumerNode) return { lc: await pickConnection(s, arg.connId), stream: arg.stream, consumer: arg.name, node: arg };
    throw new Error("Select a consumer in the NATS explorer");
  };

  reg("nats.consumerInfo", async (arg?: unknown) => {
    const { lc, stream, consumer } = await consumerTarget(arg);
    await s.infoDocs.show(infoUri(lc.id, `/consumer/${stream}/${consumer}.json`));
  });

  reg("nats.editConsumerConfig", async (arg?: unknown) => {
    const { lc, stream, consumer } = await consumerTarget(arg);
    await openConfig(consumerConfigUri(lc.id, stream, consumer));
  });

  reg("nats.deleteConsumer", async (arg?: unknown) => {
    const { lc, stream, consumer, node } = await consumerTarget(arg);
    if (!(await confirmDanger(`Delete consumer "${consumer}" on ${stream}?`, "Its delivery and acknowledgement state is lost. Messages stay in the stream.", "Delete Consumer", { lc, typeToConfirm: consumer }))) return;
    await (await lc.jsm()).consumers.delete(stream, consumer);
    WebviewPanelBase.disposeWhere((k) => k === `consumerLab:${lc.id}:${stream}:${consumer}`);
    if (node?.parent) s.explorer.refresh(node.parent.parent instanceof StreamsFolder ? node.parent.parent : (node.parent as NatsNode));
    else s.explorer.refreshFolder(lc.id, "streams");
  });

  reg("nats.openConsumerLab", async (arg?: unknown) => {
    const { lc, stream, consumer } = await consumerTarget(arg);
    openConsumerLab(s, lc, stream, consumer);
  });
}

async function openConfig(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.setStatusBarMessage("$(info) Save the document to apply the configuration on the server", 6000);
}

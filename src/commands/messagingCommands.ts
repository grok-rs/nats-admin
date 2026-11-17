// Messaging commands: Live Tail, Publish / Request, publish editor selection,
// Dead Letter Monitor, publish to a stream, request a service endpoint.

import * as vscode from "vscode";
import type { Services } from "../services";
import { pickConnection, pickFrom, required, safe, validateSubject } from "../core/ui";
import { assertWritable } from "../core/ui";
import { ConnectionNode, NatsNode, ServiceEndpointNode, StreamNode } from "../tree/explorer";
import { openLiveTail } from "../panels/liveTailPanel";
import { openPublisher } from "../panels/publisherPanel";
import { openDeadLetters } from "../panels/deadLetterPanel";
import { exampleSubject } from "../nats/messaging";
import { utf8Encode } from "../shared/encoding";
import { fmtBytes } from "../shared/format";

const LAST_SUB_KEY = "nats.lastSubscribeSubject";
const RECENT_PUB_KEY = "nats.recentPublishSubjects";

function connIdOf(node: unknown): string | undefined {
  if (node instanceof ConnectionNode) return node.profile.id;
  if (node instanceof NatsNode) return node.connId;
  return undefined;
}

/** Quick input that offers recent subjects but accepts any typed subject. */
async function pickSubject(recent: string[], title: string, placeholder: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
    qp.title = title;
    qp.placeholder = placeholder;
    const recentItems = recent.map((r) => ({ label: r, description: "recent" }));
    qp.items = recentItems;
    qp.onDidChangeValue((v) => {
      const typed = v.trim();
      const err = typed ? validateSubject(typed, false) : undefined;
      qp.items = typed && !recent.includes(typed) ? [{ label: typed, description: err ?? "publish to this subject" }, ...recentItems] : recentItems;
    });
    let done = false;
    qp.onDidAccept(() => {
      const value = (qp.selectedItems[0]?.label ?? qp.value).trim();
      const err = validateSubject(value, false);
      if (err) {
        qp.title = `${title} — ${err}`;
        return;
      }
      done = true;
      resolve(value);
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!done) reject(new Error("cancelled"));
    });
    qp.show();
  }).catch(() => required<string>(undefined));
}

export function registerMessagingCommands(s: Services): void {
  const state = s.context.globalState;
  const reg = (id: string, label: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(label, fn)));

  reg("nats.subscribe", "Live Tail", async (node?: unknown) => {
    const lc = await pickConnection(s, connIdOf(node));
    if (node instanceof ServiceEndpointNode) {
      openLiveTail(s, lc, { subject: node.endpoint.subject });
      return;
    }
    const subject = required(
      await vscode.window.showInputBox({
        title: `Live Tail · ${lc.profile.name}`,
        prompt: "Subject to subscribe to (wildcards * and > allowed)",
        value: state.get<string>(LAST_SUB_KEY, ">"),
        validateInput: (v) => validateSubject(v),
      }),
    ).trim();
    await state.update(LAST_SUB_KEY, subject);
    openLiveTail(s, lc, { subject });
  });

  reg("nats.publish", "Publish", async (node?: unknown) => {
    const lc = await pickConnection(s, connIdOf(node));
    openPublisher(s, lc, { mode: "publish" });
  });

  reg("nats.request", "Request", async (node?: unknown) => {
    const lc = await pickConnection(s, connIdOf(node));
    openPublisher(s, lc, { mode: "request" });
  });

  reg("nats.publishSelection", "Publish selection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error("Open an editor with the payload to publish");
    const sel = editor.selection;
    const text = sel && !sel.isEmpty ? editor.document.getText(sel) : editor.document.getText();
    const recent = state.get<string[]>(RECENT_PUB_KEY, []);
    const lc = await pickConnection(s);
    assertWritable(lc, "publishing");
    const subject = await pickSubject(recent, `Publish ${sel && !sel.isEmpty ? "selection" : "document"} · ${lc.profile.name}`, "Subject to publish to");
    const data = utf8Encode(text);
    lc.nc.publish(subject, data);
    await lc.nc.flush();
    await state.update(RECENT_PUB_KEY, [subject, ...recent.filter((r) => r !== subject)].slice(0, 10));
    void vscode.window.showInformationMessage(`Published ${fmtBytes(data.length)} to ${subject} on ${lc.profile.name}`);
  });

  reg("nats.deadLetters", "Dead Letter Monitor", async (node?: unknown) => {
    const lc = await pickConnection(s, connIdOf(node));
    openDeadLetters(s, lc);
  });

  reg("nats.publishToStream", "Publish to stream", async (node?: unknown) => {
    if (!(node instanceof StreamNode)) throw new Error("Select a stream in the NATS explorer");
    const lc = await pickConnection(s, node.connId);
    const subjects = node.info.config.subjects ?? [];
    if (!subjects.length) throw new Error(`Stream ${node.name} has no subjects (mirror/sourced streams cannot be published to directly)`);
    const pattern = subjects.length === 1 ? subjects[0] : await pickFrom(subjects, (x) => x, `Subject of ${node.name} to publish to`);
    openPublisher(s, lc, { mode: "publish", subject: exampleSubject(pattern), jetstream: true });
  });

  reg("nats.requestEndpoint", "Request endpoint", async (node?: unknown) => {
    if (!(node instanceof ServiceEndpointNode)) throw new Error("Select a service endpoint in the NATS explorer");
    const lc = await pickConnection(s, node.connId);
    openPublisher(s, lc, { mode: "request", subject: node.endpoint.subject });
  });
}

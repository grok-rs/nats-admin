// Executes a finding's suggested action. The stream / consumer / bucket commands
// of the explorer only accept tree nodes, so their equivalents are opened
// directly here (info documents, config documents, panels); commands that
// resolve a { connId } argument themselves are executed as-is.

import * as vscode from "vscode";
import type { Services } from "../services";
import { pickConnection } from "../core/ui";
import { infoUri } from "../fs/infoDocs";
import { consumerConfigUri, streamConfigUri } from "../fs/configFs";
import { openMessageBrowser } from "../panels/messageBrowserPanel";
import { openConsumerLab } from "../panels/consumerLabPanel";
import type { Finding, FindingFix, FindingTarget } from "./model";

export { findingOf } from "./model";

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`The suggested action is missing the ${what}`);
  return v;
}

async function openEditable(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.setStatusBarMessage("$(info) Save the document to apply the configuration on the server", 6000);
}

export async function runFix(s: Services, fix: FindingFix): Promise<void> {
  const { connId, stream, consumer, bucket } = fix.args;
  switch (fix.command) {
    case "nats.editStreamConfig":
      return openEditable(streamConfigUri(connId, need(stream, "stream")));
    case "nats.streamInfo":
      await s.infoDocs.show(infoUri(connId, `/stream/${need(stream, "stream")}.json`));
      return;
    case "nats.browseMessages":
      openMessageBrowser(s, await pickConnection(s, connId), need(stream, "stream"));
      return;
    case "nats.consumerInfo":
      await s.infoDocs.show(infoUri(connId, `/consumer/${need(stream, "stream")}/${need(consumer, "consumer")}.json`));
      return;
    case "nats.editConsumerConfig":
      return openEditable(consumerConfigUri(connId, need(stream, "stream"), need(consumer, "consumer")));
    case "nats.openConsumerLab":
      openConsumerLab(s, await pickConnection(s, connId), need(stream, "stream"), need(consumer, "consumer"));
      return;
    case "nats.kvBucketInfo":
      await s.infoDocs.show(infoUri(connId, `/kv/${need(bucket, "bucket")}.json`));
      return;
    case "nats.objBucketInfo":
      await s.infoDocs.show(infoUri(connId, `/obj/${need(bucket, "bucket")}.json`));
      return;
    default:
      // nats.serverInfo / nats.openDashboard / nats.editConnection resolve { connId } themselves.
      await vscode.commands.executeCommand(fix.command, fix.args);
  }
}

/** Open the read-only info document of a finding's resource. */
export async function openTarget(s: Services, t: FindingTarget): Promise<void> {
  switch (t.kind) {
    case "stream":
      await s.infoDocs.show(infoUri(t.connId, `/stream/${need(t.stream, "stream")}.json`));
      return;
    case "consumer":
      await s.infoDocs.show(infoUri(t.connId, `/consumer/${need(t.stream, "stream")}/${need(t.consumer, "consumer")}.json`));
      return;
    case "kv":
      await s.infoDocs.show(infoUri(t.connId, `/kv/${need(t.bucket, "bucket")}.json`));
      return;
    case "objectstore":
      await s.infoDocs.show(infoUri(t.connId, `/obj/${need(t.bucket, "bucket")}.json`));
      return;
    default:
      await s.infoDocs.show(infoUri(t.connId, "/server.json"));
  }
}

/** nats.healthFix: run the suggested action, or open the resource when there is none. */
export async function applyFinding(s: Services, f: Finding): Promise<void> {
  if (f.fix) await runFix(s, f.fix);
  else await openTarget(s, f.target);
}

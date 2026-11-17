// Stream & KV insights: the Stream Dashboard panel, the "Subjects" explorer folder under each
// stream and nats.browseSubject (Message Browser filtered to a subject or token folder).

import * as vscode from "vscode";
import type { StreamInfo } from "@nats-io/jetstream";
import type { Services } from "../services";
import { pickConnection, pickFrom, safe } from "../core/ui";
import { listStreams } from "../nats/streams";
import { openMessageBrowser } from "../panels/messageBrowserPanel";
import { openStreamDashboard } from "../panels/streamDashboardPanel";
import { BROWSE_SUBJECT, registerSubjectNodes, subjectTargetOf } from "../tree/subjectNodes";
import { fmtNumber } from "../shared/format";
import { streamArgOf } from "./args";

export function registerInsights(s: Services): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id.replace("nats.", ""), fn)));

  s.context.subscriptions.push(registerSubjectNodes(s));

  reg("nats.openStreamDashboard", async (arg?: unknown) => {
    const { connId, stream } = streamArgOf(arg);
    const lc = await pickConnection(s, connId);
    let name = stream;
    if (!name) {
      const streams = await listStreams(await lc.jsm(), true);
      const si = await pickFrom<StreamInfo>(streams, (x) => x.config.name, "Select a stream", (x) => `${fmtNumber(x.state.messages)} msgs · ${(x.config.subjects ?? []).join(", ")}`);
      name = si.config.name;
    }
    openStreamDashboard(s, lc, name);
  });

  reg(BROWSE_SUBJECT, async (arg?: unknown) => {
    const target = subjectTargetOf(arg);
    if (!target) throw new Error("Select a subject under a stream's Subjects folder in the NATS explorer");
    const lc = await pickConnection(s, target.connId);
    openMessageBrowser(s, lc, target.stream, { filter: target.filter ?? "" });
  });
}

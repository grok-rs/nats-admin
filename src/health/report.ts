// nats.exportHealthReport: the latest report (running a check first if needed)
// as an untitled Markdown document.

import * as vscode from "vscode";
import type { Services } from "../services";
import { ENVIRONMENTS } from "../core/profile";
import { pickConnection } from "../core/ui";
import type { HealthService } from "./healthService";
import { toMarkdown } from "./score";

export async function exportReport(s: Services, health: HealthService, connId: string): Promise<void> {
  let report = health.get(connId);
  if (!report) {
    // No report yet: connect (with progress) when needed, then run the check.
    if (!s.manager.get(connId)) await pickConnection(s, connId);
    report = await health.run(connId);
  }
  const env = ENVIRONMENTS.find((e) => e.id === s.store.get(connId)?.environment)?.label;
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: toMarkdown(report, { environment: env }) });
  await vscode.window.showTextDocument(doc, { preview: false });
}

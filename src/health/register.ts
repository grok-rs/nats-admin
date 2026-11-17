// JetStream health doctor: wires the health service, the "nats.health" view,
// explorer decorations, the status bar item, the Health Dashboard and commands
// (nats.runHealthCheck, nats.openHealthDashboard, nats.exportHealthReport, nats.healthFix).

import * as vscode from "vscode";
import type { Services } from "../services";
import { CancelledError, pickConnection, pickFrom, safe } from "../core/ui";
import { profileIdOf } from "../commands/connectionCommands";
import { HealthService } from "./healthService";
import { HealthTreeProvider } from "./healthView";
import { HealthDecorations } from "./decorations";
import { registerHealthStatusItem } from "./statusItem";
import { openHealthDashboard } from "./healthPanel";
import { exportReport } from "./report";
import { applyFinding, findingOf } from "./fixes";
import { countsText, scoreLabel } from "./model";

export function registerHealth(s: Services): void {
  const health = new HealthService(s);
  const tree = new HealthTreeProvider(s, health);
  const view = vscode.window.createTreeView("nats.health", { treeDataProvider: tree, showCollapseAll: true });
  const decorations = new HealthDecorations(health);

  const updateBadge = () => {
    let errors = 0;
    let warnings = 0;
    for (const id of health.connIds()) {
      const r = health.get(id);
      errors += r?.counts.error ?? 0;
      warnings += r?.counts.warning ?? 0;
    }
    view.badge = errors + warnings > 0 ? { value: errors + warnings, tooltip: `Health: ${countsText({ error: errors, warning: warnings, info: 0 })}` } : undefined;
  };

  s.context.subscriptions.push(health, tree, view, decorations, vscode.window.registerFileDecorationProvider(decorations), registerHealthStatusItem(s, health), health.onDidChange(updateBadge));

  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id.replace("nats.", ""), fn)));

  /** Connection for a command: tree node / profile id / { connId } → that one; none → active (or ask). */
  const resolveConn = async (arg: unknown): Promise<string> => (await pickConnection(s, profileIdOf(arg))).id;

  reg("nats.runHealthCheck", async (arg?: unknown) => {
    const connId = await resolveConn(arg);
    const name = s.store.get(connId)?.name ?? "NATS";
    const report = await vscode.window.withProgress({ location: { viewId: "nats.health" }, title: `Health check: ${name}` }, () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `$(pulse) Checking ${name}…` }, () => health.run(connId)),
    );
    const msg = `Health check for ${name}: ${report.score}/100 (${scoreLabel(report.score)}) — ${countsText(report.counts)}.`;
    const actions = report.findings.length ? ["Open Dashboard", "Show Findings"] : ["Open Dashboard"];
    const shown = report.counts.error ? vscode.window.showWarningMessage(msg, ...actions) : vscode.window.showInformationMessage(msg, ...actions);
    void shown.then((choice) => {
      if (choice === "Open Dashboard") openHealthDashboard(s, health, connId);
      if (choice === "Show Findings") void vscode.commands.executeCommand("nats.health.focus");
    });
  });

  reg("nats.openHealthDashboard", async (arg?: unknown) => {
    let connId = profileIdOf(arg);
    if (!connId) {
      const active = s.manager.activeId;
      const withReports = health.connIds();
      connId = active && (s.manager.get(active) || health.get(active)) ? active : withReports[0];
    }
    if (!connId) connId = await resolveConn(undefined);
    openHealthDashboard(s, health, connId);
    if (!health.get(connId) && !health.isRunning(connId) && s.manager.get(connId)) health.run(connId).catch(() => undefined);
  });

  reg("nats.exportHealthReport", async (arg?: unknown) => {
    let connId = profileIdOf(arg);
    if (!connId) {
      const withReports = health.connIds().filter((id) => health.get(id));
      const active = s.manager.activeId;
      if (active && health.get(active)) connId = active;
      else if (withReports.length === 1) connId = withReports[0];
      else if (withReports.length > 1)
        connId = (
          await pickFrom(
            withReports.map((id) => ({ id, name: s.store.get(id)?.name ?? id, r: health.get(id)! })),
            (x) => x.name,
            "Export the health report of",
            (x) => `${x.r.score}/100 · ${countsText(x.r.counts)}`,
          )
        ).id;
      else connId = await resolveConn(undefined);
    }
    await exportReport(s, health, connId);
  });

  reg("nats.healthFix", async (arg?: unknown) => {
    const f = findingOf(arg);
    if (!f) throw new CancelledError();
    await applyFinding(s, f);
  });
}

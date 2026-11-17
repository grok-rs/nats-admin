// Status bar item "$(pulse) <score>" for the active connection's latest health report.
// Warning / error background when the report has warnings / errors; click → dashboard.

import * as vscode from "vscode";
import type { Services } from "../services";
import { ENVIRONMENTS } from "../core/profile";
import type { HealthService } from "./healthService";
import { reportTooltip } from "./healthView";
import { countsText, scoreLabel } from "./model";

export function registerHealthStatusItem(s: Services, health: HealthService): vscode.Disposable {
  const item = vscode.window.createStatusBarItem("nats.health.status", vscode.StatusBarAlignment.Left, 49);
  item.name = "NATS Health";

  const update = () => {
    const active = (s.manager.activeId && s.manager.get(s.manager.activeId)) || s.manager.connected()[0];
    if (!active) {
      item.hide();
      return;
    }
    const id = active.id;
    const r = health.get(id);
    const running = health.isRunning(id);
    const name = active.profile.name;
    const env = ENVIRONMENTS.find((e) => e.id === active.profile.environment);
    if (!r && !running) {
      item.hide();
      return;
    }
    item.text = r ? `${running ? "$(sync~spin)" : "$(pulse)"} ${r.score}` : "$(sync~spin) Health";
    item.backgroundColor = r?.counts.error ? new vscode.ThemeColor("statusBarItem.errorBackground") : r?.counts.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const tip = reportTooltip(name, r, { running, error: health.lastError(id), env: env?.label });
    tip.appendMarkdown("Click to open the Health Dashboard");
    item.tooltip = tip;
    item.accessibilityInformation = { label: r ? `NATS health for ${name}: ${r.score} of 100, ${scoreLabel(r.score)}, ${countsText(r.counts)}. Open the Health Dashboard.` : `NATS health check running for ${name}` };
    item.command = { command: "nats.openHealthDashboard", title: "Open Health Dashboard", arguments: [id] };
    item.show();
  };

  const subs = [health.onDidChange(update), s.manager.onDidChangeActive(update), s.manager.onDidChangeState(update), s.store.onDidChange(update)];
  update();
  return {
    dispose: () => {
      for (const d of subs) d.dispose();
      item.dispose();
    },
  };
}

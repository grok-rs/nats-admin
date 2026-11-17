// Health Dashboard panel (webview "health"): one panel that can switch between
// connections. Pushes "update" view models whenever the selected connection's
// report, run state, connection state or profile changes.

import * as vscode from "vscode";
import type { Services } from "../services";
import { pickConnection } from "../core/ui";
import { WebviewPanelBase, type RpcHandler } from "../panels/webviewHost";
import type { HealthService } from "./healthService";
import { applyFinding, openTarget } from "./fixes";
import { exportReport } from "./report";
import type { FindingTarget, HealthViewModel } from "./model";

const KEY = "health";

class HealthPanel extends WebviewPanelBase {
  constructor(
    private readonly s: Services,
    private readonly health: HealthService,
    private connId: string,
  ) {
    super(s.context, { viewType: "nats.healthDashboard", key: KEY, title: titleFor(s, connId), script: "health", init: health.viewModel(connId) });
    // Any connection's change can alter the switcher (scores, states), and view models are small.
    this.disposables.push(
      health.onDidChange(() => this.push()),
      s.manager.onDidChangeState(() => this.push()),
      s.store.onDidChange(() => this.push()),
    );
  }

  select(connId: string): void {
    this.connId = connId;
    this.setTitle(titleFor(this.s, connId));
    this.push();
  }

  private model(): HealthViewModel {
    return this.health.viewModel(this.connId);
  }

  private push(): void {
    this.post("update", this.model());
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      state: () => this.model(),
      select: ({ connId }: { connId: string }) => {
        if (!this.s.store.get(connId)) throw new Error("Unknown connection");
        this.select(connId);
        return this.model();
      },
      run: async () => {
        if (!this.s.manager.get(this.connId)) await pickConnection(this.s, this.connId);
        await this.health.run(this.connId);
        return this.model();
      },
      fix: async ({ key }: { key: string }) => {
        const f = this.health.get(this.connId)?.findings.find((x) => x.key === key);
        if (!f) throw new Error("This finding is no longer in the latest report — re-run the health check");
        await applyFinding(this.s, f);
        return true;
      },
      open: async ({ target }: { target: FindingTarget }) => {
        await openTarget(this.s, { ...target, connId: this.connId });
        return true;
      },
      export: async () => {
        await exportReport(this.s, this.health, this.connId);
        return true;
      },
      docs: async ({ url }: { url: string }) => {
        if (!/^https:\/\/docs\.nats\.io\//.test(url)) throw new Error("Only docs.nats.io links can be opened");
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return true;
      },
      settings: async () => {
        await vscode.commands.executeCommand("workbench.action.openSettings", "nats.health");
        return true;
      },
    };
  }
}

function titleFor(s: Services, connId: string): string {
  return `Health: ${s.store.get(connId)?.name ?? "NATS"}`;
}

export function openHealthDashboard(s: Services, health: HealthService, connId: string): void {
  const existing = WebviewPanelBase.reveal<HealthPanel>(KEY);
  if (existing) existing.select(connId);
  else new HealthPanel(s, health, connId);
}

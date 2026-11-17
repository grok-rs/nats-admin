// NATS Home: fleet view of every connection profile grouped by environment, with live status,
// server, RTT, throughput, JetStream usage and health per connection, fleet KPIs, search and
// filters, and a getting-started guide when no profiles exist.
//
// The webview polls `snapshot` (nats.overview.refreshInterval) only while the panel is visible
// (the host sends `visibility`); connection / profile / health changes push `changed`.

import * as vscode from "vscode";
import type { Services } from "../services";
import { cfg } from "../core/ui";
import { healthBus } from "../core/healthBus";
import { WebviewPanelBase, type RpcHandler } from "./webviewHost";
import { fleetMonitor, fleetRow } from "../overview/fleet";
import { openDocs, revealInExplorer, runCommand } from "../overview/actions";
import { overviewInterval } from "../overview/overviewView";
import { compareProfiles, type HomeInit, type HomeSnapshot } from "../overview/model";

const HOME_KEY = "home";

class HomePanel extends WebviewPanelBase {
  private changeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly s: Services) {
    super(s.context, { viewType: "nats.home", key: HOME_KEY, title: "NATS Home", script: "home", init: homeInit() });
    const changed = () => {
      if (this.changeTimer) return;
      this.changeTimer = setTimeout(() => {
        this.changeTimer = undefined;
        this.post("changed");
      }, 120);
    };
    this.disposables.push(
      this.panel.onDidChangeViewState(() => this.post("visibility", { visible: this.panel.visible })),
      s.manager.onDidChangeState(changed),
      s.manager.onDidChangeActive(changed),
      s.store.onDidChange(changed),
      healthBus.onDidChange(changed),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nats.overview") || e.affectsConfiguration("nats.health.rttWarningMs")) this.post("config", homeInit());
      }),
      { dispose: () => this.changeTimer && clearTimeout(this.changeTimer) },
    );
  }

  private async snapshot(): Promise<HomeSnapshot> {
    const s = this.s;
    const sample = this.panel.visible;
    const maxAgeMs = overviewInterval() / 2;
    const rows = await Promise.all(s.store.list().map((p) => fleetRow(s, p, { sample, maxAgeMs })));
    rows.sort((a, b) => compareProfiles(a.profile, b.profile));
    return { at: Date.now(), rows, hidden: s.store.hiddenProfiles().length };
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      snapshot: () => this.snapshot(),
      run: (p: { command: string; profileId?: string }) => runCommand(this.s, p.command, p.profileId),
      reveal: (p: { profileId: string }) => revealInExplorer(this.s, p.profileId),
      retryMonitor: (p: { profileId: string }) => fleetMonitor(this.s).invalidate(p.profileId),
      openDocs: (p: { url: string }) => openDocs(p.url),
    };
  }
}

function homeInit(): HomeInit {
  return { refreshInterval: overviewInterval(), rttWarnMs: cfg("health.rttWarningMs", 100) };
}

export function openHome(s: Services): void {
  if (WebviewPanelBase.reveal(HOME_KEY)) return;
  new HomePanel(s);
}

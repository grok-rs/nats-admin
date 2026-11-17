// Overview sidebar (webview view "nats.overview"): the active connection at a glance —
// environment, read-only state, status, server, RTT and throughput, JetStream inventory and
// usage, health, quick actions and a connection switcher. With nothing connected it lists the
// profiles (grouped by environment) with Connect buttons.
//
// The webview polls `snapshot` (nats.overview.refreshInterval) only while the view is visible;
// the host pushes `changed` when connections, profiles or health summaries change.

import * as vscode from "vscode";
import type { Services } from "../services";
import { cfg } from "../core/ui";
import { healthBus } from "../core/healthBus";
import type { RpcHandler } from "../panels/webviewHost";
import { WebviewViewHost } from "./webviewViewHost";
import { fleetMonitor, fleetRow, profileSummary } from "./fleet";
import { openDocs, revealInExplorer, runCommand, setActive } from "./actions";
import { compareProfiles, isLive, type OverviewInit, type OverviewSnapshot } from "./model";

export const OVERVIEW_VIEW_ID = "nats.overview";

export function overviewInterval(): number {
  return Math.max(1000, cfg("overview.refreshInterval", 3000));
}

export class OverviewViewProvider extends WebviewViewHost {
  private changeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly s: Services) {
    super(s.context, { viewType: OVERVIEW_VIEW_ID, script: "overview", title: "NATS Overview" });
  }

  /** Subscriptions that live as long as the extension (not just the current view). */
  listen(): vscode.Disposable[] {
    return [
      this.s.manager.onDidChangeActive(() => this.changed()),
      this.s.manager.onDidChangeState(() => this.changed()),
      this.s.store.onDidChange(() => this.changed()),
      healthBus.onDidChange(() => this.changed()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nats.overview") || e.affectsConfiguration("nats.health.rttWarningMs")) this.post("config", this.init());
      }),
      { dispose: () => this.changeTimer && clearTimeout(this.changeTimer) },
    ];
  }

  /** Coalesce bursts of state changes into one `changed` event. */
  private changed(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.post("changed");
    }, 120);
  }

  protected init(): OverviewInit {
    return { refreshInterval: overviewInterval(), visible: this.visible, rttWarnMs: cfg("health.rttWarningMs", 100) };
  }

  async snapshot(): Promise<OverviewSnapshot> {
    const s = this.s;
    const profiles = s.store.list().map((p) => profileSummary(s, p)).sort(compareProfiles);
    const live = profiles.filter((p) => isLive(p.state));
    const activeId = s.manager.activeId;
    const preferred = profiles.find((p) => p.id === activeId && (isLive(p.state) || p.state === "connecting"));
    const shown = preferred ?? live[0];
    const snap: OverviewSnapshot = { at: Date.now(), profiles, live };
    if (shown) {
      const p = s.store.get(shown.id);
      // Collect only while somebody is looking; otherwise reuse the last sample.
      if (p) snap.active = await fleetRow(s, p, { sample: this.visible && isLive(shown.state), maxAgeMs: overviewInterval() / 2 });
    }
    return snap;
  }

  protected handlers(): Record<string, RpcHandler> {
    return {
      snapshot: () => this.snapshot(),
      run: (p: { command: string; profileId?: string }) => runCommand(this.s, p.command, p.profileId),
      setActive: (p: { profileId: string }) => setActive(this.s, p.profileId),
      reveal: (p: { profileId: string }) => revealInExplorer(this.s, p.profileId),
      retryMonitor: (p: { profileId: string }) => fleetMonitor(this.s).invalidate(p.profileId),
      openDocs: (p: { url: string }) => openDocs(p.url),
    };
  }
}

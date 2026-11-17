// Overview sidebar, Home (fleet) dashboard and their shared metrics service.
//   - webview view "nats.overview" (retainContextWhenHidden; polls only while visible)
//   - command nats.openHome
// The server dashboard (nats.openDashboard) is registered with the connection commands and
// lives in src/panels/dashboardPanel.ts.

import * as vscode from "vscode";
import type { Services } from "../services";
import { safe } from "../core/ui";
import { openHome } from "../panels/homePanel";
import { fleetMonitor } from "./fleet";
import { OVERVIEW_VIEW_ID, OverviewViewProvider } from "./overviewView";

export function registerOverview(s: Services): void {
  fleetMonitor(s);
  const provider = new OverviewViewProvider(s);
  s.context.subscriptions.push(
    provider,
    ...provider.listen(),
    vscode.window.registerWebviewViewProvider(OVERVIEW_VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("nats.openHome", safe("Open NATS Home", () => openHome(s))),
  );
}

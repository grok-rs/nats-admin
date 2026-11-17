// Status bar item showing the active NATS connection and its round-trip time.

import * as vscode from "vscode";
import type { Services } from "./services";
import { ENVIRONMENTS } from "./core/profile";

export function registerStatusBar(s: Services): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = "nats.selectActiveConnection";
  let rtt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const update = () => {
    const live = s.manager.connected();
    if (live.length === 0) {
      item.hide();
      return;
    }
    const active = (s.manager.activeId && s.manager.get(s.manager.activeId)) || live[0];
    const state = active.state;
    const p = active.profile;
    const env = ENVIRONMENTS.find((e) => e.id === p.environment);
    const icon = state === "reconnecting" ? "$(sync~spin)" : p.environment === "prod" ? "$(shield)" : "$(plug)";
    const envTag = env ? ` [${env.id === "prod" ? "PROD" : env.id}]` : "";
    item.text = `${icon} NATS: ${p.name}${envTag}${p.readOnly ? " $(lock)" : ""}${rtt !== undefined ? ` · ${rtt < 1 ? rtt.toFixed(2) : Math.round(rtt)}ms` : ""}${live.length > 1 ? ` (+${live.length - 1})` : ""}`;
    item.tooltip = `Active NATS connection: ${p.name}${env ? ` (${env.label})` : ""}${p.readOnly ? " — read-only" : ""}\n${active.nc.getServer()}\n${active.info?.server_name ?? ""} v${active.info?.version ?? "?"}\n\nClick to switch the active connection`;
    item.backgroundColor =
      state === "reconnecting" || p.environment === "staging"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : p.environment === "prod"
          ? new vscode.ThemeColor("statusBarItem.errorBackground")
          : undefined;
    item.show();
  };

  const poll = async () => {
    const active = (s.manager.activeId && s.manager.get(s.manager.activeId)) || s.manager.connected()[0];
    if (!active) {
      rtt = undefined;
      return update();
    }
    try {
      rtt = await active.nc.rtt();
    } catch {
      rtt = undefined;
    }
    update();
  };

  const ensureTimer = () => {
    const any = s.manager.connected().length > 0;
    if (any && !timer) {
      timer = setInterval(() => void poll(), 10_000);
      void poll();
    } else if (!any && timer) {
      clearInterval(timer);
      timer = undefined;
      rtt = undefined;
    }
    update();
  };

  s.context.subscriptions.push(
    item,
    s.manager.onDidChangeState(() => ensureTimer()),
    s.manager.onDidChangeActive(() => void poll()),
    s.store.onDidChange(() => update()),
    { dispose: () => timer && clearInterval(timer) },
  );
  ensureTimer();
}

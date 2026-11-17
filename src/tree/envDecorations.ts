// Colours connection labels by environment (prod red, staging yellow, …) and
// adds a short badge, using the nats-node://<connId>/ resource URI of each
// connection node.

import * as vscode from "vscode";
import type { ConnectionStore } from "../core/connectionStore";
import { ENVIRONMENTS } from "../core/profile";
import { NODE_SCHEME } from "./base";

const BADGE: Record<string, string> = { prod: "P", staging: "S", test: "T", dev: "D" };

export class EnvironmentDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly store: ConnectionStore) {
    this.sub = store.onDidChange(() => this._onDidChange.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== NODE_SCHEME || (uri.path !== "/" && uri.path !== "")) return undefined;
    const p = this.store.get(uri.authority);
    if (!p) return undefined;
    const env = ENVIRONMENTS.find((e) => e.id === p.environment);
    if (!env && !p.readOnly) return undefined;
    const tooltip = [env ? `${env.label} environment` : undefined, p.readOnly ? "read-only" : undefined].filter(Boolean).join(" · ");
    return new vscode.FileDecoration(env ? BADGE[env.id] : "RO", tooltip, env ? new vscode.ThemeColor(env.themeColor) : undefined);
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}

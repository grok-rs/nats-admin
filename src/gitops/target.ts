// Target connection for config files, remembered per folder in workspaceState. The default is
// the active connection.

import * as vscode from "vscode";
import { dirname } from "node:path";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { connectWithProgress, required } from "../core/ui";
import { ENVIRONMENTS } from "../core/profile";
import type { PlanConnection } from "./types";

const STATE_KEY = "nats.gitops.targets";

export class GitOpsTargets implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<string>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly s: Services) {}

  private map(): Record<string, string> {
    return this.s.context.workspaceState.get<Record<string, string>>(STATE_KEY, {});
  }

  /** Folder key for a file or folder URI. */
  static folderOf(uri: vscode.Uri, isFolder = false): string {
    return isFolder ? uri.fsPath : dirname(uri.fsPath);
  }

  /** Stored target profile id (if the profile still exists), else the active connection. */
  get(folder: string): string | undefined {
    const stored = this.map()[folder];
    if (stored && this.s.store.get(stored)) return stored;
    const active = this.s.manager.activeId;
    return active && this.s.store.get(active) ? active : undefined;
  }

  /** True when the folder has an explicit choice (not just the active connection). */
  isExplicit(folder: string): boolean {
    const stored = this.map()[folder];
    return !!stored && !!this.s.store.get(stored);
  }

  async set(folder: string, profileId: string): Promise<void> {
    await this.s.context.workspaceState.update(STATE_KEY, { ...this.map(), [folder]: profileId });
    this._onDidChange.fire(folder);
  }

  /** Ask for a target connection for `folder` and remember it. */
  async pick(folder: string): Promise<string> {
    const current = this.get(folder);
    const profiles = this.s.store.list();
    if (!profiles.length) {
      const add = await vscode.window.showInformationMessage("No NATS connections configured.", "Add Connection");
      if (add) await vscode.commands.executeCommand("nats.addConnection");
      required(undefined);
    }
    const label = vscode.workspace.asRelativePath(folder, false);
    const pick = await vscode.window.showQuickPick(
      profiles.map((p) => {
        const env = ENVIRONMENTS.find((e) => e.id === p.environment);
        const live = this.s.manager.get(p.id);
        return {
          label: `${live ? "$(circle-filled)" : "$(circle-outline)"} ${p.name}`,
          description: [env?.label, p.readOnly ? "read-only" : undefined, p.id === current ? "current target" : undefined].filter(Boolean).join(" · "),
          detail: p.servers.join(", "),
          id: p.id,
        };
      }),
      { title: `Target connection for ${label}`, placeHolder: "Config files in this folder are compared with and applied to this connection" },
    );
    const id = required(pick).id;
    await this.set(folder, id);
    return id;
  }

  /** Live connection for `folder`: stored / active target, else ask; connects when needed. */
  async resolve(folder: string, opts: { pick?: boolean } = {}): Promise<LiveConnection> {
    const id = opts.pick ? await this.pick(folder) : (this.get(folder) ?? (await this.pick(folder)));
    return this.s.manager.get(id) ?? (await connectWithProgress(this.s, id));
  }

  describe(profileId: string | undefined): PlanConnection | undefined {
    if (!profileId) return undefined;
    const p = this.s.store.get(profileId);
    if (!p) return undefined;
    const lc = this.s.manager.get(profileId);
    const st = this.s.manager.stateOf(profileId).state;
    return {
      id: p.id,
      name: p.name,
      env: p.environment,
      readOnly: p.readOnly,
      state: lc ? (st === "reconnecting" ? "reconnecting" : "connected") : st === "connecting" ? "connecting" : st === "error" ? "error" : "disconnected",
      server: lc?.info ? `${lc.info.server_name} · v${lc.info.version}` : undefined,
      url: lc?.nc.getServer(),
    };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export function connectionLabel(lc: { profile: { name: string; environment?: string } }): string {
  return lc.profile.environment === "prod" ? `${lc.profile.name} (PRODUCTION)` : lc.profile.name;
}

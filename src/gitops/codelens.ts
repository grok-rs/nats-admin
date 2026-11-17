// CodeLens on *.stream.json / *.consumer.json / *.kv.json:
//   [sync status] · $(cloud-upload) Apply to <conn> · $(diff) Compare with <conn> · $(plug) <conn>
// The status lens appears only when the target connection is live (no auto-connect) and is
// cached per document version for a few seconds.

import * as vscode from "vscode";
import { basename } from "node:path";
import type { Services } from "../services";
import { errorMessage } from "../core/connectionManager";
import { parseConfigFile } from "./configFiles";
import { configDiff } from "./configDiff";
import { fetchServerConfig } from "./plan";
import { GitOpsTargets } from "./target";

export const SELECT_TARGET_CMD = "nats.gitops.selectTarget";

interface Status {
  title: string;
  tooltip: string;
  at: number;
}

const STATUS_TTL_MS = 10_000;

export class ConfigCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private readonly cache = new Map<string, Status>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly s: Services,
    private readonly targets: GitOpsTargets,
  ) {
    this.disposables.push(
      this._onDidChange,
      targets.onDidChange(() => this.refresh()),
      s.manager.onDidChangeState(() => this.refresh()),
      s.manager.onDidChangeActive(() => this.refresh()),
      s.store.onDidChange(() => this.refresh()),
      vscode.workspace.onDidSaveTextDocument(() => this.refresh(false)),
    );
  }

  /** Re-render lenses; `clear` drops cached sync statuses (after apply / reconnect). */
  refresh(clear = true): void {
    if (clear) this.cache.clear();
    this._onDidChange.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const folder = GitOpsTargets.folderOf(doc.uri);
    const targetId = this.targets.get(folder);
    const profile = targetId ? this.s.store.get(targetId) : undefined;
    const range = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [];
    if (!profile) {
      lenses.push(new vscode.CodeLens(range, { title: "$(plug) Select NATS connection…", tooltip: "Choose the connection these config files are compared with and applied to", command: SELECT_TARGET_CMD, arguments: [doc.uri] }));
      return lenses;
    }
    const prod = profile.environment === "prod";
    const name = prod ? `${profile.name} ⚠ PRODUCTION` : profile.name;
    const lc = this.s.manager.get(profile.id);
    if (lc) {
      const st = this.status(doc, profile.id);
      if (st) lenses.push(new vscode.CodeLens(range, { title: st.title, tooltip: st.tooltip, command: "nats.compareConfigFile", arguments: [doc.uri] }));
    }
    lenses.push(
      new vscode.CodeLens(range, {
        title: `$(cloud-upload) Apply to ${name}`,
        tooltip: profile.readOnly ? `${profile.name} is read-only: applying is blocked` : `Create or update this resource on ${profile.name} (shows the changes first)`,
        command: "nats.applyConfigFile",
        arguments: [doc.uri],
      }),
      new vscode.CodeLens(range, { title: `$(diff) Compare with ${profile.name}`, tooltip: `Diff the server definition on ${profile.name} with this file`, command: "nats.compareConfigFile", arguments: [doc.uri] }),
      new vscode.CodeLens(range, {
        title: `$(plug) ${profile.name}${lc ? "" : " (offline)"}`,
        tooltip: `${this.targets.isExplicit(folder) ? "Target connection for this folder" : "Target: the active connection"} — click to change`,
        command: SELECT_TARGET_CMD,
        arguments: [doc.uri],
      }),
    );
    return lenses;
  }

  private status(doc: vscode.TextDocument, connId: string): Status | undefined {
    const key = `${doc.uri.toString()}|${doc.version}|${connId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit;
    if (!this.inflight.has(key)) {
      const p = this.compute(doc, connId)
        .then((st) => {
          for (const k of this.cache.keys()) if (k.startsWith(`${doc.uri.toString()}|`)) this.cache.delete(k);
          // Fresh from when the answer arrived: a slow server must not loop on an already expired entry.
          this.cache.set(key, { ...st, at: Date.now() });
          this._onDidChange.fire();
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return hit ?? { title: "$(sync~spin) Checking…", tooltip: "Comparing with the server", at: 0 };
  }

  private async compute(doc: vscode.TextDocument, connId: string): Promise<Status> {
    const at = Date.now();
    const parsed = parseConfigFile(basename(doc.uri.fsPath), doc.getText());
    if (!parsed.ok) return { title: "$(error) Invalid config", tooltip: parsed.error, at };
    const lc = this.s.manager.get(connId);
    if (!lc) return { title: "$(debug-disconnect) Offline", tooltip: "Connect to compare", at };
    try {
      const server = await fetchServerConfig(await lc.jsm(), parsed.kind, parsed.name, parsed.stream);
      if (!server) return { title: "$(diff-added) Not on server", tooltip: `${parsed.name} does not exist on ${lc.profile.name} — Apply creates it`, at };
      const changes = configDiff(parsed.kind, parsed.config, server);
      if (!changes.length) return { title: "$(pass) In sync", tooltip: `Matches ${lc.profile.name} (fields omitted from the file are not compared)`, at };
      const blocked = changes.some((c) => c.immutable);
      const paths = changes.map((c) => c.path);
      return {
        title: `${blocked ? "$(lock)" : "$(diff-modified)"} ${changes.length} change${changes.length === 1 ? "" : "s"}${blocked ? " (immutable)" : ""}`,
        tooltip: `Differs from ${lc.profile.name}: ${paths.slice(0, 8).join(", ")}${paths.length > 8 ? "…" : ""}`,
        at,
      };
    } catch (e) {
      return { title: "$(warning) Compare failed", tooltip: errorMessage(e), at };
    }
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

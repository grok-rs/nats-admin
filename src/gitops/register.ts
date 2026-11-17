// Declarative JetStream configuration ("config as code"):
//   nats.exportConfig        server → <folder>/<STREAM>.stream.json, <STREAM>.<CONSUMER>.consumer.json, <BUCKET>.kv.json
//   nats.applyConfigFile     one file → create / update on its target connection (change list first)
//   nats.compareConfigFile   diff editor: server definition ↔ local file
//   nats.planConfigFolder    Plan webview: create / update / unchanged / drift / errors, Apply all
//   nats.kvExport / kvImport bucket keys ↔ JSON file
// CodeLens on config files shows the sync status, Apply / Compare and the target connection
// (remembered per folder; default = the active connection). JSON schemas: schemas/*.schema.json.

import * as vscode from "vscode";
import type { Services } from "../services";
import { safe } from "../core/ui";
import { GitOpsTargets } from "./target";
import { ConfigCodeLensProvider, SELECT_TARGET_CMD } from "./codelens";
import { applyConfigFile, compareConfigFile } from "./fileCommands";
import { exportConfig } from "./exportCommand";
import { kvExport, kvImport } from "./kvTransferCommands";
import { openPlan, resolvePlanFolder } from "./planPanel";

export function registerGitOps(s: Services): void {
  const targets = new GitOpsTargets(s);
  const lenses = new ConfigCodeLensProvider(s, targets);
  const onApplied = () => lenses.refresh();
  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id.replace("nats.", ""), fn)));

  s.context.subscriptions.push(
    targets,
    lenses,
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: "file", pattern: "**/*.stream.json" },
        { scheme: "file", pattern: "**/*.consumer.json" },
        { scheme: "file", pattern: "**/*.kv.json" },
      ],
      lenses,
    ),
  );

  reg("nats.exportConfig", (arg?: unknown, folder?: unknown) => exportConfig(s, targets, arg, folder));
  reg("nats.applyConfigFile", (arg?: unknown) => applyConfigFile(s, targets, arg, onApplied));
  reg("nats.compareConfigFile", (arg?: unknown) => compareConfigFile(s, targets, arg));
  reg("nats.planConfigFolder", async (arg?: unknown) => openPlan({ s, targets, onApplied }, await resolvePlanFolder(arg)));
  reg("nats.kvExport", (arg?: unknown) => kvExport(s, arg));
  reg("nats.kvImport", (arg?: unknown) => kvImport(s, arg));
  // Internal (CodeLens): choose the target connection for a config file's folder.
  reg(SELECT_TARGET_CMD, async (arg?: unknown) => {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri) return;
    await targets.pick(GitOpsTargets.folderOf(uri));
  });
}

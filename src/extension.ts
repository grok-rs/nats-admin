// Extension entry point: wires the connection store/manager, explorer tree,
// virtual documents, status bar, commands and panels together.

import * as vscode from "vscode";
import { ConnectionStore } from "./core/connectionStore";
import { ConnectionManager } from "./core/connectionManager";
import { setLogger } from "./core/log";
import { reportedErrors } from "./core/ui";
import { rpcLog } from "./panels/webviewHost";
import { NatsExplorer } from "./tree/explorer";
import { InfoDocs, INFO_SCHEME } from "./fs/infoDocs";
import { KvFileSystem, KV_SCHEME } from "./fs/kvFs";
import { registerStatusBar } from "./statusBar";
import { registerOpsCommands, registerLocalDetection } from "./commands/opsCommands";
import { registerAutoRefresh } from "./core/autoRefresh";
import { EnvironmentDecorations } from "./tree/envDecorations";
import { registerConnectionCommands } from "./commands/connectionCommands";
import { registerStreamCommands } from "./commands/streamCommands";
import { registerKvCommands } from "./commands/kvCommands";
import { registerObjCommands } from "./commands/objCommands";
import { registerServiceCommands } from "./commands/serviceCommands";
import { registerMessagingCommands } from "./commands/messagingCommands";
import { registerPlaybook } from "./playbook/playbook";
import { registerHealth } from "./health/register";
import { registerInsights } from "./insights/register";
import { registerAdmin } from "./admin/register";
import { registerOverview } from "./overview/register";
import { registerGitOps } from "./gitops/register";
import type { Services } from "./services";

let manager: ConnectionManager | undefined;

export interface ExtensionApi extends Services {
  /** For integration tests only. */
  testing: { reportedErrors: string[]; rpcLog: string[] };
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const channel = vscode.window.createOutputChannel("NATS", { log: true });
  context.subscriptions.push(channel);
  setLogger({
    info: (m) => channel.info(m),
    warn: (m) => channel.warn(m),
    error: (m) => channel.error(m),
    debug: (m) => channel.debug(m),
  });

  const store = new ConnectionStore(context);
  manager = new ConnectionManager(store, context.globalState);
  const explorer = new NatsExplorer(store, manager);
  const infoDocs = new InfoDocs(manager);
  const kvFs = new KvFileSystem(manager);

  const view = vscode.window.createTreeView("nats.explorer", { treeDataProvider: explorer, showCollapseAll: true });
  explorer.view = view;

  context.subscriptions.push(
    store,
    manager,
    explorer,
    view,
    infoDocs,
    kvFs,
    vscode.workspace.registerTextDocumentContentProvider(INFO_SCHEME, infoDocs),
    vscode.workspace.registerFileSystemProvider(KV_SCHEME, kvFs, { isCaseSensitive: true }),
    // Give JSON values JSON highlighting even though keys have no .json extension.
    vscode.workspace.onDidOpenTextDocument((doc) => void autoDetectJson(doc)),
  );

  const envDecorations = new EnvironmentDecorations(store);
  context.subscriptions.push(envDecorations, vscode.window.registerFileDecorationProvider(envDecorations));

  const services: Services = { context, store, manager, explorer, infoDocs, kvFs };
  registerStatusBar(services);
  registerConnectionCommands(services);
  registerOpsCommands(services);
  registerLocalDetection(services);
  registerAutoRefresh(services);
  registerStreamCommands(services);
  registerKvCommands(services);
  registerObjCommands(services);
  registerServiceCommands(services);
  registerMessagingCommands(services);
  registerPlaybook(services);
  registerHealth(services);
  registerInsights(services);
  registerAdmin(services);
  registerOverview(services);
  registerGitOps(services);
  // Auto-connect / restore once all connection sources are loaded.
  void store.ready.then(() => manager!.connectOnStartup());
  return { ...services, testing: { reportedErrors, rpcLog } };
}

async function autoDetectJson(doc: vscode.TextDocument): Promise<void> {
  if (doc.uri.scheme !== KV_SCHEME && doc.uri.scheme !== INFO_SCHEME) return;
  if (doc.languageId !== "plaintext") return;
  const text = doc.getText().trim();
  if (!text || !/^[[{]/.test(text)) return;
  try {
    JSON.parse(text);
    await vscode.languages.setTextDocumentLanguage(doc, "json");
  } catch {
    /* not JSON */
  }
}

export function deactivate(): void {
  manager?.dispose();
}

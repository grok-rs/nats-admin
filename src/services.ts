// The extension's service container, passed to every command / panel module.

import type * as vscode from "vscode";
import type { ConnectionStore } from "./core/connectionStore";
import type { ConnectionManager } from "./core/connectionManager";
import type { NatsExplorer } from "./tree/explorer";
import type { InfoDocs } from "./fs/infoDocs";
import type { KvFileSystem } from "./fs/kvFs";

export interface Services {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  manager: ConnectionManager;
  explorer: NatsExplorer;
  infoDocs: InfoDocs;
  kvFs: KvFileSystem;
}

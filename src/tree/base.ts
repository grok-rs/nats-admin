// Base classes shared by the explorer and feature modules that contribute
// tree nodes (via src/tree/hooks.ts). Kept separate to avoid import cycles.

import * as vscode from "vscode";
import { errorMessage } from "../core/connectionManager";

/** URI scheme used as TreeItem.resourceUri so FileDecorationProviders (e.g. health) can decorate nodes. */
export const NODE_SCHEME = "nats-node";

/** nats-node://<connId>/<path>, e.g. /stream/ORDERS, /consumer/ORDERS/billing, /kv/config, /obj/files, /server */
export function nodeUri(connId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: NODE_SCHEME, authority: connId, path: path.startsWith("/") ? path : `/${path}` });
}

export function md(lines: (string | false | undefined | null)[]): vscode.MarkdownString {
  const m = new vscode.MarkdownString(lines.filter(Boolean).join("  \n"));
  m.supportThemeIcons = true;
  return m;
}

export abstract class NatsNode {
  constructor(
    readonly connId: string,
    readonly parent: NatsNode | undefined,
  ) {}
  abstract getTreeItem(): vscode.TreeItem;
  getChildren(): Promise<NatsNode[]> {
    return Promise.resolve([]);
  }
  /** Drop cached children so the next expansion refetches. */
  invalidate(): void {
    /* default: nothing cached */
  }
}

/** Leaf node used for messages, errors and "load more" hints. */
export class MessageNode extends NatsNode {
  constructor(
    connId: string,
    parent: NatsNode | undefined,
    readonly text: string,
    readonly icon: string = "info",
    readonly command?: vscode.Command,
    readonly tooltip?: string,
  ) {
    super(connId, parent);
  }
  getTreeItem(): vscode.TreeItem {
    const ti = new vscode.TreeItem(this.text, vscode.TreeItemCollapsibleState.None);
    ti.iconPath = new vscode.ThemeIcon(this.icon, this.icon === "error" ? new vscode.ThemeColor("errorForeground") : undefined);
    ti.command = this.command;
    ti.tooltip = this.tooltip ?? this.text;
    ti.contextValue = "message";
    return ti;
  }
}

/** Shared helper: cache an async child list on a node. */
export abstract class CachedNode extends NatsNode {
  private cache?: Promise<NatsNode[]>;
  protected abstract load(): Promise<NatsNode[]>;
  override getChildren(): Promise<NatsNode[]> {
    if (!this.cache) {
      this.cache = this.load().catch((e) => {
        this.cache = undefined;
        return [new MessageNode(this.connId, this, errorMessage(e), "error")];
      });
    }
    return this.cache;
  }
  override invalidate(): void {
    this.cache = undefined;
  }
}


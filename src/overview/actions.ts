// Actions the Overview / Home / Dashboard webviews may trigger on the host. Commands are
// whitelisted (ALLOWED_COMMANDS) so a webview can never run arbitrary VS Code commands, and
// external links are limited to the NATS documentation.

import * as vscode from "vscode";
import type { Services } from "../services";
import { ALLOWED_COMMANDS, isAllowedCommand, isDocsLink } from "./model";

/** Argument for commands that take a tree node: the explorer's ConnectionNode, else { connId }. */
function nodeArg(s: Services, profileId: string): unknown {
  return s.explorer.connectionNode(profileId) ?? { connId: profileId };
}

/**
 * Run a whitelisted command for a profile. The profile becomes the active connection first,
 * so commands that fall back to the active connection target the same one.
 */
export async function runCommand(s: Services, command: unknown, profileId?: unknown): Promise<void> {
  if (!isAllowedCommand(command)) throw new Error(`Command not available from this view: ${String(command)}`);
  const id = typeof profileId === "string" && s.store.get(profileId) ? profileId : undefined;
  const kind = ALLOWED_COMMANDS[command];
  if (kind === "none" || !id) {
    await vscode.commands.executeCommand(command);
    return;
  }
  if (s.manager.get(id) && command !== "nats.disconnect") s.manager.setActive(id);
  await vscode.commands.executeCommand(command, kind === "id" ? id : nodeArg(s, id));
}

/** Focus the Connections view and select (and expand) the connection's node. */
export async function revealInExplorer(s: Services, profileId: string): Promise<void> {
  await vscode.commands.executeCommand("nats.showExplorer");
  let node = s.explorer.connectionNode(profileId);
  if (!node) {
    // The tree may not have been rendered yet: wait for the first getChildren.
    await new Promise((r) => setTimeout(r, 150));
    node = s.explorer.connectionNode(profileId);
  }
  if (!node) throw new Error("Connection is not shown in the explorer (hidden?)");
  await s.explorer.view?.reveal(node, { select: true, focus: true, expand: !!s.manager.get(profileId) });
}

export async function openDocs(url: unknown): Promise<void> {
  if (!isDocsLink(url)) throw new Error("Only NATS documentation links can be opened from this view");
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

export function setActive(s: Services, profileId: unknown): void {
  if (typeof profileId !== "string" || !s.manager.get(profileId)) throw new Error("Connection is not live");
  s.manager.setActive(profileId);
}

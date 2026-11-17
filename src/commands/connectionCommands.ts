// Connection lifecycle commands: add / edit / duplicate / remove / import,
// connect / disconnect, active connection, dashboard, server info, refresh.

import * as vscode from "vscode";
import type { Services } from "../services";
import { ConnectionNode, NatsNode, ServerNode } from "../tree/explorer";
import { CancelledError, confirmDanger, connectWithProgress, pickConnection, required, safe } from "../core/ui";
import { readNatsContexts, natsContextDir } from "../core/natsContexts";
import { openConnectionEditor, uniqueName } from "../panels/connectionEditorPanel";
import { openDashboard } from "../panels/dashboardPanel";
import { WebviewPanelBase } from "../panels/webviewHost";
import { infoUri, INFO_SCHEME } from "../fs/infoDocs";

/** Commands receive a tree node, a profile id string, an object with connId, or nothing. */
export function profileIdOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg instanceof ConnectionNode) return arg.profile.id;
  if (arg instanceof NatsNode) return arg.connId;
  if (arg && typeof arg === "object" && "connId" in arg && typeof (arg as { connId: unknown }).connId === "string") return (arg as { connId: string }).connId;
  return undefined;
}

export function registerConnectionCommands(s: Services): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id.replace("nats.", ""), fn)));

  reg("nats.addConnection", () => openConnectionEditor(s));

  reg("nats.editConnection", (arg?: unknown) => {
    const id = profileIdOf(arg);
    const p = id ? s.store.get(id) : undefined;
    if (!p) throw new Error("Select a connection to edit");
    return openConnectionEditor(s, p);
  });

  reg("nats.duplicateConnection", async (arg?: unknown) => {
    const id = profileIdOf(arg);
    const p = id ? s.store.get(id) : undefined;
    if (!p) return;
    const { id: _old, ...rest } = p;
    const copy = await s.store.save({ ...rest, name: uniqueName(s, `${p.name}-copy`) }, await s.store.getSecrets(p.id));
    await openConnectionEditor(s, copy);
  });

  reg("nats.removeConnection", async (arg?: unknown) => {
    const id = profileIdOf(arg) ?? required(await pickProfile(s, "Remove which connection?"));
    const p = s.store.get(id);
    if (!p) return;
    if (!s.store.isManaged(id)) return vscode.commands.executeCommand("nats.hideConnection", id);
    if (!(await confirmDanger(`Remove connection "${p.name}"?`, "The profile and its stored secrets are deleted. Nothing changes on the server.", "Remove"))) return;
    await s.manager.disconnect(id);
    WebviewPanelBase.disposeWhere((key) => key.includes(`:${id}`));
    await s.store.remove(id);
  });

  reg("nats.importContexts", async () => {
    const contexts = await readNatsContexts();
    if (!contexts.length) {
      void vscode.window.showInformationMessage(`No NATS CLI contexts found in ${natsContextDir()}.`);
      return;
    }
    const existing = new Set(s.store.list().map((p) => p.name.toLowerCase()));
    const picks = await vscode.window.showQuickPick(
      contexts.map((c) => ({
        label: c.name,
        description: c.profile.servers.join(", "),
        detail: `${c.profile.auth.kind}${c.profile.tls?.enabled ? " · TLS" : ""}${existing.has(c.name.toLowerCase()) ? " · already exists (will be updated)" : ""}`,
        picked: !existing.has(c.name.toLowerCase()),
        ctx: c,
      })),
      { canPickMany: true, placeHolder: "Select NATS CLI contexts to import" },
    );
    if (!picks?.length) return;
    for (const { ctx } of picks) {
      const prev = s.store.findByName(ctx.name);
      await s.store.save({ ...ctx.profile, id: prev?.id }, ctx.secrets);
    }
    void vscode.window.showInformationMessage(`Imported ${picks.length} NATS context${picks.length === 1 ? "" : "s"}.`);
  });

  reg("nats.connect", async (arg?: unknown) => {
    let id = profileIdOf(arg);
    if (!id) {
      const offline = s.store.list().filter((p) => !s.manager.get(p.id));
      if (!offline.length) {
        if (!s.store.list().length) return vscode.commands.executeCommand("nats.addConnection");
        void vscode.window.showInformationMessage("All connections are already connected.");
        return;
      }
      id = required(await pickProfile(s, "Connect to…", offline.map((p) => p.id)));
    }
    await connectWithProgress(s, id);
    const node = s.explorer.connectionNode(id);
    if (node && s.explorer.view?.visible) {
      setTimeout(() => {
        const fresh = s.explorer.connectionNode(id!);
        if (fresh) void s.explorer.view?.reveal(fresh, { expand: true, select: false }).then(undefined, () => undefined);
      }, 50);
    }
  });

  reg("nats.disconnect", async (arg?: unknown) => {
    let id = profileIdOf(arg);
    if (!id) {
      const live = s.manager.connected();
      if (!live.length) return;
      id = live.length === 1 ? live[0].id : required(await pickProfile(s, "Disconnect…", live.map((l) => l.id)));
    }
    await s.manager.disconnect(id);
  });

  reg("nats.selectActiveConnection", async () => {
    const id = required(await pickProfile(s, "Select the active NATS connection"));
    if (!s.manager.get(id)) await connectWithProgress(s, id);
    s.manager.setActive(id);
  });

  // Opens the NATS view container and focuses Connections. Uses the container
  // command first: view ".focus" commands only exist once the view registered.
  reg("nats.showExplorer", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.nats");
    try {
      await vscode.commands.executeCommand("nats.explorer.focus");
    } catch {
      /* container is open; focusing the view is best effort */
    }
  });

  reg("nats.refresh", () => s.explorer.refresh());
  reg("nats.refreshNode", (node?: NatsNode) => s.explorer.refresh(node));

  reg("nats.openDashboard", async (arg?: unknown) => {
    const lc = await pickConnection(s, profileIdOf(arg));
    openDashboard(s, lc);
  });

  reg("nats.serverInfo", async (arg?: unknown) => {
    const lc = await pickConnection(s, profileIdOf(arg));
    await s.infoDocs.show(infoUri(lc.id, "/server.json"));
  });

  reg("nats.refreshInfoDoc", () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === INFO_SCHEME) s.infoDocs.refresh(uri);
  });

  reg("nats.copyName", async (node?: NatsNode & { name?: string }) => {
    const name = node && "name" in node ? node.name : undefined;
    if (!name) return;
    await vscode.env.clipboard.writeText(name);
    vscode.window.setStatusBarMessage(`Copied "${name}"`, 2000);
  });

  // Ensure ServerNode clicks resolve (ServerNode extends NatsNode → profileIdOf handles it).
  void ServerNode;
}

async function pickProfile(s: Services, placeHolder: string, ids?: string[]): Promise<string | undefined> {
  const list = s.store.list().filter((p) => !ids || ids.includes(p.id));
  if (!list.length) {
    void vscode.window.showInformationMessage("No NATS connections configured yet.");
    throw new CancelledError();
  }
  const pick = await vscode.window.showQuickPick(
    list.map((p) => ({
      label: `${s.manager.get(p.id) ? "$(circle-filled)" : "$(circle-outline)"} ${p.name}`,
      description: p.servers.join(", "),
      id: p.id,
    })),
    { placeHolder },
  );
  return pick?.id;
}

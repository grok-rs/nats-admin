// Admin features: JetStream topology graph, cluster overview, system-account explorer
// ("Servers" folder) and "who am I". Wired from src/extension.ts.

import * as vscode from "vscode";
import type { Services } from "../services";
import { pickConnection, safe } from "../core/ui";
import { log } from "../core/log";
import { infoUri } from "../fs/infoDocs";
import { NatsNode } from "../tree/base";
import { treeHooks } from "../tree/hooks";
import { ServersFolderNode, SysServerNode } from "../tree/systemNodes";
import { forgetSystemAccess, hasSystemAccess } from "../nats/system";
import { prettyJson } from "../shared/payload";
import { openTopology } from "../panels/topologyPanel";
import { openCluster } from "../panels/clusterPanel";
import { buildServerDetails, buildWhoAmI } from "./docs";

/** Profile id from a tree node, a profile id string or a `{ connId }` object. */
export function connIdOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg instanceof NatsNode) return arg.connId;
  if (arg && typeof arg === "object") {
    const o = arg as { connId?: unknown; profile?: { id?: unknown } };
    if (typeof o.connId === "string") return o.connId;
    if (typeof o.profile?.id === "string") return o.profile.id;
  }
  return undefined;
}

export function registerAdmin(s: Services): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id, fn)));

  reg("nats.openTopology", async (arg?: unknown) => {
    const lc = await pickConnection(s, connIdOf(arg));
    openTopology(s, lc);
  });

  reg("nats.openCluster", async (arg?: unknown) => {
    const lc = await pickConnection(s, connIdOf(arg));
    openCluster(s, lc);
  });

  reg("nats.whoAmI", async (arg?: unknown) => {
    const lc = await pickConnection(s, connIdOf(arg));
    const id = lc.id;
    const uri = infoUri(id, "/sys/whoami.json");
    s.infoDocs.setDynamic(uri, async () => {
      const cur = s.manager.get(id);
      if (!cur) return "// Not connected — reconnect from the NATS explorer and use Refresh.";
      return prettyJson(await buildWhoAmI(cur));
    });
    await s.infoDocs.show(uri, { language: "json", preview: true });
  });

  reg("nats.serverDetails", async (arg?: unknown) => {
    let connId = connIdOf(arg);
    let serverId: string | undefined;
    let serverName: string | undefined;
    if (arg instanceof SysServerNode) {
      serverId = arg.serverId;
      serverName = arg.serverName;
    } else if (arg && typeof arg === "object") {
      const o = arg as { serverId?: unknown; serverName?: unknown };
      if (typeof o.serverId === "string") serverId = o.serverId;
      if (typeof o.serverName === "string") serverName = o.serverName;
    }
    const lc = await pickConnection(s, connId);
    connId = lc.id;
    if (!serverId) serverId = lc.info?.server_id;
    if (!serverId) throw new Error("No server selected");
    const sid = serverId;
    const uri = infoUri(connId, `/sys/server-${sid}.json`);
    const cid = connId;
    s.infoDocs.setDynamic(uri, async () => {
      const cur = s.manager.get(cid);
      if (!cur) return "// Not connected — reconnect from the NATS explorer and use Refresh.";
      return prettyJson(await buildServerDetails(cur.nc, sid));
    });
    log.debug(`server details for ${serverName ?? sid}`);
    await s.infoDocs.show(uri, { language: "json", preview: true });
  });

  // "Servers" folder for connections with system-account access.
  s.context.subscriptions.push(
    treeHooks.registerConnectionChildren(async ({ connId, parent, lc }) => {
      if (!(await hasSystemAccess(lc.nc))) return [];
      return [new ServersFolderNode(connId, parent, lc, (n) => s.explorer.repaint(n))];
    }),
    s.manager.onDidChangeState((e) => {
      if (e.state !== "connected") return;
      const lc = s.manager.get(e.profileId);
      if (lc) forgetSystemAccess(lc.nc);
    }),
  );
}

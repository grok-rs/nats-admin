// Micro-service commands (discovery is done by the explorer's Services folder).

import * as vscode from "vscode";
import type { Services } from "../services";
import { ServiceNode } from "../tree/explorer";
import { pickConnection, safe } from "../core/ui";
import { infoUri } from "../fs/infoDocs";

export function registerServiceCommands(s: Services): void {
  s.context.subscriptions.push(
    vscode.commands.registerCommand(
      "nats.serviceInfo",
      safe("serviceInfo", async (node?: ServiceNode) => {
        if (!(node instanceof ServiceNode)) throw new Error("Select a service in the NATS explorer");
        const lc = await pickConnection(s, node.connId);
        await s.infoDocs.show(infoUri(lc.id, `/service/${node.service.name}.json`));
      }),
    ),
  );
}

// nats.exportConfig: write streams, durable consumers and KV bucket definitions as config files.

import * as vscode from "vscode";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { CancelledError, pickConnection, withProgress } from "../core/ui";
import { log } from "../core/log";
import { collectInventory, exportFiles, type InventoryEntry } from "./export";
import { KIND_LABEL, type ResourceKind } from "./types";
import type { GitOpsTargets } from "./target";

function connIdOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object") {
    const o = arg as { connId?: unknown; profile?: { id?: unknown } };
    if (typeof o.connId === "string") return o.connId;
    if (typeof o.profile?.id === "string") return o.profile.id;
  }
  return undefined;
}

/** Folder-safe connection name. */
export function safeFolderName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "connection";
}

async function chooseFolder(lc: LiveConnection): Promise<vscode.Uri> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const def = ws ? vscode.Uri.joinPath(ws.uri, "nats", safeFolderName(lc.profile.name)) : undefined;
  if (def) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: `$(folder) ${vscode.workspace.asRelativePath(def, true)}`, description: "default", uri: def as vscode.Uri | undefined },
        { label: "$(folder-opened) Choose another folder…", uri: undefined },
      ],
      { title: `Export JetStream config from ${lc.profile.name}`, placeHolder: "Where should the config files go?" },
    );
    if (!pick) throw new CancelledError();
    if (pick.uri) return pick.uri;
  }
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: ws?.uri, openLabel: "Export Here", title: `Export JetStream config from ${lc.profile.name}` });
  if (!picked?.[0]) throw new CancelledError();
  return picked[0];
}

const KIND_ICON: Record<ResourceKind, string> = { stream: "$(database)", consumer: "$(person)", kv: "$(symbol-key)" };

async function chooseResources(lc: LiveConnection, entries: InventoryEntry[]): Promise<InventoryEntry[]> {
  type Item = vscode.QuickPickItem & { entry?: InventoryEntry };
  const items: Item[] = [];
  const groups: [ResourceKind, string][] = [
    ["stream", "Streams"],
    ["consumer", "Consumers (durable)"],
    ["kv", "Key-Value buckets"],
  ];
  for (const [kind, title] of groups) {
    const list = entries.filter((e) => e.kind === kind);
    if (!list.length) continue;
    items.push({ label: `${title} (${list.length})`, kind: vscode.QuickPickItemKind.Separator });
    for (const e of list) items.push({ label: `${KIND_ICON[kind]} ${kind === "consumer" ? `${e.stream} › ${e.name}` : e.name}`, description: e.detail, picked: true, entry: e });
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Export from ${lc.profile.name}: ${entries.length} resources`,
    placeHolder: "Choose what to export (all selected). Type to filter.",
    matchOnDescription: true,
  });
  if (!picked) throw new CancelledError();
  const chosen = picked.map((p) => p.entry).filter((e): e is InventoryEntry => !!e);
  if (!chosen.length) throw new CancelledError();
  return chosen;
}

async function exists(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
}

/** arg: connection tree node / profile id / undefined (picker). `folderArg`: skip the folder prompt. */
export async function exportConfig(s: Services, targets: GitOpsTargets, arg?: unknown, folderArg?: unknown): Promise<void> {
  const lc = await pickConnection(s, connIdOf(arg));
  const jsm = await lc.jsm().catch(() => {
    throw new Error(`JetStream is not enabled on ${lc.profile.name}`);
  });
  const inv = await withProgress(`Reading JetStream resources from ${lc.profile.name}…`, () => collectInventory(jsm));
  if (!inv.entries.length) {
    void vscode.window.showInformationMessage(`${lc.profile.name} has no streams or KV buckets to export.`);
    return;
  }
  const chosen = await chooseResources(lc, inv.entries);
  const folder = folderArg instanceof vscode.Uri ? folderArg : await chooseFolder(lc);
  const files = exportFiles(chosen);

  // Ask once about existing files whose content differs.
  const enc = new TextEncoder();
  const plans = await Promise.all(
    files.map(async (f) => {
      const uri = vscode.Uri.joinPath(folder, f.path);
      const cur = await exists(uri);
      const bytes = enc.encode(f.content);
      const state: "new" | "same" | "differs" = !cur ? "new" : Buffer.from(cur).equals(Buffer.from(bytes)) ? "same" : "differs";
      return { f, uri, bytes, state };
    }),
  );
  const differs = plans.filter((p) => p.state === "differs");
  let overwrite = true;
  if (differs.length) {
    const choice = await vscode.window.showWarningMessage(
      `${differs.length} file${differs.length === 1 ? "" : "s"} in ${vscode.workspace.asRelativePath(folder, false)} already exist${differs.length === 1 ? "s" : ""} with different content.`,
      { modal: true, detail: differs.slice(0, 12).map((p) => p.f.path).join("\n") + (differs.length > 12 ? `\n… and ${differs.length - 12} more` : "") },
      "Overwrite",
      "Keep Existing",
    );
    if (!choice) return;
    overwrite = choice === "Overwrite";
  }
  await vscode.workspace.fs.createDirectory(folder);
  let written = 0;
  let unchanged = 0;
  let kept = 0;
  for (const p of plans) {
    if (p.state === "same") {
      unchanged++;
      continue;
    }
    if (p.state === "differs" && !overwrite) {
      kept++;
      continue;
    }
    await vscode.workspace.fs.writeFile(p.uri, p.bytes);
    written++;
  }
  await targets.set(folder.fsPath, lc.id);

  const count = (k: ResourceKind) => chosen.filter((e) => e.kind === k).length;
  const parts = (["stream", "consumer", "kv"] as const).filter((k) => count(k)).map((k) => `${count(k)} ${KIND_LABEL[k]}${count(k) === 1 ? "" : "s"}`);
  const extra = [unchanged && `${unchanged} unchanged`, kept && `${kept} kept`, inv.objectStores.length && `${inv.objectStores.length} object store${inv.objectStores.length === 1 ? "" : "s"} not exported`, inv.ephemeral && `${inv.ephemeral} ephemeral consumer${inv.ephemeral === 1 ? "" : "s"} skipped`].filter(Boolean);
  log.info(`Exported ${files.length} config files from "${lc.profile.name}" to ${folder.fsPath}`);
  const msg = `Exported ${parts.join(", ")} from ${lc.profile.name} to ${vscode.workspace.asRelativePath(folder, true)}${written !== files.length ? ` (${written} written)` : ""}.${extra.length ? ` ${extra.join(" · ")}.` : ""}`;
  const c = await vscode.window.showInformationMessage(msg, "Reveal", "Plan");
  if (c === "Reveal") {
    const first = plans[0]?.uri;
    if (first && vscode.workspace.getWorkspaceFolder(first)) await vscode.commands.executeCommand("revealInExplorer", first);
    else await vscode.commands.executeCommand("revealFileInOS", first ?? folder);
  } else if (c === "Plan") {
    await vscode.commands.executeCommand("nats.planConfigFolder", folder);
  }
}

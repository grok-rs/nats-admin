// Key-Value commands: buckets (create / delete / status / browser) and keys
// (open / add / delete / purge / history with diff & restore / filter / copy).

import * as vscode from "vscode";
import { StorageType } from "@nats-io/jetstream";
import type { Services } from "../services";
import { KvBucketNode, KvKeyNode } from "../tree/explorer";
import { assertWritable, confirmDanger, pickConnection, pickFrom, required, safe, validateName, withProgress } from "../core/ui";
import { profileIdOf } from "./connectionCommands";
import { history, listBuckets } from "../nats/kv";
import { kvUri } from "../fs/kvFs";
import { infoUri, renderValue } from "../fs/infoDocs";
import { openKvBrowser } from "../panels/kvBrowserPanel";
import { WebviewPanelBase } from "../panels/webviewHost";
import { fmtAgo, fmtBytes, fmtNumber, parseDuration } from "../shared/format";
import { validateKvKey } from "../shared/shape";
import { utf8Encode } from "../shared/encoding";
import type { LiveConnection } from "../core/connectionManager";

export function registerKvCommands(s: Services): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id.replace("nats.", ""), fn)));

  const bucketTarget = async (arg?: unknown): Promise<{ lc: LiveConnection; bucket: string; node?: KvBucketNode }> => {
    if (arg instanceof KvBucketNode) return { lc: await pickConnection(s, arg.connId), bucket: arg.name, node: arg };
    if (arg instanceof KvKeyNode) return { lc: await pickConnection(s, arg.connId), bucket: arg.bucket, node: arg.bucketNode };
    const lc = await pickConnection(s, profileIdOf(arg));
    const buckets = await listBuckets(lc.kvm());
    const b = await pickFrom(buckets, (x) => x.bucket, "Select a KV bucket", (x) => `${fmtNumber(x.values)} values · ${fmtBytes(x.bytes)}`);
    return { lc, bucket: b.bucket };
  };

  const keyTarget = async (arg?: unknown): Promise<{ lc: LiveConnection; bucket: string; key: string; node?: KvKeyNode }> => {
    if (arg instanceof KvKeyNode) return { lc: await pickConnection(s, arg.connId), bucket: arg.bucket, key: arg.key, node: arg };
    throw new Error("Select a key in the NATS explorer");
  };

  const refreshBucket = (connId: string, node?: KvBucketNode) => {
    if (node) s.explorer.refresh(node);
    else s.explorer.refreshFolder(connId, "kv");
  };

  reg("nats.createKvBucket", async (arg?: unknown) => {
    const lc = await pickConnection(s, profileIdOf(arg));
    assertWritable(lc, "creating a KV bucket");
    const name = required(await vscode.window.showInputBox({ title: "Create KV bucket (1/4)", prompt: "Bucket name", placeHolder: "config", validateInput: validateName, ignoreFocusOut: true })).trim();
    const hist = required(
      await vscode.window.showInputBox({
        title: "Create KV bucket (2/4)",
        prompt: "History: revisions kept per key (1–64)",
        value: "5",
        validateInput: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 64 ? undefined : "Enter a number between 1 and 64"),
      }),
    );
    const ttl = required(
      await vscode.window.showInputBox({
        title: "Create KV bucket (3/4)",
        prompt: "Per-key TTL, e.g. 30m, 24h, 7d (leave empty to keep values forever)",
        placeHolder: "forever",
        validateInput: (v) => (v.trim() && parseDuration(v) === undefined ? "Use a duration like 90s, 30m, 24h or 7d" : undefined),
      }),
    );
    const storage = required(
      await vscode.window.showQuickPick(
        [
          { label: "File", description: "persisted to disk", value: StorageType.File },
          { label: "Memory", description: "fast, lost on server restart", value: StorageType.Memory },
        ],
        { title: "Create KV bucket (4/4) — Storage" },
      ),
    ).value;
    await withProgress(`Creating bucket ${name}…`, () =>
      lc.kvm().create(name, { history: Number(hist), ttl: ttl.trim() ? parseDuration(ttl) : 0, storage }),
    );
    s.explorer.refreshFolder(lc.id, "kv");
    const next = await vscode.window.showInformationMessage(`KV bucket "${name}" created.`, "Open KV Browser");
    if (next) await openKvBrowser(s, lc, name);
  });

  reg("nats.deleteKvBucket", async (arg?: unknown) => {
    const { lc, bucket, node } = await bucketTarget(arg);
    const detail = node ? `${fmtNumber(node.bucket.values)} stored values (${fmtBytes(node.bucket.bytes)}) will be permanently deleted.` : "All keys and history will be permanently deleted.";
    if (!(await confirmDanger(`Delete KV bucket "${bucket}"?`, detail, "Delete Bucket", { lc, typeToConfirm: bucket }))) return;
    await (await lc.kvm().open(bucket)).destroy();
    WebviewPanelBase.disposeWhere((k) => k === `kvBrowser:${lc.id}:${bucket}`);
    s.explorer.refreshFolder(lc.id, "kv");
  });

  reg("nats.kvBucketInfo", async (arg?: unknown) => {
    const { lc, bucket } = await bucketTarget(arg);
    await s.infoDocs.show(infoUri(lc.id, `/kv/${bucket}.json`));
  });

  reg("nats.openKvBrowser", async (arg?: unknown) => {
    const { lc, bucket, node } = await bucketTarget(arg);
    const filter = arg instanceof KvKeyNode && arg.isFolder ? `${arg.key}${node?.separator ?? "."}>` : node?.filter;
    await openKvBrowser(s, lc, bucket, { filter, selectKey: arg instanceof KvKeyNode && arg.node.isKey ? arg.key : undefined });
  });

  reg("nats.kvOpenKey", async (arg?: unknown) => {
    const { lc, bucket, key } = await keyTarget(arg);
    const doc = await vscode.workspace.openTextDocument(kvUri(lc.id, bucket, key));
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  reg("nats.kvAddKey", async (arg?: unknown) => {
    const { lc, bucket, node } = await bucketTarget(arg);
    assertWritable(lc, "adding a key");
    const sep = node?.separator ?? ".";
    const prefix = arg instanceof KvKeyNode ? `${arg.key}${sep}` : "";
    const key = required(
      await vscode.window.showInputBox({
        title: `Add key to ${bucket}`,
        prompt: "Key (letters, digits, - / _ = .)",
        value: prefix,
        valueSelection: [prefix.length, prefix.length],
        validateInput: (v) => validateKvKey(v.trim()),
        ignoreFocusOut: true,
      }),
    ).trim();
    const value = required(
      await vscode.window.showInputBox({
        title: `Value for ${key}`,
        prompt: "Initial value (text or JSON). Leave empty to start with an empty value and edit it in the editor.",
        placeHolder: '{"enabled": true}',
        ignoreFocusOut: true,
      }),
    );
    const kv = await lc.kvm().open(bucket);
    try {
      await kv.create(key, utf8Encode(value));
    } catch (e) {
      const exists = await kv.get(key);
      if (exists && exists.operation === "PUT") {
        const open = await vscode.window.showWarningMessage(`Key "${key}" already exists in ${bucket}.`, "Open it");
        if (open) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(kvUri(lc.id, bucket, key)));
        return;
      }
      throw e;
    }
    refreshBucket(lc.id, node);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(kvUri(lc.id, bucket, key)), { preview: false });
  });

  reg("nats.kvDeleteKey", async (arg?: unknown) => {
    const { lc, bucket, key, node } = await keyTarget(arg);
    if (!(await confirmDanger(`Delete key "${key}"?`, `Writes a delete marker in bucket "${bucket}". History is kept until it rolls off.`, "Delete", { lc, typeToConfirm: key }))) return;
    await (await lc.kvm().open(bucket)).delete(key);
    refreshBucket(lc.id, node?.bucketNode);
  });

  reg("nats.kvPurgeKey", async (arg?: unknown) => {
    const { lc, bucket, key, node } = await keyTarget(arg);
    if (!(await confirmDanger(`Purge key "${key}"?`, `Removes the key and all of its revisions from bucket "${bucket}".`, "Purge", { lc, typeToConfirm: key }))) return;
    await (await lc.kvm().open(bucket)).purge(key);
    refreshBucket(lc.id, node?.bucketNode);
  });

  reg("nats.kvKeyHistory", async (arg?: unknown) => {
    const { lc, bucket, key, node } = await keyTarget(arg);
    const kv = await lc.kvm().open(bucket);
    const revs = await history(kv, key);
    if (!revs.length) {
      void vscode.window.showInformationMessage(`No history for "${key}".`);
      return;
    }
    const current = revs.find((r) => r.operation === "PUT")?.revision;
    const pick = required(
      await vscode.window.showQuickPick(
        revs.map((r) => ({
          label: `$(${r.operation === "PUT" ? "git-commit" : "trash"}) rev ${r.revision}${r.revision === current ? " (current)" : ""}`,
          description: `${r.operation} · ${fmtAgo(r.created)} · ${fmtBytes(r.length)}`,
          detail: r.operation === "PUT" ? new TextDecoder().decode(r.value.subarray(0, 200)).replace(/\s+/g, " ") : undefined,
          r,
        })),
        { title: `History of ${key} (${revs.length} revision${revs.length === 1 ? "" : "s"}, bucket keeps ${node?.bucketNode.bucket.history ?? "?"})`, matchOnDetail: true },
      ),
    ).r;
    const revUri = infoUri(lc.id, `/kv-rev/${bucket}/${pick.revision}/${key}`);
    const actions = pick.operation !== "PUT" ? ["Open"] : pick.revision === current ? ["Open"] : ["Compare with current", "Open", "Restore as new revision"];
    const action = actions.length === 1 ? actions[0] : await vscode.window.showQuickPick(actions, { title: `rev ${pick.revision} of ${key}` });
    if (action === "Compare with current") {
      await vscode.commands.executeCommand("vscode.diff", revUri, kvUri(lc.id, bucket, key), `${key}: rev ${pick.revision} ↔ current`);
    } else if (action === "Open") {
      await s.infoDocs.show(revUri);
    } else if (action === "Restore as new revision") {
      assertWritable(lc, "restoring a revision");
      const rev = await kv.put(key, pick.value);
      void vscode.window.showInformationMessage(`Restored rev ${pick.revision} of "${key}" as revision ${rev}.`);
    }
  });

  reg("nats.kvFilterKeys", async (arg?: unknown) => {
    const { node } = await bucketTarget(arg);
    if (!node) return;
    const suggestion = arg instanceof KvKeyNode ? `${arg.key}${node.separator}>` : (node.filter ?? "");
    const f = await vscode.window.showInputBox({
      title: `Filter keys in ${node.name}`,
      prompt: "NATS wildcard filter, e.g. app.> or *.url — leave empty to show all keys",
      value: suggestion,
    });
    if (f === undefined) return;
    node.filter = f.trim() || undefined;
    s.explorer.refresh(node);
    s.explorer.repaint(node);
    if (node.parent) s.explorer.view?.reveal(node, { expand: true }).then(undefined, () => undefined);
  });

  reg("nats.kvCopyKey", async (arg?: unknown) => {
    if (!(arg instanceof KvKeyNode)) return;
    await vscode.env.clipboard.writeText(arg.key);
    vscode.window.setStatusBarMessage(`Copied key "${arg.key}"`, 2000);
  });

  reg("nats.kvCopyValue", async (arg?: unknown) => {
    const { lc, bucket, key } = await keyTarget(arg);
    const e = await (await lc.kvm().open(bucket)).get(key);
    if (!e || e.operation !== "PUT") throw new Error(`"${key}" has no value`);
    await vscode.env.clipboard.writeText(renderValue(e.value));
    vscode.window.setStatusBarMessage(`Copied value of "${key}" (${fmtBytes(e.length)})`, 2000);
  });
}

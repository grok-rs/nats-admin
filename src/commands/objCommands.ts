// Object Store commands: buckets (create / delete / status) and objects
// (upload / download / open / info / delete).

import * as vscode from "vscode";
import { basename, extname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { StorageType } from "@nats-io/jetstream";
import type { Services } from "../services";
import { ObjBucketNode, ObjectNode } from "../tree/explorer";
import { assertWritable, cfg, confirmDanger, pickConnection, pickFrom, required, safe, validateName } from "../core/ui";
import { profileIdOf } from "./connectionCommands";
import { downloadToFile, listObjBuckets, uploadFile } from "../nats/obj";
import { infoUri } from "../fs/infoDocs";
import { fmtBytes, parseDuration } from "../shared/format";
import type { LiveConnection } from "../core/connectionManager";

const VIEWABLE_BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".pdf", ".mp4", ".webm", ".mp3", ".wav"]);

export function registerObjCommands(s: Services): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => s.context.subscriptions.push(vscode.commands.registerCommand(id, safe(id.replace("nats.", ""), fn)));

  const bucketTarget = async (arg?: unknown): Promise<{ lc: LiveConnection; bucket: string; node?: ObjBucketNode }> => {
    if (arg instanceof ObjBucketNode) return { lc: await pickConnection(s, arg.connId), bucket: arg.name, node: arg };
    const lc = await pickConnection(s, profileIdOf(arg));
    const buckets = await listObjBuckets(lc.objm());
    const b = await pickFrom(buckets, (x) => x.bucket, "Select an object store", (x) => fmtBytes(x.size));
    return { lc, bucket: b.bucket };
  };

  const objectTarget = async (arg?: unknown): Promise<{ lc: LiveConnection; node: ObjectNode }> => {
    if (arg instanceof ObjectNode) return { lc: await pickConnection(s, arg.connId), node: arg };
    throw new Error("Select an object in the NATS explorer");
  };

  reg("nats.createObjBucket", async (arg?: unknown) => {
    const lc = await pickConnection(s, profileIdOf(arg));
    assertWritable(lc, "creating an object store");
    const name = required(await vscode.window.showInputBox({ title: "Create object store (1/3)", prompt: "Bucket name", placeHolder: "files", validateInput: validateName, ignoreFocusOut: true })).trim();
    const storage = required(
      await vscode.window.showQuickPick(
        [
          { label: "File", description: "persisted to disk", value: StorageType.File },
          { label: "Memory", description: "fast, lost on server restart", value: StorageType.Memory },
        ],
        { title: "Create object store (2/3) — Storage" },
      ),
    ).value;
    const ttl = required(
      await vscode.window.showInputBox({
        title: "Create object store (3/3)",
        prompt: "Object TTL, e.g. 7d (leave empty to keep objects forever)",
        placeHolder: "forever",
        validateInput: (v) => (v.trim() && parseDuration(v) === undefined ? "Use a duration like 30m, 24h or 7d" : undefined),
      }),
    );
    await lc.objm().create(name, { storage, ttl: ttl.trim() ? Math.round(parseDuration(ttl)! * 1e6) : 0 });
    s.explorer.refreshFolder(lc.id, "obj");
    void vscode.window.showInformationMessage(`Object store "${name}" created.`);
  });

  reg("nats.deleteObjBucket", async (arg?: unknown) => {
    const { lc, bucket, node } = await bucketTarget(arg);
    if (!(await confirmDanger(`Delete object store "${bucket}"?`, `All objects${node ? ` (${fmtBytes(node.status.size)})` : ""} are permanently deleted.`, "Delete Bucket", { lc, typeToConfirm: bucket }))) return;
    await (await lc.objm().open(bucket)).destroy();
    s.explorer.refreshFolder(lc.id, "obj");
  });

  reg("nats.objBucketInfo", async (arg?: unknown) => {
    const { lc, bucket } = await bucketTarget(arg);
    await s.infoDocs.show(infoUri(lc.id, `/obj/${bucket}.json`));
  });

  reg("nats.objUpload", async (arg?: unknown) => {
    const { lc, bucket, node } = await bucketTarget(arg);
    assertWritable(lc, "uploading");
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: `Upload to ${bucket}`, title: `Upload files to object store "${bucket}"` });
    if (!files?.length) return;
    let prefix = "";
    if (files.length === 1) {
      const name = required(await vscode.window.showInputBox({ prompt: "Object name", value: basename(files[0].fsPath), validateInput: (v) => (v.trim() ? undefined : "Name is required") }));
      prefix = name.trim();
    } else {
      prefix = required(await vscode.window.showInputBox({ prompt: `Optional name prefix for ${files.length} objects (e.g. "docs/")`, value: "" }));
    }
    const os = await lc.objm().open(bucket);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading to ${bucket}`, cancellable: false }, async (progress) => {
      for (const [i, f] of files.entries()) {
        const name = files.length === 1 ? prefix : `${prefix}${basename(f.fsPath)}`;
        progress.report({ message: `${name} (${i + 1}/${files.length})`, increment: 100 / files.length });
        await uploadFile(os, name, f.fsPath);
      }
    });
    if (node) s.explorer.refresh(node);
    else s.explorer.refreshFolder(lc.id, "obj");
    void vscode.window.showInformationMessage(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"} to ${bucket}.`);
  });

  reg("nats.objDownload", async (arg?: unknown) => {
    const { lc, node } = await objectTarget(arg);
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(basename(node.name)), title: `Download ${node.name}` });
    if (!target) return;
    const os = await lc.objm().open(node.bucket);
    const bytes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${node.name}`, cancellable: false }, async (progress) => {
      let last = 0;
      return downloadToFile(os, node.name, target.fsPath, (done, total) => {
        const pct = total ? Math.floor((done / total) * 100) : 0;
        if (pct > last) {
          progress.report({ increment: pct - last, message: `${fmtBytes(done)} / ${fmtBytes(total)}` });
          last = pct;
        }
      });
    });
    const open = await vscode.window.showInformationMessage(`Downloaded ${node.name} (${fmtBytes(bytes)}).`, "Open", "Reveal");
    if (open === "Open") await vscode.commands.executeCommand("vscode.open", target);
    if (open === "Reveal") await vscode.commands.executeCommand("revealFileInOS", target);
  });

  reg("nats.objOpen", async (arg?: unknown) => {
    const { lc, node } = await objectTarget(arg);
    const max = cfg("objectStore.maxPreviewBytes", 5 * 1024 * 1024);
    if (node.info.size > max) {
      const dl = await vscode.window.showWarningMessage(`${node.name} is ${fmtBytes(node.info.size)} — larger than the preview limit (${fmtBytes(max)}).`, "Download…");
      if (dl) await vscode.commands.executeCommand("nats.objDownload", node);
      return;
    }
    const ext = extname(node.name).toLowerCase();
    if (VIEWABLE_BINARY.has(ext)) {
      // Images, PDFs and media open in VS Code's own viewers via a temp copy.
      const dir = join(tmpdir(), "nats-admin-objects", node.bucket);
      await mkdir(dir, { recursive: true });
      const file = join(dir, node.name.replace(/[\\/]/g, "_"));
      await downloadToFile(await lc.objm().open(node.bucket), node.name, file);
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { preview: true });
      return;
    }
    await s.infoDocs.show(infoUri(lc.id, `/object/${node.bucket}/${node.name}`));
  });

  reg("nats.objInfo", async (arg?: unknown) => {
    const { lc, node } = await objectTarget(arg);
    await s.infoDocs.show(infoUri(lc.id, `/object-info/${node.bucket}/${node.name}.json`));
  });

  reg("nats.objDelete", async (arg?: unknown) => {
    const { lc, node } = await objectTarget(arg);
    if (!(await confirmDanger(`Delete object "${node.name}"?`, `From object store "${node.bucket}" (${fmtBytes(node.info.size)}).`, "Delete", { lc, typeToConfirm: node.name }))) return;
    await (await lc.objm().open(node.bucket)).delete(node.name);
    if (node.parent) s.explorer.refresh(node.parent);
  });
}

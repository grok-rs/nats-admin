// nats.kvExport / nats.kvImport: a bucket's keys as a JSON file (see kvTransfer.ts for the format).

import * as vscode from "vscode";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { openKvBrowser } from "../panels/kvBrowserPanel";
import { assertWritable, cfg, confirmDanger, isProduction, pickConnection, pickFrom, withProgress } from "../core/ui";
import { log } from "../core/log";
import { fmtBytes } from "../shared/format";
import { buildKvExport, existingKeys, importRecords, parseKvImport, readAllEntries } from "./kvTransfer";

/** KvBucketNode (.connId, .name), { connId, bucket } or nothing (pickers). */
async function resolveBucket(s: Services, arg: unknown): Promise<{ lc: LiveConnection; bucket: string }> {
  const o = (arg ?? {}) as { connId?: unknown; name?: unknown; bucket?: unknown };
  const connId = typeof o.connId === "string" ? o.connId : undefined;
  const lc = await pickConnection(s, connId);
  let bucket = typeof o.name === "string" ? o.name : typeof o.bucket === "string" ? o.bucket : undefined;
  if (!bucket) {
    const names: string[] = [];
    for await (const st of lc.kvm().list()) names.push(st.bucket);
    bucket = await pickFrom(names.sort(), (n) => n, "Select a KV bucket");
  }
  return { lc, bucket };
}

function defaultDir(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export async function kvExport(s: Services, arg: unknown): Promise<void> {
  const { lc, bucket } = await resolveBucket(s, arg);
  const kv = await lc.kvm().open(bucket);
  const max = cfg("kv.maxKeys", 5000) * 20;
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading ${bucket}…`, cancellable: true }, (progress, token) =>
    readAllEntries(kv, { max, token, onProgress: (n) => progress.report({ message: `${n} keys` }) }),
  );
  if (result.cancelled) return;
  if (!result.records.length) {
    void vscode.window.showInformationMessage(`Bucket "${bucket}" has no keys to export.`);
    return;
  }
  const dir = defaultDir();
  const target = await vscode.window.showSaveDialog({
    defaultUri: dir ? vscode.Uri.joinPath(dir, `${bucket}.json`) : vscode.Uri.file(`${bucket}.json`),
    filters: { JSON: ["json"] },
    title: `Export ${result.records.length} keys from ${bucket}`,
    saveLabel: "Export",
  });
  if (!target) return;
  if (/\.kv\.json$/i.test(target.path)) {
    const c = await vscode.window.showWarningMessage(`"*.kv.json" files are bucket definitions (config as code), not key exports. Save the keys under that name anyway?`, { modal: true }, "Save Anyway");
    if (!c) return;
  }
  const content = JSON.stringify(buildKvExport(result.records), null, 2) + "\n";
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
  const bytes = result.records.reduce((n, r) => n + r.value.length, 0);
  log.info(`Exported ${result.records.length} keys from KV "${bucket}" on "${lc.profile.name}" to ${target.fsPath}`);
  const c = await vscode.window.showInformationMessage(
    `Exported ${result.records.length} keys (${fmtBytes(bytes)} of values) from ${bucket}${result.truncated ? ` — stopped at ${max} keys` : ""}.`,
    "Open File",
  );
  if (c) await vscode.window.showTextDocument(target);
}

export async function kvImport(s: Services, arg: unknown): Promise<void> {
  const { lc, bucket } = await resolveBucket(s, arg);
  assertWritable(lc, "importing keys");
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ["json"] }, defaultUri: defaultDir(), openLabel: "Import", title: `Import keys into ${bucket}` });
  const file = picked?.[0];
  if (!file) return;
  if (/\.kv\.json$/i.test(file.path)) {
    const c = await vscode.window.showWarningMessage(
      `${vscode.workspace.asRelativePath(file)} looks like a bucket definition (config as code), not a key export.`,
      { modal: true, detail: "Importing it writes its fields (bucket, history, ttl…) as keys. Use Apply Config to Server for bucket definitions." },
      "Import as Keys Anyway",
    );
    if (!c) return;
  }
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
  const parsed = parseKvImport(text);
  if (!parsed.records.length) {
    void vscode.window.showWarningMessage(`No importable keys in ${vscode.workspace.asRelativePath(file)}${parsed.invalid.length ? ` (${parsed.invalid.length} invalid)` : ""}.`);
    return;
  }
  const kv = await lc.kvm().open(bucket);
  const existing = await withProgress(`Checking existing keys in ${bucket}…`, () => existingKeys(kv));
  const overlap = parsed.records.filter((r) => existing.has(r.key)).length;
  const fresh = parsed.records.length - overlap;
  const bytes = parsed.records.reduce((n, r) => n + r.value.length, 0);
  const detail = [
    `${parsed.records.length} keys (${fmtBytes(bytes)}) from ${vscode.workspace.asRelativePath(file)}`,
    `${fresh} new · ${overlap} already exist in ${bucket}`,
    parsed.invalid.length ? `${parsed.invalid.length} skipped: ${parsed.invalid.slice(0, 3).join("; ")}${parsed.invalid.length > 3 ? "…" : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let skipExisting = true;
  const title = `Import ${parsed.records.length} keys into ${bucket} on ${lc.profile.name}?`;
  if (overlap > 0) {
    const overwriteLabel = `Overwrite ${overlap} Existing`;
    const skipLabel = fresh ? `Import ${fresh} New Only` : undefined;
    const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, ...[overwriteLabel, skipLabel].filter((x): x is string => !!x));
    if (!choice) return;
    skipExisting = choice !== overwriteLabel;
    if (!skipExisting && !(await confirmDanger(`Overwrite ${overlap} keys in "${bucket}"?`, "Existing values get a new revision (history keeps the old ones).", "Overwrite", { lc, typeToConfirm: bucket }))) return;
  } else if (isProduction(lc)) {
    if (!(await confirmDanger(title, detail.replace(/\n/g, ". "), "Import", { lc, typeToConfirm: bucket }))) return;
  } else {
    const ok = await vscode.window.showInformationMessage(title, { modal: true, detail }, "Import");
    if (!ok) return;
  }

  const t0 = Date.now();
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing into ${bucket}`, cancellable: true }, (progress, token) => {
    let last = 0;
    return importRecords(kv, parsed.records, {
      skipExisting,
      isCancelled: () => token.isCancellationRequested,
      onProgress: (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct > last || done === total) {
          progress.report({ increment: pct - last, message: `${done} / ${total}` });
          last = pct;
        }
      },
    });
  });
  s.explorer.refreshFolder(lc.id, "kv");
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log.info(`KV import into "${bucket}" on "${lc.profile.name}": ${res.written} written, ${res.skipped} skipped, ${res.failed.length} failed`);
  for (const f of res.failed.slice(0, 20)) log.warn(`KV import ${bucket}/${f.key}: ${f.error}`);
  const summary = `Imported ${res.written} keys into ${bucket} in ${secs}s${res.skipped ? `, skipped ${res.skipped} existing` : ""}${res.failed.length ? `, ${res.failed.length} failed (see the NATS output)` : ""}.`;
  const fn = res.failed.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  const c = await fn(summary, "Open KV Browser");
  if (c) {
    const live = s.manager.get(lc.id);
    if (live) await openKvBrowser(s, live, bucket);
  }
}

// nats.applyConfigFile / nats.compareConfigFile: one config file against its target connection.

import * as vscode from "vscode";
import { basename } from "node:path";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { assertWritable, CancelledError, confirmDanger, isProduction, withProgress } from "../core/ui";
import { log } from "../core/log";
import { consumerConfigUri, streamConfigUri } from "../fs/configFs";
import { infoUri } from "../fs/infoDocs";
import { CONFIG_FILE_RE, CONFIG_GLOB, classifyFileName, kvFileObject, parseConfigFile, toFileContent, type ParsedOk } from "./configFiles";
import { blockedReason, configDiff } from "./configDiff";
import { fetchServerConfig } from "./plan";
import { applyResource } from "./apply";
import { describeChange } from "./valueFormat";
import { GitOpsTargets, connectionLabel } from "./target";
import { KIND_LABEL } from "./types";

/** URI from a command argument (explorer / editor title / CodeLens), the active editor, or a picker. */
export async function resolveConfigUri(arg: unknown): Promise<vscode.Uri> {
  if (arg instanceof vscode.Uri) return arg;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && CONFIG_FILE_RE.test(active.path)) return active;
  const files = await vscode.workspace.findFiles(CONFIG_GLOB, "**/node_modules/**", 1000);
  if (!files.length) {
    void vscode.window.showInformationMessage("No *.stream.json, *.consumer.json or *.kv.json files in the workspace. Export them from a connection first.", "Export Config…").then((c) => {
      if (c) void vscode.commands.executeCommand("nats.exportConfig");
    });
    throw new CancelledError();
  }
  const pick = await vscode.window.showQuickPick(
    files
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((u) => ({ label: basename(u.fsPath), description: vscode.workspace.asRelativePath(u, false), uri: u })),
    { placeHolder: "Select a config file" },
  );
  if (!pick) throw new CancelledError();
  return pick.uri;
}

/** Text of the file, including unsaved editor changes. */
export async function readConfigText(uri: vscode.Uri): Promise<{ text: string; dirty: boolean }> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return { text: doc.getText(), dirty: doc.isDirty };
}

async function parseOrThrow(uri: vscode.Uri): Promise<{ parsed: ParsedOk; dirty: boolean }> {
  const { text, dirty } = await readConfigText(uri);
  const parsed = parseConfigFile(basename(uri.fsPath), text);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`${basename(uri.fsPath)}: ${parsed.error}`, "Open File").then((c) => {
      if (c) void vscode.window.showTextDocument(uri);
    });
    throw new CancelledError();
  }
  return { parsed, dirty };
}

function label(p: { kind: "stream" | "consumer" | "kv"; name: string; stream?: string }): string {
  return p.kind === "consumer" ? `consumer "${p.stream} › ${p.name}"` : `${KIND_LABEL[p.kind]} "${p.name}"`;
}

/** Refresh the explorer folder that shows the resource. */
export function refreshExplorer(s: Services, connId: string, kinds: Iterable<"stream" | "consumer" | "kv">): void {
  const set = new Set(kinds);
  if (set.has("stream") || set.has("consumer")) s.explorer.refreshFolder(connId, "streams");
  if (set.has("kv")) s.explorer.refreshFolder(connId, "kv");
}

export async function applyConfigFile(s: Services, targets: GitOpsTargets, arg: unknown, onApplied?: () => void): Promise<void> {
  const uri = await resolveConfigUri(arg);
  const { parsed, dirty } = await parseOrThrow(uri);
  const folder = GitOpsTargets.folderOf(uri);
  const lc = await targets.resolve(folder);
  const conn = connectionLabel(lc);
  const jsm = await lc.jsm();
  const server = await fetchServerConfig(jsm, parsed.kind, parsed.name, parsed.stream);
  const what = label(parsed);

  if (parsed.kind === "consumer" && !server) {
    const stream = await fetchServerConfig(jsm, "stream", parsed.stream!);
    if (!stream) {
      void vscode.window.showErrorMessage(`Stream "${parsed.stream}" does not exist on ${conn}. Apply ${parsed.stream}.stream.json first (or plan the whole folder).`, "Plan Folder").then((c) => {
        if (c) void vscode.commands.executeCommand("nats.planConfigFolder", vscode.Uri.file(folder));
      });
      return;
    }
  }

  const changes = server ? configDiff(parsed.kind, parsed.config, server) : [];
  if (server && !changes.length) {
    void vscode.window.showInformationMessage(`${what} on ${conn} already matches ${basename(uri.fsPath)}.`);
    return;
  }
  assertWritable(lc, `applying ${KIND_LABEL[parsed.kind]} config`);

  const blocked = blockedReason(changes);
  if (blocked) {
    const detail = changes
      .filter((c) => c.immutable)
      .map(describeChange)
      .join("\n");
    const c = await vscode.window.showWarningMessage(`Cannot update ${what} on ${conn}: ${blocked}.`, { modal: true, detail }, "Compare with Server");
    if (c) await compareConfigFile(s, targets, uri);
    return;
  }

  const lines = server ? changes.map(describeChange) : [`+ create from ${basename(uri.fsPath)}`, ...parsed.warnings.map((w) => `⚠ ${w}`)];
  const shown = lines.slice(0, 20);
  if (lines.length > shown.length) shown.push(`… and ${lines.length - shown.length} more`);
  const risks = changes.filter((c) => c.risk).length;
  const verb = server ? "Update" : "Create";
  const headline = `${verb} ${what} on ${conn}?`;
  const detail = `${server ? `${changes.length} change${changes.length === 1 ? "" : "s"}` : "New resource"}${dirty ? " (from unsaved editor content)" : ""}:\n${shown.join("\n")}`;

  let ok: boolean;
  if (isProduction(lc)) {
    const short = server ? `${changes.length} change(s): ${changes.map((c) => c.path).slice(0, 6).join(", ")}${changes.length > 6 ? "…" : ""}.` : "Creates a new resource.";
    ok = await confirmDanger(headline, short, verb, { lc, typeToConfirm: parsed.name });
  } else {
    const fn = risks ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    ok = (await fn(headline, { modal: true, detail }, verb)) === verb;
  }
  if (!ok) return;

  const outcome = await withProgress(`${verb === "Create" ? "Creating" : "Updating"} ${what} on ${lc.profile.name}…`, () => applyResource({ jsm, kvm: lc.kvm() }, parsed));
  log.info(`Config apply: ${what} ${outcome} on "${lc.profile.name}" from ${uri.fsPath}`);
  refreshExplorer(s, lc.id, [parsed.kind]);
  onApplied?.();
  const msg = outcome === "unchanged" ? `${what} on ${conn} already matched.` : `${outcome === "created" ? "Created" : "Updated"} ${what} on ${conn}${server ? ` (${changes.length} change${changes.length === 1 ? "" : "s"})` : ""}.`;
  const c = await vscode.window.showInformationMessage(msg, "Compare with Server");
  if (c) await compareConfigFile(s, targets, uri);
}

export async function compareConfigFile(s: Services, targets: GitOpsTargets, arg: unknown): Promise<void> {
  const uri = await resolveConfigUri(arg);
  const cls = classifyFileName(basename(uri.fsPath));
  if (!cls || !cls.ok) {
    void vscode.window.showErrorMessage(cls && !cls.ok ? cls.error : "Not a config file");
    return;
  }
  const lc = await targets.resolve(GitOpsTargets.folderOf(uri));
  await compareWith(s, lc, uri, cls.kind, cls.name, cls.stream);
}

/** Diff editor: server definition (left) ↔ local file (right). */
export async function compareWith(s: Services, lc: LiveConnection, uri: vscode.Uri, kind: "stream" | "consumer" | "kv", name: string, stream?: string): Promise<void> {
  const jsm = await lc.jsm();
  const server = await fetchServerConfig(jsm, kind, name, stream);
  const what = label({ kind, name, stream });
  if (!server) {
    const c = await vscode.window.showInformationMessage(`${what} does not exist on ${connectionLabel(lc)} yet.`, "Apply to Create");
    if (c) await vscode.commands.executeCommand("nats.applyConfigFile", uri);
    return;
  }
  let left: vscode.Uri;
  if (kind === "kv") {
    left = infoUri(lc.id, `/gitops/${name}.kv.json`);
    s.infoDocs.setDynamic(left, async () => {
      const live = s.manager.get(lc.id);
      if (!live) return "// Not connected";
      const si = await (await live.jsm()).streams.info(`KV_${name}`);
      return toFileContent(kvFileObject(si.config as unknown as Record<string, unknown>));
    });
  } else {
    left = kind === "stream" ? streamConfigUri(lc.id, name) : consumerConfigUri(lc.id, stream!, name);
  }
  await vscode.commands.executeCommand("vscode.diff", left, uri, `${basename(uri.fsPath)} (${lc.profile.name} ↔ local)`, { preview: true });
}

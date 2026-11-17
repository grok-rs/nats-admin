// Plan webview host (script "plan"): terraform-style plan of a config folder against a
// connection, with Apply all / per-item apply, live progress and drift adoption.

import * as vscode from "vscode";
import { basename, dirname, join, sep } from "node:path";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { assertWritable, CancelledError, confirmDanger, connectWithProgress, isProduction } from "../core/ui";
import { log } from "../core/log";
import { infoUri } from "../fs/infoDocs";
import { WebviewPanelBase } from "../panels/webviewHost";
import { CONFIG_FILE_RE, CONFIG_GLOB, KIND_ORDER, exportConsumerConfig, exportKvDefinition, exportStreamConfig, fileNameFor, type ParsedOk } from "./configFiles";
import { computePlan, consumerStreamsOf, countActions, fetchServerState, findConfigSubfolders, isJetStreamUnavailable, parseFolderFiles, readConfigFolder, type ServerState } from "./plan";
import type { JetStreamManager } from "@nats-io/jetstream";
import { applyResource } from "./apply";
import { compareWith, refreshExplorer } from "./fileCommands";
import { GitOpsTargets, connectionLabel } from "./target";
import type { ApplyProgress, ApplySummary, PlanInit, PlanItem, PlanResult } from "./types";

export interface PlanDeps {
  s: Services;
  targets: GitOpsTargets;
  onApplied?: () => void;
}

class PlanPanel extends WebviewPanelBase {
  private parsed = new Map<string, ParsedOk>();
  private items = new Map<string, PlanItem>();
  private state?: ServerState;
  private applying = false;
  private planSeq = 0;
  private suppressWatchUntil = 0;
  private changeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly deps: PlanDeps,
    private readonly folder: vscode.Uri,
    private profileId: string | undefined,
    key: string,
    init: PlanInit,
  ) {
    super(deps.s.context, { viewType: "nats.configPlan", key, title: `Plan: ${basename(folder.fsPath)}`, script: "plan", init });
    const s = deps.s;
    // The plan covers the folder's own files only (subfolders are planned separately).
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "*.{stream,consumer,kv}.json"));
    const changed = () => this.filesChanged();
    this.disposables.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && this.isPlanned(e.document.uri)) changed();
      }),
      s.manager.onDidChangeState((e) => {
        if (e.profileId === this.profileId) this.post("connection", this.describe());
      }),
      s.store.onDidChange(() => this.post("connection", this.describe())),
      { dispose: () => this.changeTimer && clearTimeout(this.changeTimer) },
    );
  }

  private filesChanged(): void {
    if (Date.now() < this.suppressWatchUntil || this.applying) return;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.post("filesChanged", { at: Date.now() }), 400);
  }

  replan(): void {
    this.post("replan");
  }

  private describe() {
    return this.deps.targets.describe(this.profileId);
  }

  private live(): LiveConnection {
    const lc = this.profileId ? this.deps.s.manager.get(this.profileId) : undefined;
    if (!lc) throw new Error("Not connected — connect to compute the plan");
    return lc;
  }

  /** A config file directly in the planned folder (file scheme). */
  private isPlanned(uri: vscode.Uri): boolean {
    return uri.scheme === "file" && CONFIG_FILE_RE.test(uri.path) && dirname(uri.fsPath) === this.folder.fsPath;
  }

  private abs(file: string): vscode.Uri {
    return vscode.Uri.file(join(this.folder.fsPath, file));
  }

  private async computePlan(): Promise<PlanResult> {
    const t0 = Date.now();
    const seq = ++this.planSeq;
    const lc = this.live();
    const overrides = new Map<string, string>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && this.isPlanned(doc.uri)) overrides.set(doc.uri.fsPath, doc.getText());
    }
    const files = await readConfigFolder(this.folder.fsPath, overrides);
    const subfolders = await findConfigSubfolders(this.folder.fsPath);
    const parsed = parseFolderFiles(files);
    // Only "JetStream is off" turns into per-file errors; timeouts / permission errors fail the plan.
    let jsm: JetStreamManager | undefined;
    try {
      jsm = await lc.jsm();
    } catch (e) {
      if (!isJetStreamUnavailable(e)) throw e;
    }
    const jetstream = !!jsm;
    const state: ServerState = jsm ? await fetchServerState(jsm, consumerStreamsOf(parsed)) : { jetstream: false, streams: new Map(), consumers: new Map(), kv: new Map() };
    const { items, scope } = computePlan(parsed, state);
    // Overlapping plans: only the latest one becomes what Apply / Add to folder act on (the webview shows the latest too).
    if (seq === this.planSeq) {
      this.parsed = new Map(parsed.filter((p): p is ParsedOk => p.ok).map((p) => [p.id, p]));
      this.items = new Map(items.map((i) => [i.id, i]));
      this.state = state;
    }
    return {
      folder: this.folder.fsPath,
      folderLabel: vscode.workspace.asRelativePath(this.folder, true),
      connection: this.describe()!,
      generatedAt: Date.now(),
      durationMs: Date.now() - t0,
      files: files.length,
      subfolders,
      scope,
      items,
      counts: countActions(items),
      jetstream,
    };
  }

  private async apply(ids: string[]): Promise<ApplySummary> {
    // Claimed before the confirmation prompt so a second request can't start a parallel run.
    if (this.applying) throw new Error("An apply is already running");
    this.applying = true;
    try {
      return await this.applyNow(ids);
    } finally {
      this.applying = false;
    }
  }

  private async applyNow(ids: string[]): Promise<ApplySummary> {
    const lc = this.live();
    // The plan that was reviewed (a re-plan finishing meanwhile must not change what runs).
    const items = this.items;
    const parsed = this.parsed;
    assertWritable(lc, "applying config");
    const t0 = Date.now();
    const results = new Map<string, ApplyProgress>();
    // A consumer on a stream that is being created pulls the stream in.
    const expanded = new Set(ids);
    for (const id of ids) {
      const dep = items.get(id)?.dependsOn;
      if (dep && items.get(dep)?.action === "create") expanded.add(dep);
    }
    const wanted = [...expanded]
      .map((id) => items.get(id))
      .filter((i): i is PlanItem => !!i && (i.action === "create" || i.action === "update"))
      .sort((a, b) => KIND_ORDER[a.kind!] - KIND_ORDER[b.kind!]);
    const runnable = wanted.filter((i) => !i.blocked && parsed.has(i.id));
    for (const i of wanted) if (i.blocked) results.set(i.id, { id: i.id, state: "skipped", message: `Blocked: ${i.blocked}` });
    if (!runnable.length) return { applied: 0, failed: 0, skipped: results.size, durationMs: 0, results: [...results.values()] };

    // Confirmation
    const conn = connectionLabel(lc);
    const risky = runnable.flatMap((i) => i.changes.filter((c) => c.risk).map((c) => `⚠ ${i.name}: ${c.path} — ${c.risk}`));
    let ok = true;
    if (runnable.length > 1) {
      const creates = runnable.filter((i) => i.action === "create").length;
      const updates = runnable.length - creates;
      const detail = [`${creates} to create, ${updates} to update${results.size ? `, ${results.size} blocked (skipped)` : ""}.`, ...risky.slice(0, 10)].join("\n");
      ok = await confirmDanger(`Apply ${runnable.length} change${runnable.length === 1 ? "" : "s"} to ${conn}?`, detail, "Apply", { lc, typeToConfirm: isProduction(lc) ? lc.profile.name : undefined });
    } else {
      const i = runnable[0];
      const verb = i.action === "create" ? "Create" : "Update";
      const what = i.kind === "consumer" ? `consumer ${i.stream} › ${i.name}` : `${i.kind} ${i.name}`;
      if (isProduction(lc)) ok = await confirmDanger(`${verb} ${what} on ${conn}?`, i.action === "update" ? `${i.changes.length} change(s): ${i.changes.map((c) => c.path).join(", ")}.` : "Creates a new resource.", verb, { lc, typeToConfirm: i.name });
      else if (risky.length) ok = await confirmDanger(`${verb} ${what} on ${conn}?`, risky.join("\n"), verb, { lc });
    }
    if (!ok) return { cancelled: true, applied: 0, failed: 0, skipped: 0, durationMs: 0, results: [] };

    const kinds = new Set<"stream" | "consumer" | "kv">();
    try {
      for (const i of runnable) this.post("progress", { id: i.id, state: "pending" } satisfies ApplyProgress);
      const jsm = await lc.jsm();
      const kvm = lc.kvm();
      for (const i of runnable) {
        const depInRun = !!i.dependsOn && runnable.some((r) => r.id === i.dependsOn);
        if (depInRun && results.get(i.dependsOn!)?.state !== "done") {
          const r: ApplyProgress = { id: i.id, state: "skipped", message: `Stream ${i.stream} was not created` };
          results.set(i.id, r);
          this.post("progress", r);
          continue;
        }
        this.post("progress", { id: i.id, state: "running" } satisfies ApplyProgress);
        let r: ApplyProgress;
        try {
          const outcome = await applyResource({ jsm, kvm }, parsed.get(i.id)!);
          r = { id: i.id, state: "done", message: outcome };
          kinds.add(i.kind!);
          log.info(`Config plan apply: ${i.id} ${outcome} on "${lc.profile.name}"`);
        } catch (e) {
          r = { id: i.id, state: "failed", message: e instanceof Error ? e.message : String(e) };
          log.error(`Config plan apply: ${i.id} failed on "${lc.profile.name}": ${r.message}`);
        }
        results.set(i.id, r);
        this.post("progress", r);
      }
    } finally {
      refreshExplorer(this.deps.s, lc.id, kinds);
      this.deps.onApplied?.();
    }
    const all = [...results.values()];
    return {
      applied: all.filter((r) => r.state === "done").length,
      failed: all.filter((r) => r.state === "failed").length,
      skipped: all.filter((r) => r.state === "skipped").length,
      durationMs: Date.now() - t0,
      results: all,
    };
  }

  /** Write drift items (server-only resources) into the folder as config files. */
  private async adopt(ids: string[]): Promise<string[]> {
    const written: string[] = [];
    this.suppressWatchUntil = Date.now() + 2000;
    for (const id of ids) {
      const i = this.items.get(id);
      if (!i || i.action !== "drift" || !i.kind || !this.state) continue;
      let content: string | undefined;
      if (i.kind === "stream") {
        const cfg = this.state.streams.get(i.name);
        if (cfg) content = exportStreamConfig(cfg);
      } else if (i.kind === "consumer") {
        const cfg = this.state.consumers.get(i.stream!)?.get(i.name);
        if (cfg) content = exportConsumerConfig(cfg);
      } else {
        const cfg = this.state.streams.get(`KV_${i.name}`);
        if (cfg) content = exportKvDefinition(cfg);
      }
      if (!content) continue;
      const file = fileNameFor(i.kind, i.name, i.stream);
      const uri = this.abs(file);
      try {
        await vscode.workspace.fs.stat(uri);
        throw new Error(`${file} already exists in the folder`);
      } catch (e) {
        if (!(e instanceof vscode.FileSystemError)) throw e;
      }
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      written.push(file);
    }
    return written;
  }

  protected handlers() {
    const s = this.deps.s;
    return {
      plan: () => this.computePlan(),
      apply: ({ ids }: { ids: string[] }) => this.apply(ids),
      adopt: ({ ids }: { ids: string[] }) => this.adopt(ids),
      selectConnection: async () => {
        const id = await this.deps.targets.pick(this.folder.fsPath).catch((e) => {
          if (e instanceof CancelledError) return undefined;
          throw e;
        });
        if (!id) return null;
        this.profileId = id;
        if (!s.manager.get(id)) await connectWithProgress(s, id);
        const d = this.describe();
        this.post("connection", d);
        return d;
      },
      connect: async () => {
        if (!this.profileId) return null;
        await connectWithProgress(s, this.profileId);
        return this.describe();
      },
      openFile: async ({ file }: { file: string }) => {
        await vscode.window.showTextDocument(this.abs(file), { preview: true, viewColumn: vscode.ViewColumn.Beside });
        return true;
      },
      compare: async ({ id }: { id: string }) => {
        const p = this.parsed.get(id);
        if (!p) throw new Error("This item has no valid config file");
        await compareWith(s, this.live(), this.abs(p.file), p.kind, p.name, p.stream);
        return true;
      },
      viewServer: async ({ id }: { id: string }) => {
        const i = this.items.get(id);
        if (!i?.kind) return false;
        const lc = this.live();
        const path = i.kind === "stream" ? `/stream/${i.name}.json` : i.kind === "consumer" ? `/consumer/${i.stream}/${i.name}.json` : `/kv/${i.name}.json`;
        await s.infoDocs.show(infoUri(lc.id, path), { column: vscode.ViewColumn.Beside });
        return true;
      },
      planSubfolder: async ({ dir }: { dir: string }) => {
        const target = vscode.Uri.file(join(this.folder.fsPath, dir));
        if (!target.fsPath.startsWith(this.folder.fsPath + sep)) throw new Error("Not a subfolder of the planned folder");
        await vscode.commands.executeCommand("nats.planConfigFolder", target);
        return true;
      },
      exportHere: async () => {
        await vscode.commands.executeCommand("nats.exportConfig", this.profileId, this.folder);
        return true;
      },
      revealFolder: async () => {
        if (vscode.workspace.getWorkspaceFolder(this.folder)) await vscode.commands.executeCommand("revealInExplorer", this.folder);
        else await vscode.commands.executeCommand("revealFileInOS", this.folder);
        return true;
      },
    };
  }
}

/** Folder for nats.planConfigFolder: explorer folder / file URI, the active config file, or a picker. */
export async function resolvePlanFolder(arg: unknown): Promise<vscode.Uri> {
  if (arg instanceof vscode.Uri) {
    const st = await vscode.workspace.fs.stat(arg).then(
      (x) => x,
      () => undefined,
    );
    return st && st.type & vscode.FileType.Directory ? arg : vscode.Uri.file(dirname(arg.fsPath));
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file" && CONFIG_FILE_RE.test(active.path)) return vscode.Uri.file(dirname(active.fsPath));
  const files = await vscode.workspace.findFiles(CONFIG_GLOB, "**/node_modules/**", 2000);
  const byDir = new Map<string, number>();
  for (const f of files) byDir.set(dirname(f.fsPath), (byDir.get(dirname(f.fsPath)) ?? 0) + 1);
  if (byDir.size === 1) return vscode.Uri.file([...byDir.keys()][0]);
  type Item = vscode.QuickPickItem & { dir?: string };
  const items: Item[] = [...byDir]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, n]) => ({ label: `$(folder) ${vscode.workspace.asRelativePath(dir, true)}`, description: `${n} config file${n === 1 ? "" : "s"}`, dir }));
  items.push({ label: "$(folder-opened) Browse…" });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select a folder of *.stream.json / *.consumer.json / *.kv.json files to plan" });
  if (!pick) throw new CancelledError();
  if (pick.dir) return vscode.Uri.file(pick.dir);
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Plan Folder", defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
  if (!picked?.[0]) throw new CancelledError();
  return picked[0];
}

export async function openPlan(deps: PlanDeps, folder: vscode.Uri): Promise<void> {
  const key = `gitopsPlan:${folder.fsPath}`;
  const existing = WebviewPanelBase.reveal<PlanPanel>(key);
  if (existing) {
    existing.replan();
    return;
  }
  const { s, targets } = deps;
  let profileId = targets.get(folder.fsPath);
  if (!profileId) profileId = await targets.pick(folder.fsPath).catch(() => undefined);
  if (profileId && !s.manager.get(profileId)) await connectWithProgress(s, profileId).catch(() => undefined);
  const init: PlanInit = { folder: folder.fsPath, folderLabel: vscode.workspace.asRelativePath(folder, true), connection: targets.describe(profileId) };
  new PlanPanel(deps, folder, profileId, key, init);
}

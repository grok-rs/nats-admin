// `.nats` playbooks: runnable, version-controllable NATS requests kept in the
// workspace. CodeLens runs a block (PUB / REQ / SUB), shows which connection
// it uses, diagnostics flag parse errors, and replies open as JSON documents.

import * as vscode from "vscode";
import { assertWritable } from "../core/ui";
import { headers as mkHeaders, type MsgHdrs } from "@nats-io/nats-core";
import type { Services } from "../services";
import { errorMessage, type LiveConnection } from "../core/connectionManager";
import { cfg, CancelledError, pickConnection, required, safe, validateSubject } from "../core/ui";
import { infoUri } from "../fs/infoDocs";
import { headersToArray } from "../nats/messages";
import { parsePlaybook, PLAYBOOK_SAMPLE, type PlaybookBlock, type PlaybookFile } from "../shared/playbook";
import { utf8Encode } from "../shared/encoding";
import { connectionDirectiveEdit, describeMessage, effectiveConnectionName, expandBlock, formatReply, sanitizeFileName } from "./playbookCore";

const LANG = "nats-playbook";
const VERB_LABEL: Record<PlaybookBlock["verb"], string> = { PUB: "▶ Publish", REQ: "▶ Send Request", SUB: "▶ Subscribe" };

let output: vscode.LogOutputChannel | undefined;
function out(): vscode.LogOutputChannel {
  return (output ??= vscode.window.createOutputChannel("NATS Playbook", { log: true }));
}

function toHeaders(list: [string, string][]): MsgHdrs | undefined {
  const clean = list.filter(([k]) => k.trim());
  if (!clean.length) return undefined;
  const h = mkHeaders();
  for (const [k, v] of clean) h.append(k.trim(), v);
  return h;
}

class PlaybookLenses implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly s: Services) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const pb = parsePlaybook(doc.getText());
    const lenses: vscode.CodeLens[] = [];
    pb.blocks.forEach((block, index) => {
      const range = new vscode.Range(block.line, 0, block.line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: VERB_LABEL[block.verb],
          command: "nats.runPlaybookBlock",
          arguments: [doc.uri, index],
          tooltip: `${block.verb} ${block.subject}`,
        }),
      );
      lenses.push(new vscode.CodeLens(range, { title: this.connectionLabel(pb, block), command: "nats.setPlaybookConnection", arguments: [doc.uri], tooltip: "Change the playbook's connection" }));
    });
    return lenses;
  }

  private connectionLabel(pb: PlaybookFile, block: PlaybookBlock): string {
    const name = effectiveConnectionName(pb, block);
    if (name) {
      const p = this.s.store.findByName(name);
      if (!p) return `$(warning) ${name} (not found)`;
      return `$(${this.s.manager.get(p.id) ? "plug" : "debug-disconnect"}) ${p.name}`;
    }
    const active = this.s.manager.activeId ? this.s.store.get(this.s.manager.activeId) : undefined;
    return active ? `$(plug) ${active.name} (active)` : "$(plug) choose connection";
  }
}

class PlaybookFolding implements vscode.FoldingRangeProvider {
  provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
    const pb = parsePlaybook(doc.getText());
    return pb.blocks
      .filter((b) => b.endLine > b.startLine)
      .map((b) => {
        let end = b.endLine;
        while (end > b.startLine && !doc.lineAt(end).text.trim()) end--;
        return new vscode.FoldingRange(b.startLine, end, vscode.FoldingRangeKind.Region);
      })
      .filter((r) => r.end > r.start);
  }
}

function validate(s: Services, doc: vscode.TextDocument, diags: vscode.DiagnosticCollection): void {
  if (doc.languageId !== LANG) return;
  const pb = parsePlaybook(doc.getText());
  const list: vscode.Diagnostic[] = [];
  const lineRange = (line: number) => doc.lineAt(Math.min(line, doc.lineCount - 1)).range;
  for (const e of pb.errors) list.push(new vscode.Diagnostic(lineRange(e.line), e.message, vscode.DiagnosticSeverity.Error));
  if (pb.connection && pb.connectionLine !== undefined && !s.store.findByName(pb.connection)) {
    list.push(new vscode.Diagnostic(lineRange(pb.connectionLine), `No connection named "${pb.connection}"`, vscode.DiagnosticSeverity.Warning));
  }
  for (const b of pb.blocks) {
    // Subjects containing templates are validated after rendering, at run time.
    const subjErr = b.subject.includes("{{") ? undefined : validateSubject(b.subject, b.verb === "SUB");
    if (subjErr) list.push(new vscode.Diagnostic(lineRange(b.line), subjErr, vscode.DiagnosticSeverity.Error));
    try {
      expandBlock({ ...b, body: "", headers: [] }, { defaultRequestTimeout: 1 });
    } catch (e) {
      list.push(new vscode.Diagnostic(lineRange(b.line), errorMessage(e), vscode.DiagnosticSeverity.Error));
    }
    if (b.connection && !s.store.findByName(b.connection)) {
      list.push(new vscode.Diagnostic(lineRange(b.line), `No connection named "${b.connection}"`, vscode.DiagnosticSeverity.Warning));
    }
    if (b.verb === "SUB" && b.body.trim()) {
      list.push(new vscode.Diagnostic(lineRange(b.line), "SUB blocks ignore the body", vscode.DiagnosticSeverity.Information));
    }
  }
  diags.set(doc.uri, list);
}

async function resolveConnection(s: Services, pb: PlaybookFile, block: PlaybookBlock): Promise<LiveConnection> {
  const name = effectiveConnectionName(pb, block);
  if (name) {
    const p = s.store.findByName(name);
    if (p) return pickConnection(s, p.id);
    const choice = await vscode.window.showWarningMessage(`Playbook connection "${name}" was not found.`, "Choose Connection");
    if (!choice) throw new CancelledError();
  }
  return pickConnection(s);
}

async function runBlock(s: Services, uri: vscode.Uri | undefined, index: number | undefined): Promise<void> {
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!doc) throw new Error("No playbook document");
  const pb = parsePlaybook(doc.getText());
  let i = index;
  if (i === undefined) {
    // Run the block under the cursor.
    const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    i = pb.blocks.findIndex((b) => line >= b.startLine && line <= b.endLine);
  }
  const block = pb.blocks[i ?? -1];
  if (!block) throw new Error("No runnable block here — the playbook may have changed; try again from the CodeLens");
  const exp = expandBlock(block, { defaultRequestTimeout: cfg("request.timeout", 5000) });
  for (const m of exp.messages) {
    const err = validateSubject(m.subject, block.verb === "SUB");
    if (err) throw new Error(`Subject "${m.subject}": ${err}`);
  }
  const lc = await resolveConnection(s, pb, block);
  const label = block.name ? `"${block.name}"` : `${block.verb} ${block.subject}`;

  if (exp.verb === "PUB") {
    assertWritable(lc, "publishing");
    const log = out();
    if (exp.jetstream) {
      const js = lc.js();
      let last = "";
      for (const m of exp.messages) {
        const ack = await js.publish(m.subject, utf8Encode(m.data), { headers: toHeaders(m.headers) });
        last = `${ack.stream} seq ${ack.seq}${ack.duplicate ? " (duplicate)" : ""}`;
        log.info(`[${lc.profile.name}] JS PUB ${m.subject} → ${last}`);
      }
      vscode.window.setStatusBarMessage(`$(check) ${label}: ${exp.messages.length} message(s) stored — last ${last}`, 5000);
    } else {
      for (const m of exp.messages) {
        lc.nc.publish(m.subject, utf8Encode(m.data), { headers: toHeaders(m.headers), reply: m.reply });
      }
      await lc.nc.flush();
      log.info(`[${lc.profile.name}] PUB ${exp.messages[0].subject} ×${exp.messages.length}`);
      vscode.window.setStatusBarMessage(`$(check) ${label}: published ${exp.messages.length} message(s) on ${lc.profile.name}`, 5000);
    }
    return;
  }

  if (exp.verb === "REQ") {
    const m = exp.messages[0];
    const replyUri = infoUri(lc.id, `/reply/${sanitizeFileName(doc.uri.path)}-${block.line + 1}.json`);
    const started = performance.now();
    let content: string;
    let failed: string | undefined;
    try {
      const reply = await lc.nc.request(m.subject, utf8Encode(m.data), { timeout: exp.timeoutMs, headers: toHeaders(m.headers) });
      const status = reply.headers?.hasError ? `${reply.headers.code} ${reply.headers.description}`.trim() : undefined;
      const svcErr = reply.headers?.get("Nats-Service-Error");
      content = formatReply({
        requestSubject: m.subject,
        subject: reply.subject,
        headers: headersToArray(reply.headers),
        data: reply.data,
        latencyMs: performance.now() - started,
        status: status ?? (svcErr ? `service error ${reply.headers?.get("Nats-Service-Error-Code") ?? ""}: ${svcErr}`.trim() : undefined),
      });
    } catch (e) {
      const msg = describeRequestError(e, exp.timeoutMs);
      failed = msg;
      content = formatReply({ requestSubject: m.subject, latencyMs: performance.now() - started, error: msg });
    }
    out().info(`[${lc.profile.name}] REQ ${m.subject} → ${failed ?? "reply received"}`);
    s.infoDocs.setDynamic(replyUri, async () => content);
    await s.infoDocs.show(replyUri, { column: vscode.ViewColumn.Beside, preview: true });
    if (failed) void vscode.window.showWarningMessage(`Request ${m.subject}: ${failed}`);
    return;
  }

  // SUB
  const subject = exp.messages[0].subject;
  const log = out();
  log.show(true);
  log.info(`[${lc.profile.name}] SUB ${subject}${exp.queue ? ` queue=${exp.queue}` : ""} — up to ${exp.maxMessages ?? "∞"} message(s) / ${exp.timeoutMs / 1000}s`);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Subscribed to ${subject}`, cancellable: true },
    async (progress, token) => {
      const sub = lc.nc.subscribe(subject, { queue: exp.queue, max: exp.maxMessages });
      let n = 0;
      const timer = setTimeout(() => sub.unsubscribe(), exp.timeoutMs);
      const cancel = token.onCancellationRequested(() => sub.unsubscribe());
      try {
        for await (const msg of sub) {
          n++;
          log.info(describeMessage(n, { subject: msg.subject, reply: msg.reply || undefined, headers: headersToArray(msg.headers), data: msg.data }));
          progress.report({ message: `${n} message(s)` });
        }
      } finally {
        clearTimeout(timer);
        cancel.dispose();
      }
      log.info(`[${lc.profile.name}] SUB ${subject} ended after ${n} message(s)${token.isCancellationRequested ? " (cancelled)" : ""}`);
    },
  );
}

function describeRequestError(e: unknown, timeoutMs: number): string {
  const name = e instanceof Error ? e.name : "";
  const msg = errorMessage(e);
  const cause = e instanceof Error ? (e as { cause?: unknown }).cause : undefined;
  const causeName = cause instanceof Error ? cause.name : "";
  if (/NoResponders/i.test(name + causeName) || /no responders/i.test(msg)) return "no responders — nothing is subscribed to this subject";
  if (/Timeout/i.test(name + causeName) || /timeout/i.test(msg)) return `timed out after ${timeoutMs}ms`;
  return msg;
}

async function setConnection(s: Services, uri?: vscode.Uri): Promise<void> {
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== LANG) throw new Error("Open a .nats playbook first");
  const profiles = s.store.list();
  if (!profiles.length) {
    await vscode.commands.executeCommand("nats.addConnection");
    return;
  }
  const current = parsePlaybook(doc.getText()).connection;
  const pick = required(
    await vscode.window.showQuickPick(
      profiles.map((p) => ({ label: p.name, description: p.servers.join(", "), detail: p.name === current ? "current" : undefined })),
      { placeHolder: "Connection used by this playbook (@connection)" },
    ),
  );
  const edit = connectionDirectiveEdit(doc.getText(), pick.label);
  const we = new vscode.WorkspaceEdit();
  if (edit.replace) we.replace(doc.uri, doc.lineAt(edit.line).range, edit.text);
  else we.insert(doc.uri, new vscode.Position(edit.line, 0), edit.text);
  await vscode.workspace.applyEdit(we);
}

async function newPlaybook(s: Services): Promise<void> {
  const active = s.manager.activeId ? s.store.get(s.manager.activeId) : undefined;
  const name = active?.name ?? s.store.list()[0]?.name ?? "local";
  const content = PLAYBOOK_SAMPLE.replace(/^@connection local$/m, `@connection ${name}`);
  const doc = await vscode.workspace.openTextDocument({ language: LANG, content });
  await vscode.window.showTextDocument(doc);
}

export function registerPlaybook(s: Services): void {
  const lenses = new PlaybookLenses(s);
  const diags = vscode.languages.createDiagnosticCollection(LANG);
  const selector: vscode.DocumentSelector = { language: LANG };
  const revalidate = () => vscode.workspace.textDocuments.forEach((d) => validate(s, d, diags));

  s.context.subscriptions.push(
    diags,
    { dispose: () => output?.dispose() },
    vscode.languages.registerCodeLensProvider(selector, lenses),
    vscode.languages.registerFoldingRangeProvider(selector, new PlaybookFolding()),
    vscode.workspace.onDidOpenTextDocument((d) => validate(s, d, diags)),
    vscode.workspace.onDidChangeTextDocument((e) => validate(s, e.document, diags)),
    vscode.workspace.onDidCloseTextDocument((d) => diags.delete(d.uri)),
    s.store.onDidChange(() => {
      lenses.refresh();
      revalidate();
    }),
    s.manager.onDidChangeActive(() => lenses.refresh()),
    s.manager.onDidChangeState(() => lenses.refresh()),
    vscode.commands.registerCommand(
      "nats.runPlaybookBlock",
      safe("Playbook", (uri?: vscode.Uri, index?: number) => runBlock(s, uri instanceof vscode.Uri ? uri : undefined, typeof index === "number" ? index : undefined)),
    ),
    vscode.commands.registerCommand(
      "nats.setPlaybookConnection",
      safe("Set playbook connection", (uri?: vscode.Uri) => setConnection(s, uri instanceof vscode.Uri ? uri : undefined)),
    ),
    vscode.commands.registerCommand("nats.newPlaybook", safe("New playbook", () => newPlaybook(s))),
  );
  revalidate();
}

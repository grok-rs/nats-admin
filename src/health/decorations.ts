// Decorates explorer nodes (nats-node://<connId>/stream/…, /consumer/…, /kv/…, /obj/…, /server)
// that have health findings: badge ("!" for one, else the count), label colour and a tooltip,
// so problems show inline in the Connections tree. Consumer problems also mark their stream.

import * as vscode from "vscode";
import { NODE_SCHEME } from "../tree/base";
import type { HealthService } from "./healthService";
import { badgeFor, decorationMarks, type DecorationMark } from "./model";

export class HealthDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  /** connId → node path → mark. */
  private readonly marks = new Map<string, Map<string, DecorationMark>>();
  private readonly sub: vscode.Disposable;

  constructor(private readonly health: HealthService) {
    this.sub = health.onDidChange((connId) => this.update(connId));
  }

  private update(connId: string): void {
    const before = this.marks.get(connId);
    const after = decorationMarks(this.health.get(connId)?.findings ?? []);
    if (after.size) this.marks.set(connId, after);
    else this.marks.delete(connId);
    const paths = new Set([...(before?.keys() ?? []), ...after.keys()]);
    if (!paths.size) return;
    this._onDidChange.fire([...paths].map((p) => vscode.Uri.from({ scheme: NODE_SCHEME, authority: connId, path: p })));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== NODE_SCHEME) return undefined;
    const m = this.marks.get(uri.authority)?.get(uri.path);
    if (!m || (!m.errors && !m.warnings)) return undefined;
    const parts = [m.errors && `${m.errors} ${m.errors === 1 ? "error" : "errors"}`, m.warnings && `${m.warnings} ${m.warnings === 1 ? "warning" : "warnings"}`].filter(Boolean).join(", ");
    const shown = m.titles.slice(0, 3).join("; ");
    const tooltip = `Health: ${parts} — ${shown}${m.titles.length > 3 ? "; …" : ""}`;
    const color = new vscode.ThemeColor(m.errors ? "errorForeground" : "editorWarning.foreground");
    return new vscode.FileDecoration(badgeFor(m.errors + m.warnings), tooltip, color);
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}

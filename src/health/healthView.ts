// Tree for the "nats.health" view: connection → severity group → finding.
// Clicking a finding runs nats.healthFix (suggested action, or opens the resource).

import * as vscode from "vscode";
import type { Services } from "../services";
import { ENVIRONMENTS } from "../core/profile";
import type { HealthService } from "./healthService";
import { CATEGORY_LABEL, countsText, scoreLabel, SEVERITY_PLURAL, targetLabel, type Finding, type HealthReport, type Severity } from "./model";

export const SEVERITY_ICON: Record<Severity, { icon: string; color: string }> = {
  error: { icon: "error", color: "errorForeground" },
  warning: { icon: "warning", color: "editorWarning.foreground" },
  info: { icon: "info", color: "editorInfo.foreground" },
};

export function scoreIcon(score: number): vscode.ThemeIcon {
  if (score >= 90) return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  if (score >= 60) return new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground"));
  return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
}

export class HealthConnectionNode {
  readonly type = "connection";
  constructor(readonly connId: string) {}
}

export class HealthGroupNode {
  readonly type = "group";
  constructor(
    readonly connId: string,
    readonly severity: Severity,
    readonly findings: Finding[],
  ) {}
}

export class HealthFindingNode {
  readonly type = "finding";
  constructor(
    readonly connId: string,
    readonly finding: Finding,
  ) {}
}

export class HealthMessageNode {
  readonly type = "message";
  constructor(
    readonly connId: string,
    readonly text: string,
    readonly icon: vscode.ThemeIcon,
    readonly command?: vscode.Command,
    readonly tooltip?: string,
  ) {}
}

export type HealthNode = HealthConnectionNode | HealthGroupNode | HealthFindingNode | HealthMessageNode;

export function findingTooltip(f: Finding): vscode.MarkdownString {
  const icon = SEVERITY_ICON[f.severity].icon;
  const m = new vscode.MarkdownString(undefined, true);
  m.appendMarkdown(`$(${icon}) **${escapeMd(f.title)}**\n\n`);
  m.appendMarkdown(`\`${targetLabel(f.target)}\` · ${CATEGORY_LABEL[f.category]} · \`${f.id}\`\n\n`);
  m.appendMarkdown(`${escapeMd(f.detail)}\n\n`);
  m.appendMarkdown(`**Why it matters / best practice:** ${escapeMd(f.recommendation)}\n\n`);
  m.appendMarkdown(f.fix ? `$(lightbulb) Click to apply: **${escapeMd(f.fix.label)}**` : `$(go-to-file) Click to open the resource`);
  return m;
}

export function reportTooltip(name: string, r: HealthReport | undefined, opts: { running?: boolean; error?: string; env?: string } = {}): vscode.MarkdownString {
  const m = new vscode.MarkdownString(undefined, true);
  if (!r) {
    m.appendMarkdown(`**${escapeMd(name)}**${opts.env ? ` · ${opts.env}` : ""}\n\n`);
    m.appendMarkdown(opts.running ? "$(loading~spin) Health check running…" : opts.error ? `$(error) Health check failed: ${escapeMd(opts.error)}` : "No health check yet.");
    return m;
  }
  m.appendMarkdown(`**${escapeMd(name)}**${opts.env ? ` · ${opts.env}` : ""} — health **${r.score}/100** (${scoreLabel(r.score)})\n\n`);
  m.appendMarkdown(`${countsText(r.counts)} · checked ${new Date(r.at).toLocaleTimeString()} in ${r.durationMs} ms\n\n`);
  for (const f of r.findings.slice(0, 5)) m.appendMarkdown(`$(${SEVERITY_ICON[f.severity].icon}) ${escapeMd(f.title)} — \`${targetLabel(f.target)}\`\n\n`);
  if (r.findings.length > 5) m.appendMarkdown(`…and ${r.findings.length - 5} more\n\n`);
  if (opts.running) m.appendMarkdown("$(loading~spin) Re-running…\n\n");
  if (opts.error) m.appendMarkdown(`$(error) Last run failed: ${escapeMd(opts.error)}\n\n`);
  return m;
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]<>|])/g, "\\$1");
}

export class HealthTreeProvider implements vscode.TreeDataProvider<HealthNode>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<HealthNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly s: Services,
    private readonly health: HealthService,
  ) {
    this.subs = [health.onDidChange(() => this._onDidChange.fire(undefined)), s.manager.onDidChangeState(() => this._onDidChange.fire(undefined)), s.store.onDidChange(() => this._onDidChange.fire(undefined))];
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getChildren(node?: HealthNode): HealthNode[] {
    if (!node) {
      const ids = new Set([...this.s.manager.connected().map((c) => c.id), ...this.health.connIds()]);
      return [...ids]
        .filter((id) => this.s.store.get(id))
        .sort((a, b) => this.s.store.get(a)!.name.localeCompare(this.s.store.get(b)!.name))
        .map((id) => new HealthConnectionNode(id));
    }
    if (node instanceof HealthConnectionNode) {
      const r = this.health.get(node.connId);
      if (!r) {
        if (this.health.isRunning(node.connId)) return [new HealthMessageNode(node.connId, "Checking streams, consumers, buckets and server…", new vscode.ThemeIcon("loading~spin"))];
        const err = this.health.lastError(node.connId);
        return [
          new HealthMessageNode(node.connId, err ? `Check failed: ${err}` : "Not checked yet — run a health check", new vscode.ThemeIcon(err ? "error" : "play", err ? new vscode.ThemeColor("errorForeground") : undefined), {
            command: "nats.runHealthCheck",
            title: "Run Health Check",
            arguments: [node.connId],
          }),
        ];
      }
      if (!r.findings.length) return [new HealthMessageNode(node.connId, "No problems found", new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed")), { command: "nats.openHealthDashboard", title: "Open Health Dashboard", arguments: [node.connId] })];
      return (["error", "warning", "info"] as const).map((sev) => new HealthGroupNode(node.connId, sev, r.findings.filter((f) => f.severity === sev))).filter((g) => g.findings.length > 0);
    }
    if (node instanceof HealthGroupNode) return node.findings.map((f) => new HealthFindingNode(node.connId, f));
    return [];
  }

  getTreeItem(node: HealthNode): vscode.TreeItem {
    if (node instanceof HealthConnectionNode) {
      const p = this.s.store.get(node.connId);
      const r = this.health.get(node.connId);
      const running = this.health.isRunning(node.connId);
      const err = this.health.lastError(node.connId);
      const env = ENVIRONMENTS.find((e) => e.id === p?.environment);
      const ti = new vscode.TreeItem(p?.name ?? node.connId, r?.findings.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      // Distinct ids so the node expands when findings first appear (VS Code keeps state per id).
      ti.id = `health:${node.connId}:${r?.findings.length ? "findings" : "empty"}`;
      ti.contextValue = "healthConnection";
      const envTag = env ? (env.id === "prod" ? "PROD · " : "") : "";
      ti.description = running && !r ? `${envTag}checking…` : r ? `${envTag}${r.score} · ${r.counts.error}E/${r.counts.warning}W/${r.counts.info}I${running ? " · re-running…" : ""}` : err ? `${envTag}check failed` : `${envTag}not checked`;
      ti.iconPath = running ? new vscode.ThemeIcon("loading~spin") : r ? scoreIcon(r.score) : err ? new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground")) : new vscode.ThemeIcon("pulse");
      ti.tooltip = reportTooltip(p?.name ?? node.connId, r, { running, error: err, env: env?.label });
      ti.accessibilityInformation = { label: `${p?.name ?? node.connId}: ${r ? `health score ${r.score} of 100, ${scoreLabel(r.score)}, ${countsText(r.counts)}` : running ? "health check running" : "not checked"}` };
      return ti;
    }
    if (node instanceof HealthGroupNode) {
      const ti = new vscode.TreeItem(SEVERITY_PLURAL[node.severity], node.severity === "info" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      ti.id = `health:${node.connId}:${node.severity}`;
      ti.description = String(node.findings.length);
      const ic = SEVERITY_ICON[node.severity];
      ti.iconPath = new vscode.ThemeIcon(ic.icon, new vscode.ThemeColor(ic.color));
      ti.contextValue = "healthGroup";
      return ti;
    }
    if (node instanceof HealthFindingNode) {
      const f = node.finding;
      const ti = new vscode.TreeItem(f.title, vscode.TreeItemCollapsibleState.None);
      ti.id = `health:${node.connId}:f:${f.key}`;
      ti.description = targetLabel(f.target);
      const ic = SEVERITY_ICON[f.severity];
      ti.iconPath = new vscode.ThemeIcon(ic.icon, new vscode.ThemeColor(ic.color));
      ti.tooltip = findingTooltip(f);
      ti.contextValue = f.fix ? "healthFinding.fixable" : "healthFinding";
      ti.command = { command: "nats.healthFix", title: f.fix?.label ?? "Open", arguments: [f] };
      ti.accessibilityInformation = { label: `${f.severity}: ${f.title}, ${targetLabel(f.target)}` };
      return ti;
    }
    const ti = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    ti.iconPath = node.icon;
    ti.command = node.command;
    ti.tooltip = node.tooltip ?? node.text;
    ti.contextValue = "healthMessage";
    return ti;
  }

  dispose(): void {
    for (const d of this.subs) d.dispose();
    this._onDidChange.dispose();
  }
}

// "Subjects" folder under each stream in the explorer: the stream's stored subjects as a token
// hierarchy with message counts (lazy, capped by nats.explorer.maxSubjects). Clicking a subject
// or folder runs nats.browseSubject, which opens the Message Browser filtered to it.
//
//   Subjects 1,204                         contextValue subjectsFolder
//     orders.>        41.2k msgs · 12 subj  contextValue subjectFolder → filter orders.>
//       eu.>          30.1k msgs · 4 subj
//         created     12,034 msgs           contextValue subject      → filter orders.eu.created

import * as vscode from "vscode";
import type { StreamInfo } from "@nats-io/jetstream";
import type { Services } from "../services";
import type { LiveConnection } from "../core/connectionManager";
import { cfg } from "../core/ui";
import { CachedNode, MessageNode, NatsNode, md } from "./base";
import { treeHooks } from "./hooks";
import { buildSubjectTree, fetchSubjectCounts, findSubjectNode, folderFilter, share, type SubjectCounts, type SubjectNode } from "../nats/subjects";
import { fmtCompact, fmtNumber } from "../shared/format";
import type { SubjectTarget } from "../insights/args";

export { subjectTargetOf, type SubjectTarget } from "../insights/args";

export const BROWSE_SUBJECT = "nats.browseSubject";

/** Context shared by the nodes of one stream's Subjects folder. */
interface SubjectScope {
  s: Services;
  connId: string;
  stream: string;
  fallbackLc: LiveConnection;
  /** Messages in the stream (for shares in tooltips). */
  streamMessages: number;
}

/**
 * Tree item ids: subjects cannot contain whitespace, so " >" (folder) and " =" (a folder's own
 * subject) can never collide with a real subject such as "a/" or "a#self".
 */
function subjectId(scope: SubjectScope, path: string, kind: "folder" | "self" | "leaf"): string {
  return `${scope.connId}/stream/${scope.stream}/subjects/${path}${kind === "folder" ? " >" : kind === "self" ? " =" : ""}`;
}

function browseCommand(target: SubjectTarget, title: string): vscode.Command {
  return { command: BROWSE_SUBJECT, title, arguments: [target] };
}

function maxSubjects(): number {
  return Math.max(10, cfg("explorer.maxSubjects", 2000));
}

async function jsmOf(scope: SubjectScope) {
  const lc = scope.s.manager.get(scope.connId) ?? scope.fallbackLc;
  return lc.jsm();
}

function childNodes(scope: SubjectScope, parent: NatsNode, node: SubjectNode, partial: boolean): NatsNode[] {
  const out: NatsNode[] = [];
  // A folder that is also a subject: its own messages as the first leaf.
  if (node.path && node.isSubject && node.children.length) out.push(new SubjectLeafNode(scope, parent, node, true));
  for (const c of node.children) out.push(c.children.length ? new SubjectFolderNode(scope, parent, c, partial) : new SubjectLeafNode(scope, parent, c, false));
  return out;
}

function truncationNode(connId: string, parent: NatsNode, counts: SubjectCounts): MessageNode {
  const kept = counts.subjects.length;
  const among = counts.scanned < counts.total ? ` among the first ${fmtNumber(counts.scanned)} (alphabetical) of ${fmtNumber(counts.total)}` : "";
  return new MessageNode(
    connId,
    parent,
    `Showing ${fmtNumber(kept)} of ${fmtNumber(counts.total)} subjects`,
    "warning",
    { command: "workbench.action.openSettings", title: "Open setting", arguments: ["nats.explorer.maxSubjects"] },
    `Only the ${fmtNumber(kept)} subjects with the most messages${among} are listed (nats.explorer.maxSubjects). Folders re-query their own subtree when expanded. Click to change the limit.`,
  );
}

/** "Subjects" folder under a stream. */
export class SubjectsFolderNode extends CachedNode {
  readonly target: SubjectTarget;
  private readonly scope: SubjectScope;

  constructor(s: Services, connId: string, parent: NatsNode, lc: LiveConnection, private readonly info: StreamInfo) {
    super(connId, parent);
    this.scope = { s, connId, stream: info.config.name, fallbackLc: lc, streamMessages: info.state.messages };
    this.target = { connId, stream: info.config.name };
  }

  get stream(): string {
    return this.scope.stream;
  }

  getTreeItem(): vscode.TreeItem {
    const n = this.info.state.num_subjects;
    const empty = this.info.state.messages === 0;
    const ti = new vscode.TreeItem("Subjects", empty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    ti.id = `${this.connId}/stream/${this.stream}/subjects`;
    ti.iconPath = new vscode.ThemeIcon("symbol-namespace");
    ti.description = typeof n === "number" ? fmtNumber(n) : empty ? "0" : undefined;
    ti.contextValue = "subjectsFolder";
    ti.tooltip = md([
      `**Subjects** stored in \`${this.stream}\``,
      typeof n === "number" ? `${fmtNumber(n)} distinct subjects · ${fmtNumber(this.info.state.messages)} messages` : `${fmtNumber(this.info.state.messages)} messages`,
      "$(list-flat) Click a subject or folder to browse its messages.",
      `Lists up to ${fmtNumber(maxSubjects())} subjects (\`nats.explorer.maxSubjects\`).`,
    ]);
    return ti;
  }

  protected async load(): Promise<NatsNode[]> {
    const counts = await fetchSubjectCounts(await jsmOf(this.scope), this.stream, { max: maxSubjects() });
    this.scope.streamMessages = counts.streamMessages;
    if (!counts.subjects.length) return [new MessageNode(this.connId, this, "No messages stored", "info")];
    const root = buildSubjectTree(counts.subjects);
    const nodes = childNodes(this.scope, this, root, counts.truncated);
    if (counts.truncated) nodes.push(truncationNode(this.connId, this, counts));
    return nodes;
  }
}

/** A token folder ("orders.eu.>"). */
export class SubjectFolderNode extends CachedNode {
  readonly target: SubjectTarget;

  constructor(
    private readonly scope: SubjectScope,
    parent: NatsNode,
    private readonly node: SubjectNode,
    /** Counts come from a truncated listing: re-query this subtree on expand. */
    private readonly partial: boolean,
  ) {
    super(scope.connId, parent);
    this.target = { connId: scope.connId, stream: scope.stream, filter: folderFilter(node.path) };
  }

  get path(): string {
    return this.node.path;
  }

  getTreeItem(): vscode.TreeItem {
    const n = this.node;
    const ti = new vscode.TreeItem(`${n.name}.>`, vscode.TreeItemCollapsibleState.Collapsed);
    ti.id = subjectId(this.scope, n.path, "folder");
    ti.iconPath = new vscode.ThemeIcon("folder");
    ti.description = `${this.partial ? "≥ " : ""}${fmtCompact(n.messages)} msgs · ${fmtNumber(n.subjects)} subj${this.partial ? "+" : ""}`;
    ti.contextValue = "subjectFolder";
    ti.command = browseCommand(this.target, "Browse Messages");
    const pct = share(n.messages, this.scope.streamMessages);
    ti.tooltip = md([
      `\`${folderFilter(n.path)}\``,
      `${fmtNumber(n.messages)} messages${pct ? ` (${(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}% of the stream)` : ""} on ${fmtNumber(n.subjects)} subjects`,
      n.isSubject && `including ${fmtNumber(n.own)} on \`${n.path}\` itself`,
      this.partial && "$(warning) Counts are partial (subject listing was capped); expanding re-queries this folder.",
      "$(list-flat) Click to browse these messages.",
    ]);
    return ti;
  }

  protected async load(): Promise<NatsNode[]> {
    if (!this.partial) return childNodes(this.scope, this, this.node, false);
    const counts = await fetchSubjectCounts(await jsmOf(this.scope), this.scope.stream, { filter: folderFilter(this.node.path), max: maxSubjects() });
    // "orders.eu.>" does not match "orders.eu" itself: keep the folder's own count from the parent listing.
    const own = this.node.isSubject ? [{ subject: this.node.path, messages: this.node.own }] : [];
    const sub = findSubjectNode(buildSubjectTree([...counts.subjects, ...own]), this.node.path);
    if (!sub) return [new MessageNode(this.connId, this, "No messages stored", "info")];
    const nodes = childNodes(this.scope, this, sub, counts.truncated);
    if (counts.truncated) nodes.push(truncationNode(this.connId, this, counts));
    return nodes;
  }
}

/** A concrete subject (or a folder's own subject when `self`). */
export class SubjectLeafNode extends NatsNode {
  readonly target: SubjectTarget;

  constructor(
    private readonly scope: SubjectScope,
    parent: NatsNode,
    private readonly node: SubjectNode,
    private readonly self: boolean,
  ) {
    super(scope.connId, parent);
    this.target = { connId: scope.connId, stream: scope.stream, filter: node.path };
  }

  get subject(): string {
    return this.node.path;
  }

  getTreeItem(): vscode.TreeItem {
    const n = this.node;
    const count = this.self ? n.own : n.messages;
    const ti = new vscode.TreeItem(this.self ? n.path : n.name, vscode.TreeItemCollapsibleState.None);
    ti.id = subjectId(this.scope, n.path, this.self ? "self" : "leaf");
    ti.iconPath = new vscode.ThemeIcon("symbol-string");
    ti.description = `${fmtNumber(count)} ${count === 1 ? "msg" : "msgs"}${this.self ? " · exact subject" : ""}`;
    ti.contextValue = "subject";
    ti.command = browseCommand(this.target, "Browse Messages");
    const pct = share(count, this.scope.streamMessages);
    ti.tooltip = md([`\`${n.path}\``, `${fmtNumber(count)} messages${pct ? ` (${(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}% of the stream)` : ""}`, "$(list-flat) Click to browse these messages."]);
    return ti;
  }
}

/** Add the Subjects folder under every stream. */
export function registerSubjectNodes(s: Services): vscode.Disposable {
  return treeHooks.registerStreamChildren(({ connId, parent, lc, info }) => [new SubjectsFolderNode(s, connId, parent, lc, info)]);
}

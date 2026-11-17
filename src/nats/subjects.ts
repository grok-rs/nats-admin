// Per-subject message counts of a stream (STREAM.INFO with subjects_filter), capped at
// nats.explorer.maxSubjects, plus pure helpers that rank them and fold them into a token
// hierarchy ("orders" → "orders.eu" → "orders.eu.created") with summed message counts.
// No vscode imports: used by the explorer, the stream dashboard and the unit tests.

import type { JetStreamManager, StreamInfo } from "@nats-io/jetstream";
import { buildKeyTree, sortedChildren, type KeyTreeNode } from "../shared/keyTree";

export const SUBJECT_SEPARATOR = ".";

export interface SubjectCount {
  subject: string;
  messages: number;
}

export interface SubjectCounts {
  stream: string;
  /** Subject filter the counts were requested with (">" = every subject). */
  filter: string;
  /** Kept subjects, most messages first (at most `max`). */
  subjects: SubjectCount[];
  /** Distinct subjects matching the filter on the server. */
  total: number;
  /** True when `total` exceeds the subjects kept. */
  truncated: boolean;
  /**
   * Distinct subjects actually received and ranked. Below `total` only for huge streams: the
   * server pages subjects alphabetically (100k per page) and paging stops at `max`, so the kept
   * subjects are then the busiest of the first `scanned` subjects, not of the whole stream.
   */
  scanned: number;
  /** The cap that was applied. */
  max: number;
  /** Messages stored in the stream (all subjects). */
  streamMessages: number;
  /** Messages on the kept subjects. */
  keptMessages: number;
  /** Server time of the (first) response, when reported. */
  serverTs?: string;
}

/** The STREAM.INFO request API that nats.js keeps on jsm.streams (not part of its public types). */
interface RawStreamApi {
  _request?: (subj: string, data?: unknown) => Promise<unknown>;
  prefix?: string;
}

type PagedInfo = StreamInfo & { total?: number; offset?: number; limit?: number };

/** Hard stop for paging, whatever the server reports (each page holds up to 100k subjects). */
const MAX_PAGES = 20;

/**
 * Fetch per-subject message counts for `stream`. Pages through STREAM.INFO only until `max`
 * subjects are known (nats.js' own `streams.info` would page through *every* subject), keeps
 * the `max` subjects with the most messages and reports truncation.
 */
export async function fetchSubjectCounts(jsm: JetStreamManager, stream: string, opts: { filter?: string; max?: number } = {}): Promise<SubjectCounts> {
  const filter = opts.filter?.trim() || ">";
  const max = Math.max(1, Math.floor(opts.max ?? 2000));
  const raw = jsm.streams as unknown as RawStreamApi;
  const collected = new Map<string, number>();
  let total = 0;
  let streamMessages = 0;
  let serverTs: string | undefined;

  if (typeof raw._request === "function" && typeof raw.prefix === "string") {
    const subj = `${raw.prefix}.STREAM.INFO.${stream}`;
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await raw._request.call(raw, subj, offset ? { subjects_filter: filter, offset } : { subjects_filter: filter })) as PagedInfo;
      if (page === 0) {
        streamMessages = r.state?.messages ?? 0;
        serverTs = r.ts;
      }
      const subjects = r.state?.subjects ?? {};
      const names = Object.keys(subjects);
      for (const k of names) collected.set(k, subjects[k]);
      total = Math.max(r.total ?? 0, collected.size);
      offset += names.length;
      const limit = r.limit ?? 0;
      if (names.length === 0 || collected.size >= max || collected.size >= total || (limit > 0 && names.length < limit)) break;
    }
  } else {
    // Fallback for client versions without the raw request API: lets nats.js page.
    const si = await jsm.streams.info(stream, { subjects_filter: filter });
    streamMessages = si.state.messages;
    serverTs = si.ts;
    for (const [k, v] of Object.entries(si.state.subjects ?? {})) collected.set(k, v);
    total = collected.size;
  }

  const all = [...collected].map(([subject, messages]) => ({ subject, messages }));
  const subjects = topSubjects(all, max);
  return {
    stream,
    filter,
    subjects,
    total,
    truncated: total > subjects.length,
    scanned: collected.size,
    max,
    streamMessages,
    keptMessages: subjects.reduce((a, s) => a + s.messages, 0),
    serverTs,
  };
}

/** The `n` subjects with the most messages (ties: natural subject order). */
export function topSubjects(counts: readonly SubjectCount[], n: number): SubjectCount[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...counts].sort((a, b) => b.messages - a.messages || collator.compare(a.subject, b.subject)).slice(0, Math.max(0, n));
}

/** One token level of the subject hierarchy. */
export interface SubjectNode {
  /** Token at this level ("created"). */
  name: string;
  /** Full subject / prefix up to this token ("orders.eu.created"). "" for the root. */
  path: string;
  /** True when `path` itself is a stored subject. */
  isSubject: boolean;
  /** Messages stored on exactly `path` (0 for pure folders). */
  own: number;
  /** Messages at or below this node. */
  messages: number;
  /** Distinct subjects at or below this node. */
  subjects: number;
  /** Folders first, then subjects, each in natural order. */
  children: SubjectNode[];
}

/** Fold flat subject counts into a token tree (reuses the KV key tree), summing messages per folder. */
export function buildSubjectTree(counts: readonly SubjectCount[], separator = SUBJECT_SEPARATOR): SubjectNode {
  const own = new Map<string, number>();
  for (const c of counts) own.set(c.subject, (own.get(c.subject) ?? 0) + c.messages);
  const convert = (k: KeyTreeNode): SubjectNode => {
    const children = sortedChildren(k).map(convert);
    const mine = k.isKey ? (own.get(k.path) ?? 0) : 0;
    return {
      name: k.name,
      path: k.path,
      isSubject: k.isKey,
      own: mine,
      messages: mine + children.reduce((a, c) => a + c.messages, 0),
      subjects: k.count,
      children,
    };
  };
  return convert(buildKeyTree(own.keys(), separator));
}

/** Find a node by its full path ("" = root). */
export function findSubjectNode(root: SubjectNode, path: string, separator = SUBJECT_SEPARATOR): SubjectNode | undefined {
  if (!path) return root;
  let node: SubjectNode | undefined = root;
  for (const token of path.split(separator)) {
    node = node?.children.find((c) => c.name === token);
    if (!node) return undefined;
  }
  return node;
}

/**
 * Where a treemap should start: skips a chain of single folders at the top ("orders" when every
 * subject starts with "orders."), so the first level shows a real distribution. Stops at
 * folders that also hold messages of their own.
 */
export function treemapStart(root: SubjectNode): SubjectNode {
  let node = root;
  while (node.children.length === 1 && node.children[0].children.length > 0 && !(node.path && node.isSubject)) node = node.children[0];
  return node;
}

/** Message Browser filter for a folder ("orders.eu" → "orders.eu.>", root → ">"). */
export function folderFilter(path: string, separator = SUBJECT_SEPARATOR): string {
  return path ? `${path}${separator}>` : ">";
}

/** Structural twin of the webview Treemap's TreeNode (the dashboard renders it directly). */
export interface TreemapNode {
  id: string;
  label: string;
  value?: number;
  children?: TreemapNode[];
  hint?: string;
}

/** Id suffixes for synthetic treemap tiles (never real subjects: they contain a space). */
export const OTHER_SUFFIX = " (other)";
export const SELF_SUFFIX = " (exact)";

/**
 * Treemap input for a subject tree: per level the `maxChildren` largest children, the rest
 * folded into an "Other (n)" tile; messages stored on a folder's own subject become an
 * "(exact)" tile; levels below `maxDepth` are summed into their parent.
 */
export function subjectTreemap(root: SubjectNode, opts: { maxChildren?: number; maxDepth?: number } = {}): TreemapNode[] {
  const maxChildren = Math.max(2, opts.maxChildren ?? 24);
  const maxDepth = Math.max(1, opts.maxDepth ?? 4);
  const level = (node: SubjectNode, depth: number): TreemapNode[] => {
    const parts: TreemapNode[] = node.children.filter((c) => c.messages > 0).map((c) => toTile(c, depth));
    if (node.path && node.isSubject && node.own > 0 && parts.length) {
      parts.push({ id: node.path + SELF_SUFFIX, label: "(exact)", value: node.own, hint: `Messages on exactly ${node.path}` });
    }
    parts.sort((a, b) => tileValue(b) - tileValue(a));
    if (parts.length <= maxChildren) return parts;
    const keep = parts.slice(0, maxChildren - 1);
    const rest = parts.slice(maxChildren - 1);
    keep.push({
      id: (node.path || "*") + OTHER_SUFFIX,
      label: `Other (${rest.length})`,
      value: rest.reduce((a, t) => a + tileValue(t), 0),
      hint: `${rest.length} smaller ${rest.length === 1 ? "token" : "tokens"} under ${node.path || "the stream"}`,
    });
    return keep;
  };
  const toTile = (c: SubjectNode, depth: number): TreemapNode => {
    const hint = `${c.path} · ${c.subjects} ${c.subjects === 1 ? "subject" : "subjects"}`;
    if (c.children.length && depth + 1 < maxDepth) {
      const children = level(c, depth + 1);
      if (children.length) return { id: c.path, label: c.name, children, hint };
    }
    // A folder summarised below maxDepth: its id is the wildcard filter ("orders.eu.>").
    return c.children.length ? { id: folderFilter(c.path), label: `${c.name}.>`, value: c.messages, hint } : { id: c.path, label: c.name, value: c.messages, hint };
  };
  return level(root, 0);
}

function tileValue(t: TreemapNode): number {
  return t.children?.length ? t.children.reduce((a, c) => a + tileValue(c), 0) : Math.max(0, t.value ?? 0);
}

/**
 * Message Browser filter behind a treemap tile: tiles with children are folders ("orders.eu" →
 * "orders.eu.>"), summarised folders already carry their wildcard, "(exact)" tiles map to their
 * subject and "Other" tiles to nothing.
 */
export function tileFilter(tile: { id: string; children?: readonly unknown[] }, separator = SUBJECT_SEPARATOR): string | undefined {
  const { id } = tile;
  if (id.endsWith(OTHER_SUFFIX)) return undefined;
  if (id.endsWith(SELF_SUFFIX)) return id.slice(0, -SELF_SUFFIX.length);
  if (tile.children?.length) return folderFilter(id, separator);
  return id;
}

/** Share of `part` in `whole` as a fraction (0 when whole is 0). */
export function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

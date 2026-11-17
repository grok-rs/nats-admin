// Groups flat KV keys (e.g. "app.db.host") into a folder hierarchy by a
// separator so buckets read like a data structure instead of a flat list.

export interface KeyTreeNode {
  /** The token for this level (e.g. "db"). */
  name: string;
  /** Full prefix / key up to and including this token (e.g. "app.db"). */
  path: string;
  /** True when `path` itself is a key in the bucket. */
  isKey: boolean;
  children: Map<string, KeyTreeNode>;
  /** Number of keys at or below this node. */
  count: number;
}

export function buildKeyTree(keys: Iterable<string>, separator: string): KeyTreeNode {
  const root: KeyTreeNode = { name: "", path: "", isKey: false, children: new Map(), count: 0 };
  for (const key of keys) {
    const parts = separator ? splitKey(key, separator) : [key];
    let node = root;
    root.count++;
    let path = "";
    parts.forEach((part, i) => {
      path = i === 0 ? part : path + separator + part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, isKey: false, children: new Map(), count: 0 };
        node.children.set(part, child);
      }
      child.count++;
      node = child;
    });
    node.isKey = true;
  }
  return root;
}

/** Split on the separator but keep empty tokens attached (".a" or "a..b" are legal-ish keys). */
function splitKey(key: string, sep: string): string[] {
  const parts = key.split(sep);
  return parts.length === 0 ? [key] : parts;
}

/** Children sorted with folders first, then keys, each alphabetically (natural order). */
export function sortedChildren(node: KeyTreeNode): KeyTreeNode[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...node.children.values()].sort((a, b) => {
    const af = a.children.size > 0 ? 0 : 1;
    const bf = b.children.size > 0 ? 0 : 1;
    if (af !== bf) return af - bf;
    return collator.compare(a.name, b.name);
  });
}

/** Find a node by its full path. */
export function findNode(root: KeyTreeNode, path: string, separator: string): KeyTreeNode | undefined {
  if (!path) return root;
  const parts = separator ? path.split(separator) : [path];
  let node: KeyTreeNode | undefined = root;
  for (const p of parts) {
    node = node?.children.get(p);
    if (!node) return undefined;
  }
  return node;
}

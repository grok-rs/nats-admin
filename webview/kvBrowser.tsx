import "./lib/styles.css";
import "./kvBrowser.css";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getInit, onEvent, rpc } from "./lib/vscode";
import { Badge, Button, CopyButton, cx, Empty, ErrorBanner, Flash, fmtTime, Icon, Notice, SplitPane, Tabs, useFlash } from "./lib/ui";
import { PayloadView, payloadPreview } from "./lib/PayloadView";
import { describeShape } from "./lib/JsonTree";
import type { KvBrowserInit } from "../src/panels/kvBrowserPanel";
import type { KvBucketDTO, KvEntryDTO } from "../src/shared/dto";
import { base64ToBytes, bytesToBase64, utf8DecodeStrict, utf8Encode } from "../src/shared/encoding";
import { detect } from "../src/shared/payload";
import { buildKeyTree, sortedChildren, type KeyTreeNode } from "../src/shared/keyTree";
import { aggregateShape, validateKvKey } from "../src/shared/shape";
import { fmtAgo, fmtBytes, fmtMillis, fmtNumber } from "../src/shared/format";
import { Card, EmptyState, Grid, KpiRow, KpiTile } from "./lib/dashboard";
import { ActivityStrip, Donut, Histogram, ItemsTable, Treemap, bucketize, formatValue, nodeValue, quantile, useElementSize, type HistogramMarker, type TreeNode } from "./lib/charts";
import { activityWindow, kindSlot, prefixTreemap, stepLabel, tileKey, type PrefixMetric } from "../src/insights/kvInsights";

const init = getInit<KvBrowserInit>();
const SEP = init.separator;

type Kind = { label: string; tone: "accent" | "neutral" | "warn" | "info" };

function kindOf(e: KvEntryDTO): Kind {
  if (!e.data) return { label: "empty", tone: "neutral" };
  const d = detect(base64ToBytes(e.data));
  if (d.format === "json") return { label: d.kind, tone: d.kind === "object" || d.kind === "array" ? "accent" : "info" };
  if (d.format === "binary") return { label: d.gzip ? "gzip" : "binary", tone: "warn" };
  return { label: d.format === "empty" ? "empty" : "text", tone: "neutral" };
}

function jsonOf(e: KvEntryDTO): unknown | undefined {
  if (!e.data) return undefined;
  const d = detect(base64ToBytes(e.data));
  return d.format === "json" ? d.json : undefined;
}

type Selection = { type: "key"; key: string } | { type: "prefix"; prefix: string } | null;

function App() {
  const [status, setStatus] = useState<KvBucketDTO>(init.status);
  const [entries, setEntries] = useState<Map<string, KvEntryDTO>>(new Map());
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(init.filter ?? "");
  const [appliedFilter, setAppliedFilter] = useState(init.filter ?? "");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);
  const [view, setView] = useState<"tree" | "table">("tree");
  const [selection, setSelection] = useState<Selection>(init.selectKey ? { type: "key", key: init.selectKey } : null);
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set());
  const [deletedWhileOpen, setDeletedWhileOpen] = useState<string | null>(null);
  const [connState, setConnState] = useState("connected");
  const [showAdd, setShowAdd] = useState(false);
  const [flash, setFlash] = useFlash();
  const pendingSelect = useRef<string | undefined>(init.selectKey);

  const load = (f = appliedFilter, isLive = live) => {
    setLoading(true);
    setError(null);
    rpc("load", { filter: f || undefined, live: isLive }).catch((e) => {
      setLoading(false);
      setError(String(e.message ?? e));
    });
    void rpc<KvBucketDTO>("status").then(setStatus).catch(() => undefined);
  };

  useEffect(() => {
    const offs = [
      onEvent<{ entries: KvEntryDTO[]; truncated: boolean }>("snapshot", ({ entries: list, truncated: t }) => {
        setEntries(new Map(list.map((e) => [e.key, e])));
        setTruncated(t);
        setLoading(false);
        if (pendingSelect.current) {
          setSelection({ type: "key", key: pendingSelect.current });
          pendingSelect.current = undefined;
        }
      }),
      onEvent<KvEntryDTO[]>("updates", (batch) => {
        setEntries((prev) => {
          const next = new Map(prev);
          for (const e of batch) {
            if (e.operation === "PUT") next.set(e.key, e);
            else next.delete(e.key);
          }
          return next;
        });
        const changed = new Set(batch.filter((e) => e.operation === "PUT").map((e) => e.key));
        setFlashKeys(changed);
        setTimeout(() => setFlashKeys(new Set()), 1600);
        setSelection((sel) => {
          if (sel?.type === "key" && batch.some((e) => e.key === sel.key && e.operation !== "PUT")) setDeletedWhileOpen(sel.key);
          return sel;
        });
        void rpc<KvBucketDTO>("status").then(setStatus).catch(() => undefined);
      }),
      onEvent<string>("error", (m) => setError(m)),
      onEvent<{ state: string }>("connection", ({ state }) => setConnState(state)),
      onEvent<{ filter: string; selectKey?: string }>("setFilter", ({ filter: f, selectKey }) => {
        setFilter(f);
        setAppliedFilter(f);
        pendingSelect.current = selectKey;
        load(f);
      }),
    ];
    load();
    return () => offs.forEach((o) => o());
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = [...entries.values()];
    if (!q) return list;
    return list.filter((e) => e.key.toLowerCase().includes(q) || payloadPreview(e.data ?? "", 400).toLowerCase().includes(q));
  }, [entries, search]);

  const selectedEntry = selection?.type === "key" ? entries.get(selection.key) : undefined;
  const scoped = useMemo(() => {
    if (selection?.type !== "prefix") return visible;
    const p = selection.prefix;
    return visible.filter((e) => e.key === p || e.key.startsWith(p + SEP));
  }, [visible, selection]);

  const totalSize = useMemo(() => [...entries.values()].reduce((a, e) => a + e.size, 0), [entries]);

  return (
    <>
      <div class="page-header">
        <div class="title">
          <Icon name="database" />
          <h2>{init.bucket}</h2>
          <span class="muted small">KV bucket · {init.connName}</span>
        </div>
        <div class="row wrap">
          <Badge title="Revisions kept per key">history {status.history}</Badge>
          <Badge title="Per-key time to live">TTL {status.ttlMs ? fmtMillis(status.ttlMs) : "∞"}</Badge>
          <Badge>{status.storage}</Badge>
          <Badge title="Replicas">R{status.replicas}</Badge>
          <Badge title="Stored messages incl. history">{fmtNumber(status.values)} values</Badge>
          <Badge>{fmtBytes(status.bytes)}</Badge>
        </div>
        <div class="spacer" />
        <Button small variant="ghost" icon="info" title="Bucket status (JSON)" onClick={() => void rpc("bucketInfo")} />
      </div>
      <div class="toolbar">
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedFilter(filter);
            load(filter);
          }}
        >
          <input class="input mono" style={{ width: "220px" }} placeholder="key filter: app.> or *.url" title="Server-side NATS wildcard filter (* and >)" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          <Button small icon="filter" title="Apply filter" type="submit" />
        </form>
        <input class="input" style={{ width: "200px" }} placeholder="Search keys & values…" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
        <div class="seg">
          <button type="button" class={cx("seg-btn", view === "tree" && "seg-active")} onClick={() => setView("tree")} title="Group keys by '{SEP}'">
            <Icon name="list-tree" /> Tree
          </button>
          <button type="button" class={cx("seg-btn", view === "table" && "seg-active")} onClick={() => setView("table")}>
            <Icon name="table" /> Table
          </button>
        </div>
        <label class="check" title="Watch the bucket and apply changes as they happen">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).checked;
              setLive(v);
              if (v) load(appliedFilter, true);
              else void rpc("stopLive");
            }}
          />
          <span class={cx("dot", live && connState === "connected" ? "dot-ok dot-pulse" : "")} /> Live
        </label>
        <div class="spacer" />
        <Flash message={flash} />
        <Button small icon="add" onClick={() => setShowAdd(!showAdd)}>
          Add key
        </Button>
        <Button small icon="refresh" busy={loading} title="Reload" onClick={() => load()} />
        <Button
          small
          icon="export"
          title="Export visible keys as JSON"
          onClick={() =>
            void rpc<string | null>("export", { entries: visible }).then((p) => {
              if (p) setFlash(`Exported ${visible.length} keys`);
            })
          }
        />
      </div>
      {connState !== "connected" && <Notice tone="warn">Connection is {connState}. Live updates are paused.</Notice>}
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {truncated && (
        <Notice tone="warn">
          Showing the first {fmtNumber(init.maxKeys)} keys (setting <code>nats.kv.maxKeys</code>). Narrow the view with a key filter.
        </Notice>
      )}
      {showAdd && (
        <AddKey
          defaultPrefix={selection?.type === "prefix" ? selection.prefix + SEP : ""}
          onDone={(key) => {
            setShowAdd(false);
            if (key) {
              setFlash(`Created ${key}`);
              pendingSelect.current = key;
              setSelection({ type: "key", key });
              void rpc("refreshTree");
            }
          }}
        />
      )}
      <SplitPane initial={38} storageKey="kv">
        <div class="col grow" style={{ gap: 0 }}>
          <div class="list-head muted small">
            {loading ? "Loading…" : `${fmtNumber(visible.length)} key${visible.length === 1 ? "" : "s"}${search ? ` matching "${search}"` : ""} · ${fmtBytes(totalSize)}`}
          </div>
          {!loading && entries.size === 0 ? (
            <Empty icon="key" title={appliedFilter ? `No keys match "${appliedFilter}"` : "This bucket is empty"}>
              Use “Add key” to create one.
            </Empty>
          ) : view === "tree" ? (
            <KeyTree entries={visible} selection={selection} onSelect={setSelection} flashKeys={flashKeys} forceOpen={Boolean(search)} />
          ) : (
            <KeyTable entries={visible} selection={selection} onSelect={setSelection} flashKeys={flashKeys} />
          )}
        </div>
        <div class="col grow" style={{ gap: 0 }}>
          {selection?.type === "key" ? (
            selectedEntry ? (
              <KeyDetail
                key={selection.key}
                entry={selectedEntry}
                onDeleted={() => {
                  setFlash(`Deleted ${selection.key}`);
                  setSelection(null);
                  void rpc("refreshTree");
                }}
                flash={setFlash}
              />
            ) : (
              <Empty icon={deletedWhileOpen === selection.key ? "trash" : "search"} title={deletedWhileOpen === selection.key ? `"${selection.key}" was deleted` : loading ? "Loading…" : `"${selection.key}" not found`}>
                {deletedWhileOpen === selection.key ? "The key was deleted or purged on the server." : "It may have been deleted, or is excluded by the filter."}
              </Empty>
            )
          ) : (
            <Overview entries={scoped} prefix={selection?.type === "prefix" ? selection.prefix : undefined} total={entries.size} loading={loading && entries.size === 0} onSelectKey={(key) => setSelection({ type: "key", key })} />
          )}
        </div>
      </SplitPane>
    </>
  );
}

// --- left pane: tree --------------------------------------------------------------

function KeyTree({
  entries,
  selection,
  onSelect,
  flashKeys,
  forceOpen,
}: {
  entries: KvEntryDTO[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  flashKeys: Set<string>;
  forceOpen: boolean;
}) {
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const root = useMemo(() => buildKeyTree(entries.map((e) => e.key), SEP), [entries]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const autoExpanded = useRef(false);
  // Expand the top level once data arrives (when it is small enough to be useful).
  useEffect(() => {
    if (autoExpanded.current || root.children.size === 0) return;
    autoExpanded.current = true;
    if (root.children.size <= 12) setOpen(new Set([...root.children.keys()]));
  }, [root]);
  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const activate = (child: KeyTreeNode, isFolder: boolean) => {
    if (isFolder) {
      toggle(child.path);
      onSelect(child.isKey ? { type: "key", key: child.path } : { type: "prefix", prefix: child.path });
    } else onSelect({ type: "key", key: child.path });
  };
  const rows: preact.JSX.Element[] = [];
  const walk = (node: KeyTreeNode, depth: number) => {
    for (const child of sortedChildren(node)) {
      const isFolder = child.children.size > 0;
      const isOpen = forceOpen || open.has(child.path);
      const e = child.isKey ? byKey.get(child.path) : undefined;
      const selected = (selection?.type === "key" && selection.key === child.path) || (selection?.type === "prefix" && selection.prefix === child.path);
      const kind = e ? kindOf(e) : undefined;
      rows.push(
        <div
          key={child.path}
          class={cx("tree-row", selected && "selected", e && flashKeys.has(child.path) && "flash-row")}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          title={child.path}
          role="treeitem"
          tabIndex={0}
          aria-expanded={isFolder ? isOpen : undefined}
          aria-selected={selected}
          onClick={() => activate(child, isFolder)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              activate(child, isFolder);
            }
          }}
        >
          {isFolder ? <Icon name={isOpen ? "chevron-down" : "chevron-right"} class="twisty" /> : <span class="twisty" />}
          <Icon name={isFolder ? (child.isKey ? "symbol-object" : isOpen ? "folder-opened" : "folder") : "symbol-field"} class="tree-icon" />
          <span class="tree-name">{child.name}</span>
          {isFolder && <span class="muted small">{child.count}</span>}
          <span class="spacer" />
          {kind && <Badge tone={kind.tone}>{kind.label}</Badge>}
          {e && <span class="muted small num">{fmtBytes(e.size)}</span>}
        </div>,
      );
      if (isFolder && isOpen) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return (
    <div class="list tree" role="tree" aria-label="Keys">
      {rows}
    </div>
  );
}

// --- left pane: table --------------------------------------------------------------

type SortKey = "key" | "type" | "size" | "revision" | "created";

function KeyTable({ entries, selection, onSelect, flashKeys }: { entries: KvEntryDTO[]; selection: Selection; onSelect: (s: Selection) => void; flashKeys: Set<string> }) {
  const [sort, setSort] = useState<{ by: SortKey; dir: 1 | -1 }>({ by: "key", dir: 1 });
  const sorted = useMemo(() => {
    const collator = new Intl.Collator(undefined, { numeric: true });
    const val = (e: KvEntryDTO): string | number => (sort.by === "key" ? e.key : sort.by === "type" ? kindOf(e).label : sort.by === "size" ? e.size : sort.by === "revision" ? e.revision : Date.parse(e.created));
    return [...entries].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb))) * sort.dir;
    });
  }, [entries, sort]);
  const th = (by: SortKey, label: string, cls?: string) => (
    <th class={cls} style={{ cursor: "pointer" }} onClick={() => setSort((s) => ({ by, dir: s.by === by ? ((-s.dir) as 1 | -1) : 1 }))}>
      {label} {sort.by === by && <Icon name={sort.dir === 1 ? "arrow-up" : "arrow-down"} />}
    </th>
  );
  return (
    <div class="list">
      <table class="table">
        <thead>
          <tr>
            {th("key", "Key")}
            {th("type", "Type")}
            <th>Value</th>
            {th("size", "Size", "num")}
            {th("revision", "Rev", "num")}
            {th("created", "Updated")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => {
            const k = kindOf(e);
            return (
              <tr
                key={e.key}
                class={cx("clickable", selection?.type === "key" && selection.key === e.key && "selected", flashKeys.has(e.key) && "flash-row")}
                onClick={() => onSelect({ type: "key", key: e.key })}
              >
                <td class="mono">{e.key}</td>
                <td>
                  <Badge tone={k.tone}>{k.label}</Badge>
                </td>
                <td class="preview">{payloadPreview(e.data ?? "")}</td>
                <td class="num">{fmtBytes(e.size)}</td>
                <td class="num">{e.revision}</td>
                <td class="muted small" title={fmtTime(e.created)}>
                  {fmtAgo(e.created)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- right pane: overview / structure ----------------------------------------------

/** "37s ago" style age for the overview KPIs. */
function agoParts(iso: string | undefined): string {
  return iso ? fmtAgo(iso) : "–";
}

function Overview({ entries, prefix, total, loading, onSelectKey }: { entries: KvEntryDTO[]; prefix?: string; total: number; loading?: boolean; onSelectKey?: (key: string) => void }) {
  const [metric, setMetric] = useState<PrefixMetric>("keys");
  const stats = useMemo(() => {
    const kinds = new Map<string, number>();
    let size = 0;
    const jsonValues: unknown[] = [];
    let newest: KvEntryDTO | undefined;
    let largest: KvEntryDTO | undefined;
    const sizes: number[] = [];
    const times: number[] = [];
    for (const e of entries) {
      const k = kindOf(e).label;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      size += e.size;
      sizes.push(e.size);
      const t = Date.parse(e.created);
      if (Number.isFinite(t)) times.push(t);
      const j = jsonOf(e);
      if (j !== undefined && j !== null && typeof j === "object") jsonValues.push(j);
      if (!newest || e.revision > newest.revision) newest = e;
      if (!largest || e.size > largest.size) largest = e;
    }
    const sorted = [...sizes].sort((a, b) => a - b);
    const now = Date.now();
    const win = activityWindow(times, now);
    const buckets = win ? bucketize(times, { start: win.start, end: win.end, bucketMs: win.bucketMs, agg: "count" }) : [];
    return { kinds, size, shape: aggregateShape(jsonValues), newest, largest, sizes, sorted, win, buckets };
  }, [entries]);

  // Key-space treemap: skip a single shared prefix (the selected folder) so tiles show its contents.
  const space = useMemo(() => {
    let tiles = prefixTreemap(entries, SEP, metric, { maxChildren: 20, maxDepth: 5 });
    let root = init.bucket;
    while (tiles.length === 1 && tiles[0].children?.length) {
      root = `${tiles[0].id}${SEP}*`;
      tiles = tiles[0].children;
    }
    return { tiles, root };
  }, [entries, metric]);

  const donut = useMemo(
    () =>
      [...stats.kinds.entries()]
        .sort((a, b) => kindSlot(a[0]) - kindSlot(b[0]))
        .map(([label, value]) => ({ id: label, label, value, slot: kindSlot(label) })),
    [stats.kinds],
  );
  const n = entries.length;
  const pct = (q: number) => quantile(stats.sorted, q);
  const metricBtn = (m: PrefixMetric, label: string) => (
    <button type="button" aria-pressed={metric === m} class={cx("seg-btn", metric === m && "seg-active")} onClick={() => setMetric(m)}>
      {label}
    </button>
  );
  const scopeLabel = prefix ? (
    <>
      under <span class="mono">{`${prefix}${SEP}*`}</span>
    </>
  ) : (
    "in this view"
  );

  return (
    <div class="detail kv-overview">
      <div class="detail-header">
        <Icon name={prefix ? "folder-opened" : "database"} />
        <span class="detail-title">{prefix ? `${prefix}${SEP}*` : init.bucket}</span>
        <Badge>{fmtNumber(n)} keys</Badge>
        {prefix && <span class="muted small">of {fmtNumber(total)}</span>}
      </div>
      {!loading && n === 0 ? (
        <EmptyState compact kind="no-data" title={prefix ? "No keys under this prefix" : "Nothing to analyse yet"}>
          Sizes, value types, key space and change activity appear once keys exist {scopeLabel}. Use <b>Add key</b> in the toolbar to create one.
        </EmptyState>
      ) : (
        <>
          <KpiRow min={128} label="Overview metrics">
            <KpiTile label="Keys" value={loading ? undefined : n} unit="count" sub={prefix ? `of ${fmtNumber(total)} in the bucket` : "latest revision of each key"} hint="Keys in the current view (server-side filter and search applied). Deleted keys are not counted." loading={loading} />
            <KpiTile label="Value size" value={loading ? undefined : stats.size} unit="bytes" sub={n ? `avg ${formatValue(stats.size / n, "bytes")} per key` : undefined} hint="Sum of the current values' sizes (history revisions excluded)." loading={loading} />
            <KpiTile
              label="Largest value"
              value={loading ? undefined : stats.largest?.size}
              unit="bytes"
              sub={stats.largest ? <span class="mono">{stats.largest.key}</span> : undefined}
              hint="Biggest single value: large values slow down watchers and history."
              onClick={stats.largest && onSelectKey ? () => onSelectKey(stats.largest!.key) : undefined}
              loading={loading}
            />
            <KpiTile
              label="Last change"
              value={loading ? undefined : agoParts(stats.newest?.created)}
              sub={stats.newest ? <span class="mono">{stats.newest.key}</span> : undefined}
              hint={stats.newest ? `Revision ${stats.newest.revision} at ${fmtTime(stats.newest.created)}` : "Most recently written key"}
              onClick={stats.newest && onSelectKey ? () => onSelectKey(stats.newest!.key) : undefined}
              loading={loading}
            />
          </KpiRow>
          <Grid gap={10}>
            <Card
              span={6}
              title="Value sizes"
              subtitle="bytes per value · percentile markers"
              icon="symbol-ruler"
              loading={loading}
              tableView={() => (
                <ItemsTable
                  items={[
                    { label: "p50", value: pct(0.5) ?? 0 },
                    { label: "p95", value: pct(0.95) ?? 0 },
                    { label: "p99", value: pct(0.99) ?? 0 },
                    { label: "max", value: stats.sorted.at(-1) ?? 0 },
                  ]}
                  unit="bytes"
                  labelHeader="Percentile"
                  valueHeader="Value size"
                  caption="Value size percentiles"
                />
              )}
            >
              <SizeHistogram sizes={stats.sizes} sorted={stats.sorted} />
            </Card>
            <Card span={6} title="Value types" subtitle="keys by detected payload type" icon="symbol-misc" loading={loading} tableView={() => <ItemsTable items={donut.map((d) => ({ label: d.label, value: d.value }))} unit="count" labelHeader="Type" valueHeader="Keys" caption="Keys by value type" />}>
              <Donut label="Keys by value type" data={donut} unit="count" size={116} thickness={13} centerLabel="keys" emptyText="No values" />
            </Card>
            <Card
              span={12}
              title="Key space"
              subtitle={<>{metric === "keys" ? "keys" : "value bytes"} per prefix {scopeLabel} · click a folder to drill in, a key to open it</>}
              icon="type-hierarchy"
              loading={loading}
              actions={
                <div class="seg" role="group" aria-label="Size tiles by">
                  {metricBtn("keys", "Keys")}
                  {metricBtn("bytes", "Bytes")}
                </div>
              }
              tableView={() => <ItemsTable items={space.tiles.map((t) => ({ label: t.label, value: nodeValue(t as TreeNode) }))} unit={metric === "keys" ? "count" : "bytes"} labelHeader="Prefix / key" valueHeader={metric === "keys" ? "Keys" : "Bytes"} mono caption="Key space by prefix" />}
            >
              <Treemap
                label={`Key space by ${metric === "keys" ? "key count" : "value bytes"}`}
                data={space.tiles as TreeNode[]}
                unit={metric === "keys" ? "count" : "bytes"}
                height={200}
                rootLabel={space.root}
                separator={SEP || "."}
                onSelect={(node) => {
                  const key = node.children?.length ? undefined : tileKey(node.id);
                  if (key !== undefined && onSelectKey) onSelectKey(key);
                }}
                emptyText="No keys"
              />
            </Card>
            <Card
              span={12}
              title="Change activity"
              subtitle={stats.win ? `last write per key · ${stepLabel(stats.win.bucketMs)} buckets` : "last write per key"}
              icon="pulse"
              loading={loading}
              footer={<span>Each key counts once, at its latest revision. Open a key's History tab for earlier changes.</span>}
            >
              {stats.buckets.length ? <ActivityStrip label={`Keys last written per ${stats.win ? stepLabel(stats.win.bucketMs) : "bucket"}`} buckets={stats.buckets} bucketMs={stats.win!.bucketMs} unit="count" height={22} /> : <span class="muted small">No timestamps</span>}
            </Card>
            <Card
              span={12}
              title="Structure of JSON values"
              subtitle={stats.shape.documents ? `${fmtNumber(stats.shape.documents)} documents · field paths, types and presence` : undefined}
              icon="json"
              flush={stats.shape.documents > 0}
              loading={loading}
            >
              {stats.shape.documents === 0 ? (
                <p class="muted">No JSON objects or arrays {prefix ? "under this prefix" : "in this view"}. Select a key to inspect its value.</p>
              ) : (
                <div class="kv-shape-scroll">
                  <table class="table shape-table">
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Type</th>
                        <th class="num">Present</th>
                        <th>Examples</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.shape.rows
                        .filter((r) => r.path !== "")
                        .map((r) => {
                          const pctPresent = Math.round((r.present / stats.shape.documents) * 100);
                          return (
                            <tr key={r.path}>
                              <td class="mono" style={{ paddingLeft: `${8 + (r.depth - 1) * 14}px` }} title={r.path}>
                                {r.path.split(/\.(?=[^.]*$)/).pop()}
                              </td>
                              <td>
                                {Object.entries(r.types).map(([t, cnt]) => (
                                  <span key={t} class={cx("type-chip", `type-${t}`)} title={`${cnt}×`}>
                                    {t}
                                  </span>
                                ))}
                              </td>
                              <td class="num" title={`${r.present} of ${stats.shape.documents} documents`}>
                                <span class={pctPresent < 100 ? "muted" : ""}>{pctPresent}%</span>
                              </td>
                              <td class="preview" title={r.examples.join(", ")}>
                                {r.examples.join(", ")}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </Grid>
        </>
      )}
    </div>
  );
}

/** Value-size histogram; narrow panes keep only p50 / p99 so the marker labels do not collide. */
function SizeHistogram({ sizes, sorted }: { sizes: number[]; sorted: number[] }) {
  const [ref, { width }] = useElementSize<HTMLDivElement>();
  const markers: HistogramMarker[] | "percentiles" | undefined =
    sizes.length < 5
      ? undefined
      : width >= 420
        ? "percentiles"
        : [
            { value: quantile(sorted, 0.5) ?? 0, label: "p50", tone: "info" as const },
            { value: quantile(sorted, 0.99) ?? 0, label: "p99", tone: "danger" as const },
          ];
  return (
    <div ref={ref}>
      <Histogram label="Value size distribution" values={sizes} unit="bytes" markers={markers} countLabel="keys" height={150} emptyText="No values" />
    </div>
  );
}

// --- right pane: key detail -----------------------------------------------------------

function KeyDetail({ entry, onDeleted, flash }: { entry: KvEntryDTO; onDeleted: () => void; flash: (m: string) => void }) {
  const [tab, setTab] = useState<"value" | "edit" | "history" | "structure">("value");
  const [error, setError] = useState<string | null>(null);
  const kind = kindOf(entry);
  const json = jsonOf(entry);

  const del = async (purge: boolean) => {
    const ok = await rpc<boolean>("confirm", {
      message: `${purge ? "Purge" : "Delete"} key "${entry.key}"?`,
      detail: purge ? "Removes the key and all of its history." : "Writes a delete marker; history is kept until it rolls off.",
      action: purge ? "Purge" : "Delete",
    });
    if (!ok) return;
    try {
      await rpc(purge ? "purge" : "delete", { key: entry.key });
      onDeleted();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div class="detail">
      <div class="detail-header">
        <span class="detail-title">{entry.key}</span>
        <CopyButton text={entry.key} title="Copy key" />
      </div>
      <div class="row wrap">
        <Badge tone={kind.tone}>{kind.label}</Badge>
        <Badge title="Revision (stream sequence)">rev {entry.revision}</Badge>
        <Badge>{fmtBytes(entry.size)}</Badge>
        <span class="muted small" title={fmtTime(entry.created)}>
          updated {fmtAgo(entry.created)} · {fmtTime(entry.created)}
        </span>
        <div class="spacer" />
        <Button small icon="go-to-file" title="Open in editor (save with Ctrl+S)" onClick={() => void rpc("openInEditor", { key: entry.key })}>
          Editor
        </Button>
        <Button small icon="trash" variant="ghost" title="Delete key" onClick={() => void del(false)} />
        <Button small icon="clear-all" variant="ghost" title="Purge key and history" onClick={() => void del(true)} />
      </div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {entry.truncated && <Notice tone="warn">Value is larger than 256 KiB — showing the beginning only. Open it in the editor for the full value.</Notice>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "value", label: "Value", icon: "eye" },
          { id: "edit", label: "Edit", icon: "edit", disabled: kind.label === "binary" || entry.truncated },
          { id: "history", label: "History", icon: "history" },
          { id: "structure", label: "Structure", icon: "type-hierarchy", disabled: json === undefined || json === null || typeof json !== "object" },
        ]}
      />
      {tab === "value" && <PayloadView data={entry.data ?? ""} showHeaders={false} />}
      {tab === "edit" && <Editor entry={entry} onSaved={(rev) => (flash(`Saved revision ${rev}`), setTab("value"))} />}
      {tab === "history" && <History entry={entry} flash={flash} />}
      {tab === "structure" && <Structure value={json} />}
    </div>
  );
}

function Editor({ entry, onSaved }: { entry: KvEntryDTO; onSaved: (rev: number) => void }) {
  const original = useMemo(() => {
    const bytes = base64ToBytes(entry.data ?? "");
    const d = detect(bytes);
    if (d.format === "json" && (d.kind === "object" || d.kind === "array")) return { text: JSON.stringify(d.json, null, 2), compact: !/\n/.test(d.text ?? "") };
    return { text: utf8DecodeStrict(bytes) ?? "", compact: false };
  }, [entry.key]);
  const [text, setText] = useState(original.text);
  const [baseRev, setBaseRev] = useState(entry.revision);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changedRemotely = entry.revision !== baseRev;

  let jsonError: string | null = null;
  const looksJson = /^\s*[[{]/.test(text);
  if (looksJson) {
    try {
      JSON.parse(text);
    } catch (e) {
      jsonError = (e as Error).message;
    }
  }

  const save = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let out = text;
      if (original.compact && looksJson && !jsonError) out = JSON.stringify(JSON.parse(text));
      const rev = await rpc<number>("put", { key: entry.key, data: bytesToBase64(utf8Encode(out)), revision: force ? undefined : baseRev });
      onSaved(rev);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="col grow">
      {changedRemotely && (
        <Notice tone="warn">
          The key changed on the server (now rev {entry.revision}) while you were editing.{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              const d = detect(base64ToBytes(entry.data ?? ""));
              setText(d.format === "json" ? JSON.stringify(d.json, null, 2) : (d.text ?? ""));
              setBaseRev(entry.revision);
            }}
          >
            Load the new value
          </a>{" "}
          or overwrite it.
        </Notice>
      )}
      <textarea class="input grow" style={{ minHeight: "220px" }} spellcheck={false} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
      <div class="row wrap">
        <Button variant="primary" icon="save" busy={busy} disabled={text === original.text && !changedRemotely} onClick={() => void save(false)} title="Save only if the key is still at the revision you started from">
          Save (rev {baseRev} → new)
        </Button>
        {(changedRemotely || error?.startsWith("Conflict")) && (
          <Button variant="danger" icon="warning" onClick={() => void save(true)}>
            Overwrite
          </Button>
        )}
        {looksJson && (
          <Button
            icon="symbol-namespace"
            disabled={Boolean(jsonError)}
            onClick={() => {
              try {
                setText(JSON.stringify(JSON.parse(text), null, 2));
              } catch {
                /* invalid */
              }
            }}
          >
            Format JSON
          </Button>
        )}
        <Button variant="ghost" onClick={() => setText(original.text)}>
          Revert
        </Button>
        <span class={jsonError ? "small" : "muted small"} style={jsonError ? { color: "var(--danger)" } : undefined}>
          {looksJson ? (jsonError ? `Invalid JSON: ${jsonError}` : original.compact ? "Valid JSON · stored compact on save" : "Valid JSON") : "Plain text (UTF-8)"}
        </span>
      </div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
    </div>
  );
}

function History({ entry, flash }: { entry: KvEntryDTO; flash: (m: string) => void }) {
  const [revs, setRevs] = useState<KvEntryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    setRevs(null);
    rpc<KvEntryDTO[]>("history", { key: entry.key })
      .then((r) => {
        setRevs(r);
        setSelected(r.find((x) => x.revision !== entry.revision && x.operation === "PUT")?.revision ?? r[0]?.revision ?? null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [entry.key, entry.revision]);
  if (error) return <ErrorBanner error={error} />;
  if (!revs) return <p class="muted">Loading history…</p>;
  const sel = revs.find((r) => r.revision === selected);
  return (
    <div class="col grow">
      <table class="table">
        <thead>
          <tr>
            <th class="num">Rev</th>
            <th>Op</th>
            <th>When</th>
            <th class="num">Size</th>
            <th>Value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {revs.map((r) => (
            <tr key={r.revision} class={cx("clickable", selected === r.revision && "selected")} onClick={() => setSelected(r.revision)}>
              <td class="num">{r.revision}</td>
              <td>
                <Badge tone={r.operation === "PUT" ? (r.revision === entry.revision ? "ok" : "neutral") : "danger"}>{r.revision === entry.revision ? "current" : r.operation}</Badge>
              </td>
              <td class="muted small" title={fmtTime(r.created)}>
                {fmtAgo(r.created)}
              </td>
              <td class="num">{fmtBytes(r.size)}</td>
              <td class="preview">{r.operation === "PUT" ? payloadPreview(r.data ?? "", 80) : ""}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {r.operation === "PUT" && r.revision !== entry.revision && (
                  <>
                    <Button small variant="ghost" icon="diff" title="Compare with current (VS Code diff)" onClick={(e) => (e.stopPropagation(), void rpc("diff", { key: entry.key, revision: r.revision }))} />
                    <Button
                      small
                      variant="ghost"
                      icon="discard"
                      title="Restore this revision (writes it as a new revision)"
                      onClick={(e) => {
                        e.stopPropagation();
                        void rpc<boolean>("confirm", { message: `Restore revision ${r.revision} of "${entry.key}"?`, detail: "Its value is written as a new revision.", action: "Restore" }).then(async (ok) => {
                          if (!ok) return;
                          const rev = await rpc<number>("put", { key: entry.key, data: r.data ?? "" });
                          flash(`Restored as revision ${rev}`);
                        });
                      }}
                    />
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {revs.length === 1 && <p class="muted small">Only one revision kept — the bucket keeps history {init.status.history}.</p>}
      {sel && sel.operation === "PUT" && (
        <>
          <h3>Revision {sel.revision}</h3>
          <PayloadView data={sel.data ?? ""} showHeaders={false} maxHeight="300px" />
        </>
      )}
    </div>
  );
}

function Structure({ value }: { value: unknown }) {
  const rows = useMemo(() => describeShape(value, 400), [value]);
  return (
    <div class="list">
      <table class="table shape-table">
        <thead>
          <tr>
            <th>Path</th>
            <th>Type</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path}>
              <td class="mono">{r.path}</td>
              <td>
                <span class={cx("type-chip", `type-${r.type.split(" ")[0]}`)}>{r.type}</span>
              </td>
              <td class="preview">{r.sample ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddKey({ defaultPrefix, onDone }: { defaultPrefix: string; onDone: (key?: string) => void }) {
  const [key, setKey] = useState(defaultPrefix);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyError = key ? validateKvKey(key) : undefined;
  const submit = async () => {
    if (validateKvKey(key)) return setError(validateKvKey(key)!);
    setBusy(true);
    setError(null);
    try {
      await rpc("create", { key, data: bytesToBase64(utf8Encode(value)) });
      onDone(key);
    } catch (e) {
      const msg = String((e as Error).message);
      setError(/wrong last sequence|exists/i.test(msg) ? `Key "${key}" already exists` : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="add-key col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div class="row">
        <input class={cx("input mono grow", keyError && "invalid")} placeholder="key, e.g. app.db.host" value={key} autofocus onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
        <Button variant="primary" icon="check" busy={busy} type="submit" disabled={!key || Boolean(keyError)}>
          Create
        </Button>
        <Button variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
      {keyError && <span class="small" style={{ color: "var(--danger)" }}>{keyError}</span>}
      <textarea class="input" placeholder='value — text or JSON, e.g. {"enabled": true}' value={value} onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)} />
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
    </form>
  );
}

render(<App />, document.getElementById("root")!);

// JetStream topology: interactive SVG graph of an account — subject patterns → streams
// (streams / KV buckets / object stores, mirrors and sources) → consumers, plus micro-service
// endpoints attached to the streams whose subjects overlap theirs. Pan / zoom, fit, search,
// filters, lineage highlight, hover cards, pinned action cards, list view and SVG export.
import "./lib/styles.css";
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { getInit, getState, onEvent, rpc, setState } from "./lib/vscode";
import { Button, cx, ErrorBanner, Icon, Kbd, useDebounced } from "./lib/ui";
import {
  Card,
  Chip,
  ConnectionBanner,
  DashboardHeader,
  DashboardPage,
  DataTable,
  EmptyState,
  FilterBar,
  Grid,
  KeyValueGrid,
  KpiRow,
  KpiTile,
  RefreshIndicator,
  type Column,
  type ConnectionState,
} from "./lib/dashboard";
import { BarList, ChartTooltip, fitText, HealthPill, Legend, TipHead, TipRow, ToneIcon, TONE_LABEL, usePolling, useElementSize, type LegendItem, type Tone } from "./lib/charts";
import {
  buildGraph,
  DEFAULT_FILTERS,
  fmtCount,
  lineage,
  moreConsumersNodeId,
  topologyTotals,
  type Graph,
  type GraphEdge,
  type GraphFilters,
  type GraphNode,
  type HealthThresholds,
  type NodeKind,
  type TopologyData,
} from "../src/admin/topologyModel";
import { edgeMidpoint, edgePath, layoutGraph, type Layout, type PositionedNode } from "../src/admin/graphLayout";
import { GLYPHS, type GlyphName } from "../src/admin/glyphs";
import type { HealthLite, TopologyInit, TopologyOpenParams } from "../src/panels/topologyPanel";
import "./topology.css";

const init = getInit<TopologyInit>();

// ---------------------------------------------------------------------------------------------
// Visual constants
// ---------------------------------------------------------------------------------------------

const SIZE: Record<NodeKind, { w: number; h: number }> = {
  subject: { w: 176, h: 28 },
  external: { w: 184, h: 40 },
  stream: { w: 208, h: 46 },
  kv: { w: 208, h: 46 },
  obj: { w: 208, h: 46 },
  consumer: { w: 200, h: 42 },
  endpoint: { w: 216, h: 42 },
};

const KIND_META: Record<NodeKind, { label: string; plural: string; glyph: GlyphName; icon: string; color: string }> = {
  subject: { label: "Subject pattern", plural: "Subjects", glyph: "subject", icon: "symbol-namespace", color: "var(--tp-subject)" },
  external: { label: "External origin", plural: "External", glyph: "external", icon: "globe", color: "var(--tp-external)" },
  stream: { label: "Stream", plural: "Streams", glyph: "stream", icon: "database", color: "var(--tp-stream)" },
  kv: { label: "KV bucket", plural: "KV buckets", glyph: "kv", icon: "key", color: "var(--tp-kv)" },
  obj: { label: "Object store", plural: "Object stores", glyph: "obj", icon: "package", color: "var(--tp-obj)" },
  consumer: { label: "Consumer", plural: "Consumers", glyph: "consumer", icon: "inbox", color: "var(--tp-consumer)" },
  endpoint: { label: "Service endpoint", plural: "Endpoints", glyph: "endpoint", icon: "plug", color: "var(--tp-endpoint)" },
};

const GROUP_RANK: Partial<Record<NodeKind, number>> = { stream: 2, kv: 3, obj: 4 };

const FILTER_CHIPS: { key: keyof GraphFilters; label: string; icon: string; title: string }[] = [
  { key: "subjects", label: "Subjects", icon: "symbol-namespace", title: "Subject patterns captured by each stream" },
  { key: "consumers", label: "Consumers", icon: "inbox", title: "Consumers with their pending count" },
  { key: "kv", label: "KV buckets", icon: "key", title: "Key-Value buckets (KV_* streams)" },
  { key: "obj", label: "Object stores", icon: "package", title: "Object stores (OBJ_* streams)" },
  { key: "services", label: "Services", icon: "plug", title: "Micro-service endpoints ($SRV discovery)" },
];

interface Saved {
  filters?: GraphFilters;
  view?: View;
  mode?: "graph" | "list";
  legend?: boolean;
}

interface View {
  x: number;
  y: number;
  k: number;
}

type ConnState = ConnectionState;

interface Action {
  id: string;
  label: string;
  icon: string;
  params: TopologyOpenParams;
}

function actionsFor(n: GraphNode): Action[] {
  const r = n.ref;
  switch (n.kind) {
    case "stream":
      return [
        { id: "browse", label: "Browse messages", icon: "list-flat", params: { action: "browse", stream: r.stream } },
        { id: "info", label: "Stream info", icon: "json", params: { action: "streamInfo", stream: r.stream } },
      ];
    case "kv":
      return [
        { id: "kv", label: "Open KV browser", icon: "key", params: { action: "kvBrowser", bucket: r.bucket } },
        { id: "info", label: "Bucket info", icon: "json", params: { action: "kvInfo", bucket: r.bucket } },
        { id: "browse", label: "Browse backing stream", icon: "list-flat", params: { action: "browse", stream: r.stream } },
      ];
    case "obj":
      return [
        { id: "info", label: "Object store info", icon: "json", params: { action: "objInfo", bucket: r.bucket } },
        { id: "browse", label: "Browse backing stream", icon: "list-flat", params: { action: "browse", stream: r.stream } },
      ];
    case "consumer":
      if (!r.consumer)
        return [
          { id: "browse", label: `Browse ${r.stream}`, icon: "list-flat", params: { action: "browse", stream: r.stream } },
          { id: "info", label: "Stream info", icon: "json", params: { action: "streamInfo", stream: r.stream } },
        ];
      return [
        { id: "lab", label: "Open Consumer Lab", icon: "beaker", params: { action: "consumerLab", stream: r.stream, consumer: r.consumer } },
        { id: "info", label: "Consumer info", icon: "json", params: { action: "consumerInfo", stream: r.stream, consumer: r.consumer } },
      ];
    case "subject":
      return r.subject
        ? [
            { id: "tail", label: "Live tail subject", icon: "pulse", params: { action: "liveTail", subject: r.subject } },
            { id: "browse", label: `Browse ${r.stream}`, icon: "list-flat", params: { action: "browse", stream: r.stream, subject: r.subject } },
          ]
        : [{ id: "browse", label: `Browse ${r.stream}`, icon: "list-flat", params: { action: "browse", stream: r.stream } }];
    case "endpoint":
      return [
        { id: "request", label: "Send a request", icon: "send", params: { action: "request", subject: r.subject } },
        { id: "info", label: "Service info", icon: "json", params: { action: "serviceInfo", service: r.service } },
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Text fitting (memoised: canvas measurement is the hot path for big graphs)
// ---------------------------------------------------------------------------------------------

const fitCache = new Map<string, string>();
function fit(text: string, px: number, size: number, mono = false): string {
  const key = `${px}|${size}|${mono ? 1 : 0}|${text}`;
  let v = fitCache.get(key);
  if (v === undefined) {
    v = fitText(text, px, size, mono);
    if (fitCache.size > 5000) fitCache.clear();
    fitCache.set(key, v);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

function App() {
  const saved = useMemo(() => getState<Saved>() ?? {}, []);
  const [filters, setFilters] = useState<GraphFilters>({ ...DEFAULT_FILTERS, ...saved.filters });
  const [mode, setMode] = useState<"graph" | "list">(saved.mode ?? "graph");
  const [legendOpen, setLegendOpen] = useState(saved.legend ?? true);
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim().toLowerCase(), 120);
  const [matchIdx, setMatchIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [conn, setConn] = useState<{ state: ConnState; error?: string }>({ state: init.state });
  const [health, setHealth] = useState<HealthLite | undefined>(init.health);
  const [thresholds, setThresholds] = useState<HealthThresholds>(init.thresholds);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<{ id: string; seq: number } | undefined>();
  const viewRef = useRef<View | undefined>(saved.view);

  useEffect(() => {
    const offs = [
      onEvent<{ visible: boolean }>("visible", (d) => setVisible(d.visible)),
      onEvent<{ state: ConnState; error?: string }>("connection", (d) => setConn(d)),
      onEvent<HealthLite | undefined>("health", (h) => setHealth(h ?? undefined)),
      onEvent<HealthThresholds>("thresholds", (t) => setThresholds(t)),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const live = conn.state === "connected";
  const poll = usePolling(() => rpc<TopologyData>("snapshot"), init.refreshInterval, visible && !paused && live);
  const data = poll.data;

  const persist = useCallback((patch: Partial<Saved>) => {
    const cur = getState<Saved>() ?? {};
    setState({ ...cur, ...patch });
  }, []);
  useEffect(() => persist({ filters, mode, legend: legendOpen }), [filters, mode, legendOpen]);

  const graph = useMemo(() => (data ? buildGraph(data, filters, thresholds) : undefined), [data, filters, thresholds]);
  const totals = useMemo(() => (data ? topologyTotals(data, buildGraph(data, DEFAULT_FILTERS, thresholds)) : undefined), [data, thresholds]);

  const matches = useMemo(() => {
    if (!graph || !q) return [] as string[];
    const terms = q.split(/\s+/).filter(Boolean);
    return graph.nodes.filter((n) => terms.every((t) => n.search.includes(t) || n.label.toLowerCase().includes(t))).map((n) => n.id);
  }, [graph, q]);
  useEffect(() => setMatchIdx(0), [q]);

  const issueNodes = useMemo(() => (graph ? graph.nodes.filter((n) => n.tone === "warn" || n.tone === "danger").sort((a, b) => (a.tone === b.tone ? a.label.localeCompare(b.label) : a.tone === "danger" ? -1 : 1)) : []), [graph]);

  const focusNode = useCallback(
    (id: string) => {
      // a consumer folded into "+N more consumers" is shown through that node
      let target = id;
      if (graph && !graph.nodes.some((n) => n.id === id)) {
        const m = /^cons:([^/]+)\//.exec(id);
        if (m && graph.nodes.some((n) => n.id === moreConsumersNodeId(m[1]))) target = moreConsumersNodeId(m[1]);
      }
      setMode("graph");
      setFocusReq((r) => ({ id: target, seq: (r?.seq ?? 0) + 1 }));
    },
    [graph],
  );

  const doExport = () => {
    if (mode === "graph") return exportSvg(setError);
    // the export serialises the rendered graph: switch to it first
    setMode("graph");
    requestAnimationFrame(() => requestAnimationFrame(() => exportSvg(setError)));
  };

  const open = useCallback((params: TopologyOpenParams) => {
    setError(null);
    rpc("open", params).catch((e: Error) => setError(e.message));
  }, []);

  const stale = !live || (!!poll.error && !!data);
  const loading = poll.loading && !data && live;
  const env = init.environment;

  const header = (
    <DashboardHeader
      icon="type-hierarchy"
      title="JetStream topology"
      subtitle={
        <>
          <span class="mono">{init.serverName ?? "server"}</span>
          {init.cluster && (
            <>
              {" "}
              · cluster <span class="mono">{init.cluster}</span>
            </>
          )}
          {data?.account && (
            <>
              {" "}
              · account <span class="mono">{data.account}</span>
            </>
          )}
        </>
      }
      env={env}
      connectionName={init.profileName}
      readOnly={init.readOnly}
      status={statusOf(conn.state)}
      actions={
        <>
          <Button variant="ghost" small icon="export" title="Export the whole graph as an SVG file" aria-label="Export SVG" disabled={!graph?.nodes.length} onClick={doExport} />
          <Button variant="ghost" small icon="refresh" title="Refresh now" aria-label="Refresh now" busy={poll.refreshing} disabled={!live} onClick={() => void poll.refresh()} />
        </>
      }
      meta={
        <>
          {health ? (
            <HealthPill score={health.score} size="sm" title={`Health ${health.score}/100 · ${health.errors} errors · ${health.warnings} warnings (checked ${new Date(health.at).toLocaleTimeString()})${health.top.length ? `\n${health.top.map((t) => `• ${t.title}`).join("\n")}` : ""}`} onClick={() => void rpc("runCommand", { id: "nats.openHealthDashboard" }).catch(() => undefined)} />
          ) : (
            <HealthPill score={undefined} size="sm" title="No health check has run for this connection yet" />
          )}
          {init.serverUrl && (
            <Chip icon="plug" mono size="sm" title="Connected server URL">
              {init.serverUrl}
            </Chip>
          )}
          {data && !data.jetstream && (
            <Chip icon="circle-slash" tone="warn" size="sm" title={data.jetstreamError}>
              JetStream unavailable
            </Chip>
          )}
        </>
      }
    />
  );

  return (
    <DashboardPage header={header} label="JetStream topology">
      <FilterBar label="Graph filters">
        <SearchBox value={query} onInput={setQuery} matches={matches.length} index={matchIdx} onStep={(d) => setMatchIdx((i) => (matches.length ? (i + d + matches.length) % matches.length : 0))} />
        <div class="tp-chips" role="group" aria-label="Show node types">
          {FILTER_CHIPS.map((c) => (
            <Chip key={c.key} icon={c.icon} selected={filters[c.key]} title={`${filters[c.key] ? "Hide" : "Show"} ${c.label.toLowerCase()} — ${c.title}`} onClick={() => setFilters((f) => ({ ...f, [c.key]: !f[c.key] }))}>
              {c.label}
            </Chip>
          ))}
          <Chip icon="warning" selected={issuesOnly} tone={issuesOnly ? "warn" : undefined} title="Highlight nodes with problems and everything connected to them" onClick={() => setIssuesOnly((v) => !v)}>
            Issues{issueNodes.length ? ` (${issueNodes.length})` : ""}
          </Chip>
        </div>
        <span class="spacer" />
        <RefreshIndicator updatedAt={poll.updatedAt} paused={paused} suspended={poll.suspended || !visible} refreshing={poll.refreshing} error={!live ? conn.state : poll.error} intervalMs={init.refreshInterval} onTogglePause={() => setPaused((p) => !p)} onRefresh={() => void poll.refresh()} />
      </FilterBar>
      <ConnectionBanner state={conn.state} message={conn.error} since={poll.updatedAt} onRetry={() => void rpc("reconnect").catch((e: Error) => setError(e.message))} />
      <ErrorBanner error={error ?? (poll.error && data ? `Refresh failed: ${poll.error}` : null)} onDismiss={() => setError(null)} />
      {data?.warnings.map((w) => (
        <div class="banner banner-warn" key={w}>
          <Icon name="warning" />
          <span class="banner-text">{w}</span>
        </div>
      ))}

      <KpiRow min={136} label="Topology summary">
        <KpiTile label="Streams" value={totals?.streams} unit="count" loading={loading} stale={stale} hint="Streams in this account, excluding KV and Object Store backing streams." />
        <KpiTile label="Buckets" value={totals ? totals.kv + totals.obj : undefined} unit="count" sub={totals ? `${totals.kv} KV · ${totals.obj} object` : undefined} loading={loading} stale={stale} hint="Key-Value buckets (KV_* backing streams) and object stores (OBJ_* backing streams)." />
        <KpiTile label="Consumers" value={totals?.consumers} unit="count" loading={loading} stale={stale} hint="Durable and ephemeral consumers across all streams." />
        <KpiTile label="Endpoints" value={totals?.endpoints} unit="count" sub={totals ? `${totals.services} service${totals.services === 1 ? "" : "s"}` : undefined} loading={loading} stale={stale} hint="Micro-service endpoints discovered with $SRV.INFO / $SRV.STATS." />
        <KpiTile label="Messages" value={totals?.messages} unit="msgs" loading={loading} stale={stale} hint="Sum of messages across all streams, buckets and stores." />
        <KpiTile label="Data stored" value={totals?.bytes} unit="bytes" loading={loading} stale={stale} hint="Sum of stream sizes (bytes on disk / in memory)." />
        <KpiTile label="Pending" value={totals?.pending} unit="msgs" sub={totals ? `${fmtCount(totals.ackPending)} awaiting ack` : undefined} tone={totals && totals.pending > thresholds.pendingWarning ? "warn" : undefined} loading={loading} stale={stale} hint={`Messages not yet delivered to consumers (num_pending), summed. Consumers above ${thresholds.pendingWarning.toLocaleString("en-US")} pending are flagged (nats.health.pendingWarning).`} />
        <KpiTile
          label="Issues"
          value={totals ? totals.issues.warn + totals.issues.danger : undefined}
          unit="count"
          tone={!totals ? undefined : totals.issues.danger ? "danger" : totals.issues.warn ? "warn" : "ok"}
          sub={totals ? `${totals.issues.danger} critical · ${totals.issues.warn} warnings` : undefined}
          loading={loading}
          stale={stale}
          hint="Nodes over a health threshold: pending, ack pending, storage limits, mirror/source lag, endpoint errors. Click to highlight them."
          onClick={totals && totals.issues.warn + totals.issues.danger > 0 ? () => setIssuesOnly((v) => !v) : undefined}
        />
      </KpiRow>

      <Card
        title="Topology graph"
        icon="type-hierarchy"
        subtitle={graph ? `${graph.nodes.length} nodes · ${graph.edges.length} edges` : undefined}
        flush
        loading={loading}
        minHeight={420}
        stale={stale}
        class="tp-graph-card"
        actions={
          <div class="seg" role="radiogroup" aria-label="View">
            {(["graph", "list"] as const).map((m) => (
              <button type="button" key={m} role="radio" aria-checked={mode === m} class={cx("seg-btn", mode === m && "seg-active")} onClick={() => setMode(m)} title={m === "graph" ? "Graph view" : "List view (accessible table of every node)"}>
                <Icon name={m === "graph" ? "type-hierarchy" : "list-flat"} /> {m === "graph" ? "Graph" : "List"}
              </button>
            ))}
          </div>
        }
      >
        {!data && !live ? (
          <EmptyState kind="no-connection" title="Not connected" primary={{ label: "Reconnect", icon: "plug", onClick: () => void rpc("reconnect").catch((e: Error) => setError(e.message)) }}>
            The topology of <span class="mono">{init.profileName}</span> loads once the connection is back.
          </EmptyState>
        ) : !data && poll.error ? (
          <EmptyState kind="error" title="Could not load the topology" primary={{ label: "Retry", icon: "refresh", onClick: () => void poll.refresh() }}>
            {poll.error}
          </EmptyState>
        ) : data && graph && !graph.nodes.length ? (
          <EmptyGraph data={data} filters={filters} onReset={() => setFilters(DEFAULT_FILTERS)} />
        ) : graph && mode === "graph" ? (
          <GraphCanvas
            graph={graph}
            matches={matches}
            matchIdx={matchIdx}
            issuesOnly={issuesOnly}
            focusReq={focusReq}
            legendOpen={legendOpen}
            setLegendOpen={setLegendOpen}
            initialView={viewRef.current}
            onView={(v) => {
              viewRef.current = v;
              persist({ view: v });
            }}
            onOpen={open}
          />
        ) : graph ? (
          <NodeTable graph={graph} onShow={focusNode} onOpen={open} />
        ) : null}
      </Card>

      <Grid>
        <Card span={6} title="Issues" icon="warning" subtitle={issueNodes.length ? `${issueNodes.length} node${issueNodes.length === 1 ? "" : "s"} over a threshold` : "health thresholds from nats.health.*"} loading={loading} stale={stale} minHeight={180} flush={issueNodes.length > 0}>
          {graph ? <IssuesList nodes={issueNodes} onShow={focusNode} onOpen={open} thresholds={thresholds} /> : <div class="small muted tp-wait">Waiting for data…</div>}
        </Card>
        <Card span={3} title="Largest streams" icon="database" subtitle="bytes stored" loading={loading} stale={stale} minHeight={180}>
          <BarList
            label="Largest streams by stored bytes"
            unit="bytes"
            mono
            limit={8}
            showShare
            items={(data?.streams ?? []).filter((s) => s.bytes > 0).map((s) => ({ id: `stream:${s.name}`, label: s.bucket ? `${s.bucket} (${s.kind.toUpperCase()})` : s.name, value: s.bytes, secondary: `${fmtCount(s.messages)} msgs`, hint: `${s.name}: ${fmtCount(s.messages)} messages` }))}
            onSelect={(it) => it.id && focusNode(it.id)}
            emptyText={data ? "No stored data yet" : "Waiting for data…"}
          />
        </Card>
        <Card span={3} title="Consumer backlog" icon="inbox" subtitle="pending messages" loading={loading} stale={stale} minHeight={180}>
          <BarList
            label="Consumers by pending messages"
            unit="msgs"
            mono
            limit={8}
            items={(data?.consumers ?? [])
              .filter((c) => c.pending > 0)
              .map((c) => {
                const n = graph?.nodes.find((x) => x.id === `cons:${c.stream}/${c.name}`);
                return { id: `cons:${c.stream}/${c.name}`, label: `${c.stream}/${c.name}`, value: c.pending, tone: n && (n.tone === "warn" || n.tone === "danger") ? n.tone : undefined, secondary: `${fmtCount(c.ackPending)} ack pending`, hint: n?.issues.join("; ") || undefined };
              })}
            onSelect={(it) => it.id && focusNode(it.id)}
            emptyText={data ? "Every consumer is caught up" : "Waiting for data…"}
          />
        </Card>
      </Grid>
    </DashboardPage>
  );
}

function statusOf(state: ConnState): { tone: Tone; label: string; pulse?: boolean } {
  switch (state) {
    case "connected":
      return { tone: "ok", label: "Connected", pulse: true };
    case "connecting":
      return { tone: "info", label: "Connecting" };
    case "reconnecting":
      return { tone: "warn", label: "Reconnecting" };
    case "error":
      return { tone: "danger", label: "Connection error" };
    default:
      return { tone: "danger", label: "Disconnected" };
  }
}

function SearchBox({ value, onInput, matches, index, onStep }: { value: string; onInput: (v: string) => void; matches: number; index: number; onStep: (d: number) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div class="tp-search" role="search">
      <Icon name="search" />
      <input
        ref={ref}
        class="input input-sm"
        type="search"
        name="topology-search"
        placeholder="Find stream, subject, consumer…"
        aria-label="Search nodes (press / to focus)"
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") onInput("");
        }}
      />
      {value.trim() && (
        <>
          <span class={cx("tp-search-count", !matches && "tone-warn")} aria-live="polite">
            {matches ? `${index + 1} of ${matches}` : "no match"}
          </span>
          <Button variant="ghost" small icon="arrow-up" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!matches} onClick={() => onStep(-1)} />
          <Button variant="ghost" small icon="arrow-down" title="Next match (Enter)" aria-label="Next match" disabled={!matches} onClick={() => onStep(1)} />
        </>
      )}
    </div>
  );
}

function EmptyGraph({ data, filters, onReset }: { data: TopologyData; filters: GraphFilters; onReset: () => void }) {
  const filtered = Object.values(filters).some((v) => !v) && (data.streams.length > 0 || data.endpoints.length > 0);
  if (filtered)
    return (
      <EmptyState kind="search" title="Everything is filtered out" secondary={{ label: "Show all node types", icon: "eye", onClick: onReset }}>
        The current filters hide every node. Turn node types back on to see the topology.
      </EmptyState>
    );
  if (!data.jetstream)
    return (
      <EmptyState kind="error" title="JetStream is not available for this account" secondary={{ label: "Open cluster overview", icon: "server-environment", onClick: () => void rpc("runCommand", { id: "nats.openCluster" }).catch(() => undefined) }}>
        {data.jetstreamError ? <div class="mono small">{data.jetstreamError}</div> : null}
        Start the server with <span class="mono">-js</span> (or enable JetStream for the account) to see streams, consumers and buckets. No service endpoints answered <span class="mono">$SRV.PING</span> either.
      </EmptyState>
    );
  return (
    <EmptyState kind="no-data" title="No streams yet" primary={init.readOnly ? undefined : { label: "Create stream", icon: "add", onClick: () => void rpc("runCommand", { id: "nats.createStream" }).catch(() => undefined) }}>
      This account has no streams, buckets or service endpoints. {init.readOnly ? "The connection is read-only, so streams must be created elsewhere." : "Create a stream to capture subjects, then add consumers."}
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------------------------
// Graph canvas: pan / zoom / keyboard, nodes, edges, overlays
// ---------------------------------------------------------------------------------------------

interface CanvasProps {
  graph: Graph;
  matches: string[];
  matchIdx: number;
  issuesOnly: boolean;
  focusReq?: { id: string; seq: number };
  legendOpen: boolean;
  setLegendOpen: (v: boolean) => void;
  initialView?: View;
  onView: (v: View) => void;
  onOpen: (p: TopologyOpenParams) => void;
}

const PAD = 28;

function GraphCanvas({ graph, matches, matchIdx, issuesOnly, focusReq, legendOpen, setLegendOpen, initialView, onView, onOpen }: CanvasProps) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const aspect = size.width && size.height ? Math.min(3, Math.max(0.8, Math.round((size.width / size.height) * 2) / 2)) : 1.8;
  const structureKey = useMemo(() => `${graph.nodes.map((n) => n.id).join("\n")}\u0001${graph.edges.map((e) => e.id).join("\n")}`, [graph]);
  const layout = useMemo<Layout>(
    () =>
      layoutGraph(
        graph.nodes.map((n) => ({ id: n.id, width: SIZE[n.kind].w, height: SIZE[n.kind].h, order: n.order, groupKey: GROUP_RANK[n.kind] !== undefined ? `${GROUP_RANK[n.kind]}:${n.ref.stream ?? n.label}` : `9:${n.order}` })),
        graph.edges,
        { layerGap: 64, nodeGap: 10, componentGap: 26, aspect },
      ),
    [structureKey, aspect],
  );
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const edgeById = useMemo(() => new Map(graph.edges.map((e) => [e.id, e])), [graph]);
  const [view, setViewState] = useState<View>(initialView ?? { x: PAD, y: PAD, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  /** True once the user panned / zoomed: until then the view keeps fitting the graph. */
  const userMoved = useRef(!!initialView);
  const setView = useCallback(
    (v: View | ((v: View) => View)) => {
      setViewState((prev) => {
        const next = typeof v === "function" ? v(prev) : v;
        return next;
      });
    },
    [],
  );
  useEffect(() => {
    const t = setTimeout(() => onView(view), 300);
    return () => clearTimeout(t);
  }, [view]);

  const fitK = useMemo(() => {
    if (!size.width || !size.height || !layout.width) return 1;
    return Math.min((size.width - PAD * 2) / layout.width, (size.height - PAD * 2) / layout.height, 1.25);
  }, [size.width, size.height, layout.width, layout.height]);
  const kMin = Math.min(0.12, fitK * 0.8);
  const kMax = 2.5;

  const fitView = useCallback(() => {
    if (!size.width || !layout.width) return;
    const k = fitK;
    setView({ k, x: (size.width - layout.width * k) / 2, y: Math.max(PAD, (size.height - layout.height * k) / 2) });
  }, [fitK, size.width, size.height, layout.width, layout.height]);

  useEffect(() => {
    if (!userMoved.current && size.width && layout.width) fitView();
  }, [size.width, size.height, layout, fitView]);

  const zoomAt = useCallback(
    (factor: number, cx0?: number, cy0?: number) => {
      userMoved.current = true;
      setView((v) => {
        const k = Math.min(kMax, Math.max(kMin, v.k * factor));
        const cx = cx0 ?? size.width / 2;
        const cy = cy0 ?? size.height / 2;
        return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
      });
    },
    [kMin, size.width, size.height],
  );

  const centerOn = useCallback(
    (id: string, zoomIn = false) => {
      const p = layout.nodes.get(id);
      if (!p || !size.width) return;
      userMoved.current = true;
      setView((v) => {
        const k = zoomIn ? Math.max(v.k, 0.9) : v.k;
        return { k, x: size.width / 2 - (p.x + p.width / 2) * k, y: size.height / 2 - (p.y + p.height / 2) * k };
      });
    },
    [layout, size.width, size.height],
  );

  const ensureVisible = useCallback(
    (id: string) => {
      const p = layout.nodes.get(id);
      if (!p || !size.width) return;
      const v = viewRef.current;
      const sx = p.x * v.k + v.x;
      const sy = p.y * v.k + v.y;
      const m = 24;
      if (sx < m || sy < m || sx + p.width * v.k > size.width - m || sy + p.height * v.k > size.height - m) centerOn(id);
    },
    [layout, size.width, size.height, centerOn],
  );

  // ---- interaction state ----
  const [hovered, setHovered] = useState<string | undefined>();
  const [pinned, setPinned] = useState<string | undefined>();
  const [current, setCurrent] = useState<string | undefined>();
  const nodeEls = useRef(new Map<string, SVGGElement>());

  useEffect(() => {
    if (pinned && !nodeById.has(pinned)) setPinned(undefined);
    if (hovered && !nodeById.has(hovered)) setHovered(undefined);
  }, [nodeById]);

  const activeMatch = matches.length ? matches[Math.min(matchIdx, matches.length - 1)] : undefined;
  useEffect(() => {
    if (!activeMatch) return;
    setPinned(undefined);
    centerOn(activeMatch, true);
  }, [activeMatch, matchIdx]);

  useEffect(() => {
    if (!focusReq || !layout.nodes.has(focusReq.id)) return;
    setPinned(focusReq.id);
    setCurrent(focusReq.id);
    centerOn(focusReq.id, true);
    requestAnimationFrame(() => nodeEls.current.get(focusReq.id)?.focus({ preventScroll: true }));
  }, [focusReq?.seq, layout]);

  const focusId = pinned ?? hovered;
  const highlight = useMemo(() => {
    if (focusId) return lineage(graph, focusId);
    if (issuesOnly) {
      const set = new Set<string>();
      for (const n of graph.nodes) if (n.tone === "warn" || n.tone === "danger") for (const x of lineage(graph, n.id)) set.add(x);
      return set;
    }
    return undefined;
  }, [graph, focusId, issuesOnly]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const searching = matches.length > 0;

  // ---- pan / zoom handlers ----
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest(".tp-node") || t.closest(".tp-overlay")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, id: e.pointerId };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) {
      setDragging(true);
      userMoved.current = true;
    }
    d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = undefined;
    setDragging(false);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (d && !d.moved) setPinned(undefined);
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest(".tp-overlay")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
      else {
        userMoved.current = true;
        setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onCanvasKey = (e: KeyboardEvent) => {
    if ((e.target as Element).closest(".tp-overlay")) return;
    const step = 60;
    switch (e.key) {
      case "+":
      case "=":
        zoomAt(1.2);
        break;
      case "-":
      case "_":
        zoomAt(1 / 1.2);
        break;
      case "0":
        userMoved.current = false;
        fitView();
        break;
      case "Escape":
        if (pinned) {
          const id = pinned;
          setPinned(undefined);
          nodeEls.current.get(id)?.focus({ preventScroll: true });
        } else return;
        break;
      default:
        if ((e.target as Element).classList?.contains("tp-viewport-focus")) {
          userMoved.current = true;
          if (e.key === "ArrowLeft") setView((v) => ({ ...v, x: v.x + step }));
          else if (e.key === "ArrowRight") setView((v) => ({ ...v, x: v.x - step }));
          else if (e.key === "ArrowUp") setView((v) => ({ ...v, y: v.y + step }));
          else if (e.key === "ArrowDown") setView((v) => ({ ...v, y: v.y - step }));
          else return;
          break;
        }
        return;
    }
    e.preventDefault();
  };

  // ---- keyboard navigation between nodes ----
  const navigate = (id: string, dir: "up" | "down" | "left" | "right"): string | undefined => {
    const p = layout.nodes.get(id);
    if (!p) return undefined;
    const cx0 = p.x + p.width / 2;
    const cy0 = p.y + p.height / 2;
    const all = [...layout.nodes.values()];
    if (dir === "up" || dir === "down") {
      const col = all.filter((n) => Math.abs(n.x + n.width / 2 - cx0) < 2).sort((a, b) => a.y - b.y);
      const i = col.findIndex((n) => n.id === id);
      return col[dir === "down" ? i + 1 : i - 1]?.id;
    }
    const nbrs = graph.edges.filter((e) => (dir === "right" ? e.from === id : e.to === id)).map((e) => layout.nodes.get(dir === "right" ? e.to : e.from)!).filter(Boolean);
    const pool = nbrs.length ? nbrs : all.filter((n) => (dir === "right" ? n.x > p.x + p.width : n.x + n.width < p.x));
    let best: PositionedNode | undefined;
    let score = Infinity;
    for (const n of pool) {
      const s = Math.abs(n.x + n.width / 2 - cx0) * (nbrs.length ? 0 : 3) + Math.abs(n.y + n.height / 2 - cy0);
      if (s < score) {
        score = s;
        best = n;
      }
    }
    return best?.id;
  };

  const onNodeKey = (n: GraphNode, e: KeyboardEvent) => {
    const map: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (map[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      const next = navigate(n.id, map[e.key]);
      if (next) {
        setCurrent(next);
        if (pinned) setPinned(next);
        ensureVisible(next);
        nodeEls.current.get(next)?.focus({ preventScroll: true });
      }
    } else if (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const a = actionsFor(n)[0];
      if (a) onOpen(a.params);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setPinned((p) => (p === n.id ? undefined : n.id));
    } else if (e.key === "Home") {
      e.preventDefault();
      const first = graph.nodes.find((x) => layout.nodes.has(x.id));
      if (first) {
        setCurrent(first.id);
        ensureVisible(first.id);
        nodeEls.current.get(first.id)?.focus({ preventScroll: true });
      }
    }
  };

  const roving = current && layout.nodes.has(current) ? current : (activeMatch ?? graph.nodes.find((n) => layout.nodes.has(n.id))?.id);
  const lod = view.k < 0.45 ? "tp-lod-low" : "";
  const hoverNode = hovered && hovered !== pinned ? nodeById.get(hovered) : undefined;
  const hoverPos = hoverNode ? layout.nodes.get(hoverNode.id) : undefined;
  const pinnedNode = pinned ? nodeById.get(pinned) : undefined;
  const pinnedPos = pinnedNode ? layout.nodes.get(pinnedNode.id) : undefined;

  return (
    <div class="tp-canvas-wrap">
      <div
        ref={wrapRef}
        class={cx("tp-canvas", dragging && "tp-dragging")}
        onPointerDown={onPointerDown as never}
        onPointerMove={onPointerMove as never}
        onPointerUp={onPointerUp as never}
        onPointerCancel={onPointerUp as never}
        onKeyDown={onCanvasKey as never}
      >
        <button type="button" class="tp-viewport-focus sr-only-focusable" aria-label="Graph viewport: arrow keys pan, plus and minus zoom, 0 fits the graph. Tab into the graph to move between nodes.">
          Graph viewport
        </button>
        <svg ref={svgRef} class={cx("tp-svg", lod)} width={size.width || 800} height={size.height || 480} role="group" aria-label={`Topology graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges. Use arrow keys to move between nodes, Enter for details, Shift+Enter to open.`} data-width={layout.width} data-height={layout.height}>
          <defs>
            <pattern id="tp-dots" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x % (16 * view.k)},${view.y % (16 * view.k)}) scale(${view.k})`}>
              <circle cx="1" cy="1" r="0.9" class="tp-dot" />
            </pattern>
            {(["base", "hl", "mirror", "serves", "warn", "danger"] as const).map((m) => (
              <marker key={m} id={`tp-arrow-${m}`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0,0.6 L8,4 L0,7.4 z" class={`tp-arrow tp-arrow-${m}`} />
              </marker>
            ))}
          </defs>
          <rect class="tp-bg" data-tp="bg" width="100%" height="100%" fill="url(#tp-dots)" />
          <g class="tp-viewport" data-tp="viewport" transform={`translate(${round(view.x)},${round(view.y)}) scale(${round(view.k, 4)})`}>
            <g class="tp-edges" aria-hidden="true">
              {layout.edges.map((pe) => {
                const e = edgeById.get(pe.id);
                if (!e) return null;
                return <EdgeView key={pe.id} edge={e} points={pe.points} dim={(highlight && !(highlight.has(e.from) && highlight.has(e.to))) || (searching && !(matchSet.has(e.from) || matchSet.has(e.to)))} hl={!!focusId && !!highlight && highlight.has(e.from) && highlight.has(e.to)} />;
              })}
            </g>
            <g class="tp-nodes">
              {graph.nodes.map((n) => {
                const p = layout.nodes.get(n.id);
                if (!p) return null;
                return (
                  <NodeView
                    key={n.id}
                    node={n}
                    pos={p}
                    dim={(highlight && !highlight.has(n.id)) || (searching && !matchSet.has(n.id))}
                    match={matchSet.has(n.id)}
                    active={activeMatch === n.id}
                    pinned={pinned === n.id}
                    tabIndex={roving === n.id ? 0 : -1}
                    elRef={(el) => {
                      if (el) nodeEls.current.set(n.id, el);
                      else nodeEls.current.delete(n.id);
                    }}
                    onEnter={() => setHovered(n.id)}
                    onLeave={() => setHovered((h) => (h === n.id ? undefined : h))}
                    onFocus={() => setCurrent(n.id)}
                    onClick={() => {
                      setCurrent(n.id);
                      setPinned((p2) => (p2 === n.id ? undefined : n.id));
                    }}
                    onDblClick={() => {
                      const a = actionsFor(n)[0];
                      if (a) onOpen(a.params);
                    }}
                    onKey={(e) => onNodeKey(n, e)}
                  />
                );
              })}
            </g>
          </g>
        </svg>

        {hoverNode && hoverPos && (
          <ChartTooltip {...tipAnchor(hoverPos, view, size.width)} y={hoverPos.y * view.k + view.y}>
            <TipHead>
              <span class="tp-tip-kind">{KIND_META[hoverNode.kind].label}</span> <span class="mono">{hoverNode.label}</span>
            </TipHead>
            {hoverNode.issues.map((i) => (
              <TipRow key={i} shape="none" value={<span class={`tone-${hoverNode.tone}`}>{i}</span>} />
            ))}
            {hoverNode.stats
              .filter(([k]) => k !== "Type")
              .slice(0, 7)
              .map(([k, v], i) => (
                <TipRow key={`${k}${i}`} shape="none" value={v} label={k} />
              ))}
            <div class="tp-tip-hint">{actionsFor(hoverNode)[0] ? `Click for actions · double-click: ${actionsFor(hoverNode)[0].label.toLowerCase()}` : "Click for details"}</div>
          </ChartTooltip>
        )}

        {pinnedNode && pinnedPos && (
          <PinnedCard
            node={pinnedNode}
            x={pinnedPos.x * view.k + view.x}
            y={pinnedPos.y * view.k + view.y}
            w={pinnedPos.width * view.k}
            containerW={size.width}
            containerH={size.height}
            onClose={() => {
              const id = pinnedNode.id;
              setPinned(undefined);
              nodeEls.current.get(id)?.focus({ preventScroll: true });
            }}
            onOpen={onOpen}
          />
        )}

        <div class="tp-overlay tp-zoom" role="toolbar" aria-label="Zoom">
          <Button variant="ghost" small icon="zoom-in" title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomAt(1.25)} />
          <Button variant="ghost" small icon="zoom-out" title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.25)} />
          <Button
            variant="ghost"
            small
            icon="screen-full"
            title="Fit to view (0)"
            aria-label="Fit to view"
            onClick={() => {
              userMoved.current = false;
              fitView();
            }}
          />
          <Button
            variant="ghost"
            small
            icon="target"
            title="Actual size (100%)"
            aria-label="Actual size"
            onClick={() => zoomAt(1 / view.k)}
          />
          <span class="tp-zoom-pct num" aria-live="off" title="Zoom level">
            {Math.round(view.k * 100)}%
          </span>
        </div>

        <GraphLegend graph={graph} open={legendOpen && size.width >= 640} setOpen={setLegendOpen} />

        <div class={cx("tp-overlay tp-help small muted", pinnedNode && "tp-hidden")} aria-hidden="true">
          Drag or scroll to pan · <Kbd>Ctrl</Kbd>+scroll to zoom · <Kbd>/</Kbd> search
        </div>
      </div>
    </div>
  );
}

/** Tooltip beside the node: right of it, or left when it would overflow (ChartTooltip flips on x > 55%). */
function tipAnchor(p: PositionedNode, v: View, width: number): { x: number; containerWidth: number } {
  const left = p.x * v.k + v.x;
  const right = left + p.width * v.k;
  return right + 290 > width && left > 300 ? { x: left, containerWidth: 0 } : { x: right, containerWidth: Number.MAX_SAFE_INTEGER };
}

function round(v: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------------------------
// Nodes and edges
// ---------------------------------------------------------------------------------------------

function Glyph({ name, x, y, size = 16, class: cls }: { name: GlyphName; x: number; y: number; size?: number; class?: string }) {
  const g = GLYPHS[name];
  return <path d={g.d} fill-rule={"evenOdd" in g && g.evenOdd ? "evenodd" : undefined} class={cx("tp-glyph", cls)} transform={`translate(${x},${y}) scale(${size / 16})`} />;
}

interface NodeViewProps {
  node: GraphNode;
  pos: PositionedNode;
  dim?: boolean;
  match?: boolean;
  active?: boolean;
  pinned?: boolean;
  tabIndex: number;
  elRef: (el: SVGGElement | null) => void;
  onEnter: () => void;
  onLeave: () => void;
  onFocus: () => void;
  onClick: () => void;
  onDblClick: () => void;
  onKey: (e: KeyboardEvent) => void;
}

function NodeView({ node: n, pos: p, dim, match, active, pinned, tabIndex, elRef, onEnter, onLeave, onFocus, onClick, onDblClick, onKey }: NodeViewProps) {
  const w = p.width;
  const h = p.height;
  const isSubject = n.kind === "subject";
  const mono = isSubject || n.kind === "external";
  const meta = KIND_META[n.kind];
  const badgeW = n.badge ? Math.max(22, n.badge.text.length * 6.4 + 12) : 0;
  const toneIcon = n.tone === "warn" || n.tone === "danger";
  const flagGlyph: GlyphName | undefined = n.flags.includes("mirror") ? "mirror" : n.flags.includes("sourced") ? "sourced" : n.flags.includes("paused") ? "paused" : undefined;
  const rightReserve = (n.badge ? badgeW + 8 : 0) + (toneIcon ? 18 : 0) + (flagGlyph ? 16 : 0) + 8;
  const textX = isSubject ? 28 : 34;
  const labelPx = w - textX - rightReserve;
  const label = fit(n.label, labelPx, isSubject ? 11 : 12, mono);
  const sub = n.sub ? fit(n.sub, w - textX - 10 - (n.badge ? badgeW + 6 : 0), 10.5, n.kind === "endpoint") : undefined;
  const aria = `${meta.label} ${n.label}${n.sub ? `, ${n.sub}` : ""}${n.badge ? `, ${n.badge.title}` : ""}${toneIcon ? `, ${TONE_LABEL[n.tone].toLowerCase()}: ${n.issues.join("; ")}` : ""}`;
  let rx = 6;
  if (isSubject) rx = h / 2;
  let iconX = 10;
  if (isSubject) iconX = 9;
  let x = w - 8;
  const parts: ComponentChildren[] = [];
  if (n.badge) {
    x -= badgeW;
    parts.push(
      <g key="badge" class={cx("tp-badge", `tp-tone-${n.badge.tone}`)} transform={`translate(${x},${(h - 18) / 2})`}>
        <title>{n.badge.title}</title>
        <rect width={badgeW} height="18" rx="9" />
        <text x={badgeW / 2} y="12.5" text-anchor="middle">
          {n.badge.text}
        </text>
      </g>,
    );
    x -= 6;
  }
  if (toneIcon) {
    x -= 15;
    parts.push(<Glyph key="tone" name={n.tone === "danger" ? "danger" : "warn"} x={x} y={isSubject ? 6 : 6} size={14} class={`tp-tone-glyph tp-tone-${n.tone}`} />);
    x -= 4;
  }
  if (flagGlyph) {
    x -= 14;
    parts.push(<Glyph key="flag" name={flagGlyph} x={x} y={7} size={13} class="tp-flag-glyph" />);
  }
  return (
    <g
      ref={elRef}
      class={cx("tp-node", `tp-k-${n.kind}`, `tp-tone-${n.tone}`, dim && "tp-dim", match && "tp-match", active && "tp-active", pinned && "tp-pinned", n.flags.includes("more") && "tp-more")}
      transform={`translate(${p.x},${p.y})`}
      role="button"
      tabIndex={tabIndex}
      aria-label={aria}
      aria-haspopup="dialog"
      aria-expanded={pinned}
      data-id={n.id}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onFocus}
      onClick={onClick}
      onDblClick={onDblClick}
      onKeyDown={onKey as never}
    >
      <rect class="tp-halo" x="-4" y="-4" width={w + 8} height={h + 8} rx={rx + 4} />
      <rect class="tp-box" width={w} height={h} rx={rx} />
      {!isSubject && <rect class="tp-accent" x="0.5" y="0.5" width="3.5" height={h - 1} rx="1.5" />}
      <Glyph name={meta.glyph} x={iconX} y={(h - 16) / 2} class="tp-kind-glyph" />
      <text class={cx("tp-label", mono && "tp-mono")} x={textX} y={sub ? h / 2 - 3 : h / 2 + 4}>
        {label}
      </text>
      {sub && (
        <text class={cx("tp-sub", n.kind === "endpoint" && "tp-mono")} x={textX} y={h / 2 + 12}>
          {sub}
        </text>
      )}
      {parts}
    </g>
  );
}

function EdgeView({ edge, points, dim, hl }: { edge: GraphEdge; points: [number, number][]; dim?: boolean; hl?: boolean }) {
  const d = edgePath(points);
  const toned = edge.tone === "warn" || edge.tone === "danger";
  const marker = hl ? "hl" : toned ? edge.tone! : edge.kind === "mirror" || edge.kind === "source" ? "mirror" : edge.kind === "serves" ? "serves" : "base";
  const [mx, my] = edgeMidpoint(points);
  return (
    <g class={cx("tp-edge", `tp-e-${edge.kind}`, toned && `tp-tone-${edge.tone}`, dim && "tp-dim", hl && "tp-hl")}>
      <title>{edge.title}</title>
      <path class="tp-edge-hit" d={d} />
      <path class="tp-edge-line" d={d} marker-end={`url(#tp-arrow-${marker})`} />
      {edge.label && (
        <text class="tp-elabel" x={mx} y={my - 5} text-anchor="middle">
          {edge.label}
        </text>
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------------------------
// Overlays: pinned action card, legend
// ---------------------------------------------------------------------------------------------

/** Stats whose values are identifiers (shown in monospace in the pinned card). */
const MONO_STATS = new Set(["Subject pattern", "Captured by", "Backing stream", "Leader", "Deliver subject", "Filter", "Subject", "Endpoint", "Queue group", "Origin stream", "Subjects", "Folded consumers"]);

function PinnedCard({ node, x, y, w, containerW, containerH, onClose, onOpen }: { node: GraphNode; x: number; y: number; w: number; containerW: number; containerH: number; onClose: () => void; onOpen: (p: TopologyOpenParams) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(220);
  const cardW = Math.min(320, containerW - 24);
  useLayoutEffect(() => {
    if (ref.current) setH(ref.current.offsetHeight);
  }, [node.id]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".tp-pop-actions .btn")?.focus({ preventScroll: true });
  }, [node.id]);
  let left = x + w + 10;
  if (left + cardW > containerW - 8) left = x - cardW - 10;
  if (left < 8) left = Math.max(8, Math.min(containerW - cardW - 8, x));
  const top = Math.max(8, Math.min(containerH - h - 8, y - 8));
  const actions = actionsFor(node);
  const meta = KIND_META[node.kind];
  return (
    <div
      ref={ref}
      class="tp-overlay tp-pop"
      role="dialog"
      aria-label={`${meta.label} ${node.label}`}
      style={{ left: `${left}px`, top: `${top}px`, width: `${cardW}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div class={cx("tp-pop-head", `tp-k-${node.kind}`)}>
        <span class="tp-pop-icon" aria-hidden="true">
          <Icon name={meta.icon} />
        </span>
        <div class="tp-pop-titles">
          <div class="tp-pop-kind">{node.stats.find(([k]) => k === "Type")?.[1] ?? meta.label}</div>
          <div class="tp-pop-name mono" title={node.label}>
            {node.label}
          </div>
        </div>
        <Button variant="ghost" small icon="close" title="Close (Esc)" aria-label="Close" onClick={onClose} />
      </div>
      {node.issues.length > 0 && (
        <ul class={cx("tp-pop-issues", node.tone === "danger" && "tp-pop-issues-danger")}>
          {node.issues.map((i) => (
            <li key={i} class={`tone-${node.tone}`}>
              <ToneIcon tone={node.tone} /> <span>{i}</span>
            </li>
          ))}
        </ul>
      )}
      <KeyValueGrid
        dense
        columns={2}
        items={node.stats
          .filter(([k]) => k !== "Type")
          .slice(0, 10)
          .map(([k, v]) => ({ label: k, value: v, mono: MONO_STATS.has(k), wide: v.length > 22 }))}
      />
      {actions.length > 0 && (
        <div class="tp-pop-actions">
          {actions.map((a, i) => (
            <Button key={a.id} variant={i === 0 ? "primary" : "secondary"} small icon={a.icon} onClick={() => onOpen(a.params)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
      <div class="tp-pop-hint small muted">
        <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> on a node runs the first action
      </div>
    </div>
  );
}

function GraphLegend({ graph, open, setOpen }: { graph: Graph; open: boolean; setOpen: (v: boolean) => void }) {
  const kinds = [...new Set(graph.nodes.map((n) => n.kind))].sort((a, b) => Object.keys(SIZE).indexOf(a) - Object.keys(SIZE).indexOf(b));
  const edgeKinds = new Set(graph.edges.map((e) => e.kind));
  const nodeItems: LegendItem[] = kinds.map((k) => ({ id: k, label: KIND_META[k].plural, color: KIND_META[k].color, shape: "rect", value: String(graph.nodes.filter((n) => n.kind === k).length) }));
  const edgeItems: LegendItem[] = [
    edgeKinds.has("capture") && { id: "capture", label: "captures", color: "var(--tp-edge)", shape: "line" as const, title: "Subject pattern stored in the stream" },
    edgeKinds.has("consume") && { id: "consume", label: "consumes", color: "var(--tp-edge)", shape: "line" as const, title: "Consumer reads the stream" },
    (edgeKinds.has("mirror") || edgeKinds.has("source")) && { id: "mirror", label: "mirror / source", color: "var(--tp-edge-strong)", shape: "line" as const, dashed: true, title: "Replication from the origin stream, labelled with lag" },
    edgeKinds.has("serves") && { id: "serves", label: "endpoint overlaps", color: "var(--tp-endpoint)", shape: "line" as const, dashed: true, title: "Service endpoint subject overlaps the stream's subjects" },
  ].filter(Boolean) as LegendItem[];
  return (
    <div class={cx("tp-overlay tp-legend", !open && "tp-legend-closed")}>
      <button type="button" class="tp-legend-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Hide legend" : "Show legend"}>
        <Icon name={open ? "chevron-down" : "chevron-right"} /> Legend
      </button>
      {open && (
        <div class="tp-legend-body">
          <Legend items={nodeItems} label="Node types" vertical />
          {edgeItems.length > 0 && <Legend items={edgeItems} label="Edge types" vertical />}
          <div class="tp-legend-status" role="list" aria-label="Status">
            <span role="listitem">
              <ToneIcon tone="warn" /> warning
            </span>
            <span role="listitem">
              <ToneIcon tone="danger" /> critical
            </span>
            <span role="listitem" class="tp-legend-badge">
              <span class="tp-badge-chip">12</span> pending
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// List view, issues
// ---------------------------------------------------------------------------------------------

interface Row {
  id: string;
  node: GraphNode;
  upstream: string;
  downstream: number;
}

function NodeTable({ graph, onShow, onOpen }: { graph: Graph; onShow: (id: string) => void; onOpen: (p: TopologyOpenParams) => void }) {
  const rows: Row[] = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.nodes.map((n) => ({
      id: n.id,
      node: n,
      upstream: graph.edges
        .filter((e) => e.to === n.id)
        .map((e) => byId.get(e.from)?.label)
        .filter(Boolean)
        .join(", "),
      downstream: graph.edges.filter((e) => e.from === n.id).length,
    }));
  }, [graph]);
  const columns: Column<Row>[] = [
    {
      key: "kind",
      header: "Type",
      width: "150px",
      value: (r) => KIND_META[r.node.kind].label,
      render: (r) => (
        <span class={cx("tp-kind-cell", `tp-k-${r.node.kind}`)}>
          <Icon name={KIND_META[r.node.kind].icon} /> {KIND_META[r.node.kind].label}
        </span>
      ),
    },
    { key: "name", header: "Name", mono: true, value: (r) => r.node.label },
    { key: "details", header: "Details", value: (r) => r.node.sub ?? "", render: (r) => (r.node.sub ? <span class="tp-ellipsis">{r.node.sub}</span> : <span class="muted">–</span>), hideBelow: "sm" },
    {
      key: "upstream",
      header: "Upstream",
      mono: true,
      value: (r) => r.upstream,
      render: (r) =>
        r.upstream ? (
          <span class="tp-ellipsis" title={r.upstream}>
            {r.upstream}
          </span>
        ) : (
          <span class="muted">–</span>
        ),
      hideBelow: "md",
      title: "Nodes with an edge into this one",
    },
    { key: "downstream", header: "Out", numeric: true, value: (r) => r.downstream, hideBelow: "md", title: "Outgoing edges (consumers, mirrors, endpoints)" },
    {
      key: "status",
      header: "Status",
      width: "120px",
      value: (r) => (r.node.tone === "danger" ? 0 : r.node.tone === "warn" ? 1 : 2),
      render: (r) =>
        r.node.tone === "warn" || r.node.tone === "danger" ? (
          <span class={`tone-${r.node.tone}`} title={r.node.issues.join("\n")}>
            <ToneIcon tone={r.node.tone} /> {TONE_LABEL[r.node.tone]}
          </span>
        ) : (
          <span class="muted">–</span>
        ),
    },
    {
      key: "actions",
      header: "",
      sortable: false,
      filterable: false,
      width: "90px",
      render: (r) => (
        <span class="tp-row-actions">
          <Button
            variant="ghost"
            small
            icon="target"
            title="Show in graph"
            aria-label={`Show ${r.node.label} in graph`}
            onClick={(e) => {
              e.stopPropagation();
              onShow(r.id);
            }}
          />
          {actionsFor(r.node)[0] && (
            <Button
              variant="ghost"
              small
              icon={actionsFor(r.node)[0].icon}
              title={actionsFor(r.node)[0].label}
              aria-label={`${actionsFor(r.node)[0].label}: ${r.node.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(actionsFor(r.node)[0].params);
              }}
            />
          )}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      label="Topology nodes"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      initialSort={{ key: "status", dir: "asc" }}
      filter={{ placeholder: "Filter nodes…" }}
      onRowClick={(r) => onShow(r.id)}
      rowTone={(r) => (r.node.tone === "warn" || r.node.tone === "danger" ? r.node.tone : undefined)}
      maxHeight="calc(100vh - 300px)"
      dense
    />
  );
}

function IssuesList({ nodes, onShow, onOpen, thresholds }: { nodes: GraphNode[]; onShow: (id: string) => void; onOpen: (p: TopologyOpenParams) => void; thresholds: HealthThresholds }) {
  if (!nodes.length)
    return (
      <EmptyState compact kind="success" title="No issues found" secondary={{ label: "Run health check", icon: "pulse", onClick: () => void rpc("runCommand", { id: "nats.runHealthCheck" }).catch(() => undefined) }}>
        No consumer above {thresholds.pendingWarning.toLocaleString("en-US")} pending or {Math.round(thresholds.ackPendingRatio * 100)}% ack pending, no stream above {Math.round(thresholds.storageWarningRatio * 100)}% of its limits, no lagging mirror and no failing endpoint.
      </EmptyState>
    );
  return (
    <ul class="tp-issues" aria-label="Nodes with issues">
      {nodes.slice(0, 50).map((n) => {
        const a = actionsFor(n)[0];
        return (
          <li key={n.id} class={cx("tp-issue", `ds-tone-${n.tone}`)}>
            <ToneIcon tone={n.tone} title={TONE_LABEL[n.tone]} />
            <div class="tp-issue-text">
              <div class="tp-issue-name">
                <Icon name={KIND_META[n.kind].icon} class="muted" /> <span class="mono">{n.kind === "consumer" ? `${n.ref.stream}/${n.label}` : n.label}</span>
              </div>
              <div class="tp-issue-why small">{n.issues.join(" · ")}</div>
            </div>
            <div class="tp-issue-actions">
              <Button variant="ghost" small icon="target" title="Show in graph" aria-label={`Show ${n.label} in graph`} onClick={() => onShow(n.id)} />
              {a && <Button variant="ghost" small icon={a.icon} title={a.label} aria-label={`${a.label}: ${n.label}`} onClick={() => onOpen(a.params)} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// SVG export: inline the resolved theme styles so the file renders outside VS Code
// ---------------------------------------------------------------------------------------------

const STYLE_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "opacity", "font-family", "font-size", "font-weight", "paint-order", "stroke-linejoin", "stroke-linecap"];
// "display" is not copied: zoomed-out views hide secondary labels (level of detail) but the
// exported file always contains the full detail.

function exportSvg(setError: (e: string | null) => void) {
  const live = document.querySelector<SVGSVGElement>(".tp-svg");
  const vp = live?.querySelector<SVGGElement>(".tp-viewport");
  if (!live || !vp) return;
  const w = Number(live.dataset.width) || 800;
  const h = Number(live.dataset.height) || 600;
  const pad = 32;
  const head = 34;
  const clone = live.cloneNode(true) as SVGSVGElement;
  const liveEls = [live, ...Array.from(live.querySelectorAll("*"))];
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll("*"))];
  liveEls.forEach((el, i) => {
    const c = cloneEls[i] as SVGElement;
    if (!c || el instanceof SVGDefsElement) return;
    const cs = getComputedStyle(el);
    const style = STYLE_PROPS.map((p) => {
      let v = cs.getPropertyValue(p);
      if (p === "opacity" && el.classList.contains("tp-dim")) v = "1";
      return v ? `${p}:${v}` : "";
    })
      .filter(Boolean)
      .join(";");
    c.setAttribute("style", style);
    c.removeAttribute("class");
    c.removeAttribute("tabindex");
    c.removeAttribute("role");
    c.removeAttribute("aria-label");
    c.removeAttribute("aria-haspopup");
    c.removeAttribute("aria-expanded");
  });
  clone.querySelector('[data-tp="bg"]')?.remove(); // dotted background
  clone.querySelector("pattern")?.remove();
  const vpClone = clone.querySelector('[data-tp="viewport"]');
  vpClone?.setAttribute("transform", `translate(${pad},${pad + head})`);
  const bg = getComputedStyle(document.querySelector(".tp-canvas") ?? document.body).backgroundColor || "#1f1f1f";
  const fg = getComputedStyle(document.body).color;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w + pad * 2));
  clone.setAttribute("height", String(h + pad * 2 + head));
  clone.setAttribute("viewBox", `0 0 ${w + pad * 2} ${h + pad * 2 + head}`);
  const ns = "http://www.w3.org/2000/svg";
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("width", "100%");
  rect.setAttribute("height", "100%");
  rect.setAttribute("fill", bg);
  const title = document.createElementNS(ns, "text");
  title.setAttribute("x", String(pad));
  title.setAttribute("y", String(pad + 6));
  title.setAttribute("style", `fill:${fg};font-family:${getComputedStyle(document.body).fontFamily};font-size:15px;font-weight:600`);
  title.textContent = `JetStream topology · ${init.profileName} · ${new Date().toLocaleString()}`;
  clone.insertBefore(title, clone.firstChild);
  clone.insertBefore(rect, clone.firstChild);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  rpc("exportSvg", { svg, name: `topology-${init.profileName}` }).catch((e: Error) => setError(e.message));
}

render(<App />, document.getElementById("root")!);

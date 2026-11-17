// Cluster overview: every server of the cluster / super-cluster ($SYS statsz with system-account
// access, otherwise the connected server's HTTP monitoring endpoint), a cluster map (clusters,
// routes, gateways, leaf nodes), message / data rates, server cards with CPU and JetStream
// gauges, and tables for servers, routes, gateways and leaf nodes. The header shows "who am I".
import "./lib/styles.css";
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getInit, onEvent, rpc } from "./lib/vscode";
import { Button, cx, Icon } from "./lib/ui";
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
  SectionHeading,
  TimeRangePicker,
  rangeMs,
  type Column,
  type ConnectionState,
} from "./lib/dashboard";
import {
  BarList,
  ChartTooltip,
  CrosshairSync,
  formatValue,
  Gauge,
  Meter,
  SeriesTable,
  Sparkline,
  StatusDot,
  TimeSeriesChart,
  TipHead,
  TipRow,
  ToneIcon,
  TONE_LABEL,
  usageTone,
  useElementSize,
  usePolling,
  useTimeSeries,
  type TimeSeries,
  type Tone,
} from "./lib/charts";
import {
  buildClusterGraph,
  clusterTotals,
  computeRates,
  counterSample,
  cpuFraction,
  layoutClusterGraph,
  serverTone,
  type ClusterLayout,
  type ClusterSnapshot,
  type CounterSample,
  type GatewayRow,
  type LeafRow,
  type RouteRow,
  type ServerRow,
} from "../src/admin/clusterModel";
import { GLYPHS, type GlyphName } from "../src/admin/glyphs";
import type { ClusterInit } from "../src/panels/clusterPanel";
import "./cluster.css";

const init = getInit<ClusterInit>();

type ConnState = ConnectionState;

const fmtUptime = (ms: number | undefined) => (ms === undefined ? "–" : formatValue(ms, "ms"));
const fmtPct = (v: number | undefined) => (v === undefined ? "–" : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`);

function App() {
  const [conn, setConn] = useState<{ state: ConnState; error?: string }>({ state: init.state });
  const [visible, setVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [interval, setIntervalMs] = useState(init.refreshInterval);
  const [range, setRange] = useState("5m");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const force = useRef(false);

  useEffect(() => {
    const offs = [
      onEvent<{ visible: boolean }>("visible", (d) => setVisible(d.visible)),
      onEvent<{ state: ConnState; error?: string }>("connection", (d) => setConn(d)),
      onEvent<{ refreshInterval: number }>("config", (d) => setIntervalMs(d.refreshInterval)),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const live = conn.state === "connected";
  const poll = usePolling(
    () => {
      const f = force.current;
      force.current = false;
      return rpc<ClusterSnapshot>("snapshot", { force: f });
    },
    interval,
    visible && !paused && live,
  );
  const snap = poll.data;

  // ---- rates: per-second deltas of cumulative counters, kept in a time series ----
  const ts = useTimeSeries<string>(1800);
  const prevSample = useRef<CounterSample | undefined>(undefined);
  useEffect(() => {
    if (!snap) return;
    const sample = counterSample(snap.at, snap.servers);
    const r = computeRates(prevSample.current, sample);
    prevSample.current = sample;
    const values: Record<string, number | null> = {};
    for (const s of snap.servers) {
      if (s.ghost) continue;
      values[`conns:${s.id}`] = s.connections ?? null;
      values[`cpu:${s.id}`] = s.cpu ?? null;
      values[`mem:${s.id}`] = s.mem ?? null;
    }
    const totals = clusterTotals(snap.servers);
    values.conns = totals.connections;
    values.subs = totals.subscriptions;
    if (r) {
      values.in = r.total.inMsgs;
      values.out = r.total.outMsgs;
      values.bin = r.total.inBytes;
      values.bout = r.total.outBytes;
      for (const [id, v] of Object.entries(r.perServer)) {
        values[`in:${id}`] = v.inMsgs;
        values[`out:${id}`] = v.outMsgs;
      }
    }
    ts.push(snap.at, values);
  }, [snap]);

  const totals = useMemo(() => (snap ? clusterTotals(snap.servers) : undefined), [snap]);
  const win = rangeMs(range);
  const loading = poll.loading && !snap && live;
  const stale = !live || (!!poll.error && !!snap);
  const realServers = snap?.servers.filter((s) => !s.ghost) ?? [];
  /** Basic mode (INFO only) has no counters: show "–" rather than zeros. */
  const metrics = realServers.some((s) => s.connections !== undefined);
  const msgSeries: TimeSeries[] = [
    { id: "in", name: "Inbound", points: ts.series("in", win) },
    { id: "out", name: "Outbound", points: ts.series("out", win) },
  ];
  const byteSeries: TimeSeries[] = [
    { id: "bin", name: "Bytes in", points: ts.series("bin", win) },
    { id: "bout", name: "Bytes out", points: ts.series("bout", win) },
  ];
  const sourceLabel = !snap ? undefined : snap.mode === "system" ? `$SYS statsz · ${realServers.length} server${realServers.length === 1 ? "" : "s"}` : snap.mode === "monitor" ? "HTTP monitoring · connected server" : "INFO only";
  const refresh = () => {
    force.current = true;
    void poll.refresh();
  };
  const scrollToServer = (id: string) => {
    setSelected(id);
    requestAnimationFrame(() => {
      const el = document.getElementById(`srv-${cssId(id)}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.querySelector<HTMLElement>(".ds-card-title")?.focus?.();
    });
  };
  const details = (s: ServerRow) => {
    if (s.ghost) return;
    rpc("serverDetails", { id: s.id, name: s.name }).catch((e: Error) => setError(e.message));
  };

  const header = (
    <DashboardHeader
      icon="server-environment"
      title="Cluster overview"
      subtitle={
        <>
          <span class="mono">{snap?.connectedUrl ?? init.connectedUrl ?? "–"}</span>
          {(init.cluster || totals?.clusters.length) && (
            <>
              {" "}
              · {totals && totals.clusters.length > 1 ? "super-cluster" : "cluster"} <span class="mono">{totals?.clusters.join(", ") || init.cluster}</span>
            </>
          )}
        </>
      }
      env={init.environment}
      connectionName={init.profileName}
      readOnly={init.readOnly}
      status={statusOf(conn.state)}
      actions={
        <>
          <Button variant="ghost" small icon="account" title="Show user info & permissions as JSON" onClick={() => void rpc("whoAmI").catch((e: Error) => setError(e.message))}>
            Who am I
          </Button>
          <Button variant="ghost" small icon="refresh" title="Refresh now" aria-label="Refresh now" busy={poll.refreshing} disabled={!live} onClick={refresh} />
        </>
      }
      meta={<WhoAmIChips snap={snap} loading={loading} />}
    />
  );

  return (
    <DashboardPage header={header} label="Cluster overview">
      <FilterBar>
        <TimeRangePicker value={range} onChange={(id) => setRange(id)} />
        <RefreshIndicator updatedAt={poll.updatedAt} paused={paused} suspended={poll.suspended || !visible} refreshing={poll.refreshing} error={!live ? conn.state : poll.error} intervalMs={interval} onTogglePause={() => setPaused((p) => !p)} onRefresh={refresh} />
        <span class="spacer" />
        {sourceLabel && (
          <Chip icon={snap?.mode === "system" ? "pass-filled" : "info"} tone={snap?.mode === "system" ? "ok" : "warn"} size="sm" title={snap?.mode === "system" ? "Data from $SYS.REQ.SERVER.PING (every server answers)" : snap?.mode === "monitor" ? `Data from ${snap.monitorUrl}` : "Only the INFO block of the connected server is available"}>
            {sourceLabel}
          </Chip>
        )}
      </FilterBar>
      <ConnectionBanner state={conn.state} message={conn.error} since={poll.updatedAt} onRetry={() => void rpc("reconnect").catch((e: Error) => setError(e.message))} />
      {(error || (poll.error && snap)) && (
        <div class="banner banner-error" role="alert">
          <Icon name="error" />
          <span class="banner-text">{error ?? `Refresh failed: ${poll.error}`}</span>
          <Button variant="ghost" small icon="close" title="Dismiss" aria-label="Dismiss" onClick={() => setError(null)} />
        </div>
      )}
      {!snap && !live && (
        <EmptyState kind="no-connection" title="Not connected" primary={{ label: "Reconnect", icon: "plug", onClick: () => void rpc("reconnect").catch((e: Error) => setError(e.message)) }}>
          The cluster overview of <span class="mono">{init.profileName}</span> loads once the connection is back.
        </EmptyState>
      )}
      {poll.error && !snap && !loading && live && (
        <EmptyState kind="error" title="Could not load the cluster overview" primary={{ label: "Retry", icon: "refresh", onClick: refresh }}>
          {poll.error}
        </EmptyState>
      )}
      {snap && snap.mode !== "system" && <LimitedNotice snap={snap} onError={setError} />}

      <KpiRow min={140} label="Cluster summary">
        <KpiTile
          label="Servers"
          value={totals?.servers}
          unit="count"
          tone={snap?.expectedServers && totals && totals.servers < snap.expectedServers ? "warn" : undefined}
          sub={snap?.mode === "system" ? `${totals?.clusters.length || 1} cluster${(totals?.clusters.length ?? 1) > 1 ? "s" : ""}${snap.expectedServers && totals && totals.servers < snap.expectedServers ? ` · ${snap.expectedServers - totals.servers} missing` : ""}` : snap ? "connected server only" : undefined}
          loading={loading}
          stale={stale}
          hint="Servers that answered $SYS.REQ.SERVER.PING. statsz active_servers is the number expected."
        />
        <KpiTile label="Connections" value={metrics ? totals?.connections : snap ? null : undefined} unit="count" sub={totals && metrics ? `${formatValue(totals.subscriptions, "count")} subscriptions` : snap ? "not reported" : undefined} trend={metrics ? ts.series("conns", win) : undefined} loading={loading} stale={stale} hint="Client connections across all servers (statsz connections). Subscriptions include internal ones." />
        <KpiTile label="Inbound" value={ts.last("in")} unit="msgs/s" previous={ts.stats("in", win)?.avg} deltaLabel={`vs ${range} avg`} goodWhen="neither" trend={ts.series("in", win)} loading={loading} stale={stale} hint="Messages received per second, summed over servers (statsz received.msgs rate). Includes route and gateway traffic." />
        <KpiTile label="Outbound" value={ts.last("out")} unit="msgs/s" previous={ts.stats("out", win)?.avg} deltaLabel={`vs ${range} avg`} goodWhen="neither" trend={ts.series("out", win)} loading={loading} stale={stale} hint="Messages sent per second, summed over servers (statsz sent.msgs rate)." />
        <KpiTile label="Slow consumers" value={metrics ? totals?.slowConsumers : snap ? null : undefined} unit="count" tone={totals && totals.slowConsumers > 0 ? "warn" : undefined} goodWhen="down" loading={loading} stale={stale} hint="Clients the servers dropped messages for because they could not keep up (cumulative since start)." />
        <KpiTile
          label="JS storage"
          value={totals?.jsServers ? totals.jsStorage : null}
          unit="bytes"
          sub={totals?.jsServers ? `of ${formatValue(totals.jsMaxStorage, "bytes")} · ${totals.jsServers} JS server${totals.jsServers === 1 ? "" : "s"}` : snap ? (metrics ? "JetStream not enabled" : "not reported") : undefined}
          meter={totals?.jsServers && totals.jsMaxStorage > 0 ? { value: totals.jsStorage, max: totals.jsMaxStorage, warn: 0.8, danger: 0.95 } : undefined}
          tone={totals?.jsServers && totals.jsMaxStorage > 0 ? usageTone(totals.jsStorage / totals.jsMaxStorage, 0.8, 0.95) : undefined}
          loading={loading}
          stale={stale}
          hint="JetStream file storage used vs. the servers' max_storage (sum)."
        />
        <KpiTile
          label="Health"
          value={totals ? (totals.healthy + totals.unhealthy ? `${totals.healthy}/${totals.healthy + totals.unhealthy}` : "–") : undefined}
          sub={totals ? (totals.unhealthy ? `${totals.unhealthy} failing /healthz` : totals.healthy ? "all servers healthy" : "health not checked yet") : undefined}
          tone={!totals || totals.healthy + totals.unhealthy === 0 ? undefined : totals.unhealthy ? "danger" : "ok"}
          loading={loading}
          stale={stale}
          hint="Servers passing HEALTHZ ($SYS.REQ.SERVER.PING.HEALTHZ or /healthz). Refreshed every 10 seconds."
        />
      </KpiRow>

      <SectionHeading title="Topology & traffic" subtitle={snap?.topologyAt ? `routes, gateways and leaf nodes as of ${new Date(snap.topologyAt).toLocaleTimeString()}` : undefined} />
      <CrosshairSync>
        <Grid>
          <Card span={7} title="Cluster map" icon="type-hierarchy" subtitle={snap ? mapSubtitle(snap) : undefined} loading={loading} stale={stale} minHeight={260} tableView={snap ? () => <RoutesTable routes={snap.routes} compact /> : undefined}>
            {snap && <ClusterMap snap={snap} selected={selected} onSelect={scrollToServer} onDetails={details} />}
          </Card>
          <Card span={5} title="Message rate" icon="pulse" subtitle="msgs/s · all servers" loading={loading} stale={stale} minHeight={260} tableView={() => <SeriesTable series={msgSeries} unit="msgs/s" caption="Message rate" />}>
            <TimeSeriesChart series={msgSeries} label="Cluster message rate" unit="msgs/s" windowMs={win} height={210} emptyText="Waiting for the second sample to compute rates…" />
          </Card>
          <Card span={4} title="Data rate" icon="arrow-swap" subtitle="bytes/s · all servers" loading={loading} stale={stale} minHeight={200} tableView={() => <SeriesTable series={byteSeries} unit="bytes/s" caption="Data rate" />}>
            <TimeSeriesChart series={byteSeries} label="Cluster data rate" unit="bytes/s" windowMs={win} height={170} emptyText="Waiting for the second sample…" />
          </Card>
          <Card span={4} title="Connections by server" icon="plug" subtitle="client connections" loading={loading} stale={stale} minHeight={200}>
            <BarList label="Connections by server" unit="count" mono items={realServers.map((s) => ({ id: s.id, label: s.name, value: s.connections ?? 0, secondary: s.cluster }))} onSelect={(it) => it.id && scrollToServer(it.id)} selectedId={selected} emptyText="No connection data" />
          </Card>
          <Card span={4} title="CPU by server" icon="dashboard" subtitle="% of all cores" loading={loading} stale={stale} minHeight={200}>
            <BarList
              label="CPU by server, percent of all cores"
              unit="percent"
              mono
              max={100}
              sort
              items={realServers.filter((s) => s.cpu !== undefined).map((s) => {
                const f = (cpuFraction(s) ?? 0) * 100;
                const t = usageTone(f / 100);
                return { id: s.id, label: s.name, value: f, tone: t === "ok" ? undefined : t, secondary: `${fmtPct(s.cpu)} of 1 core · ${s.cores ?? "?"} cores` };
              })}
              onSelect={(it) => it.id && scrollToServer(it.id)}
              selectedId={selected}
              emptyText="CPU is reported by statsz or /varz only"
            />
          </Card>
        </Grid>
      </CrosshairSync>

      <SectionHeading title="Servers" subtitle={snap ? `${realServers.length} server${realServers.length === 1 ? "" : "s"}${snap.meta?.leader ? ` · JetStream meta leader ${snap.meta.leader}` : ""}` : undefined} />
      {loading ? (
        <Grid min={300}>
          {[0, 1, 2].map((i) => (
            <Card key={i} loading minHeight={260} />
          ))}
        </Grid>
      ) : (
        <Grid min={300}>
          {(snap?.servers ?? []).map((s) => (
            <ServerCard key={s.id} s={s} ts={ts} win={win} selected={selected === s.id} stale={stale} onDetails={details} system={snap?.mode === "system"} />
          ))}
        </Grid>
      )}

      <Grid>
        <Card span={12} title="All servers" icon="list-flat" flush loading={loading} stale={stale} collapsible>
          <ServersTable rows={snap?.servers ?? []} ts={ts} onRow={(s) => (snap?.mode === "system" ? details(s) : scrollToServer(s.id))} selected={selected} />
        </Card>
        <Card span={12} title="Routes" icon="arrow-swap" subtitle="cluster connections between servers (pooled connections merged)" flush loading={loading} stale={stale} collapsible>
          <RoutesTable routes={snap?.routes ?? []} />
        </Card>
        <Card span={6} title="Gateways" icon="globe" subtitle="super-cluster links" flush={!!snap?.gateways.length} loading={loading} stale={stale} collapsible>
          <GatewaysTable rows={snap?.gateways ?? []} />
        </Card>
        <Card span={6} title="Leaf nodes" icon="radio-tower" subtitle="leaf connections into this cluster" flush={!!snap?.leafs.length} loading={loading} stale={stale} collapsible>
          <LeafsTable rows={snap?.leafs ?? []} />
        </Card>
      </Grid>
    </DashboardPage>
  );
}

function cssId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
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

function mapSubtitle(s: ClusterSnapshot): string {
  const pairs = new Set(s.routes.map((r) => [r.serverName, r.remoteName ?? r.remoteId ?? ""].sort().join("|"))).size;
  const gws = new Set(s.gateways.map((g) => [g.cluster ?? "", g.remote].sort().join("|"))).size;
  return `${pairs} route link${pairs === 1 ? "" : "s"} · ${gws} gateway${gws === 1 ? "" : "s"} · ${s.leafs.length} leaf node${s.leafs.length === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------------------------
// Header: who am I
// ---------------------------------------------------------------------------------------------

function WhoAmIChips({ snap, loading }: { snap?: ClusterSnapshot; loading: boolean }) {
  if (loading) return <span class="skeleton skeleton-text" style={{ width: "260px" }} />;
  if (!snap) return null;
  const u = snap.user;
  const chips: ComponentChildren[] = [];
  if (u?.available) {
    chips.push(
      <Chip key="user" icon="account" mono size="sm" title="User ($SYS.REQ.USER.INFO)">
        {u.user ?? "–"}
      </Chip>,
      <Chip key="acct" icon="organization" mono size="sm" title={`Account ${u.account ?? ""}${u.accountName ? ` (${u.accountName})` : ""}`}>
        {u.accountName ?? (u.account && u.account.length > 20 ? `${u.account.slice(0, 8)}…` : u.account) ?? "–"}
      </Chip>,
      <Chip key="perm" icon="shield" size="sm" tone={u.permissions.unrestricted ? "ok" : undefined} title={u.permissions.lines.join("\n")}>
        <span class="mono">{u.permissions.short}</span>
      </Chip>,
    );
    if (u.expires) {
      const days = (Date.parse(u.expires) - Date.now()) / 86_400_000;
      chips.push(
        <Chip key="exp" icon="watch" size="sm" tone={days < 7 ? "warn" : undefined} title={`Credentials expire ${new Date(u.expires).toLocaleString()}`}>
          expires in {days < 1 ? `${Math.max(0, Math.round(days * 24))}h` : `${Math.round(days)}d`}
        </Chip>,
      );
    }
  } else {
    chips.push(
      <Chip key="nouser" icon="account" size="sm" title="$SYS.REQ.USER.INFO did not answer (nats-server < 2.10, or the subject is not allowed)">
        user info unavailable
      </Chip>,
    );
  }
  chips.push(
    snap.mode === "system" ? (
      <Chip key="sys" icon="key" size="sm" tone="ok" title="This user can query the system account ($SYS)">
        system account
      </Chip>
    ) : (
      <Chip key="sys" icon="lock" size="sm" title={snap.sysNote ?? "No system-account access"}>
        no $SYS access
      </Chip>
    ),
  );
  if (snap.rttMs !== undefined)
    chips.push(
      <Chip key="rtt" icon="pulse" size="sm" title="Client ↔ server round-trip time">
        RTT {formatValue(snap.rttMs, "ms")}
      </Chip>,
    );
  return <>{chips}</>;
}

function LimitedNotice({ snap, onError }: { snap: ClusterSnapshot; onError: (e: string) => void }) {
  const monitor = snap.mode === "monitor";
  const call = (method: string, params?: unknown) => void rpc(method, params).catch((e: Error) => onError(e.message));
  const watched = snap.servers.find((s) => !s.ghost);
  const elsewhere = monitor && watched && !watched.connected;
  return (
    <Card
      tone={monitor ? "info" : "warn"}
      icon={monitor ? "info" : "warning"}
      title={monitor ? (elsewhere ? "One server only" : "Connected server only") : "No monitoring data"}
      subtitle={monitor ? <span class="mono">{snap.monitorUrl}</span> : "limited view"}
      footer={
        <div class="cl-notice-actions">
          <Button small variant="secondary" icon="account" onClick={() => call("whoAmI")}>
            Who am I
          </Button>
          <Button small variant="secondary" icon="edit" onClick={() => call("editConnection")}>
            Edit connection
          </Button>
          {monitor && (
            <Button small variant="ghost" icon="link-external" title="Open the monitoring page in the browser" onClick={() => call("openMonitor", { path: "/" })}>
              Monitoring page
            </Button>
          )}
        </div>
      }
    >
      <div class="cl-notice">
        <p>
          {monitor ? (
            <>
              This user has no system-account access, so only {elsewhere ? <>the server behind the monitoring URL (<span class="mono">{watched?.name}</span>, not the one this client is connected to)</> : "the connected server"} is shown, read from its HTTP monitoring endpoint (<span class="mono">/varz</span>, <span class="mono">/routez</span>, <span class="mono">/gatewayz</span>, <span class="mono">/leafz</span>, <span class="mono">/healthz</span>). Route peers appear as outlines.
            </>
          ) : (
            <>
              Neither <span class="mono">$SYS</span> nor the HTTP monitoring endpoint is reachable{snap.monitorError ? <> (<span class="mono">{snap.monitorError}</span>)</> : null}, so only the server's INFO block is shown.
            </>
          )}
        </p>
        <p class="cl-howto">
          <b>To see every server</b>, connect with a user of the system account: set <span class="mono">system_account: SYS</span> in <span class="mono">nats-server.conf</span> with a user in that account, then add a connection (or NATS CLI context) for it.
          {!monitor && (
            <>
              {" "}
              <b>To enable monitoring</b>, start the server with <span class="mono">-m 8222</span> (or <span class="mono">http_port: 8222</span>) and set the monitoring URL in the connection settings if it is not <span class="mono">http://&lt;host&gt;:8222</span>.
            </>
          )}
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Cluster map
// ---------------------------------------------------------------------------------------------

function Glyph({ name, x, y, size = 16, class: cls }: { name: GlyphName; x: number; y: number; size?: number; class?: string }) {
  const g = GLYPHS[name];
  return <path d={g.d} fill-rule={"evenOdd" in g && g.evenOdd ? "evenodd" : undefined} class={cls} transform={`translate(${x},${y}) scale(${size / 16})`} />;
}

function ClusterMap({ snap, selected, onSelect, onDetails }: { snap: ClusterSnapshot; selected?: string; onSelect: (id: string) => void; onDetails: (s: ServerRow) => void }) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const graph = useMemo(() => buildClusterGraph(snap), [snap]);
  const layout: ClusterLayout = useMemo(() => layoutClusterGraph(graph, { maxWidth: Math.max(320, ((size.width || 700) - 16) / 0.85) }), [graph, size.width]);
  const byId = useMemo(() => new Map(snap.servers.map((s) => [s.id, s])), [snap]);
  const [hover, setHover] = useState<string | undefined>();
  if (!snap.servers.length) return <EmptyState compact kind="no-data" title="No servers to show" />;
  const scale = size.width && layout.width > size.width - 16 ? (size.width - 16) / layout.width : 1;
  const h = Math.ceil(layout.height * scale) + 16;
  const hs = hover ? byId.get(hover) : undefined;
  const hp = hover ? layout.servers.find((p) => p.id === hover) : undefined;
  return (
    <div ref={ref} class="cl-map" style={{ height: `${h}px` }}>
      <svg width={Math.max(0, size.width)} height={h} role="group" aria-label={`Cluster map: ${layout.clusters.length} cluster${layout.clusters.length === 1 ? "" : "s"}, ${layout.servers.length} servers, ${layout.routes.length} routes, ${layout.gateways.length} gateways, ${layout.leafs.length} leaf nodes`}>
        <g transform={`translate(${Math.max(8, ((size.width || 0) - layout.width * scale) / 2)},8) scale(${scale})`}>
          {layout.clusters.map((c) => (
            <g key={c.name} class={cx("cl-cluster", c.remote && "cl-cluster-remote")}>
              <rect x={c.x} y={c.y} width={c.w} height={c.h} rx="10" />
              <text x={c.x + 12} y={c.y + 18} class="cl-cluster-label">
                {c.remote ? "↗ " : ""}
                {c.label}
              </text>
              <text x={c.x + c.w - 12} y={c.y + 18} text-anchor="end" class="cl-cluster-count">
                {c.remote ? "remote cluster" : `${c.count} server${c.count === 1 ? "" : "s"}`}
              </text>
            </g>
          ))}
          <g aria-hidden="true">
            {layout.gateways.map((g) => (
              <g key={`${g.a}|${g.b}`} class="cl-gateway">
                <title>{`Gateway ${g.a} ↔ ${g.b}`}</title>
                <path d={g.d} />
                <text x={g.lx} y={g.ly} text-anchor="middle">
                  gateway
                </text>
              </g>
            ))}
            {layout.routes.map((r) => (
              <line key={`${r.a}|${r.b}`} class={cx("cl-route", hover && (r.a === hover || r.b === hover) && "cl-route-hl")} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2}>
                <title>{`Route ${byId.get(r.a)?.name} ↔ ${byId.get(r.b)?.name}`}</title>
              </line>
            ))}
            {layout.leafs.map((l) => (
              <line key={`l-${l.id}`} class="cl-leaf-link" x1={l.hx} y1={l.hy} x2={l.x + l.w / 2} y2={l.y} />
            ))}
          </g>
          {layout.servers.map((p) => {
            const s = byId.get(p.id)!;
            const { tone, issues } = serverTone(s);
            const label = `${s.name}${s.connected ? " (connected here)" : ""}${s.metaLeader ? ", JetStream meta leader" : ""}, ${s.ghost ? "route peer, no metrics" : `${TONE_LABEL[tone]}${issues.length ? `: ${issues.join("; ")}` : ""}`}`;
            return (
              <g
                key={p.id}
                class={cx("cl-server", `cl-tone-${tone}`, s.connected && "cl-connected", s.ghost && "cl-ghost", selected === p.id && "cl-selected")}
                transform={`translate(${p.x},${p.y})`}
                role="button"
                tabIndex={0}
                aria-label={label}
                onPointerEnter={() => setHover(p.id)}
                onPointerLeave={() => setHover((h2) => (h2 === p.id ? undefined : h2))}
                onFocus={() => setHover(p.id)}
                onBlur={() => setHover((h2) => (h2 === p.id ? undefined : h2))}
                onClick={() => onSelect(p.id)}
                onDblClick={() => onDetails(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (e.shiftKey) onDetails(s);
                    else onSelect(p.id);
                  }
                }}
              >
                <rect class="cl-server-halo" x="-3" y="-3" width={p.w + 6} height={p.h + 6} rx="9" />
                <rect class="cl-server-box" width={p.w} height={p.h} rx="6" />
                <Glyph name={s.connected ? "serverActive" : "server"} x={8} y={(p.h - 16) / 2} class="cl-server-glyph" />
                <text x={30} y={s.ghost ? p.h / 2 + 4 : p.h / 2 - 2} class="cl-server-name">
                  {s.name.length > 11 ? `${s.name.slice(0, 10)}…` : s.name}
                </text>
                {!s.ghost && (
                  <text x={30} y={p.h / 2 + 11} class="cl-server-sub">
                    {s.connections === undefined ? `v${s.version}` : `${s.cpu !== undefined ? `CPU ${Math.round((cpuFraction(s) ?? 0) * 100)}% · ` : ""}${formatValue(s.connections, "count")} conn`}
                  </text>
                )}
                {(tone === "warn" || tone === "danger") && <Glyph name={tone === "danger" ? "danger" : "warn"} x={p.w - 17} y={5} size={12} class={`cl-tone-glyph cl-tone-${tone}`} />}
                {s.metaLeader && <Glyph name="leader" x={p.w - (tone === "warn" || tone === "danger" ? 32 : 17)} y={5} size={12} class="cl-leader-glyph" />}
              </g>
            );
          })}
          {layout.leafs.map((l) => (
            <g key={l.id} class="cl-leaf">
              <title>{`Leaf node ${l.label}${l.account ? ` · account ${l.account}` : ""}`}</title>
              <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={l.h / 2} />
              <Glyph name="leaf" x={l.x + 6} y={l.y + (l.h - 12) / 2} size={12} class="cl-leaf-glyph" />
              <text x={l.x + 22} y={l.y + l.h / 2 + 4}>
                {l.label.length > 13 ? `${l.label.slice(0, 12)}…` : l.label}
              </text>
            </g>
          ))}
        </g>
      </svg>
      {layout.hiddenLeafs > 0 && <div class="cl-map-more small muted">+{layout.hiddenLeafs} more leaf nodes in the table below</div>}
      {hs && hp && !hs.ghost && (
        <ChartTooltip x={Math.max(8, ((size.width || 0) - layout.width * scale) / 2) + (hp.x + hp.w) * scale} y={8 + hp.y * scale} containerWidth={size.width}>
          <TipHead>
            <span class="mono">{hs.name}</span> {hs.connected ? <span class="muted">· connected</span> : null}
          </TipHead>
          <TipRow shape="none" value={`v${hs.version}`} label={hs.cluster ? `cluster ${hs.cluster}` : "standalone"} />
          <TipRow shape="none" value={fmtUptime(hs.uptimeMs)} label="uptime" />
          <TipRow shape="none" value={`${fmtPct(hs.cpu)} (${hs.cores ?? "?"} cores)`} label="CPU" />
          <TipRow shape="none" value={formatValue(hs.mem ?? null, "bytes")} label="memory" />
          <TipRow shape="none" value={formatValue(hs.connections ?? null, "count")} label="connections" />
          {(hs.slowConsumers ?? 0) > 0 && <TipRow shape="none" value={<span class="tone-warn">{hs.slowConsumers}</span>} label="slow consumers" />}
          <div class="cl-tip-hint">Click: show card · double-click: details JSON</div>
        </ChartTooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Server card
// ---------------------------------------------------------------------------------------------

interface TsLike {
  series(k: string, w?: number): { t: number; v: number | null }[];
  last(k: string): number | undefined;
}

function ServerCard({ s, ts, win, selected, stale, onDetails, system }: { s: ServerRow; ts: TsLike; win: number; selected: boolean; stale: boolean; onDetails: (s: ServerRow) => void; system: boolean }) {
  const { tone, issues } = serverTone(s);
  if (s.ghost)
    return (
      <div id={`srv-${cssId(s.id)}`} class={cx("cl-card-wrap", selected && "cl-card-selected")}>
        <Card title={<span class="mono">{s.name}</span>} icon="vm" subtitle="route peer" minHeight={120}>
          <EmptyState compact icon="eye-closed" title="No metrics for this server">
            Known as a route peer of the connected server. System-account access shows its CPU, memory, connections and JetStream usage.
          </EmptyState>
        </Card>
      </div>
    );
  const inRate = ts.last(`in:${s.id}`);
  const outRate = ts.last(`out:${s.id}`);
  const trend = ts.series(`in:${s.id}`, win);
  return (
    <div id={`srv-${cssId(s.id)}`} class={cx("cl-card-wrap", selected && "cl-card-selected")}>
      <Card
        title={<span class="mono">{s.name}</span>}
        icon={s.connected ? "vm-active" : "vm"}
        subtitle={`${s.cluster ? `${s.cluster} · ` : ""}v${s.version}${s.uptimeMs !== undefined ? ` · up ${fmtUptime(s.uptimeMs)}` : ""}`}
        tone={tone === "ok" || tone === "neutral" ? undefined : tone}
        stale={stale}
        actions={system ? <Button variant="ghost" small icon="json" title="Server details: statsz, VARZ, JSZ and HEALTHZ as JSON" aria-label={`Details for ${s.name}`} onClick={() => onDetails(s)} /> : undefined}
      >
        <div class="cl-badges">
          <StatusDot tone={s.health?.status === "ok" ? "ok" : s.health?.status === "error" ? "danger" : "neutral"} label={s.health?.status === "ok" ? "Healthy" : s.health?.status === "error" ? "Health check failed" : "Health unknown"} showLabel size="sm" />
          {s.connected && (
            <Chip icon="plug" size="sm" tone="info" title="This client is connected to this server">
              connected here
            </Chip>
          )}
          {s.metaLeader && (
            <Chip icon="star-full" size="sm" title="JetStream meta-group leader">
              meta leader
            </Chip>
          )}
          {!s.jetstream && (
            <Chip icon="circle-slash" size="sm" title="JetStream is not enabled on this server">
              no JetStream
            </Chip>
          )}
          {s.tags?.map((t) => (
            <Chip key={t} icon="tag" size="sm" mono>
              {t}
            </Chip>
          ))}
        </div>
        {issues.length > 0 && (
          <ul class={cx("cl-issues", `cl-issues-${tone}`)}>
            {issues.map((i) => (
              <li key={i}>
                <ToneIcon tone={tone} /> {i}
              </li>
            ))}
          </ul>
        )}
        <div class="cl-gauges">
          {s.cpu !== undefined ? (
            <Gauge label="CPU" value={s.cpu} max={Math.max(1, s.cores ?? 1) * 100} unit="percent" size={128} sublabel={`${(s.cpu / 100).toFixed(1)} / ${s.cores ?? 1} cores`} />
          ) : (
            <div class="cl-gauge-off">
              <Icon name="dashboard" />
              <span>CPU not reported</span>
            </div>
          )}
          {s.js ? (
            <Gauge label="JetStream memory" value={s.js.memory} max={s.js.maxMemory} unit="bytes" size={128} warn={0.8} danger={0.95} />
          ) : (
            <div class="cl-gauge-off">
              <Icon name={s.jetstream ? "database" : "circle-slash"} />
              <span>{s.jetstream ? "JetStream usage not reported" : "JetStream off"}</span>
            </div>
          )}
        </div>
        <KeyValueGrid
          dense
          columns={2}
          items={[
            { label: "Connections", value: formatValue(s.connections ?? null, "count"), hint: `${formatValue(s.totalConnections ?? null, "count")} since start` },
            { label: "Subscriptions", value: formatValue(s.subscriptions ?? null, "count") },
            { label: "Memory (RSS)", value: formatValue(s.mem ?? null, "bytes") },
            { label: "Slow consumers", value: formatValue(s.slowConsumers ?? null, "count"), tone: (s.slowConsumers ?? 0) > 0 ? "warn" : undefined },
            { label: "Inbound", value: inRate === undefined ? "–" : formatValue(inRate, "msgs/s") },
            { label: "Outbound", value: outRate === undefined ? "–" : formatValue(outRate, "msgs/s") },
            { label: "Routes", value: `${s.routePeers.length} peer${s.routePeers.length === 1 ? "" : "s"}` },
            { label: s.gateways.length ? "Gateways" : "Leaf nodes", value: s.gateways.length ? s.gateways.join(", ") : s.leafs === undefined ? "–" : String(s.leafs), mono: s.gateways.length > 0 },
          ]}
        />
        {s.js && <Meter label="JetStream storage" value={s.js.storage} max={s.js.maxStorage} unit="bytes" size="sm" warn={0.8} danger={0.95} />}
        {trend.length > 1 && (
          <div class="cl-trend">
            <span class="small muted">inbound msgs/s</span>
            <Sparkline values={trend} height={22} unit="msgs/s" label={`${s.name} inbound message rate`} />
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

function ServersTable({ rows, ts, onRow, selected }: { rows: ServerRow[]; ts: TsLike; onRow: (s: ServerRow) => void; selected?: string }) {
  const columns: Column<ServerRow>[] = [
    {
      key: "name",
      header: "Server",
      value: (r) => r.name,
      render: (r) => {
        const { tone } = serverTone(r);
        return (
          <span class="cl-name-cell">
            <StatusDot tone={tone} label={TONE_LABEL[tone]} size="sm" />
            <span class="mono">{r.name}</span>
            {r.connected && <Icon name="plug" title="connected here" />}
            {r.metaLeader && <Icon name="star-full" title="JetStream meta leader" />}
          </span>
        );
      },
    },
    { key: "cluster", header: "Cluster", mono: true, value: (r) => r.cluster ?? "", hideBelow: "sm" },
    { key: "version", header: "Version", value: (r) => r.version, hideBelow: "md" },
    { key: "uptime", header: "Uptime", numeric: true, value: (r) => r.uptimeMs, render: (r) => fmtUptime(r.uptimeMs), hideBelow: "md" },
    {
      key: "cpu",
      header: "CPU",
      numeric: true,
      width: "130px",
      title: "Process CPU as a share of all cores",
      value: (r) => (cpuFraction(r) ?? -1) * 100,
      render: (r) => (r.cpu === undefined ? <span class="muted">–</span> : <Meter inline size="sm" show="percent" ticks={false} value={(cpuFraction(r) ?? 0) * 100} max={100} unit="percent" title={`${fmtPct(r.cpu)} of one core · ${r.cores} cores`} />),
    },
    { key: "mem", header: "Memory", numeric: true, unit: "bytes", value: (r) => r.mem, hideBelow: "sm" },
    { key: "connections", header: "Conns", numeric: true, value: (r) => r.connections, title: "Client connections" },
    { key: "subscriptions", header: "Subs", numeric: true, value: (r) => r.subscriptions, hideBelow: "md" },
    { key: "in", header: "In msgs/s", numeric: true, value: (r) => ts.last(`in:${r.id}`), render: (r) => formatValue(ts.last(`in:${r.id}`) ?? null, "msgs/s"), hideBelow: "md" },
    { key: "slow", header: "Slow", numeric: true, value: (r) => r.slowConsumers, title: "Slow consumers", render: (r) => <span class={(r.slowConsumers ?? 0) > 0 ? "tone-warn" : undefined}>{formatValue(r.slowConsumers ?? null, "count")}</span> },
    {
      key: "js",
      header: "JS storage",
      numeric: true,
      width: "140px",
      hideBelow: "sm",
      value: (r) => (r.js && r.js.maxStorage > 0 ? r.js.storage / r.js.maxStorage : -1),
      render: (r) => (r.js ? <Meter inline size="sm" show="percent" ticks={false} value={r.js.storage} max={r.js.maxStorage} unit="bytes" warn={0.8} danger={0.95} /> : <span class="muted">{r.jetstream ? "–" : "off"}</span>),
    },
    {
      key: "health",
      header: "Health",
      value: (r) => r.health?.status ?? "unknown",
      render: (r) => (r.ghost ? <span class="muted">–</span> : <StatusDot tone={r.health?.status === "ok" ? "ok" : r.health?.status === "error" ? "danger" : "neutral"} label={r.health?.status === "ok" ? "ok" : r.health?.status === "error" ? (r.health.detail ?? "failing") : "unknown"} showLabel size="sm" />),
    },
  ];
  return (
    <DataTable
      label="Servers"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      filter={{ placeholder: "Filter servers…" }}
      initialSort={{ key: "name", dir: "asc" }}
      onRowClick={onRow}
      selectedKey={selected}
      rowTone={(r) => {
        const t = serverTone(r).tone;
        return t === "warn" || t === "danger" ? t : undefined;
      }}
      dense
      empty={<EmptyState compact kind="no-data" title="No servers" />}
    />
  );
}

function RoutesTable({ routes, compact }: { routes: RouteRow[]; compact?: boolean }) {
  const columns: Column<RouteRow>[] = [
    { key: "from", header: "Server", mono: true, value: (r) => r.serverName },
    { key: "to", header: "Peer", mono: true, value: (r) => r.remoteName ?? r.remoteId ?? `${r.ip}:${r.port}` },
    { key: "pool", header: "Conns", numeric: true, value: (r) => r.connections, title: "Pooled route connections to this peer", hideBelow: "sm" },
    { key: "rtt", header: "RTT", numeric: true, unit: "ms", value: (r) => r.rttMs, descFirst: true },
    { key: "inMsgs", header: "Msgs in", numeric: true, value: (r) => r.inMsgs, hideBelow: compact ? "sm" : undefined },
    { key: "outMsgs", header: "Msgs out", numeric: true, value: (r) => r.outMsgs, hideBelow: compact ? "sm" : undefined },
    { key: "bytes", header: "Bytes in / out", numeric: true, value: (r) => r.inBytes + r.outBytes, render: (r) => `${formatValue(r.inBytes, "bytes")} / ${formatValue(r.outBytes, "bytes")}`, hideBelow: "md" },
    { key: "pending", header: "Pending", numeric: true, unit: "bytes", value: (r) => r.pending, hideBelow: "md", title: "Bytes buffered for the peer" },
    { key: "subs", header: "Subs", numeric: true, value: (r) => r.subscriptions, hideBelow: "md" },
    { key: "compression", header: "Compression", value: (r) => r.compression ?? "", hideBelow: "md" },
  ];
  return (
    <DataTable
      label="Routes"
      columns={columns}
      rows={routes}
      rowKey={(r) => `${r.serverId}|${r.remoteId ?? r.remoteName ?? r.ip}`}
      initialSort={{ key: "from", dir: "asc" }}
      filter={compact ? false : { placeholder: "Filter routes…" }}
      dense
      maxHeight={compact ? 260 : 360}
      empty={<EmptyState compact kind="no-data" title="No routes">Standalone server, or route data needs system-account access or the monitoring endpoint.</EmptyState>}
    />
  );
}

function GatewaysTable({ rows }: { rows: GatewayRow[] }) {
  if (!rows.length)
    return (
      <EmptyState compact icon="globe" title="No gateways">
        This cluster is not linked to other clusters (no <span class="mono">gateway</span> block in the server config).
      </EmptyState>
    );
  const columns: Column<GatewayRow>[] = [
    { key: "server", header: "Server", mono: true, value: (r) => r.serverName },
    { key: "remote", header: "Remote cluster", mono: true, value: (r) => r.remote },
    { key: "dir", header: "Dir", value: (r) => r.direction, render: (r) => <span title={r.direction}>{r.direction === "outbound" ? "→ out" : "← in"}</span> },
    { key: "rtt", header: "RTT", numeric: true, unit: "ms", value: (r) => r.rttMs, hideBelow: "sm" },
    { key: "msgs", header: "Msgs in / out", numeric: true, value: (r) => (r.inMsgs ?? 0) + (r.outMsgs ?? 0), render: (r) => `${formatValue(r.inMsgs ?? null, "count")} / ${formatValue(r.outMsgs ?? null, "count")}`, hideBelow: "sm" },
  ];
  return <DataTable label="Gateways" columns={columns} rows={rows} rowKey={(r, i) => `${r.serverId}|${r.remote}|${r.direction}|${i}`} dense maxHeight={300} />;
}

function LeafsTable({ rows }: { rows: LeafRow[] }) {
  if (!rows.length)
    return (
      <EmptyState compact icon="radio-tower" title="No leaf nodes">
        No leaf node connections reported (needs a <span class="mono">leafnodes</span> listener and remote servers connecting to it).
      </EmptyState>
    );
  const columns: Column<LeafRow>[] = [
    { key: "hub", header: "Hub server", mono: true, value: (r) => r.serverName },
    { key: "name", header: "Leaf", mono: true, value: (r) => r.name ?? "" },
    { key: "account", header: "Account", mono: true, value: (r) => r.account ?? "", hideBelow: "sm" },
    { key: "addr", header: "Address", mono: true, value: (r) => (r.ip ? `${r.ip}:${r.port}` : ""), hideBelow: "md" },
    { key: "rtt", header: "RTT", numeric: true, unit: "ms", value: (r) => r.rttMs, hideBelow: "sm" },
    { key: "subs", header: "Subs", numeric: true, value: (r) => r.subscriptions, hideBelow: "md" },
  ];
  return <DataTable label="Leaf nodes" columns={columns} rows={rows} rowKey={(r, i) => `${r.serverId}|${r.name}|${i}`} dense maxHeight={300} filter={rows.length > 8} />;
}

render(<App />, document.getElementById("root")!);

import "./lib/styles.css";
import "./dashboard.css";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getInit, getState, onEvent, rpc, setState } from "./lib/vscode";
import { Button, ErrorBanner, Icon, cx } from "./lib/ui";
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
  Skeleton,
  TimeRangePicker,
  rangeMs,
  type Column,
  type KeyValueItem,
} from "./lib/dashboard";
import { BarList, CrosshairSync, Gauge, HealthPill, ItemsTable, Meter, SeriesTable, TimeSeriesChart, formatValue, useTimeSeries, type TimeSeries } from "./lib/charts";
import { fmtBytes, fmtNumber } from "../src/shared/format";
import { subjectMatches } from "../src/shared/subjects";
import {
  DOCS_LINKS,
  LIMIT_SOURCE_LABEL,
  RateSampler,
  connectionRates,
  counterIncrease,
  ownConnectionCid,
  parseGoDuration,
  resolveLimit,
  rttTone,
  stateLabel,
  stateTone,
  type AllowedCommand,
  type HealthDTO,
  type Rates,
} from "../src/overview/model";
import type { DashboardInit, DashboardSnapshot, StreamRow } from "../src/panels/dashboardPanel";

const init = getInit<DashboardInit>();
type Conn = NonNullable<DashboardSnapshot["monitor"]["connz"]>["connections"][number];
type Key = "in" | "out" | "bin" | "bout" | "cin" | "cout" | "cbin" | "cbout" | "cpu" | "mem" | "rtt" | "conns" | "subs" | "slow";
interface Persisted {
  range: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const INTERNAL = /^(KV_|OBJ_)/;

function App() {
  const saved = getState<Persisted>();
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState(saved?.range ?? "5m");
  const [cfg, setCfg] = useState({ refreshInterval: init.refreshInterval, rttWarnMs: init.rttWarnMs ?? 100 });
  const [connRates, setConnRates] = useState<Map<number, Rates>>(new Map());
  const [selectedCid, setSelectedCid] = useState<string | undefined>(undefined);
  // Enough samples for the longest range at the configured interval (one buffer entry per snapshot).
  const capacity = useMemo(() => Math.min(7200, Math.max(600, Math.ceil(3_600_000 / Math.max(500, init.refreshInterval)) + 30)), []);
  const ts = useTimeSeries<Key>(capacity);
  // Rates are computed here rather than with ts.pushCounters so the baseline restarts when /varz
  // answers from another server (a monitoring URL behind a load balancer) instead of mixing
  // counters of different servers into spikes.
  const rates = useRef(new RateSampler());
  const prevConnz = useRef<{ t: number; serverId?: string; conns: Conn[] } | undefined>(undefined);
  /** When the server currently behind /varz first answered (cumulative counters restart there). */
  const varzSince = useRef<{ id?: string; t: number }>({ t: 0 });
  const lastAt = useRef(0);
  const lastLiveAt = useRef<number | undefined>(undefined);

  const ingest = (s: DashboardSnapshot) => {
    // A manual refresh can race a pushed snapshot: never go back in time (charts need ordered points).
    if (s.at <= lastAt.current) return;
    // The host keeps the pause across webview reloads: adopt it from the first snapshot.
    if (!lastAt.current && s.paused !== undefined) setPaused(!!s.paused);
    const tooClose = s.at - lastAt.current < Math.max(250, init.refreshInterval * 0.4);
    lastAt.current = s.at;
    // "showing data from …" in the connection banner: the last sample taken over a live connection.
    if (s.state === "connected") lastLiveAt.current = s.at;
    setSnap(s);
    // A refresh right after a poll would turn counter deltas over a few ms into spikes.
    if (tooClose) return;
    const v = s.monitor.varz;
    if (v && v.server_id !== varzSince.current.id) varzSince.current = { id: v.server_id, t: s.at };
    const sr = v ? rates.current.update("server", "server", s.at, { inMsgs: v.in_msgs, outMsgs: v.out_msgs, inBytes: v.in_bytes, outBytes: v.out_bytes }, v.server_id) : undefined;
    const cr = s.client ? rates.current.update("client", "client", s.at, s.client) : undefined;
    ts.push(s.at, {
      in: sr?.msgsIn,
      out: sr?.msgsOut,
      bin: sr?.bytesIn,
      bout: sr?.bytesOut,
      cin: cr?.msgsIn,
      cout: cr?.msgsOut,
      cbin: cr?.bytesIn,
      cbout: cr?.bytesOut,
      cpu: v?.cpu,
      mem: v?.mem,
      rtt: s.rttMs,
      conns: v?.connections,
      subs: v?.subscriptions,
      slow: v?.slow_consumers,
    });
    const cz = s.monitor.connz;
    if (cz) {
      // cids are per server: only diff two /connz samples of the same server.
      const cur = { t: s.at, serverId: v?.server_id, conns: cz.connections };
      setConnRates(connectionRates(prevConnz.current?.serverId === cur.serverId ? prevConnz.current : undefined, cur));
      prevConnz.current = cur;
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      ingest(await rpc<DashboardSnapshot>("refresh"));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const offs = [
      onEvent<DashboardSnapshot>("snapshot", ingest),
      onEvent<HealthDTO | undefined>("health", (h) => setSnap((s) => (s ? { ...s, health: h } : s))),
      onEvent<{ refreshInterval: number; rttWarnMs?: number }>("config", (c) => setCfg((x) => ({ refreshInterval: c.refreshInterval ?? x.refreshInterval, rttWarnMs: c.rttWarnMs ?? x.rttWarnMs }))),
    ];
    void refresh();
    return () => offs.forEach((off) => off());
  }, []);
  useEffect(() => setState<Persisted>({ range }), [range]);

  const call = (method: string, params?: unknown) => rpc(method, params).catch((e) => setError(errText(e)));
  const run = (command: AllowedCommand) => void call("run", { command });
  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    void call("setPaused", { paused: next });
  };

  const profile = snap?.profile ?? init.profile;
  const profileName = profile?.name ?? init.profileName;

  if (!snap) return <LoadingView profileName={profileName} error={error} onRetry={() => void refresh()} />;

  const v = snap.monitor.varz;
  const server = snap.server;
  const live = snap.state === "connected" || snap.state === "reconnecting";
  const stale = !live;
  const serverRates = !!v;
  // Server-wide rates come from /varz and stay current while the NATS connection is down.
  const rateStale = stale && !serverRates;
  // /varz and /connz describe the server behind the monitoring URL, which may be another
  // cluster member than the one this connection landed on.
  const otherServer = !!(v && server && v.server_id && server.id && v.server_id !== server.id);
  // Only within the current /varz server's samples (its counter restarts where another server answered).
  const newSlow = v ? counterIncrease(ts.series("slow", Math.min(rangeMs(range), Math.max(0, snap.at - varzSince.current.t)))) : undefined;
  const k = serverRates ? { in: "in", out: "out", bin: "bin", bout: "bout" } : { in: "cin", out: "cout", bin: "cbin", bout: "cbout" };
  const win = rangeMs(range);
  const pick = (key: Key) => ts.series(key, win);
  const spark = (key: Key) => ts.series(key, 300_000);
  const sourceLabel = serverRates ? "server-wide (/varz)" : "this connection only";
  const rateHint = serverRates ? "Server-wide, from /varz counters (all clients of this server)." : "This VS Code connection only (nc.stats()): the monitoring endpoint is unreachable.";
  const version = server?.version ?? v?.version;
  const rt = rttTone(snap.rttMs, cfg.rttWarnMs);
  const health = snap.health;
  const healthz = snap.monitor.health;
  const uptimeMs = parseGoDuration(v?.uptime);

  const throughput: TimeSeries[] = [
    { id: "in", name: "Inbound", points: pick(k.in as Key) },
    { id: "out", name: "Outbound", points: pick(k.out as Key) },
  ];
  const bandwidth: TimeSeries[] = [
    { id: "bin", name: "Inbound", points: pick(k.bin as Key) },
    { id: "bout", name: "Outbound", points: pick(k.bout as Key) },
  ];
  const cpuSeries: TimeSeries[] = [{ id: "cpu", name: "CPU", points: pick("cpu") }];
  const memSeries: TimeSeries[] = [{ id: "mem", name: "Resident memory", points: pick("mem") }];
  const rttSeries: TimeSeries[] = [{ id: "rtt", name: "Round trip", points: pick("rtt"), tone: rt === "warn" || rt === "danger" ? rt : undefined }];
  const rttMax = ts.stats("rtt", win)?.max ?? 0;

  const header = (
    <DashboardHeader
      icon="dashboard"
      title={server?.name ?? v?.server_name ?? profileName}
      subtitle={
        <>
          <span class="mono">{snap.connectedUrl ?? snap.monitor.url ?? init.monitorUrl ?? ""}</span>
          {version && ` · v${version}`} · {profileName}
        </>
      }
      env={profile?.environment}
      readOnly={profile?.readOnly}
      connectionName={profileName}
      status={{ tone: stateTone(snap.state), label: stateLabel(snap.state), pulse: snap.state === "connected" || snap.state === "reconnecting" }}
      actions={
        <>
          <Button small variant="ghost" icon="json" onClick={() => void call("openServerInfo")}>
            Server info JSON
          </Button>
          {snap.monitor.ok && <Button small variant="ghost" icon="link-external" title={`Open ${snap.monitor.url} in the browser`} aria-label="Open the monitoring endpoint in the browser" onClick={() => void call("openMonitor", {})} />}
          <Button small variant="ghost" icon="radio-tower" title="Live Tail (subscribe)" aria-label="Live Tail" disabled={!live} onClick={() => run("nats.subscribe")} />
          <Button small variant="ghost" icon="type-hierarchy" title="Open JetStream topology" aria-label="Open JetStream topology" disabled={!live} onClick={() => run("nats.openTopology")} />
        </>
      }
      meta={
        <>
          {health ? (
            <HealthPill score={health.score} size="sm" onClick={() => run("nats.openHealthDashboard")} title={`Health ${Math.round(health.score)} / 100 · ${health.errors} errors, ${health.warnings} warnings — open the health dashboard`} />
          ) : (
            live && (
              <Chip size="sm" icon="pulse" onClick={() => run("nats.runHealthCheck")} title="No health check has run for this connection yet">
                Run health check
              </Chip>
            )
          )}
          {healthz && (
            <Chip size="sm" tone={healthz.status === "ok" ? "ok" : "danger"} icon={healthz.status === "ok" ? "heart" : "warning"} title={healthz.error ?? "Server /healthz status"}>
              {`healthz ${healthz.status}`}
            </Chip>
          )}
          {server?.cluster && (
            <Chip size="sm" icon="organization" title="Cluster">
              <span class="mono">{server.cluster}</span>
            </Chip>
          )}
          {(snap.jetstream?.domain ?? server?.domain) && (
            <Chip size="sm" icon="layers" title="JetStream domain">
              domain <span class="mono">{snap.jetstream?.domain ?? server?.domain}</span>
            </Chip>
          )}
          {server && (
            <Chip size="sm" icon={server.tlsRequired ? "shield" : "unlock"} tone={server.tlsRequired ? "ok" : undefined} title="Transport security">
              {server.tlsRequired ? "TLS" : "no TLS"}
            </Chip>
          )}
          {server && (
            <Chip size="sm" icon={server.jetstream ? "database" : "circle-slash"} title="JetStream on this server">
              {server.jetstream ? "JetStream" : "no JetStream"}
            </Chip>
          )}
          {v && (
            <Chip size="sm" icon="clock" title={`Started ${new Date(v.start).toLocaleString()}`}>
              {`up ${v.uptime}`}
            </Chip>
          )}
        </>
      }
    />
  );

  const notConnectedAtAll = !live && !snap.monitor.ok;

  return (
    <DashboardPage class="dash-page" header={header} label={`Server dashboard for ${profileName}`}>
      <FilterBar label="Dashboard controls">
        <TimeRangePicker value={range} onChange={(id) => setRange(id)} />
        <RefreshIndicator updatedAt={snap.at} paused={paused} refreshing={refreshing} error={error ?? undefined} intervalMs={cfg.refreshInterval} onTogglePause={togglePause} onRefresh={() => void refresh()} />
        <span class="spacer" />
        {otherServer && (
          <Chip size="sm" tone="warn" icon="warning" title={`The monitoring endpoint ${snap.monitor.url ?? ""} belongs to ${v!.server_name}, but this connection is on ${server!.name}. CPU, memory, rates and client connections describe ${v!.server_name}. Set the Monitor URL in the connection settings to pick the server.`}>
            {`Monitoring: ${v!.server_name}`}
          </Chip>
        )}
        {(live || serverRates) && (
          <Chip size="sm" icon={serverRates ? "server" : "plug"} title={rateHint}>
            {`Rates: ${sourceLabel}`}
          </Chip>
        )}
      </FilterBar>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <ConnectionBanner
        state={snap.state}
        message={`${snap.error ? `${snap.error}. ` : ""}NATS data is unavailable${snap.monitor.ok ? "; monitoring data is still shown" : ""}.`}
        since={lastLiveAt.current}
        onRetry={(snap.state === "error" || snap.state === "disconnected") && snap.monitor.ok ? () => void call("connect").then(() => refresh()) : undefined}
        retryLabel="Connect"
      />
      {!snap.monitor.ok && (
        <div class="dash-notice" role="note">
          <Icon name="info" />
          <span class="dash-notice-text">
            Monitoring endpoint {snap.monitor.url ? <span class="mono">{snap.monitor.url}</span> : ""} is unreachable{snap.monitor.error ? ` (${snap.monitor.error})` : ""}. Start nats-server with <span class="mono">-m 8222</span> or set the Monitor URL in the connection settings to see
            CPU, memory, server-wide throughput and client connections.
          </span>
          <span class="dash-notice-actions">
            <Button small icon="edit" onClick={() => void call("editConnection")}>
              Edit connection
            </Button>
            <Button small variant="ghost" icon="book" onClick={() => void call("openDocs", { url: DOCS_LINKS.monitoring })}>
              Docs
            </Button>
          </span>
        </div>
      )}

      {notConnectedAtAll ? (
        <EmptyState
          kind="no-connection"
          title={snap.state === "connecting" ? `Connecting to ${profileName}…` : `${profileName} is not connected`}
          primary={snap.state === "connecting" ? undefined : { label: "Connect", icon: "plug", onClick: () => void call("connect").then(() => refresh()) }}
          secondary={{ label: "Edit connection", icon: "edit", onClick: () => void call("editConnection") }}
        >
          Connect to load server identity, round-trip time, JetStream usage and streams{snap.monitor.url ? <>; enable monitoring at <span class="mono">{snap.monitor.url}</span> for CPU, memory and clients</> : ""}.
        </EmptyState>
      ) : (
        <>
          <KpiRow min={140} label="Key metrics">
            <KpiTile label="Inbound" value={ts.last(k.in as Key)} unit="msgs/s" previous={ts.stats(k.in as Key, win)?.avg} deltaLabel={`vs ${range} avg`} goodWhen="neither" trend={spark(k.in as Key)} hint={`Messages received per second. ${rateHint}`} stale={rateStale} />
            <KpiTile label="Outbound" value={ts.last(k.out as Key)} unit="msgs/s" previous={ts.stats(k.out as Key, win)?.avg} deltaLabel={`vs ${range} avg`} goodWhen="neither" trend={spark(k.out as Key)} hint={`Messages delivered per second. ${rateHint}`} stale={rateStale} />
            <KpiTile label="Bytes in" value={ts.last(k.bin as Key)} unit="bytes/s" previous={ts.stats(k.bin as Key, win)?.avg} deltaLabel={`vs ${range} avg`} goodWhen="neither" trend={spark(k.bin as Key)} hint={`Payload bytes received per second. ${rateHint}`} stale={rateStale} />
            <KpiTile label="Bytes out" value={ts.last(k.bout as Key)} unit="bytes/s" previous={ts.stats(k.bout as Key, win)?.avg} deltaLabel={`vs ${range} avg`} goodWhen="neither" trend={spark(k.bout as Key)} hint={`Payload bytes delivered per second. ${rateHint}`} stale={rateStale} />
            <KpiTile
              label="Connections"
              value={v?.connections}
              unit="count"
              previous={ts.previous("conns", 30)}
              deltaMode="absolute"
              deltaLabel="vs 30 samples ago"
              goodWhen="neither"
              sub={v ? `${fmtNumber(v.subscriptions)} subscriptions` : "needs /varz"}
              meter={v?.max_connections ? { value: v.connections, max: v.max_connections } : undefined}
              hint={`Client connections to this server${v?.max_connections ? ` (max_connections ${fmtNumber(v.max_connections)})` : ""}; ${v ? fmtNumber(v.total_connections) : "–"} accepted since start.`}
            />
            <KpiTile
              label="Slow consumers"
              value={v?.slow_consumers}
              unit="count"
              tone={v ? (newSlow && newSlow > 0 ? "danger" : v.slow_consumers > 0 ? "warn" : "ok") : undefined}
              sub={v ? (newSlow && newSlow > 0 ? `+${fmtNumber(newSlow)} in the last ${range}` : v.slow_consumers > 0 ? `none new in ${range}` : "since server start") : "needs /varz"}
              hint="Clients the server disconnected or dropped messages for because they could not keep up (cumulative since server start). Red when the count grew within the selected time range."
            />
            <KpiTile label="Round trip" value={snap.rttMs} unit="ms" tone={rt === "neutral" ? undefined : rt} previous={ts.stats("rtt", win)?.avg} deltaLabel={`vs ${range} avg`} goodWhen="down" trend={spark("rtt")} hint={`PING/PONG round trip from VS Code to ${snap.connectedUrl ?? "the server"}. Warning at ${cfg.rttWarnMs} ms (nats.health.rttWarningMs).`} stale={stale} />
            <KpiTile label="Uptime" value={v ? v.uptime : null} sub={v ? `since ${new Date(v.start).toLocaleDateString()}` : "needs /varz"} hint={uptimeMs ? `Server started ${new Date(v!.start).toLocaleString()}` : "Server uptime from /varz."} />
          </KpiRow>

          <SectionHeading title="Traffic" subtitle={`last ${range} · ${sourceLabel} · charts share one crosshair`} />
          <CrosshairSync>
            <Grid>
              <Card span={6} title="Message throughput" subtitle="msgs/s" icon="pulse" stale={rateStale} tableView={() => <SeriesTable series={throughput} unit="msgs/s" caption="Message throughput" />}>
                <TimeSeriesChart series={throughput} label="Message throughput" unit="msgs/s" windowMs={win} height={190} emptyText="Collecting samples — rates appear after the second poll" />
              </Card>
              <Card span={6} title="Bandwidth" subtitle="bytes/s" icon="arrow-swap" stale={rateStale} tableView={() => <SeriesTable series={bandwidth} unit="bytes/s" caption="Bandwidth" />}>
                <TimeSeriesChart series={bandwidth} label="Bandwidth" unit="bytes/s" windowMs={win} height={190} emptyText="Collecting samples — rates appear after the second poll" />
              </Card>
              <Card span={4} title="CPU" subtitle={v ? `% of one core · ${v.cores} cores` : "% of one core"} icon="pulse" tableView={() => <SeriesTable series={cpuSeries} unit="percent" caption="CPU" />}>
                <TimeSeriesChart series={cpuSeries} label="CPU usage" unit="percent" windowMs={win} height={150} emptyText={v ? "Collecting samples…" : "Requires the monitoring endpoint (/varz)"} />
              </Card>
              <Card span={4} title="Memory" subtitle="resident set size" icon="server" tableView={() => <SeriesTable series={memSeries} unit="bytes" caption="Resident memory" />}>
                <TimeSeriesChart series={memSeries} label="Resident memory" unit="bytes" windowMs={win} height={150} emptyText={v ? "Collecting samples…" : "Requires the monitoring endpoint (/varz)"} />
              </Card>
              <Card span={4} title="Round-trip time" subtitle="ms · from VS Code" icon="watch" stale={stale} tableView={() => <SeriesTable series={rttSeries} unit="ms" caption="Round-trip time" />}>
                <TimeSeriesChart
                  series={rttSeries}
                  label="Round-trip time"
                  unit="ms"
                  windowMs={win}
                  height={150}
                 
                  thresholds={rttMax >= cfg.rttWarnMs * 0.5 ? [{ value: cfg.rttWarnMs, tone: "warn", label: "warn" }] : []}
                  emptyText={live ? "Collecting samples…" : "Not connected"}
                />
              </Card>
            </Grid>
          </CrosshairSync>

          <SectionHeading title="Resources" subtitle="CPU, JetStream memory and storage against their limits" />
          <Grid>
            <UtilisationCard snap={snap} />
            <JetStreamCard snap={snap} />
            <LargestStreamsCard snap={snap} onBrowse={(stream) => void call("browseStream", { stream })} />
          </Grid>

          <SectionHeading title="Server & clients" />
          <Grid>
            <ServerCard snap={snap} />
            <TopClientsCard snap={snap} rates={connRates} selected={selectedCid} onSelect={(cid) => setSelectedCid((s) => (s === cid ? undefined : cid))} />
            <ConnectionsCard snap={snap} rates={connRates} selected={selectedCid} onSelect={(cid) => setSelectedCid((s) => (s === cid ? undefined : cid))} />
          </Grid>

          <SectionHeading title="JetStream" />
          <Grid>
            <StreamsCard snap={snap} onBrowse={(stream) => void call("browseStream", { stream })} />
          </Grid>
        </>
      )}
    </DashboardPage>
  );
}

function LoadingView({ profileName, error, onRetry }: { profileName: string; error: string | null; onRetry: () => void }) {
  return (
    <DashboardPage
      class="dash-page"
      label={`Loading dashboard for ${profileName}`}
      header={<DashboardHeader icon="dashboard" title={profileName} subtitle={<Skeleton width={220} variant="text" />} env={init.profile?.environment} readOnly={init.profile?.readOnly} connectionName={profileName} status={{ tone: "info", label: "Loading…", pulse: true }} />}
    >
      {error ? (
        <EmptyState kind="error" title="Couldn't load the dashboard" primary={{ label: "Retry", icon: "refresh", onClick: onRetry }}>
          {error}
        </EmptyState>
      ) : (
        <>
          <KpiRow min={140} label="Key metrics">
            {["Inbound", "Outbound", "Bytes in", "Bytes out", "Connections", "Slow consumers", "Round trip", "Uptime"].map((l) => (
              <KpiTile key={l} label={l} value={null} loading />
            ))}
          </KpiRow>
          <Grid>
            <Card span={6} title="Message throughput" icon="pulse" loading minHeight={210} />
            <Card span={6} title="Bandwidth" icon="arrow-swap" loading minHeight={210} />
            <Card span={4} title="CPU" icon="pulse" loading minHeight={170} />
            <Card span={4} title="Memory" icon="server" loading minHeight={170} />
            <Card span={4} title="Round-trip time" icon="watch" loading minHeight={170} />
          </Grid>
        </>
      )}
    </DashboardPage>
  );
}

// ---------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------

function jsLimits(snap: DashboardSnapshot) {
  const js = snap.jetstream;
  const jsz = snap.monitor.jsz;
  const tiers = js?.tierLimits ?? [];
  const lim = (account: number | undefined, tier: (number | undefined)[], server: number | undefined) => {
    const r = resolveLimit(account, tier, server);
    return { max: r.max ?? -1, source: LIMIT_SOURCE_LABEL[r.source], kind: r.source };
  };
  return {
    storage: lim(js?.limits?.maxStorage, tiers.map((t) => t.maxStorage), jsz?.maxStorage),
    memory: lim(js?.limits?.maxMemory, tiers.map((t) => t.maxMemory), jsz?.maxMemory),
  };
}

function UtilisationCard({ snap }: { snap: DashboardSnapshot }) {
  const v = snap.monitor.varz;
  const js = snap.jetstream;
  const lim = jsLimits(snap);
  const jsOn = js?.enabled && !js.error;
  return (
    <Card span={4} title="Utilisation" icon="dashboard" footer={<span>CPU from /varz (dial: share of all cores) · JetStream from account info{lim.storage.kind !== "account" ? ` · limits: ${lim.storage.source}` : ""}</span>}>
      <div class="dash-gauges">
        {v ? (
          <Gauge label={`CPU · ${v.cores} cores`} value={v.cpu} max={100 * Math.max(1, v.cores)} unit="percent" size={144} sublabel={`${v.cpu.toFixed(1)}% of one core`} />
        ) : (
          <div class="dash-gauge-empty">
            <span class="muted small">CPU needs /varz</span>
          </div>
        )}
        {jsOn ? (
          <>
            <Gauge label="JetStream memory" value={js!.memory ?? 0} max={lim.memory.max} unit="bytes" size={144} />
            <Gauge label="JetStream storage" value={js!.storage ?? 0} max={lim.storage.max} unit="bytes" size={144} />
          </>
        ) : (
          <div class="dash-gauge-empty">
            <span class="muted small">{js?.enabled === false ? "JetStream not enabled" : js?.error ? "JetStream error" : "JetStream: not connected"}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function JetStreamCard({ snap }: { snap: DashboardSnapshot }) {
  const js = snap.jetstream;
  const jsz = snap.monitor.jsz;
  const lim = jsLimits(snap);
  const title = `JetStream account${js?.domain ? ` · ${js.domain}` : ""}`;
  if (!js)
    return (
      <Card span={4} title={title} icon="database">
        <EmptyState compact kind="no-connection" title="Not connected">
          Connect to load JetStream account usage.
        </EmptyState>
      </Card>
    );
  if (!js.enabled)
    return (
      <Card span={4} title={title} icon="database">
        <EmptyState compact icon="circle-slash" title="JetStream is not enabled">
          Start the server with <span class="mono">-js</span> (and grant the account JetStream) to use streams, KV and object stores.
        </EmptyState>
      </Card>
    );
  if (js.error)
    return (
      <Card span={4} title={title} icon="database" tone="danger">
        <EmptyState compact kind="error" title="JetStream account info failed">
          {js.error}
        </EmptyState>
      </Card>
    );
  const l = js.limits;
  const apiErrPct = js.api && js.api.total ? (js.api.errors / js.api.total) * 100 : 0;
  return (
    <Card
      span={4}
      title={title}
      icon="database"
      footer={
        jsz ? (
          <span>
            Server-wide: {fmtNumber(jsz.streams)} streams · {fmtNumber(jsz.consumers)} consumers · {fmtNumber(jsz.messages)} msgs · {fmtBytes(jsz.bytes)}
            {jsz.accounts !== undefined ? ` · ${jsz.accounts} account${jsz.accounts === 1 ? "" : "s"}` : ""}
          </span>
        ) : undefined
      }
    >
      <Meter label="Storage" value={js.storage ?? 0} max={lim.storage.max} unit="bytes" size="sm" title={`File storage · ${lim.storage.source}`} />
      <Meter label="Memory" value={js.memory ?? 0} max={lim.memory.max} unit="bytes" size="sm" title={`Memory storage · ${lim.memory.source}`} />
      <Meter label="Streams" value={js.streams ?? 0} max={l?.maxStreams ?? -1} unit="count" size="sm" />
      <Meter label="Consumers" value={js.consumers ?? 0} max={l?.maxConsumers ?? -1} unit="count" size="sm" />
      <div class="dash-chips">
        {js.api && (
          <Chip size="sm" tone={apiErrPct > 5 ? "warn" : undefined} icon="symbol-method" title="JetStream API requests by this account">
            {`API ${fmtNumber(js.api.total)} calls · ${fmtNumber(js.api.errors)} errors${js.api.level !== undefined ? ` · level ${js.api.level}` : ""}`}
          </Chip>
        )}
        {(js.reservedStorage ?? 0) > 0 && <Chip size="sm">{`reserved storage ${fmtBytes(js.reservedStorage)}`}</Chip>}
        {(js.reservedMemory ?? 0) > 0 && <Chip size="sm">{`reserved memory ${fmtBytes(js.reservedMemory)}`}</Chip>}
        {l?.maxAckPending !== undefined && l.maxAckPending > 0 && <Chip size="sm">{`max ack pending ${fmtNumber(l.maxAckPending)}`}</Chip>}
      </div>
    </Card>
  );
}

function LargestStreamsCard({ snap, onBrowse }: { snap: DashboardSnapshot; onBrowse: (stream: string) => void }) {
  const items = (snap.streams ?? []).map((s) => ({ id: s.name, label: s.name, value: s.bytes, secondary: `${fmtNumber(s.messages)} msgs`, hint: s.subjects.join(", ") || s.sourced }));
  return (
    <Card span={4} title="Largest streams" subtitle="bytes stored" icon="archive" tableView={() => <ItemsTable items={items} unit="bytes" labelHeader="Stream" valueHeader="Size" mono caption="Largest streams" />}>
      <BarList
        label="Largest streams by bytes stored"
        items={items}
        unit="bytes"
        mono
        limit={6}
        showShare
        onSelect={(it) => it.id && it.id !== "__other" && onBrowse(it.id)}
        emptyText={snap.jetstream?.enabled === false ? "JetStream is not enabled" : snap.streams ? "No streams yet" : "Requires a JetStream-enabled connection"}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Server & clients
// ---------------------------------------------------------------------------------------------

function ServerCard({ snap }: { snap: DashboardSnapshot }) {
  const s = snap.server;
  const v = snap.monitor.varz;
  if (!s)
    return (
      <Card span={6} title="Server" icon="server">
        <EmptyState compact kind="no-connection" title="No server information">
          Connect to see the negotiated server info.
        </EmptyState>
      </Card>
    );
  const items: KeyValueItem[] = [
    { label: "Name", value: s.name, mono: true },
    { label: "Version", value: `v${s.version} · proto ${s.proto}`, hint: `Built with ${s.go}` },
    { label: "Server ID", value: s.id, mono: true, copy: s.id, wide: true },
    { label: "Listen", value: `${s.host}:${s.port}`, mono: true },
    { label: "Connected URL", value: snap.connectedUrl ?? "–", mono: true },
    { label: "Cluster", value: s.cluster ?? "–", mono: !!s.cluster },
    { label: "Max payload", value: fmtBytes(s.maxPayload) },
    { label: "Security", value: `TLS ${s.tlsRequired ? "required" : "off"} · auth ${s.authRequired ? "required" : "off"}`, tone: s.tlsRequired ? "ok" : undefined },
    { label: "Features", value: `JetStream ${s.jetstream ? "on" : "off"} · headers ${s.headers ? "on" : "off"}` },
    { label: "This client", value: `cid ${s.clientId ?? "?"}${s.clientIp ? ` · ${s.clientIp}` : ""}`, mono: true },
  ];
  if (v) items.push({ label: "Topology", value: `${v.routes ?? 0} routes · ${v.leafnodes ?? 0} leafnodes${v.remotes ? ` · ${v.remotes} remotes` : ""}`, hint: "Cluster routes, leaf node connections and gateway remotes (/varz)" });
  if (snap.client) items.push({ label: "Client traffic", value: `${fmtNumber(snap.client.inMsgs)} in · ${fmtNumber(snap.client.outMsgs)} out · ${fmtBytes(snap.client.inBytes)} / ${fmtBytes(snap.client.outBytes)}`, hint: "Messages and bytes of this VS Code connection since it connected", wide: true });
  return (
    <Card span={6} title="Server" icon="server" stale={snap.state !== "connected"}>
      <KeyValueGrid items={items} minColumnWidth={180} dense />
    </Card>
  );
}

function TopClientsCard({ snap, rates, selected, onSelect }: { snap: DashboardSnapshot; rates: Map<number, Rates>; selected?: string; onSelect: (cid: string) => void }) {
  const connz = snap.monitor.connz;
  const items = (connz?.connections ?? [])
    .map((c) => {
      const r = rates.get(c.cid);
      return { id: String(c.cid), label: c.name || `cid ${c.cid}`, value: r ? r.msgsIn + r.msgsOut : 0, secondary: `${c.ip}:${c.port}`, hint: r ? `${formatValue(r.msgsIn, "msgs/s")} in · ${formatValue(r.msgsOut, "msgs/s")} out` : undefined };
    })
    .filter((it) => it.value > 0);
  return (
    <Card span={6} title="Top clients" subtitle="msgs/s in + out · from /connz" icon="person" tableView={() => <ItemsTable items={items} unit="msgs/s" labelHeader="Client" valueHeader="Msgs/s" mono caption="Top clients" />}>
      <BarList
        label="Top clients by message rate"
        items={items}
        unit="msgs/s"
        mono
        limit={8}
        onSelect={(it) => it.id && it.id !== "__other" && onSelect(it.id)}
        selectedId={selected}
        emptyText={!connz ? "Requires the monitoring endpoint (/connz)" : rates.size ? "No client traffic in the last interval" : "Rates appear after the second /connz sample"}
      />
    </Card>
  );
}

function ConnectionsCard({ snap, rates, selected, onSelect }: { snap: DashboardSnapshot; rates: Map<number, Rates>; selected?: string; onSelect: (cid: string) => void }) {
  const connz = snap.monitor.connz;
  const me = ownConnectionCid(snap.server, snap.monitor.varz?.server_id);
  const columns = useMemo<Column<Conn>[]>(
    () => [
      { key: "cid", header: "CID", numeric: true, width: "64px", descFirst: false, value: (c) => c.cid, render: (c) => <span class="mono">{c.cid}</span> },
      {
        key: "name",
        header: "Name",
        value: (c) => c.name ?? "",
        render: (c) => (
          <span class="dash-conn-name">
            <span class="ellipsis" title={c.name}>
              {c.name || <span class="muted">(unnamed)</span>}
            </span>
            {me !== undefined && c.cid === me && (
              <Chip size="sm" tone="info" title="This VS Code connection">
                you
              </Chip>
            )}
          </span>
        ),
      },
      { key: "addr", header: "Address", mono: true, value: (c) => `${c.ip}:${String(c.port).padStart(5, "0")}`, render: (c) => `${c.ip}:${c.port}` },
      { key: "lang", header: "Client", hideBelow: "md", value: (c) => [c.lang, c.version].filter(Boolean).join(" ") },
      { key: "account", header: "Account", hideBelow: "md", mono: true, value: (c) => [c.account && c.account !== "$G" ? c.account : "", c.authorized_user ?? ""].filter(Boolean).join(" ") || "", render: (c) => (c.account && c.account !== "$G" ? <span title={c.account}>{c.account.length > 14 ? `${c.account.slice(0, 12)}…` : c.account}</span> : <span class="muted">–</span>) },
      { key: "subs", header: "Subs", numeric: true, value: (c) => c.subscriptions },
      { key: "rate", header: "Msgs/s", numeric: true, unit: "msgs/s", title: "Messages in + out per second between the last two /connz samples", value: (c) => { const r = rates.get(c.cid); return r ? r.msgsIn + r.msgsOut : undefined; }, render: (c) => { const r = rates.get(c.cid); return r ? formatValue(r.msgsIn + r.msgsOut, "count") : <span class="muted">–</span>; } },
      { key: "inMsgs", header: "Msgs in", numeric: true, hideBelow: "sm", title: "Messages sent by the client (server in)", value: (c) => c.in_msgs },
      { key: "outMsgs", header: "Msgs out", numeric: true, hideBelow: "sm", title: "Messages delivered to the client (server out)", value: (c) => c.out_msgs },
      { key: "inBytes", header: "Bytes in", numeric: true, hideBelow: "md", unit: "bytes", value: (c) => c.in_bytes },
      { key: "outBytes", header: "Bytes out", numeric: true, hideBelow: "md", unit: "bytes", value: (c) => c.out_bytes },
      { key: "pending", header: "Pending", numeric: true, hideBelow: "md", unit: "bytes", title: "Bytes queued for the client; large values risk a slow-consumer disconnect", value: (c) => c.pending_bytes ?? 0 },
      { key: "uptime", header: "Uptime", numeric: true, hideBelow: "md", value: (c) => parseGoDuration(c.uptime), render: (c) => c.uptime },
      { key: "rtt", header: "RTT", numeric: true, title: "Server ↔ client round trip", value: (c) => (c.rtt ? parseGoDuration(c.rtt) : undefined), render: (c) => c.rtt ?? <span class="muted">–</span> },
    ],
    [me, rates],
  );
  const total = connz?.num_connections ?? 0;
  const monitored = snap.monitor.varz;
  const elsewhere = !!(monitored?.server_id && snap.server?.id && monitored.server_id !== snap.server.id);
  return (
    <Card span={12} title="Client connections" subtitle={connz ? `${total}${connz.total > total ? ` of ${connz.total}` : ""} · /connz${elsewhere ? ` of ${monitored!.server_name}` : ""}` : "/connz"} icon="plug" flush stale={!snap.monitor.ok && !!connz}>
      {!connz ? (
        <EmptyState compact kind="no-data" title="Client connections need the monitoring endpoint">
          The table is built from <span class="mono">/connz</span>{snap.monitor.url ? <> at <span class="mono">{snap.monitor.url}</span></> : ""}.
        </EmptyState>
      ) : (
        <DataTable
          label="Client connections"
          columns={columns}
          rows={connz.connections}
          rowKey={(c) => String(c.cid)}
          filter={{ placeholder: "Filter name, address, lang, account…" }}
          initialSort={{ key: "cid", dir: "asc" }}
          onRowClick={(c) => onSelect(String(c.cid))}
          selectedKey={selected}
          rowTone={(c) => (me !== undefined && c.cid === me ? "info" : (c.pending_bytes ?? 0) > 1024 * 1024 ? "warn" : undefined)}
          maxHeight={420}
          empty="No client connections reported."
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Streams ↔ subjects
// ---------------------------------------------------------------------------------------------

function StreamsCard({ snap, onBrowse }: { snap: DashboardSnapshot; onBrowse: (stream: string) => void }) {
  const [filter, setFilter] = useState("");
  const [internal, setInternal] = useState(false);
  const streams = snap.streams;
  const f = filter.trim();
  const literal = !!f && !/[*>\s]/.test(f) && !f.split(".").includes("") && f.includes(".");
  const rows = useMemo(() => {
    let list: StreamRow[] = (streams ?? []).filter((s) => internal || !INTERNAL.test(s.name));
    if (f) {
      const lower = f.toLowerCase();
      const lit = !/[*>\s]/.test(f) && !f.split(".").includes("");
      list = list.filter((s) => s.name.toLowerCase().includes(lower) || s.subjects.some((p) => p.toLowerCase().includes(lower) || (lit && subjectMatches(p, f))));
    }
    return list;
  }, [streams, f, internal]);
  const captured = literal ? rows.filter((s) => s.subjects.some((p) => subjectMatches(p, f))) : [];
  const hiddenInternal = (streams ?? []).filter((s) => INTERNAL.test(s.name)).length;
  const columns: Column<StreamRow>[] = [
    {
      key: "name",
      header: "Stream",
      value: (s) => s.name,
      render: (s) => (
        <span class="dash-stream-name">
          <Icon name={s.sourced.startsWith("mirror") ? "mirror" : s.sourced ? "merge" : INTERNAL.test(s.name) ? "symbol-key" : "database"} />
          <b class="mono">{s.name}</b>
        </span>
      ),
    },
    {
      key: "subjects",
      header: "Subjects",
      sortable: false,
      value: (s) => s.subjects.join(" ") || s.sourced,
      render: (s) => (
        <span class="dash-subjects mono">
          {s.subjects.length ? (
            s.subjects.map((p) => (
              <span key={p} class={cx("dash-subject", literal && subjectMatches(p, f) && "dash-subject-hit")} title={literal && subjectMatches(p, f) ? `captures ${f}` : undefined}>
                {literal && subjectMatches(p, f) && <Icon name="check" />}
                {p}
              </span>
            ))
          ) : (
            <span class="muted">{s.sourced || "—"}</span>
          )}
        </span>
      ),
    },
    { key: "messages", header: "Messages", numeric: true, value: (s) => s.messages },
    { key: "bytes", header: "Size", numeric: true, unit: "bytes", value: (s) => s.bytes },
    { key: "consumers", header: "Consumers", numeric: true, hideBelow: "sm", value: (s) => s.consumers },
    { key: "storage", header: "Storage / retention", hideBelow: "md", value: (s) => `${s.storage}/${s.retention}`, render: (s) => <span class="muted">{`${s.storage} · ${s.retention}${s.replicas > 1 ? ` · R${s.replicas}` : ""}`}</span> },
  ];
  const toolbar = streams && (
    <>
      <label class="dash-router">
        <Icon name="filter" />
        <input class="input input-sm" type="search" name="streamFilter" aria-label="Filter streams or route a subject" placeholder="Stream, subject, or a concrete subject to route…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} title="Type a literal subject (e.g. orders.eu.created) to see which streams capture it" />
      </label>
      {literal && (
        <Chip size="sm" tone={captured.length === 1 ? "ok" : captured.length > 1 ? "warn" : "neutral"} icon={captured.length ? "check" : "circle-slash"} title={captured.length > 1 ? "More than one stream captures this subject: messages are stored twice" : undefined}>
          {captured.length ? `${captured.length} stream${captured.length === 1 ? "" : "s"} capture ${f}` : `no stream captures ${f}`}
        </Chip>
      )}
      {hiddenInternal > 0 && (
        <label class="check small" title="KV_* and OBJ_* streams back Key-Value buckets and Object Stores">
          <input type="checkbox" name="showInternal" checked={internal} onChange={(e) => setInternal((e.target as HTMLInputElement).checked)} /> KV / Object streams ({hiddenInternal})
        </label>
      )}
    </>
  );
  return (
    <Card span={12} title="Streams ↔ subjects" subtitle={streams ? `${rows.length} stream${rows.length === 1 ? "" : "s"} · click to browse messages` : undefined} icon="database" flush stale={snap.state !== "connected" && !!streams}>
      {snap.streamsError && (
        <div class="dash-inline-error" role="alert">
          <Icon name="error" /> {snap.streamsError}
        </div>
      )}
      {!streams ? (
        <EmptyState compact kind="no-data" title={snap.jetstream?.enabled === false ? "JetStream is not enabled" : "No stream information"}>
          {snap.jetstream?.enabled === false ? "Streams require JetStream on this account." : "Requires a JetStream-enabled connection."}
        </EmptyState>
      ) : (
        <DataTable
          label="Streams and their subjects"
          columns={columns}
          rows={rows}
          rowKey={(s) => s.name}
          initialSort={{ key: "name", dir: "asc" }}
          onRowClick={(s) => onBrowse(s.name)}
          toolbar={toolbar}
          maxHeight={420}
          empty={f ? <span class="muted">{literal ? `No stream captures “${f}”.` : `No stream matches “${f}”.`}</span> : <span class="muted">No streams.</span>}
        />
      )}
    </Card>
  );
}

render(<App />, document.getElementById("root")!);

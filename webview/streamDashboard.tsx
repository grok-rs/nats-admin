import "./lib/styles.css";
import "./streamDashboard.css";
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { getInit, getState, onEvent, rpc, setState } from "./lib/vscode";
import { Button, Icon, cx } from "./lib/ui";
import { payloadPreview } from "./lib/PayloadView";
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
  type KeyValueItem,
} from "./lib/dashboard";
import {
  BarList,
  CrosshairSync,
  Gauge,
  ItemsTable,
  Legend,
  Meter,
  SegmentBar,
  SeriesTable,
  Sparkline,
  StatusDot,
  Swatch,
  TimeSeriesChart,
  Treemap,
  colorOf,
  formatValue,
  lastValue,
  nodeValue,
  seriesColor,
  sequentialColor,
  usePolling,
  useElementSize,
  useHiddenSet,
  useTimeSeries,
  type TimeSeries,
  type TimeSeriesHandle,
  type TreeNode,
} from "./lib/charts";
import {
  consumerStatus,
  deriveRates,
  discardNote,
  lagSegments,
  limitTone,
  limitUsages,
  retentionNote,
  streamStatus,
  timeToLimit,
  type ConnState,
  type ConsumerRow,
  type EnvironmentId,
  type LimitUsage,
  type PeerView,
  type RecentMessages,
  type SourceView,
  type StreamDashboardInit,
  type StreamSnapshot,
  type StreamView,
  type SubjectStats,
} from "../src/insights/model";
import { tileFilter } from "../src/nats/subjects";
import { fmtAgo, fmtBytes, fmtMillis } from "../src/shared/format";

const init = getInit<StreamDashboardInit>();
const STREAM = init.stream;

/** Consumers drawn in the charts (slots 1..7; slot 0 is the stream itself). */
const CHART_CONSUMERS = 7;
const SPARK_MS = 300_000;

interface UiState {
  range: string;
  mode: "msgs" | "bytes";
  paused: boolean;
}

const saved = (getState<UiState>() ?? {}) as Partial<UiState>;
const exact = (v: number) => v.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${exact(n)} ${n === 1 ? one : many}`;

/** Slot of a consumer in charts and table swatches (stable: name order). */
function consumerSlot(names: readonly string[], name: string): number | undefined {
  const i = names.indexOf(name);
  return i >= 0 && i < CHART_CONSUMERS ? i + 1 : undefined;
}

function persist(s: UiState) {
  try {
    setState(s);
  } catch {
    /* state is a convenience */
  }
}

function App() {
  const [connState, setConnState] = useState<ConnState>(init.connState);
  const [connError, setConnError] = useState<string | undefined>(init.connError);
  const [visible, setVisible] = useState(init.visible ?? true);
  const [profile, setProfile] = useState<{ connectionName: string; environment?: EnvironmentId; readOnly?: boolean }>({ connectionName: init.connectionName, environment: init.environment, readOnly: init.readOnly });
  const [refreshInterval, setRefreshInterval] = useState(init.refreshInterval);
  const [range, setRange] = useState(saved.range ?? "5m");
  const [mode, setMode] = useState<"msgs" | "bytes">(saved.mode ?? "msgs");
  const [paused, setPaused] = useState(!!saved.paused);

  useEffect(() => persist({ range, mode, paused }), [range, mode, paused]);
  useEffect(() => {
    const offs = [
      onEvent<{ state: ConnState; error?: string }>("connection", (e) => {
        setConnState(e.state);
        setConnError(e.error);
      }),
      onEvent<{ visible: boolean }>("visibility", (e) => setVisible(e.visible)),
      onEvent<{ connectionName: string; environment?: EnvironmentId; readOnly?: boolean }>("profile", setProfile),
      onEvent<{ refreshInterval: number }>("config", (e) => setRefreshInterval(e.refreshInterval)),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  const connected = connState === "connected";
  const live = visible && !paused && connected;
  // Back off while the stream cannot be loaded at all (deleted, other domain); normal cadence otherwise.
  const [failing, setFailing] = useState(false);
  const poll = usePolling(() => rpc<StreamSnapshot>("snapshot"), failing ? Math.max(10_000, refreshInterval * 5) : refreshInterval, live);
  useEffect(() => setFailing(!!poll.error), [poll.error]);
  const subjects = usePolling(() => rpc<SubjectStats>("subjects"), Math.max(30_000, refreshInterval * 10), visible && connected && !paused);
  // A dashboard opened (or reloaded) while paused still loads one snapshot and one subject count
  // instead of showing skeletons until the user resumes.
  useEffect(() => {
    if (!paused || !visible || !connected) return;
    if (!poll.data && !poll.refreshing) void poll.refresh();
    if (!subjects.data && !subjects.refreshing) void subjects.refresh();
  }, [paused, visible, connected]);

  // ---- time series built from consecutive snapshots ----
  const capacity = useMemo(() => Math.min(8000, Math.ceil(3_700_000 / Math.max(500, init.refreshInterval))), []);
  const ts = useTimeSeries<string>(capacity);
  const prev = useRef<StreamSnapshot | undefined>(undefined);
  useEffect(() => {
    const snap = poll.data;
    if (!snap) return;
    const rates = deriveRates(prev.current, snap);
    prev.current = snap;
    const v: Record<string, number | null> = { stored: snap.stream.state.messages, bytes: snap.stream.state.bytes };
    for (const c of snap.consumers) v[`b:${c.name}`] = c.numPending + c.numAckPending;
    for (const src of [snap.stream.mirror, ...snap.stream.sources]) if (src) v[`l:${src.name}`] = src.lag;
    if (rates) {
      v.ingest = rates.ingest;
      v.ingestBytes = rates.ingestBytes;
      v.growth = rates.storedBytes;
      // Deliveries are only charted for the first CHART_CONSUMERS consumers (by name).
      const charted = new Set(snap.consumers.slice(0, CHART_CONSUMERS).map((c) => c.name));
      for (const [name, r] of Object.entries(rates.delivered)) if (charted.has(name)) v[`d:${name}`] = r;
    }
    ts.push(snap.at, v);
  }, [poll.data]);

  // ---- recent messages: refreshed when the stored range changes (at most every 5 s) ----
  const [recent, setRecent] = useState<RecentMessages | undefined>(undefined);
  const [recentError, setRecentError] = useState<string | undefined>(undefined);
  const [recentBusy, setRecentBusy] = useState(false);
  const recentAt = useRef(0);
  const loadRecent = async () => {
    setRecentBusy(true);
    try {
      setRecent(await rpc<RecentMessages>("recent"));
      setRecentError(undefined);
    } catch (e) {
      setRecentError((e as Error).message);
    } finally {
      recentAt.current = Date.now();
      setRecentBusy(false);
    }
  };
  const rangeKey = poll.data ? `${poll.data.stream.state.firstSeq}:${poll.data.stream.state.lastSeq}` : undefined;
  const loadedKey = useRef<string | undefined>(undefined);
  // Follows live updates; while paused it still loads once so the card is not a skeleton forever.
  const feedActive = visible && connected && (!paused || loadedKey.current === undefined);
  useEffect(() => {
    if (!rangeKey || !feedActive || loadedKey.current === rangeKey) return;
    const t = setTimeout(
      () => {
        loadedKey.current = rangeKey;
        void loadRecent();
      },
      Math.max(0, recentAt.current + 5000 - Date.now()),
    );
    return () => clearTimeout(t);
  }, [rangeKey, feedActive]);

  const snap = poll.data;
  const view = snap?.stream;
  const now = snap?.serverAt ?? snap?.at ?? Date.now();
  const win = rangeMs(range);
  const loading = poll.loading && !snap;
  const stale = !!snap && (!connected || !!poll.error);
  const reconnect = () => void rpc("reconnect").catch(() => undefined);
  const notFound = /not found|10059/i.test(poll.error ?? "");

  const status = streamHeaderStatus(connState, snap, now, poll.error);
  const header = (
    <DashboardHeader
      icon={view?.config.mirrorOf ? "mirror" : view?.config.sourceNames ? "merge" : "database"}
      title={<span class="mono">{STREAM}</span>}
      subtitle={
        <>
          Stream
          {view && view.subjects.length > 0 && (
            <>
              {" · "}
              <span class="mono" title={view.subjects.join(", ")}>
                {view.subjects.join(", ")}
              </span>
            </>
          )}
          {view?.config.mirrorOf && (
            <>
              {" · mirror of "}
              <span class="mono">{view.config.mirrorOf}</span>
            </>
          )}
          {" · "}
          {profile.connectionName}
        </>
      }
      env={profile.environment}
      connectionName={profile.connectionName}
      readOnly={profile.readOnly}
      status={status}
      actions={
        <>
          <Button small icon="list-flat" onClick={() => void rpc("openMessages")} title="Open the Message Browser for this stream">
            Messages
          </Button>
          <Button small variant="ghost" icon="json" aria-label="Stream info as JSON" title="Stream info (JSON)" onClick={() => void rpc("streamInfo")} />
          <Button small variant="ghost" icon="settings-gear" aria-label="Edit stream configuration" title={profile.readOnly ? "View configuration (read-only connection: saving is blocked)" : "Edit configuration (JSON, saved to the server)"} onClick={() => void rpc("editConfig")} />
        </>
      }
      meta={view ? <ConfigChips view={view} /> : undefined}
    />
  );

  if (!snap && (!connected || (!poll.loading && poll.error))) {
    const waiting = connState === "connecting" || connState === "reconnecting";
    return (
      <DashboardPage header={header} label={`${STREAM} dashboard`} class="sd-page">
        <ConnectionBanner state={connState as ConnectionState} message={connError} />
        <EmptyState
          kind={connected ? "error" : "no-connection"}
          title={connected && notFound ? `Stream ${STREAM} was not found` : connected ? `Could not load ${STREAM}` : waiting ? "Waiting for the connection" : "Not connected"}
          primary={connected ? { label: "Retry", icon: "refresh", onClick: () => void poll.refresh() } : { label: "Reconnect", icon: "plug", onClick: reconnect }}
          secondary={connected && notFound ? { label: "Close dashboard", onClick: () => void rpc("close") } : undefined}
        >
          {connected && notFound ? (
            <>
              It may have been deleted, or it lives in another JetStream domain. <span class="mono">{poll.error}</span>
            </>
          ) : connected ? (
            <span class="mono">{poll.error}</span>
          ) : (
            <>
              The dashboard for <span class="mono">{STREAM}</span> loads once <span class="mono">{profile.connectionName}</span> is connected{waiting ? " — the client is retrying in the background" : ""}.
            </>
          )}
        </EmptyState>
      </DashboardPage>
    );
  }

  return (
    <DashboardPage header={header} label={`${STREAM} dashboard`} class="sd-page">
      <FilterBar label="Dashboard controls">
        <TimeRangePicker value={range} onChange={(id) => setRange(id)} label="Chart time range" />
        <RefreshIndicator
          updatedAt={poll.updatedAt}
          paused={paused}
          suspended={!visible || poll.suspended || !connected}
          refreshing={poll.refreshing && !poll.loading}
          error={connected ? poll.error : undefined}
          intervalMs={refreshInterval}
          onTogglePause={() => setPaused((p) => !p)}
          onRefresh={() => {
            void poll.refresh();
            void subjects.refresh();
          }}
        />
      </FilterBar>
      <ConnectionBanner state={connState as ConnectionState} message={connError} since={poll.updatedAt} onRetry={reconnect} />
      {connected && poll.error && snap && (
        <div class="sd-callout sd-callout-danger sd-stale-error" role="alert">
          <Icon name="error" />
          <span class="sd-stale-error-text">
            <b>{notFound ? `Stream ${STREAM} no longer exists` : "Update failed"}</b>
            {" — showing data from "}
            {poll.updatedAt ? new Date(poll.updatedAt).toLocaleTimeString() : "the last successful poll"}. <span class="mono">{poll.error}</span>
          </span>
          <span class="sd-stale-error-actions">
            <Button small icon="refresh" onClick={() => void poll.refresh()}>
              Retry
            </Button>
            {notFound && (
              <Button small variant="ghost" onClick={() => void rpc("close")}>
                Close dashboard
              </Button>
            )}
          </span>
        </div>
      )}

      <Kpis snap={snap} ts={ts} win={win} range={range} loading={loading} stale={stale} now={now} />

      <CrosshairSync>
        <Grid class="sd-dense">
          <Throughput snap={snap} ts={ts} win={win} mode={mode} setMode={setMode} loading={loading} stale={stale} />
          <Limits view={view} now={now} largest={subjects.data ? (subjects.data.largest ?? { subject: "", messages: 0 }) : undefined} countError={!subjects.data && !!subjects.error} loading={loading} stale={stale} />
          <Backlog snap={snap} ts={ts} win={win} loading={loading} stale={stale} />
          <RecentFeed recent={recent} error={recentError} busy={recentBusy} view={view} now={now} loading={loading} stale={stale} readOnly={!!profile.readOnly} onRefresh={() => void loadRecent()} />
        </Grid>
      </CrosshairSync>

      <SubjectsSection stats={subjects.data} error={subjects.error} loading={subjects.loading && !subjects.data} refreshing={subjects.refreshing} updatedAt={subjects.updatedAt} view={view} stale={stale} readOnly={!!profile.readOnly} onRefresh={() => void subjects.refresh()} />

      <ConsumersSection snap={snap} ts={ts} loading={loading} stale={stale} now={now} readOnly={!!profile.readOnly} />

      {view && (view.cluster || view.mirror || view.sources.length > 0) && (
        <>
          <SectionHeading title="Replication" subtitle={replicationSubtitle(view)} />
          <Grid>
            {view.cluster && <ClusterCard view={view} stale={stale} />}
            {(view.mirror || view.sources.length > 0) && <SourcesCard view={view} ts={ts} stale={stale} full={!view.cluster} />}
          </Grid>
        </>
      )}

      {view && <ConfigCard view={view} />}
    </DashboardPage>
  );
}

function streamHeaderStatus(connState: ConnState, snap: StreamSnapshot | undefined, now: number, error?: string): { tone: "ok" | "warn" | "danger" | "info" | "neutral"; label: string; pulse?: boolean } {
  if (connState === "connecting") return { tone: "info", label: "Connecting" };
  if (connState === "reconnecting") return { tone: "warn", label: "Reconnecting" };
  if (connState !== "connected") return { tone: "danger", label: connState === "error" ? "Connection error" : "Disconnected" };
  if (error) return { tone: "danger", label: /not found|10059/i.test(error) ? "Stream not found" : snap ? "Stale · update failed" : "Unavailable" };
  if (!snap) return { tone: "neutral", label: "Loading" };
  const s = streamStatus(snap, now);
  return { tone: s.tone, label: s.label, pulse: s.tone === "ok" };
}

function replicationSubtitle(v: StreamView): string {
  const parts: string[] = [];
  if (v.cluster) parts.push(`R${v.config.replicas}${v.cluster.name ? ` · cluster ${v.cluster.name}` : ""}`);
  if (v.mirror) parts.push(`mirror of ${v.mirror.name}`);
  if (v.sources.length) parts.push(plural(v.sources.length, "source"));
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------
// Header chips
// ---------------------------------------------------------------------------------------------

function ConfigChips({ view }: { view: StreamView }) {
  const c = view.config;
  return (
    <>
      <Chip size="sm" icon="history" title={retentionNote(c)}>
        {c.retention} retention
      </Chip>
      <Chip size="sm" icon={c.storage === "memory" ? "zap" : "save"} title={c.storage === "memory" ? "Memory storage: fast, lost when the server restarts" : "File storage: persisted to disk"}>
        {c.storage}
      </Chip>
      <Chip size="sm" icon="layers" title={`${c.replicas} ${c.replicas === 1 ? "replica" : "replicas"}${c.placementCluster ? ` · placed in cluster ${c.placementCluster}` : ""}`}>
        R{c.replicas}
      </Chip>
      <Chip size="sm" icon="discard" title={discardNote(c)}>
        discard {c.discard}
        {c.discardNewPerSubject ? " / subject" : ""}
      </Chip>
      <Chip size="sm" icon="copy" title="Duplicate window: publishes with a repeated Nats-Msg-Id inside this window are dropped">
        dedupe {c.duplicateWindowMs ? fmtMillis(c.duplicateWindowMs) : "off"}
      </Chip>
      {c.compression && (
        <Chip size="sm" icon="file-zip" title="Storage compression">
          {c.compression} compression
        </Chip>
      )}
      {c.maxMsgSize > 0 && (
        <Chip size="sm" icon="symbol-ruler" title="max_msg_size: larger publishes are rejected">
          max msg {fmtBytes(c.maxMsgSize)}
        </Chip>
      )}
      {c.sealed && (
        <Chip size="sm" icon="lock" tone="warn" title="Sealed: no messages can be added, deleted or purged">
          sealed
        </Chip>
      )}
      {c.denyDelete && (
        <Chip size="sm" icon="circle-slash" title="deny_delete: individual messages cannot be deleted">
          no delete
        </Chip>
      )}
      {c.denyPurge && (
        <Chip size="sm" icon="circle-slash" title="deny_purge: the stream cannot be purged">
          no purge
        </Chip>
      )}
      {c.allowRollup && (
        <Chip size="sm" icon="fold" title="allow_rollup_hdrs: Nats-Rollup headers may replace a subject's or the stream's content">
          rollup
        </Chip>
      )}
      {c.allowDirect && (
        <Chip size="sm" icon="arrow-right" title="allow_direct: replicas answer direct-get requests">
          direct get
        </Chip>
      )}
      {c.allowMsgTtl && (
        <Chip size="sm" icon="watch" title="allow_msg_ttl: per-message TTL via the Nats-TTL header">
          msg TTL
        </Chip>
      )}
      {c.sourceNames && (
        <Chip size="sm" icon="merge" title={`Sources: ${c.sourceNames.join(", ")}`}>
          {plural(c.sourceNames.length, "source")}
        </Chip>
      )}
      {c.republish && (
        <Chip size="sm" icon="broadcast" mono title={`Republishes ${c.republish.src ?? ">"} to ${c.republish.dest}${c.republish.headersOnly ? " (headers only)" : ""}`}>
          → {c.republish.dest}
        </Chip>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------------------------

/** Discard-old limits are a rolling window: a full meter is normal, so it never turns warn/danger. */
function rollingMeter(discard: string): { warn?: number; danger?: number } {
  return discard === "new" ? {} : { warn: 2, danger: 2 };
}

/** Coarse duration for estimates: "<2m", "44m", "3h 20m", "2d 4h". */
function fmtEta(sec: number): string {
  if (sec < 120) return "<2m";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

type Ts = TimeSeriesHandle<string>;

function Kpis({ snap, ts, win, range, loading, stale, now }: { snap?: StreamSnapshot; ts: Ts; win: number; range: string; loading: boolean; stale: boolean; now: number }) {
  const st = snap?.stream.state;
  const c = snap?.stream.config;
  const spark = (k: string) => ts.series(k, SPARK_MS);
  const growth = ts.stats("growth", SPARK_MS)?.avg;
  const eta = st && c ? timeToLimit(st.bytes, c.maxBytes, growth) : undefined;
  const pull = snap?.consumers.filter((x) => x.kind === "pull").length ?? 0;
  const push = (snap?.consumers.length ?? 0) - pull;
  const worst = snap ? snap.consumers.map((x) => consumerStatus(x, now)).sort((a, b) => b.severity - a.severity)[0] : undefined;
  const spanMs = st?.firstTs && st.lastTs && st.messages > 0 ? Math.max(0, Date.parse(st.lastTs) - Date.parse(st.firstTs)) : undefined;
  const ageMs = st?.firstTs && st.messages > 0 ? Math.max(0, now - Date.parse(st.firstTs)) : undefined;
  const ingestAvg = ts.stats("ingest", win)?.avg;
  return (
    <KpiRow min={150} label={`${STREAM} key metrics`}>
      <KpiTile
        label="Stored messages"
        value={st?.messages}
        unit="msgs"
        trend={spark("stored")}
        sub={c ? (c.maxMsgs > 0 ? `of ${formatValue(c.maxMsgs, "msgs")} limit` : "no message limit") : undefined}
        meter={c && st && c.maxMsgs > 0 ? { value: st.messages, max: c.maxMsgs, ...rollingMeter(c.discard) } : undefined}
        hint="Messages currently stored in the stream (state.messages). Trend: last 5 minutes."
        loading={loading}
        stale={stale}
      />
      <KpiTile
        label="Stored size"
        value={st?.bytes}
        unit="bytes"
        trend={spark("bytes")}
        sub={c ? `${c.maxBytes > 0 ? `of ${fmtBytes(c.maxBytes)}` : "no size limit"}${eta !== undefined ? ` · ${c.discard === "new" ? "full" : "rolls"} in ${fmtEta(eta)}` : ""}` : undefined}
        meter={c && st && c.maxBytes > 0 ? { value: st.bytes, max: c.maxBytes, ...rollingMeter(c.discard) } : undefined}
        hint={`Bytes stored, including headers and subjects (state.bytes).${c?.maxBytes && c.maxBytes > 0 ? ` Time to the size limit uses the net growth of the last 5 minutes; at the limit ${c.discard === "new" ? "new publishes are rejected" : "the oldest messages are removed"}.` : ""}`}
        loading={loading}
        stale={stale}
      />
      <KpiTile
        label="Ingest rate"
        value={ts.last("ingest") ?? null}
        unit="msgs/s"
        previous={ingestAvg}
        deltaLabel={`vs ${range} avg`}
        goodWhen="neither"
        trend={spark("ingest")}
        hint="Messages appended per second: change of the last sequence between two polls."
        loading={loading}
        stale={stale}
      />
      <KpiTile
        label="Ingest bandwidth"
        value={ts.last("ingestBytes") ?? null}
        unit="bytes/s"
        previous={ts.stats("ingestBytes", win)?.avg}
        deltaLabel={`vs ${range} avg`}
        goodWhen="neither"
        trend={spark("ingestBytes")}
        hint="Estimated: ingest rate × average stored message size (bytes ÷ messages)."
        loading={loading}
        stale={stale}
      />
      <KpiTile
        label="Consumers"
        value={st?.consumerCount}
        unit="count"
        sub={snap ? (snap.consumers.length ? `${pull} pull · ${push} push` : "none attached") : undefined}
        tone={worst && worst.severity >= 2 ? worst.tone : undefined}
        meter={c && st && c.maxConsumers > 0 ? { value: st.consumerCount, max: c.maxConsumers } : undefined}
        hint={worst && worst.severity >= 2 ? `Worst consumer status: ${worst.label}. ${worst.reason}` : "Consumers attached to the stream. Click to jump to the consumer table."}
        onClick={
          snap
            ? () => {
                const el = document.getElementById("sd-consumers");
                el?.scrollIntoView({ behavior: "smooth", block: "start" });
                el?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
              }
            : undefined
        }
        loading={loading}
        stale={stale}
      />
      <KpiTile
        label="Last sequence"
        value={st?.lastSeq}
        format={exact}
        sub={st ? `first ${exact(st.firstSeq)}${st.numDeleted ? ` · ${plural(st.numDeleted, "gap")}` : ""}` : undefined}
        hint="Stream sequence of the newest and oldest stored message. Gaps are individually deleted (or acknowledged work-queue / interest) messages inside that range."
        loading={loading}
        stale={stale}
      />
      <KpiTile
        label="Retention span"
        value={spanMs ?? null}
        unit="ms"
        sub={st ? (st.messages > 0 && ageMs !== undefined ? `oldest ${fmtMillis(ageMs).replace(/\.\d+/, "")} ago` : "no messages stored") : undefined}
        meter={c && ageMs !== undefined && c.maxAgeMs > 0 ? { value: ageMs, max: c.maxAgeMs, warn: 2, danger: 2 } : undefined}
        hint={`Time between the oldest and the newest stored message${c?.maxAgeMs ? `; messages expire after ${fmtMillis(c.maxAgeMs)} (max_age)` : ""}.`}
        loading={loading}
        stale={stale}
      />
    </KpiRow>
  );
}

// ---------------------------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------------------------

/**
 * TimeSeriesChart that fills the height its grid row gives the card (at least `minHeight`),
 * with the legend rendered below so the plot area is exact.
 */
function FillTimeSeries({ series, label, unit, win, minHeight, emptyText }: { series: TimeSeries[]; label: string; unit: string; win: number; minHeight: number; emptyText: string }) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const hidden = useHiddenSet();
  const ids = series.map((x) => x.id);
  const items = series.map((x, i) => ({ id: x.id, label: x.name, color: colorOf(x, i), value: formatValue(lastValue(x.points), unit), hidden: hidden.hidden.has(x.id), shape: "line" as const, dashed: x.dashed }));
  return (
    <div class="sd-fill-wrap">
      <div ref={ref} class="sd-fill" style={{ minHeight: `${minHeight}px` }}>
        <div class="sd-fill-inner">
          {size.height > 0 && <TimeSeriesChart series={series} label={label} unit={unit} windowMs={win} height={size.height} legend={false} hiddenIds={[...hidden.hidden]} onToggleSeries={hidden.toggle} emptyText={emptyText} />}
        </div>
      </div>
      {series.length > 1 && <Legend items={items} onToggle={hidden.toggle} onSolo={(id) => hidden.solo(id, ids)} label={`${label} series`} />}
    </div>
  );
}

function Throughput({ snap, ts, win, mode, setMode, loading, stale }: { snap?: StreamSnapshot; ts: Ts; win: number; mode: "msgs" | "bytes"; setMode: (m: "msgs" | "bytes") => void; loading: boolean; stale: boolean }) {
  const names = snap?.consumers.map((c) => c.name) ?? [];
  const series: TimeSeries[] =
    mode === "msgs"
      ? [
          { id: "ingest", name: "Ingest", points: ts.series("ingest", win), slot: 0 },
          ...names.slice(0, CHART_CONSUMERS).map((n, i) => ({ id: `d:${n}`, name: `${n} delivered`, points: ts.series(`d:${n}`, win), slot: i + 1 })),
        ]
      : [
          { id: "ingestBytes", name: "Ingest (estimated)", points: ts.series("ingestBytes", win), slot: 0 },
          { id: "growth", name: "Net stored change", points: ts.series("growth", win), slot: 1, dashed: true },
        ];
  const unit = mode === "msgs" ? "msgs/s" : "bytes/s";
  const modeBtn = (m: "msgs" | "bytes", label: string, title: string) => (
    <button type="button" aria-pressed={mode === m} class={cx("seg-btn", mode === m && "seg-active")} title={title} onClick={() => setMode(m)}>
      {label}
    </button>
  );
  return (
    <Card
      span={8}
      title="Throughput"
      subtitle={mode === "msgs" ? "msgs/s · ingest vs consumer deliveries" : "bytes/s · ingest estimate and net storage change"}
      icon="pulse"
      loading={loading}
      stale={stale}
      minHeight={250}
      actions={
        <div class="seg" role="group" aria-label="Throughput unit">
          {modeBtn("msgs", "msgs/s", "Messages per second")}
          {modeBtn("bytes", "bytes/s", "Bytes per second")}
        </div>
      }
      tableView={() => <SeriesTable series={series} unit={unit} caption="Throughput" />}
      footer={names.length > CHART_CONSUMERS && mode === "msgs" ? `Deliveries shown for the first ${CHART_CONSUMERS} of ${names.length} consumers (by name).` : undefined}
    >
      <FillTimeSeries series={series} label={`${STREAM} throughput`} unit={unit} win={win} minHeight={220} emptyText="Collecting samples — rates appear after the second poll" />
    </Card>
  );
}

function Backlog({ snap, ts, win, loading, stale }: { snap?: StreamSnapshot; ts: Ts; win: number; loading: boolean; stale: boolean }) {
  const names = snap?.consumers.map((c) => c.name) ?? [];
  const series: TimeSeries[] = names.slice(0, CHART_CONSUMERS).map((n, i) => ({ id: `b:${n}`, name: n, points: ts.series(`b:${n}`, win), slot: i + 1 }));
  return (
    <Card span={8} title="Consumer backlog" subtitle="msgs · pending + awaiting ack, per consumer" icon="inbox" loading={loading} stale={stale} minHeight={200} tableView={series.length ? () => <SeriesTable series={series} unit="msgs" caption="Consumer backlog" /> : undefined}>
      {snap && !names.length ? (
        <EmptyState compact kind="no-data" title="No consumers">
          Nothing reads from <span class="mono">{STREAM}</span> yet, so there is no backlog to chart.
        </EmptyState>
      ) : (
        <FillTimeSeries series={series} label={`${STREAM} consumer backlog`} unit="msgs" win={win} minHeight={200} emptyText="Waiting for the first poll" />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

function Limits({ view, now, largest, countError, loading, stale }: { view?: StreamView; now: number; largest?: { subject: string; messages: number }; countError?: boolean; loading: boolean; stale: boolean }) {
  if (!view) return <Card span={4} title="Limits" icon="dashboard" loading={loading} minHeight={250} />;
  const usages = limitUsages(view, now, largest?.messages);
  const gauges = usages.filter((u) => u.max > 0 && (u.id === "msgs" || u.id === "bytes" || u.id === "age"));
  // The busiest subject is unknown until subjects are counted: no "0 msgs" meter meanwhile.
  const meters = usages.filter((u) => u.max > 0 && (u.id === "consumers" || (u.id === "perSubject" && largest !== undefined)));
  const counting = largest === undefined && view.config.maxMsgsPerSubject > 0;
  const unset = usages.filter((u) => !(u.max > 0));
  const noGrowthLimit = !["msgs", "bytes", "age"].some((id) => usages.find((u) => u.id === id)!.max > 0);
  /** "186k / 250k msgs", "74.1 MiB / 128 MiB", "15h 12m / 1d". */
  const sub = (u: LimitUsage) => `${u.unit === "msgs" ? formatValue(u.value, "count") : formatValue(u.value, u.unit)} / ${formatValue(u.max, u.unit)}`;
  return (
    <Card
      span={4}
      title="Limits"
      subtitle={`discard ${view.config.discard} · ${view.config.retention}`}
      icon="dashboard"
      stale={stale}
      minHeight={250}
      footer={
        <span class="sd-note">
          <Icon name="info" /> {discardNote(view.config)}
        </span>
      }
    >
      {noGrowthLimit && view.config.retention === "limits" && (
        <div class="sd-callout" role="note">
          <Icon name="warning" />
          <span>No message, size or age limit: the stream grows until the account or server storage limit is reached.</span>
        </div>
      )}
      {gauges.length > 0 && (
        <div class="sd-gauges">
          {gauges.map((u) => (
            <Gauge key={u.id} label={u.label} value={u.value} max={u.max} unit={u.unit} tone={limitTone(u)} size={144} sublabel={sub(u)} />
          ))}
        </div>
      )}
      {counting && (
        <div class="sd-counting muted small" title={usages.find((u) => u.id === "perSubject")!.hint}>
          Busiest subject: {countError ? "unknown, subjects could not be counted" : "counting subjects…"} (limit {formatValue(view.config.maxMsgsPerSubject, "msgs")})
        </div>
      )}
      {meters.map((u) => (
        <Meter
          key={u.id}
          label={
            <span title={u.hint}>
              {u.label}
              {u.id === "perSubject" && largest?.subject && (
                <>
                  {" "}
                  <span class="mono muted">{largest.subject}</span>
                </>
              )}
            </span>
          }
          value={u.value}
          max={u.max}
          unit={u.unit}
          tone={limitTone(u)}
          size="sm"
          title={u.hint}
        />
      ))}
      {unset.length > 0 && (
        <div class="sd-unset">
          <span class="muted small">No limit</span>
          {unset.map((u) => (
            <Chip key={u.id} size="sm" title={u.hint}>
              {u.label.toLowerCase()}
            </Chip>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Recent messages
// ---------------------------------------------------------------------------------------------

function RecentFeed({ recent, error, busy, view, now, loading, stale, readOnly, onRefresh }: { recent?: RecentMessages; error?: string; busy: boolean; view?: StreamView; now: number; loading: boolean; stale: boolean; readOnly: boolean; onRefresh: () => void }) {
  const empty = view && view.state.messages === 0;
  let body: ComponentChildren;
  if (empty) {
    body = (
      <EmptyState compact kind="no-data" title="No messages stored" primary={readOnly || view?.config.sealed ? undefined : { label: "Publish a message", icon: "send", onClick: () => void rpc("publish") }}>
        New messages on <span class="mono">{view!.subjects.join(", ") || STREAM}</span> appear here.
      </EmptyState>
    );
  } else if (error && !recent) {
    body = (
      <EmptyState compact kind="error" title="Could not read recent messages" primary={{ label: "Retry", icon: "refresh", onClick: onRefresh }}>
        <span class="mono">{error}</span>
      </EmptyState>
    );
  } else if (!recent) {
    body = (
      <ul class="sd-feed" aria-busy="true" aria-label="Loading recent messages">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} class="sd-feed-skel">
            <span class="skeleton skeleton-text" style={{ width: `${60 + ((i * 13) % 30)}%` }} />
            <span class="skeleton skeleton-text" style={{ width: "40%" }} />
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul class="sd-feed" aria-label={`Last ${recent.messages.length} messages`}>
        {recent.messages.map((m) => {
          const preview = payloadPreview(m.data, 140);
          return (
            <li key={m.seq ?? m.id}>
              <button type="button" class="sd-feed-row" title={`Open message #${m.seq} in the Message Browser`} onClick={() => void rpc("openMessage", { seq: m.seq })}>
                <span class="sd-feed-top">
                  <span class="sd-feed-seq mono">#{m.seq !== undefined ? exact(m.seq) : "?"}</span>
                  <span class="sd-feed-subject mono">{m.subject}</span>
                  <span class="sd-feed-time" title={new Date(m.time).toLocaleString()}>
                    {fmtAgo(m.time, now)}
                  </span>
                </span>
                <span class="sd-feed-bottom">
                  <span class={cx("sd-feed-preview mono", !preview && "muted")}>{preview || "(empty payload)"}</span>
                  <span class="sd-feed-size">
                    {m.headers.length > 0 && (
                      <span title={`${m.headers.length} headers`}>
                        <Icon name="symbol-key" /> {m.headers.length}
                      </span>
                    )}
                    {fmtBytes(m.size)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <Card
      span={4}
      title="Recent messages"
      subtitle={recent ? `last ${recent.messages.length} · newest first${recent.partial ? " · newest sequences mostly deleted" : ""}` : "newest first"}
      icon="mail"
      loading={loading}
      stale={stale}
      minHeight={200}
      flush={!!recent && !empty}
      actions={<Button small variant="ghost" icon="refresh" busy={busy} aria-label="Reload recent messages" title="Reload recent messages" onClick={onRefresh} />}
      footer={
        !empty && (
          <button type="button" class="ds-link" onClick={() => void rpc("openMessages")}>
            Open Message Browser
          </button>
        )
      }
    >
      {body}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------------------------

function SubjectsSection({ stats, error, loading, refreshing, updatedAt, view, stale, readOnly, onRefresh }: { stats?: SubjectStats; error?: string; loading: boolean; refreshing: boolean; updatedAt?: number; view?: StreamView; stale: boolean; readOnly: boolean; onRefresh: () => void }) {
  const [selected, setSelected] = useState<{ label: string; filter?: string; value: number } | undefined>(undefined);
  const browse = (filter: string) => void rpc("browseSubject", { filter });
  const empty = view?.state.messages === 0 || (stats && stats.total === 0);
  const subtitle = stats ? (
    <>
      {plural(stats.total, "distinct subject")}
      {stats.truncated && (
        <>
          {" · "}
          <button type="button" class="ds-link" title="Change nats.explorer.maxSubjects" onClick={() => void rpc("openSetting", { key: "nats.explorer.maxSubjects" })}>
            top {exact(stats.kept)} analysed
          </button>
        </>
      )}
      {updatedAt && <> · counted {new Date(updatedAt).toLocaleTimeString()}</>}
    </>
  ) : (
    "stored messages per subject"
  );
  const top = stats?.top.slice(0, 10) ?? [];
  // Subjects under the common prefix are listed without it ("eu.de.created" under "orders.>").
  const prefix = stats?.treePrefix ? `${stats.treePrefix}.` : "";
  const short = (subject: string) => (prefix && subject.startsWith(prefix) && subject.length > prefix.length ? subject.slice(prefix.length) : subject);
  const streamMsgs = stats?.streamMessages ?? 0;
  const topShare = streamMsgs > 0 ? top.reduce((a, s) => a + s.messages, 0) / streamMsgs : 0;
  const errorBody = error && !stats && (
    <EmptyState compact kind="error" title="Could not count subjects" primary={{ label: "Retry", icon: "refresh", onClick: onRefresh }}>
      <span class="mono">{error}</span>
    </EmptyState>
  );
  const emptyBody = (
    <EmptyState compact kind="no-data" title="No subjects yet" primary={readOnly || view?.config.sealed ? undefined : { label: "Publish a message", icon: "send", onClick: () => void rpc("publish") }}>
      The stream holds no messages, so there is no subject distribution to show.
    </EmptyState>
  );
  return (
    <>
      <SectionHeading
        title="Subjects"
        subtitle={subtitle}
        actions={<Button small variant="ghost" icon="refresh" busy={refreshing} aria-label="Recount subjects" title="Recount subjects (runs every 30 s while visible)" onClick={onRefresh} />}
      />
      {empty && !errorBody ? (
        <Grid>
          <Card span={12} title="Subject distribution" icon="type-hierarchy" stale={stale}>
            {emptyBody}
          </Card>
        </Grid>
      ) : (
        <Grid>
          <Card
            span={7}
            title="Subject distribution"
            subtitle="stored msgs by token · click a folder to drill in, a subject to browse it"
            icon="type-hierarchy"
            loading={loading}
            stale={stale}
            minHeight={300}
            tableView={stats ? () => <ItemsTable items={stats.roots.map((r) => ({ label: r.label, value: r.value }))} unit="msgs" labelHeader="Top-level token" valueHeader="Messages" mono caption="Messages per top-level token" /> : undefined}
            footer={
              selected?.filter ? (
                <span class="sd-selection">
                  <span class="mono">{selected.filter}</span>
                  <span class="muted">{formatValue(selected.value, "msgs")}</span>
                  <Button small icon="list-flat" onClick={() => browse(selected.filter!)}>
                    Browse
                  </Button>
                </span>
              ) : undefined
            }
          >
            {errorBody ||
              (empty ? (
                emptyBody
              ) : (
                <Treemap
                  label={`${STREAM} subjects by stored messages`}
                  data={(stats?.tree ?? []) as TreeNode[]}
                  unit="msgs"
                  height={260}
                  rootLabel={stats?.treePrefix ? `${stats.treePrefix}.>` : STREAM}
                  onSelect={(n) => {
                    const filter = tileFilter(n);
                    setSelected({ label: n.label, filter, value: nodeValue(n) });
                    if (filter && !n.children?.length) browse(filter);
                  }}
                  emptyText="No subjects"
                />
              ))}
          </Card>
          <Card
            span={5}
            class="sd-full-md"
            title="Top subjects"
            subtitle={
              <>
                stored msgs · % of stream{prefix && <> · under <span class="mono">{prefix}&gt;</span></>}
              </>
            }
            icon="list-ordered"
            loading={loading}
            stale={stale}
            minHeight={300}
            tableView={stats ? () => <ItemsTable items={stats.top.map((t) => ({ label: t.subject, value: t.messages }))} unit="msgs" labelHeader="Subject" valueHeader="Messages" mono caption="Top subjects by stored messages" /> : undefined}
            footer={stats && top.length > 0 ? `Top ${top.length} of ${exact(stats.total)} subjects hold ${Math.round(topShare * 100)}% of stored messages.` : undefined}
          >
            {errorBody ||
              (empty ? (
                emptyBody
              ) : (
                <BarList
                  label="Top subjects by stored messages"
                  items={top.map((t) => ({ id: t.subject, label: short(t.subject), value: t.messages, secondary: streamMsgs ? `${shareText(t.messages / streamMsgs)}` : undefined, hint: `${t.subject} · click to browse these messages` }))}
                  unit="msgs"
                  mono
                  onSelect={(it) => browse(it.id ?? it.label)}
                  emptyText="No subjects"
                />
              ))}
          </Card>
        </Grid>
      )}
    </>
  );
}

function shareText(f: number): string {
  const p = f * 100;
  return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

// ---------------------------------------------------------------------------------------------
// Consumers
// ---------------------------------------------------------------------------------------------

/**
 * Position bar colours: done in neutral grey, then one sequential hue for in flight → backlog
 * (strongest = backlog), so they never repeat a consumer's identity colour (slots 2..8) that is
 * shown in the same table row.
 */
const LAG_COLORS = { acked: sequentialColor(0.3, "var(--vz-fg)"), ackPending: sequentialColor(0.45), pending: sequentialColor(1) };
const LAG_LEGEND = [
  { id: "acked", label: "Acked (≤ ack floor)", color: LAG_COLORS.acked, shape: "rect" as const },
  { id: "ackPending", label: "Awaiting ack", color: LAG_COLORS.ackPending, shape: "rect" as const },
  { id: "pending", label: "Pending", color: LAG_COLORS.pending, shape: "rect" as const },
];

function ConsumersSection({ snap, ts, loading, stale, now, readOnly }: { snap?: StreamSnapshot; ts: Ts; loading: boolean; stale: boolean; now: number; readOnly: boolean }) {
  const rows = snap?.consumers ?? [];
  const names = rows.map((r) => r.name);
  const st = snap?.stream.state;
  const statusOf = useMemo(() => new Map(rows.map((r) => [r.name, consumerStatus(r, now)])), [snap]);
  const columns: Column<ConsumerRow>[] = [
    {
      key: "status",
      header: "Status",
      width: "120px",
      value: (r) => statusOf.get(r.name)?.severity ?? 0,
      descFirst: true,
      render: (r) => {
        const s = statusOf.get(r.name)!;
        return (
          <span class="sd-status" title={s.reason}>
            <StatusDot tone={s.tone} label={s.label} showLabel size="sm" />
          </span>
        );
      },
    },
    {
      key: "name",
      header: "Consumer",
      value: (r) => r.name,
      render: (r) => {
        const slot = consumerSlot(names, r.name);
        return (
          <span class="sd-consumer">
            <span class="sd-consumer-name">
              {slot !== undefined && <Swatch color={seriesColor(slot)} shape="line" />}
              <span class="mono" title={r.description ?? r.name}>
                {r.name}
              </span>
            </span>
            <span class="sd-consumer-meta">
              {r.kind}
              {!r.durable && " · ephemeral"}
              {r.filters.length > 0 && (
                <>
                  {" · "}
                  <span class="mono" title={`Filter: ${r.filters.join(", ")}`}>
                    {r.filters.join(", ")}
                  </span>
                </>
              )}
            </span>
          </span>
        );
      },
    },
    {
      key: "progress",
      header: "Position in stream",
      sortable: false,
      filterable: false,
      hideBelow: "md",
      width: "22%",
      title: "Acked up to the ack floor, awaiting ack and pending, against the stream's stored sequence range",
      render: (r) => {
        if (!st) return null;
        const seg = lagSegments(r, st);
        return (
          <SegmentBar
            label={`${r.name} position`}
            variant="thin"
            legend={false}
            unit="msgs"
            total={seg.total}
            segments={[
              { id: "acked", label: "Acked (≤ ack floor)", value: seg.acked, color: LAG_COLORS.acked },
              { id: "ackPending", label: "Awaiting ack", value: seg.ackPending, color: LAG_COLORS.ackPending },
              { id: "pending", label: "Pending", value: seg.pending, color: LAG_COLORS.pending },
            ]}
          />
        );
      },
    },
    { key: "pending", header: "Pending", numeric: true, unit: "msgs", value: (r) => r.numPending, title: "Messages matching the consumer not yet delivered (num_pending)" },
    {
      key: "ackPending",
      header: "Awaiting ack",
      numeric: true,
      width: "130px",
      value: (r) => r.numAckPending,
      title: "Delivered but not yet acknowledged (num_ack_pending), against max_ack_pending",
      render: (r) =>
        r.maxAckPending > 0 ? (
          <Meter value={r.numAckPending} max={r.maxAckPending} unit="count" inline size="sm" show="used" ticks={false} title={`${exact(r.numAckPending)} msgs awaiting ack of max_ack_pending ${exact(r.maxAckPending)}`} />
        ) : (
          formatValue(r.numAckPending, "msgs")
        ),
    },
    {
      key: "redelivered",
      header: "Redelivered",
      numeric: true,
      hideBelow: "md",
      value: (r) => r.numRedelivered,
      title: "Messages delivered more than once (num_redelivered)",
      render: (r) => <span class={r.numRedelivered > 0 ? "tone-warn" : "muted"}>{formatValue(r.numRedelivered, "msgs")}</span>,
    },
    {
      key: "waiting",
      header: "Waiting pulls",
      numeric: true,
      hideBelow: "md",
      value: (r) => (r.kind === "pull" ? r.numWaiting : null),
      title: "Outstanding pull requests (num_waiting); push consumers have none",
      render: (r) => (r.kind === "pull" ? formatValue(r.numWaiting, "count") : <span class="muted">–</span>),
    },
    {
      key: "trend",
      header: "Backlog, 5m",
      sortable: false,
      filterable: false,
      hideBelow: "md",
      width: "104px",
      title: "Pending + awaiting ack over the last 5 minutes",
      render: (r) => {
        const pts = ts.series(`b:${r.name}`, SPARK_MS);
        const slot = consumerSlot(names, r.name);
        return pts.length > 1 ? <Sparkline values={pts} width={92} height={20} unit="msgs" label={`${r.name} backlog trend`} color={slot !== undefined ? seriesColor(slot) : undefined} /> : <span class="muted small">collecting…</span>;
      },
    },
    {
      key: "lastActive",
      header: "Last delivery",
      hideBelow: "md",
      descFirst: true,
      value: (r) => (r.lastActive ? Date.parse(r.lastActive) : null),
      title: "Time of the last delivery to a client",
      render: (r) => (r.lastActive ? <span title={new Date(r.lastActive).toLocaleString()}>{fmtAgo(r.lastActive, now)}</span> : <span class="muted">never</span>),
    },
    {
      key: "actions",
      header: <span class="sr-only">Actions</span>,
      sortable: false,
      filterable: false,
      align: "right",
      width: "72px",
      render: (r) => (
        <span class="sd-actions">
          <Button small variant="ghost" icon="beaker" aria-label={`Open ${r.name} in Consumer Lab`} title="Consumer Lab: fetch and ack messages" onClick={() => void rpc("consumerLab", { consumer: r.name })} />
          <Button small variant="ghost" icon="json" aria-label={`${r.name} consumer info (JSON)`} title="Consumer info (JSON)" onClick={() => void rpc("consumerInfo", { consumer: r.name })} />
        </span>
      ),
    },
  ];
  const pull = rows.filter((r) => r.kind === "pull").length;
  return (
    <>
      <SectionHeading title="Consumers" subtitle={snap ? `${plural(snap.consumersTotal, "consumer")}${rows.length ? ` · ${pull} pull · ${rows.length - pull} push` : ""}` : undefined} />
      <Grid>
        <Card
          span={12}
          id="sd-consumers"
          title="Consumers"
          subtitle="position, backlog and delivery health"
          icon="list-flat"
          flush
          stale={stale}
          footer={
            <span class="sd-table-foot">
              <Legend items={LAG_LEGEND} label="Position legend" />
              {snap && snap.consumersTotal > rows.length && <span class="muted">Showing {rows.length} of {exact(snap.consumersTotal)} consumers.</span>}
            </span>
          }
        >
          <DataTable
            label={`Consumers of ${STREAM}`}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.name}
            filter={rows.length ? { placeholder: "Filter consumers…" } : false}
            initialSort={{ key: "status", dir: "desc" }}
            rowTone={(r) => {
              const t = statusOf.get(r.name)?.tone;
              return t === "danger" || t === "warn" ? t : undefined;
            }}
            loading={loading}
            maxHeight={460}
            empty={
              <EmptyState compact kind="no-data" title="No consumers" primary={readOnly ? undefined : { label: "Create consumer", icon: "add", onClick: () => void rpc("createConsumer") }}>
                Create a pull or push consumer to read messages from <span class="mono">{STREAM}</span>.
              </EmptyState>
            }
            toolbar={
              !readOnly && rows.length > 0 ? (
                <Button small variant="ghost" icon="add" onClick={() => void rpc("createConsumer")}>
                  New consumer
                </Button>
              ) : undefined
            }
          />
        </Card>
      </Grid>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Replication
// ---------------------------------------------------------------------------------------------

function peerStatus(p: PeerView): { tone: "ok" | "warn" | "danger"; label: string } {
  if (p.leader) return { tone: "ok", label: "Leader" };
  if (p.offline) return { tone: "danger", label: "Offline" };
  if (!p.current) return { tone: "warn", label: "Catching up" };
  return { tone: "ok", label: "Current" };
}

function ClusterCard({ view, stale }: { view: StreamView; stale: boolean }) {
  const cl = view.cluster!;
  const columns: Column<PeerView>[] = [
    {
      key: "name",
      header: "Server",
      value: (p) => p.name,
      render: (p) => (
        <span class="sd-peer">
          <span class="mono">{p.name}</span>
          {p.leader && (
            <Chip size="sm" icon="star-full">
              leader
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      value: (p) => peerStatus(p).label,
      render: (p) => {
        const s = peerStatus(p);
        return <StatusDot tone={s.tone} label={s.label} showLabel size="sm" />;
      },
    },
    { key: "lag", header: "Lag", numeric: true, value: (p) => p.lag, unit: "ops", title: "Uncommitted RAFT operations behind the leader" },
    { key: "active", header: "Last seen", numeric: true, value: (p) => p.activeMs ?? null, render: (p) => (p.leader ? <span class="muted">–</span> : p.activeMs !== undefined ? `${fmtMillis(p.activeMs)} ago` : <span class="muted">–</span>), title: "Time since the leader last heard from this replica" },
  ];
  const behind = cl.peers.filter((p) => !p.leader && (p.offline || !p.current)).length;
  return (
    <Card span={6} title="Cluster" subtitle={`R${view.config.replicas}${cl.name ? ` · ${cl.name}` : ""}`} icon="server-environment" stale={stale} flush tone={behind ? "warn" : undefined}>
      <div class="sd-pad">
        <KeyValueGrid
          dense
          minColumnWidth={160}
          items={[
            { label: "Leader", value: cl.leader ?? "none", mono: true, tone: cl.leader ? undefined : "danger" },
            { label: "Leader since", value: cl.leaderSince ? fmtAgo(cl.leaderSince) : "–", hint: cl.leaderSince ? new Date(cl.leaderSince).toLocaleString() : undefined },
            { label: "Replicas", value: behind ? `${cl.peers.length - behind} of ${cl.peers.length} current` : `${cl.peers.length} current`, tone: behind ? "warn" : "ok" },
            ...(cl.raftGroup ? [{ label: "RAFT group", value: cl.raftGroup, mono: true } as KeyValueItem] : []),
          ]}
        />
      </div>
      <DataTable label="Stream replicas" columns={columns} rows={cl.peers} rowKey={(p) => p.name} dense maxHeight={220} rowTone={(p) => (p.offline ? "danger" : !p.current ? "warn" : undefined)} empty="No replica information" />
    </Card>
  );
}

function SourcesCard({ view, ts, stale, full }: { view: StreamView; ts: Ts; stale: boolean; full: boolean }) {
  const rows: (SourceView & { role: "mirror" | "source" })[] = [...(view.mirror ? [{ ...view.mirror, role: "mirror" as const }] : []), ...view.sources.map((s) => ({ ...s, role: "source" as const }))];
  const tone = (r: SourceView): "ok" | "warn" | "danger" => (r.error ? "danger" : r.lag > 0 || r.activeMs === undefined ? "warn" : "ok");
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "name",
      header: view.mirror ? "Origin" : "Source",
      value: (r) => r.name,
      render: (r) => (
        <span class="sd-consumer">
          <span class="mono">{r.name}</span>
          <span class="sd-consumer-meta">
            {r.role}
            {r.filter && (
              <>
                {" · "}
                <span class="mono">{r.filter}</span>
              </>
            )}
            {r.external && (
              <>
                {" · "}
                <span class="mono" title="External API prefix">
                  {r.external}
                </span>
              </>
            )}
          </span>
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      value: (r) => (r.error ? 2 : r.lag > 0 ? 1 : 0),
      render: (r) => {
        const t = tone(r);
        const label = r.error ? "Error" : r.activeMs === undefined ? "Never active" : r.lag > 0 ? "Lagging" : "In sync";
        return (
          <span title={r.error}>
            <StatusDot tone={t} label={label} showLabel size="sm" />
          </span>
        );
      },
    },
    { key: "lag", header: "Lag", numeric: true, unit: "msgs", value: (r) => r.lag, title: "Messages behind the origin stream" },
    {
      key: "trend",
      header: "Lag, 5m",
      sortable: false,
      filterable: false,
      hideBelow: "sm",
      width: "104px",
      render: (r) => {
        const pts = ts.series(`l:${r.name}`, SPARK_MS);
        return pts.length > 1 ? <Sparkline values={pts} width={92} height={20} unit="msgs" label={`${r.name} lag trend`} tone={r.lag > 0 ? "warn" : undefined} /> : <span class="muted small">collecting…</span>;
      },
    },
    { key: "active", header: "Last activity", numeric: true, value: (r) => r.activeMs ?? null, render: (r) => (r.activeMs !== undefined ? `${fmtMillis(r.activeMs)} ago` : <span class="muted">never</span>), title: "Time since data last arrived from the origin" },
  ];
  const err = rows.find((r) => r.error);
  return (
    <Card span={full ? 12 : 6} title={view.mirror ? "Mirror" : "Sources"} subtitle={view.mirror ? `replicates ${view.mirror.name}` : plural(view.sources.length, "source")} icon={view.mirror ? "mirror" : "merge"} stale={stale} flush tone={err ? "danger" : undefined}>
      {err && (
        <div class="sd-pad">
          <div class="sd-callout sd-callout-danger" role="alert">
            <Icon name="error" />
            <span>
              <span class="mono">{err.name}</span>: {err.error}
            </span>
          </div>
        </div>
      )}
      <DataTable label={view.mirror ? "Mirror origin" : "Stream sources"} columns={columns} rows={rows} rowKey={(r) => `${r.role}:${r.name}`} dense maxHeight={260} rowTone={(r) => (tone(r) === "ok" ? undefined : tone(r))} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

function limitText(v: number, unit: "msgs" | "bytes"): string {
  return v > 0 ? (unit === "bytes" ? fmtBytes(v) : exact(v)) : "unlimited";
}

function ConfigCard({ view }: { view: StreamView }) {
  const c = view.config;
  const items: KeyValueItem[] = [
    { label: "Subjects", value: view.subjects.join(", ") || "– (mirror / sources only)", mono: true, copy: view.subjects.join(", ") || undefined, wide: true },
    ...(view.description ? [{ label: "Description", value: view.description, wide: true }] : []),
    { label: "Retention", value: c.retention, hint: retentionNote(c) },
    { label: "Storage", value: c.storage },
    { label: "Replicas", value: String(c.replicas) },
    { label: "Discard", value: `${c.discard}${c.discardNewPerSubject ? " (per subject)" : ""}`, hint: discardNote(c) },
    { label: "Max messages", value: limitText(c.maxMsgs, "msgs") },
    { label: "Max bytes", value: limitText(c.maxBytes, "bytes") },
    { label: "Max age", value: c.maxAgeMs ? fmtMillis(c.maxAgeMs) : "unlimited" },
    { label: "Max msgs per subject", value: limitText(c.maxMsgsPerSubject, "msgs") },
    { label: "Max message size", value: limitText(c.maxMsgSize, "bytes") },
    { label: "Max consumers", value: c.maxConsumers > 0 ? exact(c.maxConsumers) : "unlimited" },
    { label: "Duplicate window", value: c.duplicateWindowMs ? fmtMillis(c.duplicateWindowMs) : "off", hint: "Publishes with a repeated Nats-Msg-Id inside this window are dropped" },
    { label: "Compression", value: c.compression ?? "none" },
    { label: "Created", value: `${fmtAgo(view.created)} · ${new Date(view.created).toLocaleString()}` },
    ...(c.placementCluster || c.placementTags ? [{ label: "Placement", value: [c.placementCluster, ...(c.placementTags ?? [])].filter(Boolean).join(" · "), mono: true }] : []),
    ...(c.subjectTransform ? [{ label: "Subject transform", value: `${c.subjectTransform.src ?? ">"} → ${c.subjectTransform.dest}`, mono: true, wide: true }] : []),
    ...(c.republish ? [{ label: "Republish", value: `${c.republish.src ?? ">"} → ${c.republish.dest}${c.republish.headersOnly ? " (headers only)" : ""}`, mono: true, wide: true }] : []),
    ...Object.entries(c.metadata ?? {}).map(([k, v]) => ({ label: `metadata.${k}`, value: v, mono: true })),
  ];
  return (
    <Grid>
      <Card span={12} title="Configuration" subtitle="effective stream config" icon="settings" collapsible defaultCollapsed actions={<Button small variant="ghost" icon="edit" title="Edit the configuration as JSON" onClick={() => void rpc("editConfig")}>Edit</Button>}>
        <KeyValueGrid items={items} minColumnWidth={180} dense />
      </Card>
    </Grid>
  );
}

render(<App />, document.getElementById("root")!);

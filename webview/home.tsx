import "./lib/styles.css";
import "./home.css";
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { getInit, getState, onEvent, rpc, setState } from "./lib/vscode";
import { Button, CopyButton, ErrorBanner, Icon, cx, useDebounced } from "./lib/ui";
import {
  Card,
  Chip,
  DashboardHeader,
  DashboardPage,
  EmptyState,
  EnvBadge,
  FilterBar,
  Grid,
  KeyValueGrid,
  KpiRow,
  KpiTile,
  ReadOnlyBadge,
  RefreshIndicator,
  SectionHeading,
  Skeleton,
  type KeyValueItem,
} from "./lib/dashboard";
import { HealthPill, Meter, Sparkline, StatusDot, ToneIcon, formatValue, usePolling } from "./lib/charts";
import {
  DOCS_LINKS,
  ENV_LABEL,
  ENV_ORDER,
  LIMIT_SOURCE_LABEL,
  ORIGIN_META,
  compareProfiles,
  filterFleet,
  groupByEnvironment,
  historySeries,
  isLive,
  rttTone,
  severityTone,
  stateLabel,
  stateTone,
  summarizeFleet,
  type AllowedCommand,
  type EnvFilter,
  type FleetRow,
  type HomeInit,
  type HomeSnapshot,
  type StateFilter,
} from "../src/overview/model";

const INIT = getInit<HomeInit>() ?? { refreshInterval: 3000, rttWarnMs: 100 };

interface Persisted {
  query: string;
  env: EnvFilter;
  state: StateFilter;
}

const STATE_FILTERS: { id: StateFilter; label: string; icon: string; title: string }[] = [
  { id: "all", label: "All", icon: "list-flat", title: "Every profile" },
  { id: "live", label: "Live", icon: "circle-filled", title: "Connected (or reconnecting) profiles" },
  { id: "offline", label: "Offline", icon: "circle-outline", title: "Profiles that are not connected" },
  { id: "attention", label: "Needs attention", icon: "warning", title: "Connection errors, reconnecting, health warnings or errors" },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Call = (method: string, params?: unknown) => Promise<void>;
type Run = (command: AllowedCommand, profileId?: string) => void;

function App() {
  const saved = getState<Persisted>();
  const [cfg, setCfg] = useState<HomeInit>(INIT);
  const [visible, setVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState(saved?.query ?? "");
  const [env, setEnv] = useState<EnvFilter>(saved?.env ?? "all");
  const [stateF, setStateF] = useState<StateFilter>(saved?.state ?? "all");
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const debounced = useDebounced(query, 120);
  const poll = usePolling(() => rpc<HomeSnapshot>("snapshot"), cfg.refreshInterval, visible && !paused);

  useEffect(() => {
    const offs = [
      onEvent("changed", () => void poll.refresh()),
      onEvent<{ visible: boolean }>("visibility", (v) => setVisible(!!v?.visible)),
      onEvent<Partial<HomeInit>>("config", (c) => setCfg((x) => ({ ...x, ...c }))),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  useEffect(() => setState<Persisted>({ query, env, state: stateF }), [query, env, stateF]);

  const call: Call = (method, params) => {
    setActionError(undefined);
    return rpc(method, params)
      .then(() => void poll.refresh())
      .catch((e) => setActionError(errText(e)));
  };
  const run: Run = (command, profileId) => void call("run", { command, profileId });

  const snap = poll.data;
  const rows = snap?.rows ?? [];
  const summary = useMemo(() => summarizeFleet(rows), [snap]);
  const filtered = useMemo(() => filterFleet(rows, { query: debounced, env, state: stateF }), [snap, debounced, env, stateF]);
  const groups = useMemo(() => groupByEnvironment(filtered, (r) => r.profile.environment, (a, b) => compareProfiles(a.profile, b.profile)), [filtered]);
  const filtering = !!debounced.trim() || env !== "all" || stateF !== "all";
  const clearFilters = () => {
    setQuery("");
    setEnv("all");
    setStateF("all");
  };

  const header = (
    <DashboardHeader
      icon="home"
      title="NATS Home"
      subtitle={snap ? `Fleet overview · ${rows.length} connection profile${rows.length === 1 ? "" : "s"}${snap.hidden ? ` · ${snap.hidden} hidden` : ""}` : "Fleet overview"}
      actions={
        <>
          <Button small variant="primary" icon="add" onClick={() => run("nats.addConnection")}>
            Add connection
          </Button>
          <Button small variant="ghost" icon="cloud-download" title="Copy NATS CLI contexts into VS Code" onClick={() => run("nats.importContexts")}>
            Import contexts
          </Button>
          {!!snap?.hidden && <Button small variant="ghost" icon="eye" title="Show hidden connections" aria-label="Show hidden connections" onClick={() => run("nats.showHiddenConnections")} />}
        </>
      }
    />
  );

  if (!snap) {
    return (
      <DashboardPage class="home-page" header={header} label="NATS Home">
        {poll.error ? (
          <EmptyState kind="error" title="Couldn't load your connections" primary={{ label: "Retry", icon: "refresh", onClick: () => void poll.refresh() }}>
            {poll.error}
          </EmptyState>
        ) : (
          <>
            <KpiRow label="Fleet summary">
              {["Profiles", "Connected", "Unhealthy", "Errors", "Streams", "Consumers"].map((l) => (
                <KpiTile key={l} label={l} value={null} loading />
              ))}
            </KpiRow>
            <Grid min={320}>
              {[0, 1, 2].map((i) => (
                <Card key={i} loading minHeight={180} title={<Skeleton width={110} height={14} />} />
              ))}
            </Grid>
          </>
        )}
      </DashboardPage>
    );
  }

  if (!rows.length) {
    return (
      <DashboardPage class="home-page" header={header} label="NATS Home">
        {actionError && <ErrorBanner error={actionError} onDismiss={() => setActionError(undefined)} />}
        <GettingStarted run={run} call={call} hidden={snap.hidden} />
      </DashboardPage>
    );
  }

  const envCounts = summary.byEnv;
  return (
    <DashboardPage class="home-page" header={header} label="NATS Home">
      <FilterBar label="Filter connections">
        <label class="home-search">
          <Icon name="search" />
          <input class="input input-sm" type="search" name="home-search" placeholder="Search name, server, version, cluster…" aria-label="Search connections" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </label>
        <div class="home-chips" role="group" aria-label="Environment">
          <Chip size="sm" selected={env === "all"} onClick={() => setEnv("all")}>{`All ${rows.length}`}</Chip>
          {ENV_ORDER.filter((e) => envCounts[e] > 0).map((e) => (
            <Chip key={e} size="sm" selected={env === e} onClick={() => setEnv(env === e ? "all" : e)} class={cx("home-env-chip", e !== "none" && `ds-env-${e}`)} title={`Only ${ENV_LABEL[e]} profiles`}>
              {`${ENV_LABEL[e]} ${envCounts[e]}`}
            </Chip>
          ))}
        </div>
        <div class="home-chips" role="group" aria-label="Connection state">
          {STATE_FILTERS.map((f) => (
            <Chip key={f.id} size="sm" icon={f.icon} selected={stateF === f.id} onClick={() => setStateF(f.id)} title={f.title}>
              {f.label}
            </Chip>
          ))}
        </div>
        <span class="spacer" />
        <RefreshIndicator updatedAt={poll.updatedAt} paused={paused} suspended={!visible} refreshing={poll.refreshing} error={poll.error} intervalMs={cfg.refreshInterval} onTogglePause={() => setPaused((p) => !p)} onRefresh={() => void poll.refresh()} />
      </FilterBar>
      {actionError && <ErrorBanner error={actionError} onDismiss={() => setActionError(undefined)} />}

      <KpiRow label="Fleet summary" min={140}>
        <KpiTile label="Profiles" value={summary.profiles} unit="count" sub={summary.byEnv.prod ? `${summary.byEnv.prod} production` : "no production profiles"} hint="Connection profiles from VS Code, NATS CLI contexts, workspace settings and NATS_URL." onClick={clearFilters} />
        <KpiTile label="Connected" value={summary.connected} unit="count" sub={`of ${summary.profiles}${summary.connecting ? ` · ${summary.connecting} connecting` : ""}`} tone={summary.connected ? "ok" : undefined} meter={{ value: summary.connected, max: summary.profiles }} hint="Live connections in this VS Code window." onClick={() => setStateF("live")} />
        <KpiTile
          label="Unhealthy"
          value={summary.unhealthy}
          unit="count"
          tone={summary.unhealthy ? "danger" : summary.degraded ? "warn" : summary.connected && !summary.unchecked ? "ok" : undefined}
          sub={`${summary.degraded} degraded · ${summary.unchecked} unchecked`}
          hint="Connected profiles whose last health check scored below 60 or reported errors. Degraded: score below 90 or warnings."
          onClick={() => setStateF("attention")}
        />
        <KpiTile label="Connection errors" value={summary.errors} unit="count" tone={summary.errors ? "danger" : undefined} hint="Profiles whose last connection attempt failed." onClick={() => setStateF("attention")} />
        <KpiTile label="Streams" value={summary.connected ? summary.streams : null} unit="count" sub={summary.connected ? `${summary.kv} KV · ${summary.obj} object stores` : "connect to count"} hint="Streams (without KV_ / OBJ_ backing streams) across connected profiles. Profiles pointing at the same account are counted once each." />
        <KpiTile label="Consumers" value={summary.connected ? summary.consumers : null} unit="count" hint="Consumers across connected profiles (JetStream account info)." />
        <KpiTile label="Inbound" value={summary.withRates ? summary.msgsIn : null} unit="msgs/s" sub={summary.withRates ? `${formatValue(summary.msgsOut, "msgs/s")} out` : "no live rates"} hint="Sum of inbound message rates of connected profiles (server-wide from /varz where reachable). Two profiles on the same server are both counted." />
      </KpiRow>

      {!groups.length ? (
        <EmptyState kind="search" title="No connections match" secondary={{ label: "Clear filters", icon: "clear-all", onClick: clearFilters }}>
          {debounced.trim() ? (
            <>
              Nothing matches <span class="mono">{debounced.trim()}</span>
              {env !== "all" ? ` in ${ENV_LABEL[env]}` : ""}.
            </>
          ) : (
            "No profile matches the selected filters."
          )}
        </EmptyState>
      ) : (
        groups.map((g) => {
          const live = g.items.filter((r) => isLive(r.profile.state)).length;
          return (
            <section key={g.env} class="home-group" aria-label={`${g.label} connections`}>
              <SectionHeading title={g.env === "none" ? ENV_LABEL.none : <EnvBadge env={g.env} />} subtitle={`${live} live · ${g.items.length} profile${g.items.length === 1 ? "" : "s"}${filtering ? " (filtered)" : ""}`} />
              <Grid min={340}>
                {g.items.map((r) => (
                  <ConnectionCard key={r.profile.id} row={r} run={run} call={call} rttWarnMs={cfg.rttWarnMs} />
                ))}
              </Grid>
            </section>
          );
        })
      )}
      {summary.connected === 0 && !filtering && (
        <div class="home-tip muted small">
          <Icon name="lightbulb" /> Connect a profile to see its server, round-trip time, throughput, JetStream usage and health here. New to NATS?{" "}
          <button type="button" class="ds-link" onClick={() => void call("openDocs", { url: DOCS_LINKS.home })}>
            Read the docs
          </button>
        </div>
      )}
    </DashboardPage>
  );
}

// ---------------------------------------------------------------------------------------------
// Connection card
// ---------------------------------------------------------------------------------------------

function ConnectionCard({ row, run, call, rttWarnMs }: { row: FleetRow; run: Run; call: Call; rttWarnMs: number }) {
  const p = row.profile;
  const m = row.metrics;
  const h = row.health;
  const live = isLive(p.state);
  const origin = ORIGIN_META[p.origin];
  const sv = m?.server;
  const js = m?.jetstream;
  const rt = rttTone(m?.rttMs, rttWarnMs);
  const rttPts = m ? historySeries(m.history, "rtt") : [];
  const msgPts = m ? historySeries(m.history, "msgsIn") : [];
  const tone = stateTone(p.state);

  const items: KeyValueItem[] = live
    ? [
        { label: "Server", value: sv ? sv.name : "–", mono: true, copy: sv?.id, hint: sv ? `Server ID ${sv.id}` : undefined },
        { label: "Version", value: sv ? `v${sv.version}${sv.cluster ? ` · ${sv.cluster}` : ""}` : "–" },
        {
          label: "Round trip",
          tone: rt === "warn" || rt === "danger" ? rt : undefined,
          hint: `PING/PONG round trip. Warning at ${rttWarnMs} ms.`,
          value: (
            <span class="home-inline">
              {m?.rttMs !== undefined ? formatValue(m.rttMs, "ms") : "–"}
              {rttPts.filter((x) => x.v !== null).length > 1 && <Sparkline values={rttPts} width={64} height={16} unit="ms" label={`${p.name} round-trip trend`} tone={rt === "warn" || rt === "danger" ? rt : undefined} />}
            </span>
          ),
        },
        {
          label: m?.rates?.source === "client" ? "Msgs/s (this client)" : "Msgs/s in · out",
          hint: m?.rates?.source === "client" ? "Monitoring endpoint unreachable: rates of this VS Code connection only." : "Server-wide message rates from /varz.",
          value: m?.rates ? (
            <span class="home-inline">
              {formatValue(m.rates.msgsIn, "count")} · {formatValue(m.rates.msgsOut, "count")}
              {msgPts.filter((x) => x.v !== null).length > 1 && <Sparkline values={msgPts} width={64} height={16} unit="msgs/s" label={`${p.name} inbound message rate trend`} />}
            </span>
          ) : (
            "–"
          ),
        },
        js?.enabled === false
          ? { label: "JetStream", value: "not enabled", tone: "neutral" as const }
          : { label: "Streams · consumers", value: js && !js.error ? `${formatValue(js.streams ?? js.totalStreams ?? 0, "count")} · ${formatValue(js.consumers ?? 0, "count")}` : js?.error ? "error" : "–", tone: js?.error ? ("danger" as const) : undefined, hint: js?.error },
        { label: "KV · objects", value: js?.enabled && !js.error ? `${js.kv ?? "–"} · ${js.obj ?? "–"}` : "–" },
      ]
    : [];

  return (
    <Card
      class={cx("home-card", p.environment && `ds-env-${p.environment}`, p.active && "home-card-active")}
      title={
        <span class="home-title">
          <StatusDot tone={tone} label={stateLabel(p.state)} pulse={p.state === "connecting" || p.state === "reconnecting"} />
          <span class="ellipsis" title={p.description ? `${p.name} — ${p.description}` : p.name}>
            {p.name}
          </span>
        </span>
      }
      subtitle={p.active ? "active" : undefined}
      actions={
        <>
          <Button variant="ghost" small icon="go-to-file" title="Reveal in the Connections view" aria-label={`Reveal ${p.name} in the Connections view`} onClick={() => void call("reveal", { profileId: p.id })} />
          <Button variant="ghost" small icon="edit" title={`Edit connection (${origin.label})`} aria-label={`Edit ${p.name}`} onClick={() => run("nats.editConnection", p.id)} />
        </>
      }
      footer={<CardActions row={row} run={run} />}
      stale={p.state === "reconnecting"}
    >
      <div class="home-badges">
        {p.environment && <EnvBadge env={p.environment} />}
        {p.readOnly && <ReadOnlyBadge />}
        <Chip size="sm" icon={origin.icon} title={origin.hint}>
          {origin.label}
          {p.contextName && p.origin === "nats-context" ? `: ${p.contextName}` : ""}
          {p.selectedContext ? " ★" : ""}
        </Chip>
        {p.tls && (
          <Chip size="sm" icon="shield" title="TLS enabled">
            TLS
          </Chip>
        )}
        {p.auth !== "none" && (
          <Chip size="sm" icon="key" title="Authentication method">
            {p.auth}
          </Chip>
        )}
        {p.autoConnect && (
          <Chip size="sm" icon="zap" title="Connects automatically when VS Code starts">
            auto
          </Chip>
        )}
      </div>
      <div class="home-servers mono ellipsis" title={p.servers.join("\n")}>
        {m?.connectedUrl && live ? m.connectedUrl : p.servers.join(", ")}
        {p.servers.length > 1 && <span class="muted"> +{p.servers.length - 1}</span>}
      </div>

      {live ? (
        <>
          {p.state === "reconnecting" && (
            <div class="home-state home-reconnecting" role="status">
              <Icon name="sync" spin /> Connection lost, reconnecting… showing the last sample{m ? ` from ${new Date(m.at).toLocaleTimeString()}` : ""}.
            </div>
          )}
          <KeyValueGrid dense items={items} minColumnWidth={140} />
          {js?.enabled && !js.error && (
            <div class="home-meters">
              <Meter label="Storage" value={js.storage ?? 0} max={js.maxStorage ?? -1} unit="bytes" size="sm" title={`JetStream file storage · ${LIMIT_SOURCE_LABEL[js.storageSource ?? "none"]}`} />
              <Meter label="Memory" value={js.memory ?? 0} max={js.maxMemory ?? -1} unit="bytes" size="sm" title={`JetStream memory storage · ${LIMIT_SOURCE_LABEL[js.memorySource ?? "none"]}`} />
            </div>
          )}
          {m && !m.monitor.ok && (
            <div class="home-note">
              <Icon name="info" /> Monitoring {m.monitor.url ? <span class="mono">{m.monitor.url}</span> : "endpoint"} unreachable.{" "}
              {m.monitor.url && (
                <button type="button" class="ds-link" onClick={() => void call("retryMonitor", { profileId: p.id })}>
                  Retry
                </button>
              )}
            </div>
          )}
          <div class="home-health">
            {h ? (
              <>
                <HealthPill size="sm" score={h.score} onClick={() => run("nats.openHealthDashboard", p.id)} title={`Health ${Math.round(h.score)} / 100 · ${h.errors} errors, ${h.warnings} warnings — open the health dashboard`} />
                {h.top[0] ? (
                  <span class="home-finding" title={h.top.map((f) => `${f.severity}: ${f.title}`).join("\n")}>
                    <ToneIcon tone={severityTone(h.top[0].severity)} title={h.top[0].severity} />
                    <span class="ellipsis">{h.top[0].title}</span>
                    {h.errors + h.warnings + h.infos > 1 && (
                      <span class="muted" title={`${h.errors + h.warnings + h.infos - 1} more finding${h.errors + h.warnings + h.infos - 1 === 1 ? "" : "s"} in the health dashboard`}>
                        +{h.errors + h.warnings + h.infos - 1}
                      </span>
                    )}
                  </span>
                ) : (
                  <span class="muted small">No findings</span>
                )}
              </>
            ) : (
              <>
                <HealthPill size="sm" score={undefined} title="No health check yet" />
                <button type="button" class="ds-link small" onClick={() => run("nats.runHealthCheck", p.id)}>
                  Run health check
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <OfflineBody row={row} />
      )}
    </Card>
  );
}

function OfflineBody({ row }: { row: FleetRow }) {
  const p = row.profile;
  if (p.state === "error")
    return (
      <div class="home-state home-state-error" role="status">
        <ToneIcon tone="danger" title="Connection error" />
        <span>{p.error ?? "Connection failed"}</span>
      </div>
    );
  if (p.warning)
    return (
      <div class="home-state home-state-warn" role="status">
        <ToneIcon tone="warn" title="Warning" />
        <span>{p.warning}</span>
      </div>
    );
  if (p.state === "connecting")
    return (
      <div class="home-state">
        <Icon name="loading" spin /> Connecting…
      </div>
    );
  return <div class="home-state muted">{p.description || "Not connected. Connect to see server, throughput, JetStream usage and health."}</div>;
}

function CardActions({ row, run }: { row: FleetRow; run: Run }) {
  const p = row.profile;
  const live = isLive(p.state);
  if (!live)
    return (
      <div class="home-actions">
        <Button small variant={p.state === "error" ? "secondary" : "primary"} icon={p.state === "error" ? "refresh" : "plug"} disabled={p.state === "connecting"} onClick={() => run("nats.connect", p.id)}>
          {p.state === "error" ? "Retry" : "Connect"}
        </Button>
      </div>
    );
  return (
    <div class="home-actions">
      <Button small variant="ghost" icon="dashboard" onClick={() => run("nats.openDashboard", p.id)}>
        Dashboard
      </Button>
      <Button small variant="ghost" icon="heart" onClick={() => run("nats.openHealthDashboard", p.id)}>
        Health
      </Button>
      <Button small variant="ghost" icon="type-hierarchy" onClick={() => run("nats.openTopology", p.id)}>
        Topology
      </Button>
      <span class="spacer" />
      <Button small variant="ghost" icon="debug-disconnect" title={`Disconnect ${p.name}`} aria-label={`Disconnect ${p.name}`} onClick={() => run("nats.disconnect", p.id)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Getting started
// ---------------------------------------------------------------------------------------------

function GettingStarted({ run, call, hidden }: { run: Run; call: Call; hidden: number }) {
  const local = "nats-server -js -m 8222";
  const step = (n: number, title: string, body: ComponentChildren, action: ComponentChildren) => (
    <Card title={<span class="home-step-title"><span class="home-step-n" aria-hidden="true">{n}</span>{title}</span>} footer={action}>
      <div class="home-step-body">{body}</div>
    </Card>
  );
  return (
    <>
      <EmptyState kind="no-connection" title="Welcome to NATS Admin" primary={{ label: "Add connection", icon: "add", onClick: () => run("nats.addConnection") }} secondary={{ label: "Import NATS CLI contexts", icon: "cloud-download", onClick: () => run("nats.importContexts") }}>
        Connect to a NATS server to browse streams, Key-Value buckets and object stores, tail subjects and watch server health.
        {hidden > 0 && (
          <>
            {" "}
            {hidden} discovered connection{hidden === 1 ? " is" : "s are"} hidden.{" "}
            <button type="button" class="ds-link" onClick={() => run("nats.showHiddenConnections")}>
              Show hidden
            </button>
          </>
        )}
      </EmptyState>
      <SectionHeading title="Getting started" subtitle="three ways in" />
      <Grid min={240}>
        {step(
          1,
          "Add a connection",
          <>
            Servers, authentication (user/password, token, <span class="mono">.creds</span>, NKey), TLS / mTLS and a JetStream domain. Secrets stay in your OS keychain.
          </>,
          <Button small variant="primary" icon="add" onClick={() => run("nats.addConnection")}>
            Add connection
          </Button>,
        )}
        {step(
          2,
          "Reuse NATS CLI contexts",
          <>
            Contexts from <span class="mono">~/.config/nats/context</span>, <span class="mono">NATS_URL</span> and the workspace setting <span class="mono">nats.connections</span> show up automatically.
          </>,
          <div class="home-actions">
            <Button small icon="cloud-download" onClick={() => run("nats.importContexts")}>
              Import contexts
            </Button>
            <button type="button" class="ds-link small" onClick={() => void call("openDocs", { url: DOCS_LINKS.contexts })}>
              About contexts
            </button>
          </div>,
        )}
        {step(
          3,
          "Run a local server",
          <>
            Start a server with JetStream and HTTP monitoring, then connect to <span class="mono">localhost:4222</span>:
            <span class="home-cmd">
              <code class="mono">{local}</code>
              <CopyButton text={local} title="Copy command" />
            </span>
          </>,
          <Button small icon="plug" onClick={() => run("nats.connectLocal")}>
            Connect to localhost
          </Button>,
        )}
      </Grid>
      <div class="home-docs">
        <Icon name="book" />
        <button type="button" class="ds-link" onClick={() => void call("openDocs", { url: DOCS_LINKS.home })}>
          NATS documentation
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" class="ds-link" onClick={() => void call("openDocs", { url: DOCS_LINKS.jetstream })}>
          JetStream
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" class="ds-link" onClick={() => void call("openDocs", { url: DOCS_LINKS.monitoring })}>
          Monitoring
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" class="ds-link" onClick={() => void call("openDocs", { url: DOCS_LINKS.cli })}>
          nats CLI
        </button>
      </div>
    </>
  );
}

render(<App />, document.getElementById("root")!);

import "./lib/styles.css";
import "./overview.css";
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { getInit, onEvent, rpc } from "./lib/vscode";
import { Button, ErrorBanner, Icon, cx } from "./lib/ui";
import { Card, Chip, ConnectionBanner, DashboardHeader, DashboardPage, EmptyState, EnvBadge, InfoTip, KpiRow, KpiTile, SectionHeading, Skeleton, fmtAgoShort } from "./lib/dashboard";
import { HealthPill, Meter, Sparkline, StatusDot, ToneIcon, formatValue, usePolling } from "./lib/charts";
import {
  DOCS_LINKS,
  ENV_LABEL,
  LIMIT_SOURCE_LABEL,
  ORIGIN_META,
  compareProfiles,
  groupByEnvironment,
  historySeries,
  isLive,
  rttTone,
  severityTone,
  stateLabel,
  stateTone,
  type AllowedCommand,
  type FleetRow,
  type OverviewInit,
  type OverviewSnapshot,
  type ProfileSummary,
} from "../src/overview/model";

const INIT = getInit<OverviewInit>() ?? { refreshInterval: 3000, visible: true, rttWarnMs: 100 };

type Run = (command: AllowedCommand, profileId?: string) => void;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const QUICK_ACTIONS: { command: AllowedCommand; label: string; icon: string; hint: string; write?: boolean }[] = [
  { command: "nats.subscribe", label: "Live Tail", icon: "radio-tower", hint: "Subscribe to a subject and watch messages arrive" },
  { command: "nats.publish", label: "Publish", icon: "send", hint: "Publish a message or send a request", write: true },
  { command: "nats.openDashboard", label: "Dashboard", icon: "dashboard", hint: "Server dashboard: throughput, CPU, memory, clients, streams" },
  { command: "nats.openTopology", label: "Topology", icon: "type-hierarchy", hint: "JetStream topology: streams, sources, mirrors and consumers" },
  { command: "nats.openHealthDashboard", label: "Health", icon: "heart", hint: "Health checks for streams, consumers, buckets and the account" },
  { command: "nats.openHome", label: "Home", icon: "home", hint: "Every connection profile at a glance" },
];

function App() {
  const [cfg, setCfg] = useState<OverviewInit>(INIT);
  const [visible, setVisible] = useState(INIT.visible !== false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const poll = usePolling(() => rpc<OverviewSnapshot>("snapshot"), cfg.refreshInterval, visible);

  useEffect(() => {
    const offs = [
      onEvent("changed", () => void poll.refresh()),
      onEvent<{ visible: boolean }>("visibility", (v) => setVisible(!!v?.visible)),
      onEvent<Partial<OverviewInit>>("config", (c) => setCfg((x) => ({ ...x, ...c }))),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const call = (method: string, params?: unknown) => {
    setActionError(undefined);
    return rpc(method, params)
      .then(() => void poll.refresh())
      .catch((e) => setActionError(errText(e)));
  };
  const run: Run = (command, profileId) => void call("run", { command, profileId });

  const snap = poll.data;
  if (!snap) {
    if (poll.error)
      return (
        <DashboardPage class="ov" label="Overview">
          <EmptyState kind="error" title="Couldn't load the overview" primary={{ label: "Retry", icon: "refresh", onClick: () => void poll.refresh() }}>
            {poll.error}
          </EmptyState>
        </DashboardPage>
      );
    return <LoadingView />;
  }
  const banner = actionError ? <ErrorBanner error={actionError} onDismiss={() => setActionError(undefined)} /> : null;
  return snap.active ? (
    <ActiveView snap={snap} row={snap.active} run={run} call={call} rttWarnMs={cfg.rttWarnMs} banner={banner} />
  ) : (
    <OfflineView snap={snap} run={run} call={call} banner={banner} />
  );
}

function LoadingView() {
  return (
    <DashboardPage class="ov" label="Overview" header={<DashboardHeader title={<Skeleton width={120} height={16} />} subtitle={<Skeleton width={170} variant="text" />} />}>
      <KpiRow min={110} label="Throughput" class="ov-throughput">
        {["Msgs in", "Msgs out", "Bytes in", "Bytes out"].map((l) => (
          <KpiTile key={l} label={l} value={null} loading />
        ))}
      </KpiRow>
      <Card title="JetStream" icon="database" loading minHeight={80} />
    </DashboardPage>
  );
}

// ---------------------------------------------------------------------------------------------
// Active connection
// ---------------------------------------------------------------------------------------------

function ActiveView({ snap, row, run, call, rttWarnMs, banner }: { snap: OverviewSnapshot; row: FleetRow; run: Run; call: (m: string, p?: unknown) => Promise<void>; rttWarnMs: number; banner: ComponentChildren }) {
  const p = row.profile;
  const m = row.metrics;
  const sv = m?.server;
  const js = m?.jetstream;
  // Reconnecting without an earlier sample: show "–" (no data) rather than an endless skeleton.
  const waiting = p.state === "connected" && !m;
  /** Reconnecting: the numbers are the last sample taken before the connection dropped. */
  const stale = p.state === "reconnecting";
  const rates = m?.rates;
  const series = (k: "msgsIn" | "msgsOut" | "bytesIn" | "bytesOut") => (m ? historySeries(m.history, k) : []);
  const serverWide = rates?.source === "server" || (!rates && m?.monitor.ok);
  const sourceHint = serverWide ? "Server-wide rate from the /varz monitoring endpoint (all clients of this server)." : "Rate of this VS Code connection only (nc.stats()): the monitoring endpoint is not reachable.";
  const reveal = () => void call("reveal", { profileId: p.id });
  const jsOn = js?.enabled && !js.error;
  const others = snap.profiles.filter((x) => x.id !== p.id).sort(compareProfiles);

  const header = (
    <DashboardHeader
      title={p.name}
      subtitle={
        sv ? (
          <>
            <span class="mono">{sv.name}</span> · v{sv.version}
            {sv.cluster && (
              <>
                {" "}
                · <span class="mono">{sv.cluster}</span>
              </>
            )}
          </>
        ) : (
          <span class="mono">{m?.connectedUrl ?? p.servers[0]}</span>
        )
      }
      env={p.environment}
      readOnly={p.readOnly}
      connectionName={p.name}
      status={{ tone: stateTone(p.state), label: stateLabel(p.state), pulse: p.state === "connected" || p.state === "reconnecting" || p.state === "connecting" }}
      prodMessage={p.readOnly ? "Read-only: writes are blocked." : "Live traffic: destructive actions need typed confirmation."}
      actions={
        <>
          <Button variant="ghost" small icon="arrow-swap" title="Switch the active connection" aria-label="Switch the active connection" onClick={() => run("nats.selectActiveConnection")} />
          <Button variant="ghost" small icon="go-to-file" title="Reveal in the Connections view" aria-label="Reveal in the Connections view" onClick={reveal} />
        </>
      }
      meta={<RttLine rtt={m?.rttMs} history={m ? historySeries(m.history, "rtt") : []} warnMs={rttWarnMs} url={m?.connectedUrl} />}
    />
  );

  return (
    <DashboardPage class="ov" label={`Overview of ${p.name}`} header={header}>
      {banner}
      <ConnectionBanner state={p.state} message={p.error} since={p.state === "reconnecting" ? m?.at : undefined} onRetry={p.state === "error" || p.state === "disconnected" ? () => run("nats.connect", p.id) : undefined} />

      <SectionHeading title="Throughput" subtitle={serverWide ? "server-wide" : "this connection"} actions={<InfoTip text={sourceHint} />} />
      {m && !m.monitor.ok && (
        <div class="ov-note" role="note">
          <Icon name="info" />
          <span>
            Monitoring {m.monitor.url ? <span class="mono">{m.monitor.url}</span> : "endpoint"} not reachable: rates and client counts come from this connection only.
          </span>
          {m.monitor.url && (
            <button type="button" class="ds-link" onClick={() => void call("retryMonitor", { profileId: p.id })}>
              Retry
            </button>
          )}
        </div>
      )}
      <KpiRow min={110} label="Throughput" class="ov-throughput">
        <KpiTile label="Msgs in" value={rates?.msgsIn} unit="msgs/s" trend={series("msgsIn")} hint={`Messages received per second. ${sourceHint}`} loading={waiting} stale={stale} />
        <KpiTile label="Msgs out" value={rates?.msgsOut} unit="msgs/s" trend={series("msgsOut")} hint={`Messages delivered per second. ${sourceHint}`} loading={waiting} stale={stale} />
        <KpiTile label="Bytes in" value={rates?.bytesIn} unit="bytes/s" trend={series("bytesIn")} hint={`Payload bytes received per second. ${sourceHint}`} loading={waiting} stale={stale} />
        <KpiTile label="Bytes out" value={rates?.bytesOut} unit="bytes/s" trend={series("bytesOut")} hint={`Payload bytes delivered per second. ${sourceHint}`} loading={waiting} stale={stale} />
      </KpiRow>

      <SectionHeading title="Inventory" actions={<InfoTip text="Click a count to reveal the connection in the Connections view." />} />
      <KpiRow min={80} label="Inventory" class="ov-inventory">
        <KpiTile
          label="Clients"
          value={m?.varz?.connections}
          unit="count"
          sub={m?.varz?.maxConnections ? `of ${formatValue(m.varz.maxConnections, "count")}` : m && !m.varz ? "needs /varz" : undefined}
          hint="Client connections to this server (/varz connections)."
          loading={waiting}
        />
        {js?.enabled === false ? (
          <KpiTile label="JetStream" value="off" hint="JetStream is not enabled for this account." loading={waiting} />
        ) : (
          <>
            <KpiTile label="Streams" value={js?.streams} unit="count" hint="Streams in the account, without the KV_ / OBJ_ streams backing buckets." onClick={reveal} loading={waiting} />
            <KpiTile label="Consumers" value={js?.consumers} unit="count" hint="Consumers across all streams of the account (JetStream account info)." onClick={reveal} loading={waiting} />
            <KpiTile label="KV" value={js?.kv} unit="count" hint="Key-Value buckets (KV_* streams)." onClick={reveal} loading={waiting} />
            <KpiTile label="Objects" value={js?.obj} unit="count" hint="Object Store buckets (OBJ_* streams)." onClick={reveal} loading={waiting} />
          </>
        )}
      </KpiRow>

      <Card title="JetStream" icon="database" subtitle={js?.domain ? `domain ${js.domain}` : undefined} loading={waiting} minHeight={waiting ? 84 : undefined}>
        {js?.enabled === false ? (
          <EmptyState compact icon="circle-slash" title="JetStream not enabled" secondary={{ label: "JetStream docs", icon: "link-external", onClick: () => void call("openDocs", { url: DOCS_LINKS.jetstream }) }}>
            Start the server with <span class="mono">-js</span> and grant the account JetStream to use streams, KV and object stores.
          </EmptyState>
        ) : js?.error ? (
          <div class="ov-error" role="alert">
            <ToneIcon tone="danger" title="Error" />
            <span>{js.error}</span>
          </div>
        ) : jsOn ? (
          <>
            <Meter label="Storage" value={js!.storage ?? 0} max={js!.maxStorage ?? -1} unit="bytes" size="sm" title={`File storage: ${formatValue(js!.storage ?? 0, "bytes")} used · ${LIMIT_SOURCE_LABEL[js!.storageSource ?? "none"]}${js!.maxStorage ? ` ${formatValue(js!.maxStorage, "bytes")}` : ""}`} />
            <Meter label="Memory" value={js!.memory ?? 0} max={js!.maxMemory ?? -1} unit="bytes" size="sm" title={`Memory storage: ${formatValue(js!.memory ?? 0, "bytes")} used · ${LIMIT_SOURCE_LABEL[js!.memorySource ?? "none"]}${js!.maxMemory ? ` ${formatValue(js!.maxMemory, "bytes")}` : ""}`} />
            <div class="ov-foot">
              Limits: {LIMIT_SOURCE_LABEL[js!.storageSource ?? "none"]}
              {js!.api && js!.api.errors > 0 && (
                <>
                  {" "}
                  · <span title="JetStream API requests that returned an error">{formatValue(js!.api.errors, "count")} API errors</span>
                </>
              )}
            </div>
          </>
        ) : (
          <div class="muted small">Waiting for JetStream account info…</div>
        )}
      </Card>

      <HealthCard row={row} run={run} />

      <Card title="Quick actions" icon="zap">
        <div class="ov-actions" role="group" aria-label="Quick actions">
          {QUICK_ACTIONS.map((a) => {
            const blocked = a.write && p.readOnly;
            return (
              <button
                type="button"
                key={a.command}
                class={cx("ov-action", blocked && "ov-action-blocked")}
                title={blocked ? `${a.label}: blocked, ${p.name} is read-only` : a.hint}
                aria-disabled={blocked || undefined}
                onClick={() => !blocked && run(a.command, p.id)}
              >
                <Icon name={blocked ? "lock" : a.icon} />
                <span>{a.label}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title="Connections"
        icon="plug"
        subtitle={`${snap.live.length} live · ${snap.profiles.length} total`}
        flush
        actions={
          <>
            <Button variant="ghost" small icon="add" title="Add connection" aria-label="Add connection" onClick={() => run("nats.addConnection")} />
            <Button variant="ghost" small icon="home" title="Open NATS Home" aria-label="Open NATS Home" onClick={() => run("nats.openHome")} />
          </>
        }
      >
        {others.length ? (
          <ul class="ov-list" aria-label="Other connections">
            {others.slice(0, 8).map((x) => (
              <ProfileItem key={x.id} p={x} run={run} call={call} />
            ))}
          </ul>
        ) : (
          <div class="ov-empty-line muted small">This is your only connection profile.</div>
        )}
        {others.length > 8 && (
          <div class="ov-more">
            <button type="button" class="ds-link" onClick={() => run("nats.openHome")}>
              All {snap.profiles.length} connections in Home
            </button>
          </div>
        )}
      </Card>
    </DashboardPage>
  );
}

function RttLine({ rtt, history, warnMs, url }: { rtt?: number; history: { t: number; v: number | null }[]; warnMs: number; url?: string }) {
  const tone = rttTone(rtt, warnMs);
  const bad = tone === "warn" || tone === "danger";
  return (
    <div class="ov-rtt" title={`Round-trip time to ${url ?? "the server"} (PING/PONG). Warning at ${warnMs} ms (nats.health.rttWarningMs).`}>
      <span class="ov-rtt-label">
        <Icon name="pulse" /> RTT
      </span>
      <span class={cx("ov-rtt-value", bad && `tone-${tone}`)}>
        {bad && <ToneIcon tone={tone} title={tone === "danger" ? "Very slow" : "Slow"} />}
        {rtt !== undefined ? formatValue(rtt, "ms") : "–"}
      </span>
      <span class="ov-rtt-spark">{history.filter((h) => h.v !== null).length > 1 && <Sparkline values={history} height={18} unit="ms" label="Round-trip time trend" tone={bad ? tone : undefined} />}</span>
    </div>
  );
}

function HealthCard({ row, run }: { row: FleetRow; run: Run }) {
  const h = row.health;
  const id = row.profile.id;
  const at = h ? Date.parse(h.at) : undefined;
  return (
    <Card
      title="Health"
      icon="heart"
      subtitle={at ? `checked ${fmtAgoShort(at)}` : undefined}
      actions={<Button variant="ghost" small icon="refresh" title="Run health check" aria-label="Run health check" onClick={() => run("nats.runHealthCheck", id)} />}
    >
      {h ? (
        <>
          <div class="ov-health-head">
            <HealthPill score={h.score} onClick={() => run("nats.openHealthDashboard", id)} title={`Health score ${Math.round(h.score)} / 100 — open the health dashboard`} />
            <span class="ov-counts">
              {h.errors > 0 && <Chip size="sm" tone="danger" icon="error">{`${h.errors} error${h.errors === 1 ? "" : "s"}`}</Chip>}
              {h.warnings > 0 && <Chip size="sm" tone="warn" icon="warning">{`${h.warnings} warning${h.warnings === 1 ? "" : "s"}`}</Chip>}
              {h.errors === 0 && h.warnings === 0 && <span class="muted small">No problems found</span>}
            </span>
          </div>
          {h.top.length > 0 && (
            <ul class="ov-findings" aria-label="Top findings">
              {h.top.slice(0, 3).map((f, i) => (
                <li key={i}>
                  <ToneIcon tone={severityTone(f.severity)} title={f.severity} />
                  <span>{f.title}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div class="ov-health-empty">
          <HealthPill score={undefined} title="No health check has run for this connection yet" />
          <Button small icon="pulse" onClick={() => run("nats.runHealthCheck", id)}>
            Run check
          </Button>
        </div>
      )}
    </Card>
  );
}

function ProfileItem({ p, run, call, showOrigin }: { p: ProfileSummary; run: Run; call: (m: string, params?: unknown) => Promise<void>; showOrigin?: boolean }) {
  const origin = ORIGIN_META[p.origin];
  const live = isLive(p.state);
  const sub = p.state === "error" && p.error ? p.error : p.warning ?? p.servers.join(", ");
  return (
    <li class={cx("ov-item", p.active && "ov-item-active")}>
      <StatusDot tone={stateTone(p.state)} label={stateLabel(p.state)} size="sm" pulse={p.state === "connecting"} />
      <div class="ov-item-text">
        <div class="ov-item-name">
          <span class="ellipsis" title={p.description ? `${p.name} — ${p.description}` : p.name}>
            {p.name}
          </span>
          {p.environment && !showOrigin && <EnvBadge env={p.environment} compact />}
          {p.readOnly && <Icon name="lock" title="Read-only" class="ov-lock" />}
        </div>
        <div class={cx("ov-item-sub ellipsis", p.state === "error" || p.warning ? "tone-danger" : "mono")} title={sub}>
          {showOrigin && (
            <span class="ov-origin" title={`${origin.label}: ${origin.hint}`}>
              <Icon name={origin.icon} />
              {origin.short}
            </span>
          )}
          {sub}
        </div>
      </div>
      {p.state === "connecting" ? (
        <Button small variant="ghost" busy aria-label={`Connecting to ${p.name}`} />
      ) : live ? (
        p.active ? (
          <span class="ov-active-tag" title="Active connection">
            active
          </span>
        ) : (
          <Button small variant="ghost" icon="target" title={`Make ${p.name} the active connection`} aria-label={`Make ${p.name} the active connection`} onClick={() => void call("setActive", { profileId: p.id })} />
        )
      ) : (
        <Button small variant="secondary" icon={p.state === "error" ? "refresh" : "plug"} title={p.warning ?? `Connect to ${p.name}`} onClick={() => run("nats.connect", p.id)}>
          {p.state === "error" ? "Retry" : "Connect"}
        </Button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Nothing connected
// ---------------------------------------------------------------------------------------------

function OfflineView({ snap, run, call, banner }: { snap: OverviewSnapshot; run: Run; call: (m: string, p?: unknown) => Promise<void>; banner: ComponentChildren }) {
  const groups = groupByEnvironment(snap.profiles, (p) => p.environment, compareProfiles);
  const header = (
    <DashboardHeader
      icon="plug"
      title="NATS"
      subtitle={snap.profiles.length ? `${snap.profiles.length} connection profile${snap.profiles.length === 1 ? "" : "s"}` : "No connections configured"}
      status={{ tone: "neutral", label: "Not connected" }}
      actions={
        <>
          <Button variant="ghost" small icon="add" title="Add connection" aria-label="Add connection" onClick={() => run("nats.addConnection")} />
          <Button variant="ghost" small icon="home" title="Open NATS Home" aria-label="Open NATS Home" onClick={() => run("nats.openHome")} />
        </>
      }
    />
  );
  if (!snap.profiles.length) {
    return (
      <DashboardPage class="ov" label="Overview" header={header}>
        {banner}
        <EmptyState
          kind="no-connection"
          title="No connections yet"
          primary={{ label: "Add connection", icon: "add", onClick: () => run("nats.addConnection") }}
          secondary={{ label: "Import NATS CLI contexts", icon: "cloud-download", onClick: () => run("nats.importContexts") }}
          actions={
            <Button variant="ghost" icon="plug" onClick={() => run("nats.connectLocal")}>
              Connect to localhost:4222
            </Button>
          }
        >
          NATS CLI contexts, <span class="mono">NATS_URL</span> and workspace connections (<span class="mono">nats.connections</span>) appear here automatically.
        </EmptyState>
        <div class="ov-docs">
          <button type="button" class="ds-link" onClick={() => void call("openDocs", { url: DOCS_LINKS.home })}>
            <Icon name="book" /> NATS documentation
          </button>
        </div>
      </DashboardPage>
    );
  }
  return (
    <DashboardPage class="ov" label="Overview" header={header}>
      {banner}
      <EmptyState compact kind="no-connection" title="Not connected">
        Connect to a server to see live throughput, JetStream usage and health here.
      </EmptyState>
      {groups.map((g) => (
        <Card
          key={g.env}
          class={cx("ov-env-card", g.env !== "none" && `ds-env-${g.env}`)}
          title={g.env === "none" ? ENV_LABEL.none : <EnvBadge env={g.env} />}
          subtitle={`${g.items.length} profile${g.items.length === 1 ? "" : "s"}`}
          flush
        >
          <ul class="ov-list" aria-label={`${g.label} connections`}>
            {g.items.map((p) => (
              <ProfileItem key={p.id} p={p} run={run} call={call} showOrigin />
            ))}
          </ul>
        </Card>
      ))}
      <div class="ov-cta">
        <Button icon="add" onClick={() => run("nats.addConnection")}>
          Add connection
        </Button>
        <Button variant="ghost" icon="cloud-download" onClick={() => run("nats.importContexts")}>
          Import contexts
        </Button>
      </div>
    </DashboardPage>
  );
}

render(<App />, document.getElementById("root")!);

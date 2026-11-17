import "./lib/styles.css";
import "./health.css";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { getInit, getState, onEvent, rpc, setState } from "./lib/vscode";
import { Button, cx, ErrorBanner, Flash, Icon, useFlash } from "./lib/ui";
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
  InfoTip,
  KeyValueGrid,
  KpiRow,
  KpiTile,
  Skeleton,
  fmtAgoShort,
  type Column,
  type Tone,
} from "./lib/dashboard";
import { BarList, Donut, Gauge, ItemsTable, healthTone, toneColor, useNow } from "./lib/charts";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_PLURAL,
  countsText,
  scoreLabel,
  targetKey,
  targetLabel,
  type Category,
  type Finding,
  type HealthReport,
  type HealthViewModel,
  type ResourceRow,
  type Severity,
} from "../src/health/model";
import { fmtBytes, fmtMillis, fmtNumber } from "../src/shared/format";

const SEV_TONE: Record<Severity, Tone> = { error: "danger", warning: "warn", info: "info" };
/** Findings rendered per page (accounts with thousands of streams produce thousands of findings). */
const FINDINGS_PAGE = 100;
const SEV_ICON: Record<Severity, string> = { error: "error", warning: "warning", info: "info" };
const KIND_LABEL: Record<string, string> = { stream: "Stream", consumer: "Consumer", kv: "KV bucket", objectstore: "Object store", account: "Account", server: "Server", connection: "Connection" };
const KIND_ICON: Record<string, string> = { stream: "database", consumer: "inbox", kv: "symbol-key", objectstore: "file-binary", account: "account", server: "server", connection: "plug" };

interface UiState {
  severities?: Severity[];
  categories?: Category[];
  onlyProblems?: boolean;
}

function useUiState(): [UiState, (patch: Partial<UiState>) => void] {
  const [ui, setUi] = useState<UiState>(() => {
    try {
      return getState<UiState>() ?? {};
    } catch {
      return {};
    }
  });
  const update = (patch: Partial<UiState>) =>
    setUi((prev) => {
      const next = { ...prev, ...patch };
      try {
        setState(next);
      } catch {
        /* state persistence is a convenience */
      }
      return next;
    });
  return [ui, update];
}

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

function App() {
  const [vm, setVm] = useState<HealthViewModel>(getInit<HealthViewModel>());
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useFlash();
  const [ui, setUi] = useUiState();
  const [resource, setResource] = useState<ResourceRow | null>(null);
  const [query, setQuery] = useState("");
  /** The "last run failed" message the user dismissed (shown again when a new failure arrives). */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);

  useEffect(() => onEvent<HealthViewModel>("update", (m) => setVm(m)), []);
  useEffect(() => setResource(null), [vm.connId]);

  const call = async <T,>(method: string, params?: unknown): Promise<T | undefined> => {
    try {
      setError(null);
      return await rpc<T>(method, params);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };
  const run = async () => {
    const m = await call<HealthViewModel>("run");
    if (m) setVm(m);
  };
  const select = async (connId: string) => {
    const m = await call<HealthViewModel>("select", { connId });
    if (m) setVm(m);
  };
  const exportMd = async () => {
    if (await call("export")) setFlash("Report opened as a Markdown document");
  };

  const r = vm.report;
  const connected = vm.state === "connected";
  /** The client is (re)connecting: a run would only collect timeouts, so wait for it. */
  const transitional = vm.state === "reconnecting" || vm.state === "connecting";
  const severities = ui.severities ?? [];
  const categories = ui.categories ?? [];
  const toggleSeverity = (s: Severity) => setUi({ severities: severities.includes(s) ? severities.filter((x) => x !== s) : [...severities, s] });
  const toggleCategory = (c: Category) => setUi({ categories: categories.includes(c) ? categories.filter((x) => x !== c) : [...categories, c] });
  const showOnly = (s: Severity) => {
    setUi({ severities: [s], categories: [] });
    setResource(null);
    document.getElementById("findings")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const clearFilters = () => {
    setUi({ severities: [], categories: [] });
    setResource(null);
    setQuery("");
  };

  const header = (
    <DashboardHeader
      icon="pulse"
      title="Health"
      subtitle={<Subtitle vm={vm} />}
      env={vm.environment}
      readOnly={vm.readOnly}
      connectionName={vm.connName}
      status={r ? { tone: healthTone(r.score), label: `${scoreLabel(r.score)} · ${r.score}` } : vm.running ? { tone: "info", label: "Checking…", pulse: true } : undefined}
      actions={
        <>
          {vm.connections.length > 1 && <ConnectionSelect vm={vm} onSelect={select} />}
          <Button
            variant="primary"
            small
            icon="play"
            busy={vm.running}
            disabled={vm.running || transitional}
            onClick={run}
            title={transitional ? `Waiting for ${vm.connName} to reconnect` : connected ? (r ? "Run the health check again" : "Run the health check") : "Connect and run the health check"}
          >
            {vm.running ? "Checking…" : r ? "Re-run" : "Run check"}
          </Button>
          <Button variant="ghost" small icon="markdown" disabled={!r} onClick={exportMd} title="Export the report as Markdown" aria-label="Export report as Markdown" />
          <Button variant="ghost" small icon="settings-gear" onClick={() => void call("settings")} title="Health check settings (thresholds, auto-run, interval)" aria-label="Health check settings" />
        </>
      }
      meta={<HeaderMeta vm={vm} />}
    />
  );

  return (
    <DashboardPage header={header} label="Health dashboard">
      <Flash message={flash} />
      {r && !connected && <ConnectionBanner state={vm.state === "reconnecting" ? "reconnecting" : vm.state === "connecting" ? "connecting" : vm.state === "error" ? "error" : "disconnected"} message="Results are from the last check." since={r.at} onRetry={vm.state === "disconnected" || vm.state === "error" ? run : undefined} retryLabel="Connect & re-run" />}
      <ErrorBanner
        error={error ?? (vm.error && r && vm.error !== dismissed ? `Last run failed: ${vm.error}` : null)}
        onDismiss={() => {
          if (!error) setDismissed(vm.error);
          setError(null);
        }}
      />
      {!r ? (
        <NoReport vm={vm} onRun={run} />
      ) : (
        <Report
          vm={vm}
          r={r}
          stale={!connected}
          ui={ui}
          setUi={setUi}
          severities={severities}
          categories={categories}
          toggleSeverity={toggleSeverity}
          toggleCategory={toggleCategory}
          showOnly={showOnly}
          clearFilters={clearFilters}
          resource={resource}
          setResource={setResource}
          query={query}
          setQuery={setQuery}
          call={call}
        />
      )}
    </DashboardPage>
  );
}

function Subtitle({ vm }: { vm: HealthViewModel }) {
  const s = vm.report?.server;
  return (
    <>
      <span class="mono">{vm.connName}</span>
      {s && (
        <>
          {" · "}
          <span class="mono" title={s.id}>
            {s.name}
          </span>{" "}
          v{s.version}
          {s.cluster && (
            <>
              {" · cluster "}
              <span class="mono">{s.cluster}</span>
            </>
          )}
        </>
      )}
    </>
  );
}

function HeaderMeta({ vm }: { vm: HealthViewModel }) {
  const now = useNow(5000);
  const r = vm.report;
  return (
    <div class="hl-meta">
      {r ? (
        <span class="hl-meta-item" title={new Date(r.at).toLocaleString()}>
          <Icon name="history" /> Checked {fmtAgoShort(r.at, now)} · took {fmtMillis(r.durationMs)}
        </span>
      ) : (
        <span class="hl-meta-item">
          <Icon name="history" /> Not checked yet
        </span>
      )}
      <span class="hl-meta-item" title="Settings nats.health.autoRun and nats.health.intervalMinutes">
        <Icon name={vm.autoRun ? "sync" : "circle-slash"} /> {vm.autoRun ? "Auto-run on connect" : "Auto-run off"}
        {vm.intervalMinutes > 0 ? ` · every ${vm.intervalMinutes} min` : ""}
      </span>
      {r && (
        <span class="hl-meta-item" title={r.monitor.error ?? "HTTP monitoring endpoint (varz, healthz)"}>
          <Icon name={r.monitor.url ? (r.monitor.reachable ? "radio-tower" : "debug-disconnect") : "circle-slash"} />{" "}
          {r.monitor.url ? `Monitoring ${r.monitor.reachable ? "reachable" : "unreachable"}` : "Monitoring not configured"}
          {r.monitor.healthz ? ` · healthz ${r.monitor.healthz}` : ""}
        </span>
      )}
    </div>
  );
}

function ConnectionSelect({ vm, onSelect }: { vm: HealthViewModel; onSelect: (id: string) => void }) {
  return (
    <label class="hl-conn-select">
      <span class="sr-only">Connection</span>
      <select class="input input-sm" name="connection" aria-label="Connection" value={vm.connId} onChange={(e) => onSelect((e.target as HTMLSelectElement).value)}>
        {vm.connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.environment === "prod" ? " (PROD)" : ""}
            {c.score !== undefined ? ` · ${c.score}` : c.state !== "connected" ? ` · ${c.state}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------------------------
// Empty / loading states
// ---------------------------------------------------------------------------------------------

function NoReport({ vm, onRun }: { vm: HealthViewModel; onRun: () => void }) {
  if (vm.running) {
    return (
      <div class="hl-stack" aria-busy="true" aria-label="Health check running">
        <KpiRow min={150} label="Health summary (loading)">
          {["Health score", "Errors", "Warnings", "Info", "Resources checked", "Round-trip time"].map((l) => (
            <KpiTile key={l} label={l} value={null} loading />
          ))}
        </KpiRow>
        <Grid>
          <Card span={4} title="Health score" icon="heart" loading minHeight={170} />
          <Card span={4} title="Findings by severity" icon="pie-chart" loading minHeight={170} />
          <Card span={4} title="Findings by category" icon="list-ordered" loading minHeight={170} />
          <Card span={12} title="Findings" icon="checklist">
            <Skeleton variant="text" lines={6} />
          </Card>
        </Grid>
      </div>
    );
  }
  if (vm.state !== "connected") {
    return (
      <EmptyState kind="no-connection" title="Not connected" primary={{ label: "Connect & run health check", icon: "plug", onClick: onRun }}>
        Connect to <span class="mono">{vm.connName}</span> to analyse its streams, consumers, buckets, JetStream account and server against NATS best practices.
      </EmptyState>
    );
  }
  if (vm.error) {
    return (
      <EmptyState kind="error" title="The health check failed" primary={{ label: "Try again", icon: "refresh", onClick: onRun }}>
        <span class="mono">{vm.error}</span>
        <br />
        Check the connection's permissions and the NATS output channel for details.
      </EmptyState>
    );
  }
  return (
    <EmptyState kind="no-data" title="No health check yet" primary={{ label: "Run health check", icon: "play", onClick: onRun }}>
      The health doctor reads stream, consumer, KV, object store, account and server state (read-only) and reports misconfigurations, lagging consumers and resources close to their limits.
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

interface ReportProps {
  vm: HealthViewModel;
  r: HealthReport;
  stale: boolean;
  ui: UiState;
  setUi: (p: Partial<UiState>) => void;
  severities: Severity[];
  categories: Category[];
  toggleSeverity: (s: Severity) => void;
  toggleCategory: (c: Category) => void;
  showOnly: (s: Severity) => void;
  clearFilters: () => void;
  resource: ResourceRow | null;
  setResource: (r: ResourceRow | null) => void;
  query: string;
  setQuery: (q: string) => void;
  call: <T>(method: string, params?: unknown) => Promise<T | undefined>;
}

function Report(p: ReportProps) {
  const { vm, r, stale } = p;
  const hist = vm.history;
  const prev = hist.length >= 2 ? hist[hist.length - 2].score : undefined;
  const inv = r.inventory;
  const totalResources = inv.streams + inv.consumers + inv.kv + inv.obj;
  const a = r.account;
  const rttTone: Tone | undefined = r.rttMs === undefined ? undefined : r.rttMs > r.thresholds.rttWarningMs ? "warn" : "ok";
  const storageFrac = a && a.maxStorage > 0 ? a.storage / a.maxStorage : undefined;
  const storageTone: Tone | undefined = storageFrac === undefined ? undefined : storageFrac >= r.thresholds.storageErrorRatio ? "danger" : storageFrac >= r.thresholds.storageWarningRatio ? "warn" : "ok";

  return (
    <>
      <KpiRow min={150} label="Health summary">
        <KpiTile
          label="Health score"
          value={r.score}
          sub={`of 100 · ${scoreLabel(r.score)}`}
          tone={healthTone(r.score)}
          previous={prev}
          deltaMode="absolute"
          deltaLabel="vs previous run"
          trend={hist.length > 1 ? hist.map((h) => ({ t: h.at, v: h.score })) : undefined}
          hint="Weighted score: each severity's penalty saturates, so warnings alone never go below 60. ≥ 90 healthy, ≥ 60 degraded, below 60 critical."
          stale={stale}
        />
        <KpiTile label="Errors" value={r.counts.error} tone={r.counts.error ? "danger" : "ok"} sub={r.counts.error ? "need action now" : "none"} hint="Problems that already break or will soon break publishing, delivery or availability." onClick={() => p.showOnly("error")} stale={stale} />
        <KpiTile label="Warnings" value={r.counts.warning} tone={r.counts.warning ? "warn" : "ok"} sub={r.counts.warning ? "risky configuration" : "none"} hint="Deviations from NATS best practices and resources approaching their limits." onClick={() => p.showOnly("warning")} stale={stale} />
        <KpiTile label="Info" value={r.counts.info} tone={r.counts.info ? "info" : undefined} sub="worth a look" hint="Observations that may be intentional, plus checks that could not run (permissions, monitoring)." onClick={() => p.showOnly("info")} stale={stale} />
        <KpiTile
          label="Resources checked"
          value={totalResources}
          unit="count"
          sub={<span title={`${inv.streams} streams · ${inv.consumers} consumers · ${inv.kv} KV buckets · ${inv.obj} object stores`}>{`${inv.streams} streams · ${inv.consumers} consumers · ${inv.kv} KV · ${inv.obj} obj`}</span>}
          hint="Streams, durable consumers, KV buckets and object stores analysed in this run (KV_/OBJ_ backing streams count as buckets)."
          stale={stale}
        />
        <KpiTile label="Round-trip time" value={r.rttMs ?? null} unit="ms" tone={rttTone} sub={`warn above ${fmtMillis(r.thresholds.rttWarningMs)}`} hint="Client ↔ server RTT measured with a PING at check time (setting nats.health.rttWarningMs)." stale={stale} />
        {a ? (
          <KpiTile
            label="JetStream storage"
            value={a.storage}
            unit="bytes"
            tone={storageTone}
            sub={a.maxStorage > 0 ? `of ${fmtBytes(a.maxStorage)} account limit` : "no account limit"}
            meter={a.maxStorage > 0 ? { value: a.storage, max: a.maxStorage, warn: r.thresholds.storageWarningRatio, danger: r.thresholds.storageErrorRatio } : undefined}
            hint="File storage used by the account's streams (from $JS.API.INFO)."
            stale={stale}
          />
        ) : (
          <KpiTile label="JetStream" value={r.jetstream.enabled ? "Enabled" : "Unavailable"} tone={r.jetstream.enabled ? "ok" : "neutral"} sub={r.jetstream.reason ?? (r.jetstream.permissionDenied ? "permission denied" : undefined)} stale={stale} />
        )}
      </KpiRow>

      <Grid>
        <ScoreCard r={r} stale={stale} />
        <SeverityCard r={r} stale={stale} onSelect={p.showOnly} />
        <CategoryCard r={r} stale={stale} selected={p.categories} onSelect={(c) => p.setUi({ categories: [c], severities: [] })} />
        <ResourcesCard r={r} stale={stale} onlyProblems={p.ui.onlyProblems ?? false} setOnlyProblems={(v) => p.setUi({ onlyProblems: v })} selected={p.resource} onSelect={(row) => {
          p.setResource(p.resource?.key === row.key ? null : row);
          document.getElementById("findings")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }} onOpen={(row) => void p.call("open", { target: row.target })} />
        <FindingsCard {...p} />
        <DetailsCard r={r} onSettings={() => void p.call("settings")} />
      </Grid>
    </>
  );
}

function ScoreCard({ r, stale }: { r: HealthReport; stale: boolean }) {
  const cats = r.categories.filter((c) => c.count > 0);
  return (
    <Card
      span={4}
      title="Health score"
      icon="heart"
      subtitle="0–100, higher is healthier"
      stale={stale}
      tableView={() => <ItemsTable caption="Score by category" labelHeader="Category" valueHeader="Score" items={r.categories.map((c) => ({ label: c.label, value: c.score }))} unit="none" />}
      footer={
        <span class="hl-scale" aria-label="Score bands">
          <span class="tone-ok">
            <Icon name="pass-filled" /> ≥ 90 healthy
          </span>
          <span class="tone-warn">
            <Icon name="warning" /> ≥ 60 degraded
          </span>
          <span class="tone-danger">
            <Icon name="error" /> &lt; 60 critical
          </span>
        </span>
      }
    >
      <div class="hl-score">
        <Gauge value={r.score} max={100} label="Health score" hideLabel higherIsWorse={false} warn={0.1} danger={0.4} tone={healthTone(r.score)} sublabel={scoreLabel(r.score)} size={176} />
        {cats.length > 0 ? (
          <ul class="hl-subscores" aria-label="Lowest category scores">
            {cats
              .sort((x, y) => x.score - y.score)
              .slice(0, 3)
              .map((c) => (
                <li key={c.category}>
                  <span class="hl-sub-label">{c.label}</span>
                  <span class={cx("hl-sub-score", `tone-${healthTone(c.score)}`)}>{c.score}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p class="muted hl-center">Every category scores 100.</p>
        )}
      </div>
    </Card>
  );
}

function SeverityCard({ r, stale, onSelect }: { r: HealthReport; stale: boolean; onSelect: (s: Severity) => void }) {
  const data = SEVERITIES.map((s) => ({ id: s, label: SEVERITY_PLURAL[s], value: r.counts[s], tone: SEV_TONE[s] }));
  return (
    <Card
      span={4}
      title="Findings by severity"
      icon="pie-chart"
      subtitle="click a part to filter"
      stale={stale}
      tableView={() => <ItemsTable caption="Findings by severity" labelHeader="Severity" valueHeader="Findings" items={data.map((d) => ({ label: d.label, value: d.value, color: toneColor(d.tone) }))} />}
    >
      {r.findings.length ? (
        <Donut data={data} label="Findings by severity" unit="count" centerLabel={r.findings.length === 1 ? "finding" : "findings"} size={140} onSelect={(d) => d.id && onSelect(d.id as Severity)} />
      ) : (
        <EmptyState compact kind="success" title="No findings">
          Nothing to report for this connection.
        </EmptyState>
      )}
    </Card>
  );
}

function CategoryCard({ r, stale, selected, onSelect }: { r: HealthReport; stale: boolean; selected: Category[]; onSelect: (c: Category) => void }) {
  const items = r.categories
    .filter((c) => c.count > 0)
    .map((c) => ({
      id: c.category,
      label: c.label,
      value: c.count,
      tone: (c.errors ? "danger" : c.warnings ? "warn" : undefined) as Tone | undefined,
      secondary: countsText({ error: c.errors, warning: c.warnings, info: c.infos }),
      hint: `${c.label}: ${countsText({ error: c.errors, warning: c.warnings, info: c.infos })} · category score ${c.score}`,
    }));
  return (
    <Card
      span={4}
      title="Findings by category"
      icon="list-ordered"
      subtitle="bar colour = worst severity"
      stale={stale}
      tableView={() => <ItemsTable caption="Findings by category" labelHeader="Category" valueHeader="Findings" items={items.map((i) => ({ label: i.label, value: i.value }))} />}
    >
      {items.length ? (
        <BarList items={items} label="Findings by category" unit="count" onSelect={(i) => i.id && onSelect(i.id as Category)} selectedId={selected.length === 1 ? selected[0] : undefined} />
      ) : (
        <EmptyState compact kind="success" title="No findings">
          Streams, consumers, buckets, account and server all pass.
        </EmptyState>
      )}
    </Card>
  );
}

function SeverityCell({ sev }: { sev?: Severity }) {
  if (!sev)
    return (
      <span class="hl-sev hl-sev-ok">
        <Icon name="pass-filled" /> OK
      </span>
    );
  return (
    <span class={cx("hl-sev", `hl-sev-${sev}`)}>
      <Icon name={SEV_ICON[sev]} /> {SEVERITY_LABEL[sev]}
    </span>
  );
}

function Counts({ row }: { row: { errors: number; warnings: number; infos: number } }) {
  if (!row.errors && !row.warnings && !row.infos) return <span class="muted">–</span>;
  return (
    <span class="hl-counts" aria-label={countsText({ error: row.errors, warning: row.warnings, info: row.infos })}>
      {row.errors > 0 && (
        <span class="tone-danger" title={`${row.errors} errors`}>
          <Icon name="error" /> {row.errors}
        </span>
      )}
      {row.warnings > 0 && (
        <span class="tone-warn" title={`${row.warnings} warnings`}>
          <Icon name="warning" /> {row.warnings}
        </span>
      )}
      {row.infos > 0 && (
        <span class="tone-info" title={`${row.infos} info`}>
          <Icon name="info" /> {row.infos}
        </span>
      )}
    </span>
  );
}

const SEV_SORT = (row: ResourceRow) => (row.worst === "error" ? 0 : row.worst === "warning" ? 1 : row.worst === "info" ? 2 : 3);

function ResourcesCard({ r, stale, onlyProblems, setOnlyProblems, selected, onSelect, onOpen }: { r: HealthReport; stale: boolean; onlyProblems: boolean; setOnlyProblems: (v: boolean) => void; selected: ResourceRow | null; onSelect: (row: ResourceRow) => void; onOpen: (row: ResourceRow) => void }) {
  const affected = r.resources.filter((x) => x.worst).length;
  const rows = onlyProblems ? r.resources.filter((x) => x.worst) : r.resources;
  const columns: Column<ResourceRow>[] = [
    { key: "worst", header: "Status", value: SEV_SORT, render: (row) => <SeverityCell sev={row.worst} />, width: "104px", title: "Worst finding severity of the resource" },
    {
      key: "name",
      header: "Resource",
      value: (row) => (row.parent ? `${row.parent} › ${row.name}` : row.name),
      render: (row) => (
        <span class="hl-res">
          <Icon name={KIND_ICON[row.kind] ?? "circle-outline"} />
          <span class="mono hl-res-name">
            {row.parent && <span class="muted">{row.parent} › </span>}
            {row.name}
          </span>
        </span>
      ),
    },
    { key: "kind", header: "Kind", value: (row) => KIND_LABEL[row.kind] ?? row.kind, width: "110px", hideBelow: "sm" },
    { key: "findings", header: "Findings", value: (row) => row.errors * 10000 + row.warnings * 100 + row.infos, render: (row) => <Counts row={row} />, numeric: true, width: "120px", title: "Errors · warnings · info" },
    { key: "summary", header: "Summary", value: (row) => row.summary, render: (row) => <span class="muted hl-summary">{row.summary || "–"}</span>, sortable: false, hideBelow: "md" },
    {
      key: "open",
      header: <span class="sr-only">Actions</span>,
      sortable: false,
      filterable: false,
      width: "44px",
      align: "right",
      render: (row) => (
        <Button
          variant="ghost"
          small
          icon="go-to-file"
          title={`Open ${KIND_LABEL[row.kind] ?? row.kind} info`}
          aria-label={`Open ${row.name} info`}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            onOpen(row);
          }}
          onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
        />
      ),
    },
  ];
  return (
    <Card span={12} title="Resources" icon="server-environment" subtitle={`${fmtNumber(affected)} of ${fmtNumber(r.resources.length)} with findings · click a row to filter the findings`} flush stale={stale}>
      <DataTable
        label="Resources by worst finding"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        filter={{ placeholder: "Filter resources…" }}
        initialSort={{ key: "worst", dir: "asc" }}
        onRowClick={onSelect}
        selectedKey={selected?.key}
        rowTone={(row) => (row.worst ? SEV_TONE[row.worst] : undefined)}
        maxHeight={360}
        dense
        toolbar={
          <Chip icon="filter" size="sm" selected={onlyProblems} onClick={() => setOnlyProblems(!onlyProblems)} title="Show only resources that have findings">
            Only with findings
          </Chip>
        }
        empty={onlyProblems ? "No resource has findings." : "No resources were analysed."}
      />
    </Card>
  );
}

function FindingsCard(p: ReportProps) {
  const { r, severities, categories, resource, query, stale } = p;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(r.findings.filter((f) => f.severity === "error").slice(0, 3).map((f) => f.key)));
  useEffect(() => {
    setExpanded(new Set(r.findings.filter((f) => f.severity === "error").slice(0, 3).map((f) => f.key)));
  }, [r.at, r.connId]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = useMemo(
    () =>
      r.findings.filter((f) => {
        if (severities.length && !severities.includes(f.severity)) return false;
        if (categories.length && !categories.includes(f.category)) return false;
        if (resource && targetKey(f.target) !== resource.key) return false;
        if (terms.length) {
          const hay = `${f.title} ${f.detail} ${targetLabel(f.target)} ${f.id} ${CATEGORY_LABEL[f.category]}`.toLowerCase();
          if (!terms.every((t) => hay.includes(t))) return false;
        }
        return true;
      }),
    [r, severities, categories, resource, query],
  );
  // Selected categories stay visible (filters persist across connections and re-runs) so they can be turned off.
  const usedCategories = CATEGORIES.filter((c) => categories.includes(c) || r.findings.some((f) => f.category === c));
  const filtered = severities.length > 0 || categories.length > 0 || !!resource || terms.length > 0;
  // Large accounts can produce thousands of findings: render them in pages.
  const [limit, setLimit] = useState(FINDINGS_PAGE);
  useEffect(() => setLimit(FINDINGS_PAGE), [r.at, r.connId, severities.join(), categories.join(), resource?.key, query]);
  const shown = list.length > limit ? list.slice(0, limit) : list;
  const allOpen = list.length > 0 && list.every((f) => expanded.has(f.key));
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card
      span={12}
      id="findings"
      title="Findings"
      icon="checklist"
      subtitle={filtered ? `${list.length} of ${r.findings.length} shown` : `${r.findings.length} · most important first`}
      stale={stale}
      actions={
        r.findings.length > 0 && (
          <Button variant="ghost" small icon={allOpen ? "collapse-all" : "expand-all"} onClick={() => setExpanded(allOpen ? new Set() : new Set(list.map((f) => f.key)))} title={allOpen ? "Collapse all" : "Expand all"} aria-label={allOpen ? "Collapse all findings" : "Expand all findings"} />
        )
      }
    >
      {r.findings.length === 0 ? (
        <EmptyState kind="success" title="All checks passed" compact>
          {fmtNumber(r.resources.length)} resources were checked against NATS best practices. Re-run after configuration changes, or enable periodic checks with <span class="mono">nats.health.intervalMinutes</span>.
        </EmptyState>
      ) : (
        <>
          <FilterBar label="Finding filters" class="hl-filters">
            <div class="hl-chip-group" role="group" aria-label="Severity">
              {SEVERITIES.map((s) => (
                <Chip key={s} icon={SEV_ICON[s]} tone={SEV_TONE[s]} selected={severities.includes(s)} onClick={() => p.toggleSeverity(s)} title={`Show ${SEVERITY_PLURAL[s].toLowerCase()}`}>
                  {SEVERITY_PLURAL[s]} {r.counts[s]}
                </Chip>
              ))}
            </div>
            <div class="hl-chip-group" role="group" aria-label="Category">
              {usedCategories.map((c) => (
                <Chip key={c} size="sm" selected={categories.includes(c)} onClick={() => p.toggleCategory(c)}>
                  {CATEGORY_LABEL[c]} {r.findings.filter((f) => f.category === c).length}
                </Chip>
              ))}
            </div>
            {resource && (
              <Chip mono icon={KIND_ICON[resource.kind]} onRemove={() => p.setResource(null)} title="Findings of this resource only">
                {resource.parent ? `${resource.parent} › ${resource.name}` : resource.name}
              </Chip>
            )}
            <label class="hl-search">
              <Icon name="search" />
              <input class="input input-sm" type="search" name="finding-search" value={query} placeholder="Search findings…" aria-label="Search findings" onInput={(e) => p.setQuery((e.target as HTMLInputElement).value)} />
            </label>
            {filtered && (
              <button type="button" class="ds-link" onClick={p.clearFilters}>
                Clear filters
              </button>
            )}
          </FilterBar>
          {list.length === 0 ? (
            <EmptyState compact kind="search" title="No findings match the filters" primary={{ label: "Clear filters", icon: "clear-all", onClick: p.clearFilters }} />
          ) : (
            <>
              <ul class="hl-findings" aria-label="Findings">
                {shown.map((f) => (
                  <FindingItem key={f.key} f={f} open={expanded.has(f.key)} onToggle={() => toggle(f.key)} readOnly={!!p.vm.readOnly} disabled={p.vm.state !== "connected"} call={p.call} />
                ))}
              </ul>
              {shown.length < list.length && (
                <div class="hl-more">
                  <span class="muted">
                    Showing {fmtNumber(shown.length)} of {fmtNumber(list.length)} findings
                  </span>
                  <Button small variant="secondary" icon="chevron-down" onClick={() => setLimit((n) => n + FINDINGS_PAGE)}>
                    Show {fmtNumber(Math.min(FINDINGS_PAGE, list.length - shown.length))} more
                  </Button>
                  <button type="button" class="ds-link" onClick={() => setLimit(list.length)}>
                    Show all
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

function FindingItem({ f, open, onToggle, readOnly, disabled, call }: { f: Finding; open: boolean; onToggle: () => void; readOnly: boolean; disabled: boolean; call: ReportProps["call"] }) {
  const id = `f-${f.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const editing = !!f.fix && /^nats\.edit(Stream|Consumer)Config$/.test(f.fix.command);
  return (
    <li class={cx("hl-finding", `hl-finding-${f.severity}`)}>
      <div class="hl-finding-head">
        <span class={cx("hl-finding-icon", `tone-${SEV_TONE[f.severity]}`)} title={SEVERITY_LABEL[f.severity]}>
          <Icon name={SEV_ICON[f.severity]} />
          <span class="sr-only">{SEVERITY_LABEL[f.severity]}:</span>
        </span>
        <div class="hl-finding-main">
          <button type="button" class="hl-finding-title" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
            <Icon name={open ? "chevron-down" : "chevron-right"} class="hl-chevron" />
            <span>{f.title}</span>
          </button>
          <div class="hl-finding-sub">
            <span class="mono hl-target" title={targetLabel(f.target)}>
              <Icon name={KIND_ICON[f.target.kind] ?? "circle-outline"} /> {targetLabel(f.target)}
            </span>
            <span class="muted">{CATEGORY_LABEL[f.category]}</span>
            <span class="muted mono hl-check-id" title="Check id">
              {f.id}
            </span>
          </div>
        </div>
        <div class="hl-finding-actions">
          {f.fix && (
            <Button
              small
              variant={f.severity === "error" ? "primary" : "secondary"}
              icon={editing && readOnly ? "lock" : "lightbulb"}
              disabled={disabled}
              onClick={() => void call("fix", { key: f.key })}
              title={editing && readOnly ? `${f.fix.label} — opens the editor; saving is blocked on this read-only connection` : `${f.fix.label} (${f.fix.command})`}
            >
              {f.fix.label}
            </Button>
          )}
          <Button variant="ghost" small icon="go-to-file" disabled={disabled} onClick={() => void call("open", { target: f.target })} title={`Open ${targetLabel(f.target)} info`} aria-label={`Open ${targetLabel(f.target)} info`} />
        </div>
      </div>
      <p class="hl-detail">{f.detail}</p>
      {open && (
        <div class="hl-reco" id={id}>
          <div class="hl-reco-label">
            <Icon name="lightbulb" /> Why it matters · best practice
          </div>
          <p>{f.recommendation}</p>
          {f.docs && (
            <button type="button" class="ds-link hl-docs" onClick={() => void call("docs", { url: f.docs })}>
              <Icon name="book" /> NATS documentation
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function DetailsCard({ r, onSettings }: { r: HealthReport; onSettings: () => void }) {
  const t = r.thresholds;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Card
      span={12}
      title="Check details"
      icon="info"
      subtitle="thresholds, monitoring and collection notes"
      collapsible
      defaultCollapsed={r.notes.length === 0}
      actions={
        <Button variant="ghost" small icon="settings-gear" onClick={onSettings}>
          Thresholds
        </Button>
      }
    >
      <KeyValueGrid
        dense
        minColumnWidth={220}
        items={[
          { label: "Consumer pending warning", value: `${fmtNumber(t.pendingWarning)} msgs`, hint: "nats.health.pendingWarning — error at 10×" },
          { label: "Ack pending stall", value: `${pct(t.ackPendingRatio)} of max_ack_pending`, hint: "nats.health.ackPendingRatio" },
          { label: "Storage warning / error", value: `${pct(t.storageWarningRatio)} / ${pct(t.storageErrorRatio)}`, hint: "nats.health.storageWarningRatio / storageErrorRatio — streams, buckets, account and server limits" },
          { label: "RTT warning", value: fmtMillis(t.rttWarningMs), hint: "nats.health.rttWarningMs" },
          { label: "Idle pull consumer", value: fmtMillis(t.idleConsumerMs), hint: "Pending messages, no waiting pulls and no delivery for this long" },
          { label: "Minimum server version", value: t.minServerVersion, mono: true },
          { label: "Monitoring endpoint", value: r.monitor.url ? `${r.monitor.url} · ${r.monitor.reachable ? "reachable" : "unreachable"}` : "not configured", mono: !!r.monitor.url, tone: r.monitor.url && !r.monitor.reachable ? "warn" : undefined, copy: r.monitor.url },
          { label: "Server /healthz", value: r.monitor.healthz ?? "–", tone: r.monitor.healthz && r.monitor.healthz !== "ok" ? "danger" : undefined },
          { label: "JetStream API", value: r.account ? `${fmtNumber(r.account.apiErrors)} errors of ${fmtNumber(r.account.apiTotal)} requests` : "–", hint: "Account API statistics since server start" },
        ]}
      />
      {r.notes.length > 0 && (
        <div class="hl-notes">
          <div class="hl-reco-label">
            <Icon name="warning" /> Collection notes <InfoTip text="Parts of the server state the check could not read. Findings in those areas may be missing." />
          </div>
          <ul>
            {r.notes.map((n, i) => (
              <li key={i}>
                <b>{n.scope}</b>
                {n.stream && (
                  <>
                    {" "}
                    <span class="mono">{n.stream}</span>
                  </>
                )}
                : <span class="mono">{n.message}</span>
                {n.permission && <span class="muted"> (permission)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

render(<App />, document.getElementById("root")!);

// Design-system gallery: every chart and layout component with realistic NATS data, plus a
// theme switcher (VS Code Dark Modern / Light Modern / High Contrast variable sets).
// Build:  npx esbuild test/harness/gallery.tsx --bundle --outdir=dist/webview --format=iife \
//           --platform=browser --target=es2022 --jsx=automatic --jsx-import-source=preact --loader:.ttf=file
// Render: node scripts/harness.mjs gallery   (dist/webview/gallery.* is excluded from the .vsix)
import "../../webview/lib/styles.css";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { getInit, rpc } from "../../webview/lib/vscode";
import { Badge, Button, Icon } from "../../webview/lib/ui";
import {
  Card,
  Cell,
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
  type Environment,
} from "../../webview/lib/dashboard";
import {
  ActivityStrip,
  BarChart,
  BarList,
  CrosshairSync,
  Donut,
  Gauge,
  HealthPill,
  Heatmap,
  Histogram,
  ItemsTable,
  Legend,
  Meter,
  SegmentBar,
  SeriesTable,
  Sparkline,
  StatusDot,
  TimeSeriesChart,
  Treemap,
  bucketize,
  seriesColor,
  usePolling,
  useTimeSeries,
  type TimeSeries,
  type TreeNode,
} from "../../webview/lib/charts";

// ---- themes ------------------------------------------------------------------------------

type ThemeKind = "dark" | "light" | "hc";

const THEMES: Record<ThemeKind, { body: string; vars: Record<string, string> }> = {
  dark: {
    body: "vscode-dark",
    vars: {
      foreground: "#cccccc", descriptionForeground: "#9d9d9d", "editor-background": "#1f1f1f", "sideBar-background": "#181818",
      "panel-border": "#2b2b2b", "widget-border": "#313131", "textLink-foreground": "#4daafc", "button-background": "#0078d4",
      "button-foreground": "#ffffff", "button-hoverBackground": "#026ec1", "button-secondaryBackground": "#313131",
      "button-secondaryForeground": "#cccccc", "button-secondaryHoverBackground": "#3c3c3c", "input-background": "#313131",
      "input-foreground": "#cccccc", "input-border": "#3c3c3c", "input-placeholderForeground": "#989898", focusBorder: "#0078d4",
      "list-hoverBackground": "#2a2d2e", "list-activeSelectionBackground": "#04395e", "list-activeSelectionForeground": "#ffffff",
      "list-inactiveSelectionBackground": "#37373d", "badge-background": "#616161", "badge-foreground": "#f8f8f8",
      "textCodeBlock-background": "#2b2b2b", errorForeground: "#f85149", "editorWarning-foreground": "#cca700",
      "editorInfo-foreground": "#3794ff", "testing-iconPassed": "#73c991", "charts-foreground": "#cccccc", "charts-lines": "#cccccc80",
      "charts-red": "#f14c4c", "charts-blue": "#3794ff", "charts-yellow": "#cca700", "charts-orange": "#d18616", "charts-green": "#89d185",
      "charts-purple": "#b180d7", "terminal-ansiMagenta": "#bc3fbc", "terminal-ansiCyan": "#11a8cd", "editorHoverWidget-background": "#202020",
      "editorHoverWidget-border": "#454545", "editorHoverWidget-foreground": "#cccccc", "widget-shadow": "#0000005c",
      "toolbar-hoverBackground": "#5a5d5e50", "progressBar-background": "#0078d4", "inputValidation-errorBorder": "#be1100",
      "inputValidation-errorBackground": "#5a1d1d", "inputValidation-warningBorder": "#b89500", "inputValidation-warningBackground": "#352a05",
      "inputValidation-infoBorder": "#007acc", "inputValidation-infoBackground": "#063b49",
    },
  },
  light: {
    body: "vscode-light",
    vars: {
      foreground: "#3b3b3b", descriptionForeground: "#6f6f6f", "editor-background": "#ffffff", "sideBar-background": "#f8f8f8",
      "panel-border": "#e5e5e5", "widget-border": "#e5e5e5", "textLink-foreground": "#005fb8", "button-background": "#005fb8",
      "button-foreground": "#ffffff", "button-hoverBackground": "#0258a8", "button-secondaryBackground": "#e5e5e5",
      "button-secondaryForeground": "#3b3b3b", "button-secondaryHoverBackground": "#cccccc", "input-background": "#ffffff",
      "input-foreground": "#3b3b3b", "input-border": "#cecece", "input-placeholderForeground": "#767676", focusBorder: "#005fb8",
      "list-hoverBackground": "#f2f2f2", "list-activeSelectionBackground": "#e8e8e8", "list-activeSelectionForeground": "#000000",
      "list-inactiveSelectionBackground": "#e4e6f1", "badge-background": "#cccccc", "badge-foreground": "#3b3b3b",
      "textCodeBlock-background": "#f8f8f8", errorForeground: "#a1260d", "editorWarning-foreground": "#bf8803",
      "editorInfo-foreground": "#1a85ff", "testing-iconPassed": "#388a34", "charts-foreground": "#616161", "charts-lines": "#61616180",
      "charts-red": "#e51400", "charts-blue": "#1a85ff", "charts-yellow": "#bf8803", "charts-orange": "#d18616", "charts-green": "#388a34",
      "charts-purple": "#652d90", "terminal-ansiMagenta": "#bc05bc", "terminal-ansiCyan": "#0598bc", "editorHoverWidget-background": "#f8f8f8",
      "editorHoverWidget-border": "#c8c8c8", "editorHoverWidget-foreground": "#3b3b3b", "widget-shadow": "#00000029",
      "toolbar-hoverBackground": "#b8b8b850", "progressBar-background": "#005fb8", "inputValidation-errorBorder": "#be1100",
      "inputValidation-errorBackground": "#f2dede", "inputValidation-warningBorder": "#b89500", "inputValidation-warningBackground": "#f6f5d2",
      "inputValidation-infoBorder": "#007acc", "inputValidation-infoBackground": "#d6ecf2",
    },
  },
  hc: {
    body: "vscode-high-contrast",
    vars: {
      foreground: "#ffffff", descriptionForeground: "#d6d6d6", "editor-background": "#000000", "sideBar-background": "#000000",
      "panel-border": "#6fc3df", "widget-border": "#6fc3df", contrastBorder: "#6fc3df", contrastActiveBorder: "#f38518",
      "textLink-foreground": "#21a6ff", "button-background": "#000000", "button-border": "#6fc3df", "button-foreground": "#ffffff",
      "button-hoverBackground": "#000000", "button-secondaryBackground": "#000000", "button-secondaryForeground": "#ffffff",
      "button-secondaryHoverBackground": "#000000", "input-background": "#000000", "input-foreground": "#ffffff", "input-border": "#6fc3df",
      "input-placeholderForeground": "#ffffffb3", focusBorder: "#f38518", "list-hoverBackground": "#ffffff1a",
      "list-activeSelectionBackground": "#000000", "list-activeSelectionForeground": "#ffffff", "list-inactiveSelectionBackground": "#000000",
      "badge-background": "#000000", "badge-foreground": "#ffffff", "textCodeBlock-background": "#000000", errorForeground: "#f48771",
      "editorWarning-foreground": "#ffd370", "editorInfo-foreground": "#3794ff", "testing-iconPassed": "#73c991",
      "charts-foreground": "#ffffff", "charts-lines": "#ffffff80", "charts-red": "#f48771", "charts-blue": "#3794ff", "charts-yellow": "#ffd370",
      "charts-orange": "#ff9d3b", "charts-green": "#89d185", "charts-purple": "#b180d7", "terminal-ansiMagenta": "#d670d6",
      "terminal-ansiCyan": "#29b8db", "editorHoverWidget-background": "#0c141f", "editorHoverWidget-border": "#6fc3df",
      "editorHoverWidget-foreground": "#ffffff", "widget-shadow": "#00000000", "toolbar-hoverBackground": "#ffffff1a",
      "progressBar-background": "#6fc3df", "inputValidation-errorBorder": "#f48771", "inputValidation-errorBackground": "#000000",
      "inputValidation-warningBorder": "#ffd370", "inputValidation-warningBackground": "#000000", "inputValidation-infoBorder": "#6fc3df",
      "inputValidation-infoBackground": "#000000",
    },
  },
};

function applyTheme(kind: ThemeKind) {
  const root = document.documentElement;
  for (const t of Object.values(THEMES)) for (const k of Object.keys(t.vars)) root.style.removeProperty(`--vscode-${k}`);
  for (const [k, v] of Object.entries(THEMES[kind].vars)) root.style.setProperty(`--vscode-${k}`, v);
  document.body.classList.remove("vscode-dark", "vscode-light", "vscode-high-contrast");
  document.body.classList.add(THEMES[kind].body);
  document.body.dataset.vscodeThemeKind = THEMES[kind].body;
}

// ---- demo data -----------------------------------------------------------------------------

interface Sample {
  t: number;
  counters: { in_msgs: number; out_msgs: number; in_bytes: number; out_bytes: number };
  gauges: { connections: number; cpu: number; mem: number; rtt: number };
  pending: { billing: number; shipping: number; analytics: number };
}

interface Init {
  history: Sample[];
  stepMs: number;
  server: { name: string; version: string; url: string };
}

type Key = "in" | "out" | "bin" | "bout" | "connections" | "cpu" | "mem" | "rtt" | "billing" | "shipping" | "analytics";

let s = 42;
const rnd = () => {
  s = (s * 1103515245 + 12345) % 2147483648;
  return s / 2147483648;
};

const LATENCY = Array.from({ length: 2400 }, () => {
  const n = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  return Math.exp(1.35 + 0.55 * n) + (rnd() < 0.015 ? 40 + rnd() * 60 : 0);
});

const SUBJECTS: TreeNode[] = [
  {
    id: "orders",
    label: "orders",
    children: ["eu", "us", "apac"].map((r, i) => ({
      id: `orders.${r}`,
      label: r,
      children: ["created", "paid", "shipped", "cancelled"].map((e, j) => ({ id: `orders.${r}.${e}`, label: e, value: Math.round((90_000 - i * 26_000) * [1, 0.86, 0.71, 0.08][j]) })),
    })),
  },
  {
    id: "billing",
    label: "billing",
    children: [
      { id: "billing.invoice", label: "invoice", children: [{ id: "billing.invoice.created", label: "created", value: 48_200 }, { id: "billing.invoice.settled", label: "settled", value: 41_000 }] },
      { id: "billing.refund", label: "refund", children: [{ id: "billing.refund.requested", label: "requested", value: 3_100 }, { id: "billing.refund.settled", label: "settled", value: 2_400 }] },
    ],
  },
  { id: "telemetry", label: "telemetry", children: [{ id: "telemetry.gps", label: "gps", value: 61_000 }, { id: "telemetry.temp", label: "temp", value: 38_500 }, { id: "telemetry.battery", label: "battery", value: 12_400 }] },
  { id: "$JS", label: "$JS", children: [{ id: "$JS.API", label: "API", value: 9_800 }, { id: "$JS.EVENT", label: "EVENT", value: 2_200 }, { id: "$JS.ACK", label: "ACK", value: 21_000 }] },
  { id: "audit", label: "audit", value: 7_600 },
  { id: "_INBOX", label: "_INBOX", value: 5_100 },
];

interface ConsumerRow {
  stream: string;
  name: string;
  kind: "pull" | "push";
  pending: number;
  ackPending: number;
  maxAckPending: number;
  redelivered: number;
  waiting: number;
  lastActiveMs: number;
  health: number;
  trend: number[];
}

const CONSUMERS: ConsumerRow[] = [
  { stream: "ORDERS", name: "billing", kind: "pull", pending: 12, ackPending: 40, maxAckPending: 1000, redelivered: 0, waiting: 4, lastActiveMs: 800, health: 98, trend: [8, 12, 10, 14, 9, 11, 12] },
  { stream: "ORDERS", name: "shipping", kind: "pull", pending: 18_450, ackPending: 920, maxAckPending: 1000, redelivered: 312, waiting: 0, lastActiveMs: 4_100, health: 54, trend: [900, 2400, 5200, 8800, 12_100, 15_900, 18_450] },
  { stream: "ORDERS", name: "analytics", kind: "push", pending: 640, ackPending: 0, maxAckPending: 0, redelivered: 3, waiting: 0, lastActiveMs: 1_200, health: 82, trend: [30, 900, 20, 640, 15, 30, 640] },
  { stream: "BILLING", name: "invoicer", kind: "pull", pending: 0, ackPending: 2, maxAckPending: 500, redelivered: 0, waiting: 8, lastActiveMs: 300, health: 100, trend: [0, 1, 0, 0, 2, 0, 0] },
  { stream: "TELEMETRY", name: "ingest-cold", kind: "pull", pending: 2_300_000, ackPending: 4_800, maxAckPending: 5000, redelivered: 12_900, waiting: 0, lastActiveMs: 95_000, health: 21, trend: [1.2e6, 1.4e6, 1.6e6, 1.8e6, 2e6, 2.2e6, 2.3e6] },
  { stream: "AUDIT", name: "archiver", kind: "push", pending: 4, ackPending: 0, maxAckPending: 0, redelivered: 0, waiting: 0, lastActiveMs: 2_000, health: 96, trend: [2, 3, 5, 4, 4, 3, 4] },
];

const STREAMS = [
  { label: "ORDERS", value: 1_284_220 },
  { label: "TELEMETRY", value: 4_912_000 },
  { label: "BILLING", value: 312_400 },
  { label: "AUDIT", value: 98_200 },
  { label: "KV_config", value: 2_210 },
  { label: "OBJ_files", value: 840 },
];

const STORAGE = [
  { label: "TELEMETRY", value: 6.1 * 1024 ** 3 },
  { label: "ORDERS", value: 2.4 * 1024 ** 3 },
  { label: "BILLING", value: 820 * 1024 ** 2 },
  { label: "AUDIT", value: 310 * 1024 ** 2 },
  { label: "KV_config", value: 1.8 * 1024 ** 2 },
  { label: "OBJ_files", value: 96 * 1024 ** 2 },
  { label: "KV_sessions", value: 44 * 1024 ** 2 },
];

// ---- gallery --------------------------------------------------------------------------------

function Gallery() {
  const init = getInit<Init>();
  const [theme, setTheme] = useState<ThemeKind>("dark");
  const [env, setEnv] = useState<Environment>("prod");
  const [readOnly, setReadOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState("15m");
  const [selected, setSelected] = useState<string | undefined>("ORDERS/shipping");
  const [subject, setSubject] = useState<string>("orders.eu.created");
  const ts = useTimeSeries<Key>(1800);

  useEffect(() => applyTheme(theme), [theme]);

  const ingest = (smp: Sample) => {
    ts.pushCounters(smp.t, { in: smp.counters.in_msgs, out: smp.counters.out_msgs, bin: smp.counters.in_bytes, bout: smp.counters.out_bytes });
    ts.push(smp.t, { ...smp.gauges, ...smp.pending });
  };
  useEffect(() => {
    for (const smp of init.history) ingest(smp);
  }, []);
  const poll = usePolling(() => rpc<Sample>("stats"), 1000, !paused && !disconnected);
  useEffect(() => {
    if (poll.data) ingest(poll.data);
  }, [poll.data]);

  const win = rangeMs(range);
  const pick = (k: Key) => (empty ? [] : ts.series(k, win));
  const throughput: TimeSeries[] = [
    { id: "in", name: "Inbound", points: pick("in") },
    { id: "out", name: "Outbound", points: pick("out") },
  ];
  const bytes: TimeSeries[] = [{ id: "bin", name: "Bytes in", points: pick("bin") }];
  const lag: TimeSeries[] = [
    { id: "billing", name: "billing", points: pick("billing") },
    { id: "shipping", name: "shipping", points: pick("shipping") },
    { id: "analytics", name: "analytics", points: pick("analytics") },
  ];
  const last5m = (k: Key) => ts.series(k, 300_000).map((p) => p.v ?? 0);
  const inNow = ts.last("in");
  const inPrev = ts.stats("in", win)?.avg;

  const strip = useMemo(() => {
    const end = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
    const events: number[] = [];
    for (let i = 0; i < 260; i++) {
      const age = Math.floor(rnd() ** 2.2 * 60) * 60_000;
      events.push(end - age - rnd() * 60_000);
    }
    return { buckets: bucketize(events, { start: end - 60 * 60_000, end, bucketMs: 60_000 }), end };
  }, []);
  const heat = useMemo(() => {
    const cols = Array.from({ length: 30 }, (_, i) => ({ t: strip.end - (30 - i) * 60_000 }));
    const rows = CONSUMERS.slice(0, 5).map((c) => ({ id: `${c.stream}/${c.name}`, label: `${c.stream}/${c.name}` }));
    const values = rows.map((_, ri) => cols.map((_c, ci) => (ri === 3 && ci < 4 ? null : Math.round(ri === 1 ? ci * 60 + rnd() * 80 : ri === 4 ? 1500 + rnd() * 400 : rnd() * (ri === 2 ? 900 : 60)))));
    return { cols, rows, values };
  }, []);

  const columns: Column<ConsumerRow>[] = [
    { key: "name", header: "Consumer", mono: true, value: (r) => `${r.stream}/${r.name}`, render: (r) => (
      <span class="row" style={{ gap: "6px" }}>
        <StatusDot tone={r.health >= 90 ? "ok" : r.health >= 60 ? "warn" : "danger"} label={r.health >= 90 ? "Healthy" : r.health >= 60 ? "Degraded" : "Critical"} size="sm" />
        <span>
          <span class="muted">{r.stream}/</span>
          {r.name}
        </span>
      </span>
    ) },
    { key: "kind", header: "Type", hideBelow: "sm", render: (r) => <Badge tone={r.kind === "push" ? "info" : "neutral"}>{r.kind}</Badge> },
    { key: "pending", header: "Pending", numeric: true, unit: "msgs", title: "Messages not yet delivered (num_pending)" },
    { key: "ackPending", header: "Ack pending", numeric: true, width: "170px", title: "Delivered, awaiting ack, against max_ack_pending", render: (r) => <Meter value={r.ackPending} max={r.maxAckPending} inline size="sm" show="percent" ticks={false} label={undefined} title={`${r.ackPending} of ${r.maxAckPending || "unlimited"} ack pending`} /> },
    { key: "redelivered", header: "Redelivered", numeric: true, hideBelow: "md" },
    { key: "lastActiveMs", header: "Last active", numeric: true, unit: "ms", hideBelow: "md", descFirst: false },
    { key: "trend", header: "Pending trend", sortable: false, filterable: false, hideBelow: "sm", width: "110px", render: (r) => <Sparkline values={r.trend} width={96} height={20} label={`${r.name} pending trend`} unit="msgs" tone={r.health < 60 ? "danger" : undefined} /> },
    { key: "health", header: "Health", numeric: true, render: (r) => <HealthPill score={r.health} size="sm" /> },
  ];

  const stale = poll.refreshing && !poll.loading;
  const memMax = 2 * 1024 ** 3;

  const header = (
    <DashboardHeader
      icon="dashboard"
      title="Design system gallery"
      subtitle={
        <>
          <span class="mono">{init.server.url}</span> · v{init.server.version}
        </>
      }
      env={env}
      connectionName={init.server.name}
      readOnly={readOnly}
      status={disconnected ? { tone: "danger", label: "Disconnected" } : { tone: "ok", label: "Connected", pulse: true }}
      actions={
        <>
          <div class="seg" role="radiogroup" aria-label="Theme">
            {(["dark", "light", "hc"] as const).map((k) => (
              <button type="button" key={k} role="radio" aria-checked={theme === k} class={`seg-btn ${theme === k ? "seg-active" : ""}`} onClick={() => setTheme(k)} data-theme-btn={k}>
                {k === "hc" ? "High contrast" : k[0].toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
          <select class="input input-sm" name="env" aria-label="Environment" value={env} onChange={(e) => setEnv((e.target as HTMLSelectElement).value as Environment)}>
            <option value="dev">dev</option>
            <option value="test">test</option>
            <option value="staging">staging</option>
            <option value="prod">prod</option>
          </select>
          <Button variant="ghost" small icon={readOnly ? "lock" : "unlock"} title="Toggle read-only" onClick={() => setReadOnly((r) => !r)} />
          <Button variant="ghost" small icon="gear" title="Settings" />
        </>
      }
      meta={
        <>
          <Chip icon="server" mono>
            {init.server.name}
          </Chip>
          <Chip icon="layers" size="md">
            JetStream · domain <span class="mono">hub</span>
          </Chip>
          <Chip icon="shield" tone="ok">
            TLS
          </Chip>
          <Chip icon="filter" mono selected onRemove={() => undefined}>
            orders.&gt;
          </Chip>
        </>
      }
    />
  );

  return (
    <DashboardPage header={header} label="Gallery">
      <FilterBar>
        <TimeRangePicker value={range} onChange={(id) => setRange(id)} />
        <RefreshIndicator updatedAt={poll.updatedAt} paused={paused} suspended={poll.suspended} refreshing={poll.refreshing} error={disconnected ? "connection closed" : poll.error} intervalMs={1000} onTogglePause={() => setPaused((p) => !p)} onRefresh={() => void poll.refresh()} />
        <span class="spacer" />
        <label class="check">
          <input type="checkbox" name="loading" checked={loading} onChange={() => setLoading((v) => !v)} /> Loading
        </label>
        <label class="check">
          <input type="checkbox" name="empty" checked={empty} onChange={() => setEmpty((v) => !v)} /> Empty
        </label>
        <label class="check">
          <input type="checkbox" name="disconnected" checked={disconnected} onChange={() => setDisconnected((v) => !v)} /> Disconnected
        </label>
      </FilterBar>
      <ConnectionBanner state={disconnected ? "reconnecting" : "connected"} message="nats://nats-eu-1.internal:4222 refused the connection." since={poll.updatedAt} onRetry={() => setDisconnected(false)} />

      <KpiRow>
        <KpiTile label="Inbound messages" value={empty ? null : inNow} unit="msgs/s" previous={inPrev} deltaLabel={`vs ${range} avg`} trend={empty ? undefined : last5m("in")} hint="Server-wide in_msgs rate from /varz, per second." loading={loading} stale={stale} />
        <KpiTile label="Outbound messages" value={empty ? null : ts.last("out")} unit="msgs/s" previous={ts.stats("out", win)?.avg} deltaLabel={`vs ${range} avg`} trend={empty ? undefined : last5m("out")} loading={loading} />
        <KpiTile label="Bytes in" value={empty ? null : ts.last("bin")} unit="bytes/s" previous={ts.previous("bin")} deltaLabel="vs previous sample" goodWhen="neither" trend={empty ? undefined : last5m("bin")} loading={loading} />
        <KpiTile label="Connections" value={empty ? null : ts.last("connections")} unit="count" previous={ts.previous("connections", 30)} deltaMode="absolute" deltaLabel="vs 1m ago" goodWhen="neither" sub="of 64k max" loading={loading} />
        <KpiTile label="Slow consumers" value={empty ? null : 3} unit="count" tone="danger" previous={1} deltaMode="absolute" goodWhen="down" deltaLabel="since connect" hint="Clients dropped messages because they could not keep up." onClick={() => setSelected("TELEMETRY/ingest-cold")} loading={loading} />
        <KpiTile label="JetStream storage" value={empty ? null : 9.6 * 1024 ** 3} unit="bytes" tone="warn" sub="of 12 GiB account limit" meter={{ value: 9.6, max: 12 }} loading={loading} />
        <KpiTile label="RTT" value={empty ? null : ts.last("rtt")} unit="ms" previous={ts.stats("rtt", win)?.avg} goodWhen="down" deltaLabel="vs avg" trend={empty ? undefined : last5m("rtt")} loading={loading} />
      </KpiRow>

      <SectionHeading title="Traffic" subtitle={`last ${range} · crosshair shared across charts`} />
      <CrosshairSync>
        <Grid>
          <Card span={8} title="Message throughput" subtitle="msgs/s · server-wide" icon="pulse" tableView={() => <SeriesTable series={throughput} unit="msgs/s" caption="Message throughput" />} loading={loading} minHeight={236} stale={disconnected}>
            <TimeSeriesChart series={throughput} label="Message throughput" unit="msgs/s" windowMs={win} height={200} thresholds={[{ value: 9000, tone: "warn", label: "alert" }]} emptyText="No samples yet — waiting for the first two polls" stale={stale && false} />
          </Card>
          <Card span={4} title="Resources" icon="server" loading={loading} minHeight={236} footer={<span>Source: /varz · /jsz</span>}>
            <div class="row" style={{ justifyContent: "space-around", flexWrap: "wrap", gap: "12px" }}>
              <Gauge label="JetStream storage" value={empty ? 0 : 9.6 * 1024 ** 3} max={12 * 1024 ** 3} unit="bytes" size={150} />
              <Gauge label="Memory" value={empty ? 0 : (ts.last("mem") ?? 0)} max={memMax} unit="bytes" size={150} />
            </div>
            <Meter label="CPU" value={empty ? 0 : (ts.last("cpu") ?? 0)} max={100} unit="percent" show="percent" />
            <Meter label="Connections" value={empty ? 0 : (ts.last("connections") ?? 0)} max={65_536} unit="count" size="sm" />
            <Meter label="Subscriptions" value={empty ? 0 : 41_200} max={50_000} unit="count" size="sm" />
          </Card>
          <Card span={6} title="Bytes in" subtitle="per second" icon="arrow-down" loading={loading} tableView={() => <SeriesTable series={bytes} unit="bytes/s" />}>
            <TimeSeriesChart series={bytes} label="Bytes in" unit="bytes/s" windowMs={win} height={160} />
          </Card>
          <Card span={6} title="Consumer pending" subtitle="messages · ORDERS stream" icon="inbox" loading={loading}>
            <TimeSeriesChart series={lag} label="Consumer pending" unit="msgs" windowMs={win} height={160} />
          </Card>
        </Grid>
      </CrosshairSync>

      <SectionHeading title="Composition" />
      <Grid>
        <Card span={4} title="Top subjects" subtitle="msgs/s" icon="symbol-namespace" tableView={() => <ItemsTable items={SUBJECTS.map((n) => ({ label: n.label, value: sumNode(n) }))} unit="msgs" mono />} loading={loading}>
          <BarList label="Top subjects by message rate" items={empty ? [] : SUBJECTS.map((n) => ({ id: n.id, label: `${n.label}.>`, value: sumNode(n) / 60, secondary: n.children ? `${n.children.length} tokens` : undefined }))} unit="msgs/s" mono limit={5} showShare onSelect={(it) => setSubject(it.id ?? it.label)} selectedId={subject.split(".")[0]} emptyText="No subject activity in this window" />
        </Card>
        <Card span={4} title="Messages per stream" icon="database" loading={loading}>
          <BarChart label="Messages per stream" data={empty ? [] : STREAMS} unit="msgs" height={190} mono onSelect={(d) => setSelected(`${d.label}/`)} />
        </Card>
        <Card span={4} title="Storage by stream" icon="archive" loading={loading}>
          <Donut label="Storage by stream" data={empty ? [] : STORAGE} unit="bytes" mono centerLabel="used" />
        </Card>
        <Card span={6} title="Subject space" subtitle="messages, last 15m · click to drill in" icon="type-hierarchy" loading={loading}>
          <Treemap label="Subjects by message count" data={empty ? [] : SUBJECTS} unit="msgs" height={230} onSelect={(n, path) => setSubject(path.map((p) => p.label).join("."))} />
          <div class="small muted">
            Selected: <span class="mono">{subject}</span>
          </div>
        </Card>
        <Card span={6} title="Request latency" subtitle="billing.quote · $SRV stats" icon="watch" loading={loading}>
          <Histogram label="Request latency" values={empty ? [] : LATENCY} unit="ms" markers="percentiles" countLabel="requests" height={200} domain={[0, 40]} />
        </Card>
        <Card span={6} title="Consumer state" subtitle="ORDERS/shipping" icon="checklist">
          <SegmentBar label="Consumer message state" variant="tall" unit="msgs" legend="values" segments={[{ label: "Acked", value: 61_200, slot: 0 }, { label: "Ack pending", value: 920, slot: 1 }, { label: "Pending", value: 18_450, slot: 2 }, { label: "Redelivered", value: 312, tone: "warn" }]} />
          <SegmentBar label="Ack floor progress" variant="thin" unit="msgs" total={100_000} legend="values" segments={[{ label: "Acked", value: 61_200 }, { label: "In flight", value: 920 }]} />
          <div class="row small muted" style={{ gap: "8px" }}>
            dense <SegmentBar class="grow" label="Dense" variant="dense" legend={false} segments={[{ label: "a", value: 3 }, { label: "b", value: 2 }, { label: "c", value: 1 }]} />
          </div>
        </Card>
        <Card span={6} title="Account limits" subtitle="JetStream · account APP" icon="dashboard">
          <Meter label="Streams" value={6} max={100} unit="count" />
          <Meter label="Consumers" value={812} max={1000} unit="count" />
          <Meter label="Storage" value={9.6 * 1024 ** 3} max={12 * 1024 ** 3} unit="bytes" />
          <Meter label="Memory" value={1.2 * 1024 ** 3} max={1.25 * 1024 ** 3} unit="bytes" />
          <Meter label="Max ack pending" value={4_800} max={-1} unit="count" />
          <Meter label="Disk free" value={0.12} max={1} unit="ratio" higherIsWorse={false} show="percent" />
        </Card>
        <Card span={12} title="Advisories" subtitle="MAX_DELIVERIES · per minute, last hour" icon="bell" loading={loading}>
          <ActivityStrip label="Advisories per minute" buckets={empty ? [] : strip.buckets} bucketMs={60_000} unit="count" tone="danger" />
          <Heatmap label="Pending messages per consumer" rows={heat.rows} cols={heat.cols} values={heat.values} unit="msgs" />
        </Card>
      </Grid>

      <SectionHeading title="Data" />
      <Grid>
        <Card span={12} title="Consumers" subtitle={`${CONSUMERS.length} across 4 streams`} icon="list-flat" flush loading={false}>
          <DataTable
            label="Consumers"
            columns={columns}
            rows={empty ? [] : CONSUMERS}
            rowKey={(r) => `${r.stream}/${r.name}`}
            filter={{ placeholder: "Filter consumers…" }}
            initialSort={{ key: "pending", dir: "desc" }}
            onRowClick={(r) => setSelected(`${r.stream}/${r.name}`)}
            selectedKey={selected}
            rowTone={(r) => (r.health < 60 ? "danger" : undefined)}
            loading={loading}
            empty={<EmptyState compact kind="no-data" title="No consumers" primary={{ label: "Create consumer", icon: "add", onClick: () => undefined }}>Streams have no consumers yet.</EmptyState>}
            toolbar={
              <Button small variant="ghost" icon="add">
                New consumer
              </Button>
            }
          />
        </Card>
        <Card span={6} title="Server" icon="server" actions={<Button variant="ghost" small icon="json" title="Open /varz as JSON" />}>
          <KeyValueGrid
            items={[
              { label: "Name", value: init.server.name, mono: true },
              { label: "Version", value: `v${init.server.version}`, hint: "nats-server version reported in INFO" },
              { label: "Server ID", value: "NCM7V2C5QE5JIZUF4T4R33FCNT7OKAB2QZITYEMNHH43LVOOGU4QLKF3", mono: true, copy: "NCM7V2C5QE5JIZUF4T4R33FCNT7OKAB2QZITYEMNHH43LVOOGU4QLKF3", wide: true },
              { label: "Cluster", value: "eu-west (3 routes)" },
              { label: "Uptime", value: "3d 4h 12m" },
              { label: "Max payload", value: "1 MiB" },
              { label: "Go", value: "go1.26.5", mono: true },
              { label: "TLS", value: "required", tone: "ok" },
              { label: "Slow consumers", value: "3", tone: "danger" },
            ]}
          />
        </Card>
        <Card span={6} title="Status primitives" icon="symbol-color">
          <div class="row wrap">
            <StatusDot tone="ok" label="Connected" showLabel pulse />
            <StatusDot tone="warn" label="Reconnecting" showLabel />
            <StatusDot tone="danger" label="Closed" showLabel />
            <StatusDot tone="info" label="Draining" showLabel />
            <StatusDot tone="neutral" label="Idle" showLabel />
          </div>
          <div class="row wrap">
            <HealthPill score={97} />
            <HealthPill score={72} />
            <HealthPill score={31} />
            <HealthPill score={undefined} />
            <HealthPill score={88} size="sm" onClick={() => undefined} />
          </div>
          <div class="row wrap">
            <Chip>default</Chip>
            <Chip icon="tag" mono>
              orders.*.created
            </Chip>
            <Chip tone="warn" icon="warning">
              2 warnings
            </Chip>
            <Chip selected onClick={() => undefined}>
              selected
            </Chip>
            <Chip size="sm">small</Chip>
            <Badge tone="info">badge</Badge>
          </div>
          <Legend
            label="Categorical palette"
            items={Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, label: i < 8 ? `series ${i + 1}` : "other", color: seriesColor(i), shape: "rect" as const }))}
          />
        </Card>
      </Grid>

      <SectionHeading title="States" />
      <Grid>
        <Card span={4} title="No connection">
          <EmptyState compact kind="no-connection" title="Not connected" primary={{ label: "Connect", icon: "plug", onClick: () => setDisconnected(false) }} secondary={{ label: "Edit connection", onClick: () => undefined }}>
            Connect to <span class="mono">nats-eu-1</span> to load live metrics.
          </EmptyState>
        </Card>
        <Card span={4} title="No data">
          <EmptyState compact kind="no-data" title="No messages in this window" primary={{ label: "Publish a message", icon: "send", onClick: () => undefined }}>
            Nothing was published to <span class="mono">orders.&gt;</span> in the last {range}.
          </EmptyState>
        </Card>
        <Card span={4} title="Search">
          <EmptyState compact kind="search" title="No matches" secondary={{ label: "Clear filter", onClick: () => undefined }}>
            No subjects match <span class="mono">billing.*.void</span>.
          </EmptyState>
        </Card>
        <Card span={4} title="Success">
          <EmptyState compact kind="success" title="All checks passed">
            12 streams, 31 consumers and 4 buckets look healthy.
          </EmptyState>
        </Card>
        <Card span={4} title="Error">
          <EmptyState compact kind="error" title="Monitoring endpoint unreachable" primary={{ label: "Retry", icon: "refresh", onClick: () => undefined }}>
            GET <span class="mono">http://127.0.0.1:8222/varz</span> failed: connection refused. Start the server with <span class="mono">-m 8222</span>.
          </EmptyState>
        </Card>
        <Card span={4} title="Skeletons" collapsible>
          <Skeleton variant="text" lines={3} />
          <Skeleton height={48} />
          <div class="row">
            <Skeleton variant="circle" width={28} height={28} />
            <Skeleton variant="text" width="50%" />
          </div>
        </Card>
        <Cell span={12}>
          <div class="small muted" style={{ textAlign: "center", padding: "8px" }}>
            <Icon name="info" /> Gallery for visual testing — not shipped in the extension.
          </div>
        </Cell>
      </Grid>
    </DashboardPage>
  );
}

function sumNode(n: TreeNode): number {
  return n.children?.length ? n.children.reduce((a, c) => a + sumNode(c), 0) : (n.value ?? 0);
}

applyTheme("dark");
render(<Gallery />, document.getElementById("root")!);

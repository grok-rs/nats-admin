// Mock host for webview/topology.tsx (node scripts/harness.mjs topology).
// Variants via the URL hash: #prod, #empty, #nojs, #loading, #error, #big
(function () {
  const variant = (location.hash || "").slice(1);
  const now = Date.now();
  const iso = (ago) => new Date(now - ago).toISOString();

  window.__MOCK_INIT__ = {
    profileId: "c1",
    profileName: variant === "prod" ? "prod-eu" : "staging-eu",
    environment: variant === "prod" ? "prod" : "staging",
    readOnly: variant === "prod",
    serverName: "nats-eu-1",
    serverUrl: "nats://nats-eu-1.internal:4222",
    cluster: "eu-west",
    refreshInterval: 10000,
    thresholds: { pendingWarning: 10000, ackPendingRatio: 0.9, storageWarningRatio: 0.8, storageErrorRatio: 0.95, lagWarning: 1000 },
    health: { score: 72, errors: 1, warnings: 3, at: iso(60000), top: [{ severity: "error", title: "TELEMETRY/ingest-cold at max ack pending" }, { severity: "warning", title: "ORDERS/shipping has 18,450 pending" }] },
    state: variant === "error" ? "reconnecting" : "connected",
  };

  const stream = (name, o) => ({
    name,
    kind: name.startsWith("KV_") ? "kv" : name.startsWith("OBJ_") ? "obj" : "stream",
    bucket: name.startsWith("KV_") ? name.slice(3) : name.startsWith("OBJ_") ? name.slice(4) : undefined,
    subjects: [],
    messages: 0,
    bytes: 0,
    consumerCount: 0,
    storage: "file",
    retention: "limits",
    replicas: 3,
    maxBytes: -1,
    maxMsgs: -1,
    lastTs: iso(4000),
    cluster: { name: "eu-west", leader: "nats-eu-2", replicasCurrent: 3, replicasTotal: 3 },
    ...o,
  });
  const consumer = (s, name, o) => ({ stream: s, name, durable: true, kind: "pull", pending: 0, ackPending: 0, redelivered: 0, waiting: 1, maxAckPending: 1000, ackPolicy: "explicit", filterSubjects: [], ...o });

  let tick = 0;
  function data() {
    tick++;
    const jitter = (n, pct = 0.02) => Math.round(n * (1 + (Math.sin(tick * 1.7 + n) * pct)));
    const streams = [
      stream("ORDERS", { subjects: ["orders.>"], messages: jitter(1284500), bytes: jitter(1.9 * 1024 ** 3), consumerCount: 4, description: "All order events" }),
      stream("ORDERS_MIRROR", { messages: 1283266, bytes: 1.89 * 1024 ** 3, consumerCount: 1, mirror: { name: "ORDERS", lag: 1234, activeMs: 900 }, cluster: { name: "eu-west", leader: "nats-eu-3", replicasCurrent: 2, replicasTotal: 3 } }),
      stream("ORDERS_EU", { messages: 642000, bytes: 920 * 1024 ** 2, consumerCount: 1, sources: [{ name: "ORDERS", lag: 12, activeMs: 300, filter: "orders.eu.>" }, { name: "ORDERS_US", external: "$JS.us-east.API", lag: 4200, activeMs: 2100 }] }),
      stream("BILLING", { subjects: ["billing.invoice.*", "billing.refund.*", "billing.audit"], messages: jitter(48200), bytes: 62 * 1024 ** 2, consumerCount: 2, retention: "workqueue" }),
      stream("TELEMETRY", { subjects: ["telemetry.gps.>", "telemetry.temp.>", "telemetry.battery.>"], messages: jitter(9_800_000), bytes: 8.6 * 1024 ** 3, maxBytes: 10 * 1024 ** 3, consumerCount: 2, storage: "file", replicas: 1, cluster: { name: "eu-west", leader: "nats-eu-1" } }),
      stream("AUDIT", { subjects: ["audit.users", "audit.orders", "audit.billing", "audit.login", "audit.logout", "audit.admin", "audit.api", "audit.export", "audit.import"], messages: 7600, bytes: 3.1 * 1024 ** 2, consumerCount: 0, storage: "file" }),
      stream("KV_config", { subjects: ["$KV.config.>"], messages: 22, bytes: 1843, consumerCount: 0, retention: "limits" }),
      stream("KV_sessions", { subjects: ["$KV.sessions.>"], messages: jitter(12400), bytes: 4.2 * 1024 ** 2, consumerCount: 1, storage: "memory", replicas: 1, cluster: { name: "eu-west", leader: "nats-eu-1" } }),
      stream("OBJ_files", { subjects: ["$O.files.C.>", "$O.files.M.>"], messages: 412, bytes: 210 * 1024 ** 2, consumerCount: 0 }),
    ];
    const consumers = [
      consumer("ORDERS", "billing", { pending: 0, ackPending: 3, filterSubjects: ["orders.*.created"], lastActive: iso(800) }),
      consumer("ORDERS", "shipping", { pending: jitter(18450), ackPending: 220, redelivered: 14, filterSubjects: ["orders.*.paid"], lastActive: iso(2500) }),
      consumer("ORDERS", "analytics", { kind: "push", deliverSubject: "deliver.analytics", pushBound: true, pending: 1200, ackPending: 0, ackPolicy: "none", maxAckPending: -1 }),
      consumer("ORDERS", "fraud-check", { pending: 42, ackPending: 8, filterSubjects: ["orders.*.created", "orders.*.paid"] }),
      consumer("ORDERS_MIRROR", "backup-verify", { pending: 0, ackPending: 0 }),
      consumer("ORDERS_EU", "eu-reporting", { pending: 310, ackPending: 2 }),
      consumer("BILLING", "invoicer", { pending: 4, ackPending: 1, filterSubjects: ["billing.invoice.*"] }),
      consumer("BILLING", "refunds", { pending: 0, ackPending: 0, filterSubjects: ["billing.refund.*"], paused: true }),
      consumer("TELEMETRY", "ingest-hot", { pending: jitter(2300), ackPending: 140, maxAckPending: 20000 }),
      consumer("TELEMETRY", "ingest-cold", { pending: jitter(412000), ackPending: 1000, maxAckPending: 1000, redelivered: 3120 }),
      consumer("KV_sessions", "watch-sessions", { kind: "push", durable: false, deliverSubject: "_INBOX.x1", pushBound: true, ackPolicy: "none", maxAckPending: -1 }),
    ];
    const endpoints = [
      { service: "orders-api", version: "1.4.2", name: "create", subject: "orders.api.create", instances: 3, requests: jitter(98000), errors: 12, avgLatencyNs: 2.4e6 },
      { service: "orders-api", version: "1.4.2", name: "status", subject: "orders.api.status", instances: 3, requests: jitter(410000), errors: 0, avgLatencyNs: 0.6e6 },
      { service: "telemetry-query", version: "0.9.0", name: "range", subject: "telemetry.query.range", instances: 1, requests: 812, errors: 97, avgLatencyNs: 48e6, lastError: "timeout reading TELEMETRY" },
      { service: "quotes", version: "2.0.0", name: "quote", subject: "billing.quote", instances: 2, requests: 5100, errors: 0, avgLatencyNs: 1.1e6 },
    ];
    if (variant === "big") {
      for (let i = 0; i < 40; i++) {
        streams.push(stream(`APP_${String(i).padStart(2, "0")}`, { subjects: [`app${i}.events.>`, `app${i}.cmd.*`], messages: 1000 * i, bytes: 4096 * i * 100, consumerCount: 3 }));
        for (let j = 0; j < 3; j++) consumers.push(consumer(`APP_${String(i).padStart(2, "0")}`, `worker-${j}`, { pending: (i * 37 + j * 11) % 500 }));
      }
      // a stream with many consumers: the graph folds the healthy tail into "+N more consumers"
      streams.push(stream("WEBHOOKS", { subjects: ["hooks.>"], messages: 52000, bytes: 80 * 1024 ** 2, consumerCount: 31 }));
      for (let j = 0; j < 30; j++) consumers.push(consumer("WEBHOOKS", `tenant-${String(j).padStart(2, "0")}`, { pending: j * 3 }));
      consumers.push(consumer("WEBHOOKS", "tenant-zz-stuck", { pending: 64000, ackPending: 1000, maxAckPending: 1000 }));
    }
    return { at: Date.now(), jetstream: true, account: "APP", streams, consumers, endpoints, warnings: [] };
  }

  window.__MOCK__ = {
    snapshot() {
      if (variant === "loading") return new Promise(() => {});
      if (variant === "empty") return { at: Date.now(), jetstream: true, account: "APP", streams: [], consumers: [], endpoints: [], warnings: [] };
      if (variant === "nojs") return { at: Date.now(), jetstream: false, jetstreamError: "JetStream not enabled for account", account: "APP", streams: [], consumers: [], endpoints: [], warnings: [] };
      return new Promise((r) => setTimeout(() => r(data()), 150));
    },
    health() {
      return window.__MOCK_INIT__.health;
    },
    open(p) {
      window.__LAST_OPEN__ = p;
      return true;
    },
    exportSvg(p) {
      window.__LAST_EXPORT__ = p;
      return "/tmp/topology.svg";
    },
    reconnect() {
      setTimeout(() => window.__emit("connection", { state: "connected" }), 300);
      return true;
    },
    runCommand(p) {
      window.__LAST_COMMAND__ = p;
      return true;
    },
  };
})();

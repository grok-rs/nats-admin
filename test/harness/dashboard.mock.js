// Mock host for the server dashboard webview (node scripts/harness.mjs dashboard).
// Scenario via the URL hash: #dev (default), #prod (read-only production, slow RTT, critical
// health), #nomonitor (monitoring unreachable), #disconnected (not connected, no monitoring),
// #nojs (JetStream disabled), #cluster (the monitoring URL answers for another cluster member,
// tiered JetStream account limits, slow consumers growing). Counters grow on every poll so the rate charts move; on load the
// mock replays ~4 minutes of back-dated snapshots so the charts have history.
(function () {
  const scenario = (location.hash || "#dev").slice(1);
  const prod = scenario === "prod";
  const cluster = scenario === "cluster";
  const SERVER_ID = "NCM7V2C5QE5JIZUF4T4R33FCNT7OKAB2QZITYEMNHH43LVOOGU4QLKF3";
  const env = prod ? "prod" : "dev";
  const name = prod ? "eu-prod" : "local";
  window.__MOCK_INIT__ = {
    profileId: "c1",
    profileName: name,
    monitorUrl: "http://127.0.0.1:8222",
    refreshInterval: 1000,
    profile: { name, environment: env, readOnly: prod, origin: prod ? "nats-context" : "manual" },
    rttWarnMs: 100,
  };
  const start = Date.now() - 3 * 3600_000 - 20 * 60_000;
  let n = 0;
  let paused = false;
  const counters = { in_msgs: 125000, out_msgs: 98000, in_bytes: 41_000_000, out_bytes: 33_000_000 };
  const client = { inMsgs: 120, outMsgs: 30, inBytes: 40000, outBytes: 9000 };
  const conns = [
    { cid: 5, name: "NATS Admin (VS Code)", lang: "nats.js", version: "3.5.0", ip: "127.0.0.1", port: 51234, subscriptions: 3, rtt: "312µs" },
    { cid: 7, name: "orders-api", lang: "go", version: "1.41.2", ip: "10.0.4.12", port: 40122, subscriptions: 12, rtt: "1.204ms" },
    { cid: 9, name: "billing-worker-1", lang: "python3", version: "2.9.0", ip: "10.0.4.31", port: 39001, subscriptions: 4, rtt: "2.5ms", account: "BILLING" },
    { cid: 11, name: "", lang: "rust", version: "0.36.0", ip: "10.0.5.2", port: 50000, subscriptions: 1, rtt: "15ms" },
    { cid: 12, name: "billing-worker-2", lang: "python3", version: "2.9.0", ip: "10.0.4.32", port: 39002, subscriptions: 4, rtt: "2.1ms", account: "BILLING" },
    { cid: 14, name: "telemetry-ingest", lang: "java", version: "2.20.4", ip: "10.0.6.8", port: 41000, subscriptions: 2, rtt: "4.8ms", pending_bytes: 3_400_000 },
  ].map((c, i) => ({ ...c, in_msgs: 1000 * (i + 1), out_msgs: 800 * (i + 2), in_bytes: 50_000 * (i + 1), out_bytes: 70_000 * (i + 1), uptime: `${3 - (i % 3)}h${10 + i}m${5 * i}s`, pending_bytes: c.pending_bytes ?? 0 }));

  function snapshot(at) {
    n++;
    const burst = 200 + Math.round(150 * Math.sin(n / 9)) + Math.round(Math.random() * 80) + (n % 60 > 50 ? 400 : 0);
    counters.in_msgs += burst;
    counters.out_msgs += Math.round(burst * 0.8);
    counters.in_bytes += burst * 320;
    counters.out_bytes += burst * 260;
    client.inMsgs += 2;
    client.outMsgs += 1;
    client.inBytes += 2 * 180;
    client.outBytes += 96;
    conns.forEach((c, i) => {
      c.in_msgs += Math.round(burst / (i + 2));
      c.out_msgs += Math.round(burst / (i + 3));
    });
    const now = new Date(at ?? Date.now());
    const connected = scenario !== "disconnected";
    const monitor = scenario !== "nomonitor" && scenario !== "disconnected";
    const js = scenario !== "nojs";
    return {
      at: now.getTime(),
      state: connected ? "connected" : "error",
      error: connected ? undefined : "connect ECONNREFUSED 127.0.0.1:4222",
      connectedUrl: connected ? (prod ? "tls://nats-eu-1.internal:4222" : "nats://127.0.0.1:4222") : undefined,
      profile: window.__MOCK_INIT__.profile,
      paused,
      server: connected
        ? {
            name: prod ? "nats-eu-1" : "dev-local",
            id: SERVER_ID,
            version: "2.14.4",
            go: "go1.26.5",
            host: "0.0.0.0",
            port: 4222,
            proto: 1,
            cluster: prod ? "eu-west" : undefined,
            maxPayload: 1048576,
            tlsRequired: prod,
            authRequired: prod,
            jetstream: js,
            headers: true,
            clientId: 5,
            clientIp: "127.0.0.1",
          }
        : undefined,
      rttMs: connected ? (prod ? 120 + 40 * Math.sin(n / 7) + Math.random() * 15 : 0.25 + Math.random() * 0.4) : undefined,
      client: connected ? { ...client } : undefined,
      jetstream: !connected
        ? undefined
        : js
          ? {
              enabled: true,
              memory: 1_200_000,
              storage: 26_682_000 + n * 4000,
              reservedMemory: 0,
              reservedStorage: 0,
              streams: 5,
              consumers: 2,
              limits: cluster ? { maxMemory: -1, maxStorage: -1, maxStreams: -1, maxConsumers: -1, maxAckPending: -1 } : { maxMemory: -1, maxStorage: 100_000_000, maxStreams: -1, maxConsumers: 50, maxAckPending: -1 },
              tierLimits: cluster ? [{ maxMemory: 64 * 1024 ** 2, maxStorage: 80 * 1024 ** 2 }, { maxMemory: -1, maxStorage: -1 }] : [],
              api: { total: 740 + n * 3, errors: 4, level: 4 },
              domain: prod ? "hub" : undefined,
            }
          : { enabled: false },
      monitor: monitor
        ? {
            url: "http://127.0.0.1:8222",
            ok: true,
            varz: {
              server_name: cluster ? "nats-eu-2" : prod ? "nats-eu-1" : "dev-local",
              server_id: cluster ? "NDXPRFZ7S3Q2LVO4YH6TJ2WQ5KBN7RM3CEUAZ6GXHPT4VW2DLQ5YRN6J" : SERVER_ID,
              version: "2.14.4",
              uptime: "3h20m" + (n % 60) + "s",
              start: new Date(start).toISOString(),
              now: now.toISOString(),
              cpu: 3 + Math.random() * 12 + (n % 60 > 50 ? 25 : 0),
              mem: 20_160_512 + n * 1024 * 40,
              cores: 22,
              connections: conns.length,
              total_connections: 41,
              subscriptions: 87,
              slow_consumers: cluster ? 3 + Math.floor(n / 120) : prod ? 2 : 0,
              max_connections: 65536,
              routes: prod ? 4 : 0,
              leafnodes: prod ? 2 : 0,
              remotes: prod ? 2 : 0,
              gomaxprocs: 22,
              max_payload: 1048576,
              ...counters,
            },
            connz: { num_connections: conns.length, total: conns.length, connections: conns.map((c) => ({ ...c })) },
            jsz: { memory: 1_200_000, storage: 26_682_000, streams: 5, consumers: 2, messages: 12358, bytes: 3_450_803, accounts: 1, maxMemory: 50_137_353_216, maxStorage: 79_499_510_784, api: { total: 74, errors: 4 } },
            health: { status: prod ? "unavailable" : "ok", error: prod ? "JetStream stream ORDERS is not current" : undefined },
          }
        : { url: "http://127.0.0.1:8222", ok: false, error: "connect ECONNREFUSED 127.0.0.1:8222" },
      health: !connected
        ? undefined
        : prod
          ? { connId: "c1", score: 54, errors: 1, warnings: 3, infos: 0, at: new Date().toISOString(), top: [{ severity: "error", title: "Consumer ORDERS/shipping: 18,450 pending" }] }
          : { connId: "c1", score: 96, errors: 0, warnings: 0, infos: 1, at: new Date().toISOString(), top: [] },
      streams:
        connected && js
          ? [
              { name: "ORDERS", subjects: ["orders.>"], messages: 150, bytes: 24300, consumers: 2, storage: "file", retention: "limits", replicas: 1, sourced: "" },
              { name: "EVENTS", subjects: ["events.*.created", "events.*.deleted"], messages: 12034, bytes: 3_400_000, consumers: 0, storage: "memory", retention: "interest", replicas: 3, sourced: "" },
              { name: "ORDERS_EU", subjects: ["orders.eu.*"], messages: 90, bytes: 14_000, consumers: 1, storage: "file", retention: "workqueue", replicas: 3, sourced: "" },
              { name: "ORDERS_BACKUP", subjects: [], messages: 150, bytes: 24300, consumers: 0, storage: "file", retention: "limits", replicas: 1, sourced: "mirror of ORDERS" },
              { name: "KV_config", subjects: ["$KV.config.>"], messages: 22, bytes: 1800, consumers: 0, storage: "file", retention: "limits", replicas: 1, sourced: "" },
              { name: "OBJ_files", subjects: ["$O.files.C.>", "$O.files.M.>"], messages: 2, bytes: 403, consumers: 0, storage: "file", retention: "limits", replicas: 1, sourced: "" },
            ]
          : undefined,
    };
  }

  window.__CALLS__ = [];
  let first = true;
  window.__MOCK__ = {
    refresh: () =>
      new Promise((r) => {
        const delay = first ? 450 : 20;
        if (first) backfill(); // the app registers its listeners before its first RPC
        first = false;
        setTimeout(() => r(snapshot()), delay);
      }),
    setPaused: (p) => ((paused = !!p.paused), window.__CALLS__.push("setPaused:" + paused), paused),
    openServerInfo: () => (window.__CALLS__.push("openServerInfo"), null),
    openMonitor: (p) => (window.__CALLS__.push("openMonitor:" + (p.path || "")), null),
    connect: () => (window.__CALLS__.push("connect"), true),
    editConnection: () => (window.__CALLS__.push("editConnection"), null),
    browseStream: (p) => (window.__CALLS__.push("browse:" + p.stream), null),
    run: (p) => (window.__CALLS__.push("run:" + p.command), null),
    openDocs: (p) => (window.__CALLS__.push("openDocs:" + p.url), null),
  };
  // Back-dated history (after the first RPC), then live snapshots every second (unless paused).
  function backfill() {
    if (scenario === "disconnected") return;
    const now = Date.now();
    for (let i = 240; i > 0; i--) window.__emit("snapshot", snapshot(now - i * 1000 - 500));
  }
  setInterval(() => !first && !paused && window.__emit && window.__emit("snapshot", snapshot()), 1000);
})();

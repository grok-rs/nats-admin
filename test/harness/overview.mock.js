// Mock host for the Overview sidebar webview (node scripts/harness.mjs overview).
// Scenario via the URL hash: #dev (default), #prod (read-only production, slow RTT, findings),
// #nomonitor (monitoring unreachable), #offline (nothing connected), #empty (no profiles),
// #nojs (JetStream disabled). Each `snapshot` call advances the simulated counters.
(function () {
  const scenario = (location.hash || "#dev").slice(1);
  window.__MOCK_INIT__ = { refreshInterval: 1000, visible: true, rttWarnMs: 100 };

  const base = { readOnly: false, origin: "manual", autoConnect: false, selectedContext: false, managed: true, active: false, auth: "none", tls: false };
  const profiles = [
    { ...base, id: "c1", name: scenario === "prod" ? "eu-prod" : "local", servers: [scenario === "prod" ? "nats://nats-eu-1.internal:4222" : "nats://127.0.0.1:4222"], environment: scenario === "prod" ? "prod" : "dev", readOnly: scenario === "prod", origin: scenario === "prod" ? "nats-context" : "manual", contextName: "eu-prod", state: "connected", active: true, tls: scenario === "prod" },
    { ...base, id: "c2", name: "staging-us", servers: ["tls://nats.staging.example.com:4222"], environment: "staging", origin: "workspace", state: "connected" },
    { ...base, id: "c3", name: "ci-nats", servers: ["nats://ci-nats:4222"], origin: "env", state: "error", error: "connection refused (ECONNREFUSED 10.0.0.9:4222)" },
    { ...base, id: "c4", name: "qa-cluster", servers: ["nats://qa-1:4222", "nats://qa-2:4222"], environment: "test", origin: "nats-context", contextName: "qa", state: "disconnected" },
    { ...base, id: "c5", name: "us-prod", servers: ["nats://nats-us-1.internal:4222"], environment: "prod", readOnly: true, origin: "nats-context", state: "disconnected" },
    { ...base, id: "c6", name: "sandbox", servers: ["nats://localhost:4333"], environment: "dev", state: "connecting" },
  ];
  if (scenario === "offline") for (const p of profiles) if (p.state === "connected") ((p.state = "disconnected"), (p.active = false));

  let n = 0;
  let history = [];
  const t0 = Date.now() - 40 * 1000;
  for (let i = 0; i < 40; i++) history.push(point(t0 + i * 1000, i));

  function point(t, i) {
    const wave = Math.sin(i / 5);
    return {
      t,
      rtt: scenario === "prod" ? 140 + 40 * Math.sin(i / 3) + Math.random() * 20 : 0.3 + Math.random() * 0.4,
      msgsIn: 1200 + 400 * wave + Math.random() * 120,
      msgsOut: 980 + 300 * wave + Math.random() * 90,
      bytesIn: (1200 + 400 * wave) * 340,
      bytesOut: (980 + 300 * wave) * 290,
      cpu: 4 + Math.random() * 8,
    };
  }

  function metrics() {
    n++;
    const now = Date.now();
    history = [...history, point(now, 40 + n)].slice(-90);
    const last = history[history.length - 1];
    const noMonitor = scenario === "nomonitor";
    return {
      profileId: "c1",
      at: now,
      connectedUrl: profiles[0].servers[0],
      server: { name: scenario === "prod" ? "nats-eu-1" : "dev-local", id: "NCM7V2C5QE5JIZUF4T4R33FCNT7OKAB2QZITYEMNHH43LVOOGU4QLKF3", version: "2.14.4", cluster: scenario === "prod" ? "eu-west" : undefined, jetstream: scenario !== "nojs", clientId: 5, tlsRequired: scenario === "prod", authRequired: scenario === "prod" },
      rttMs: last.rtt,
      rates: noMonitor ? { msgsIn: 2, msgsOut: 1, bytesIn: 512, bytesOut: 128, source: "client" } : { msgsIn: last.msgsIn, msgsOut: last.msgsOut, bytesIn: last.bytesIn, bytesOut: last.bytesOut, source: "server" },
      client: { inMsgs: 120 + n, outMsgs: 30 + n, inBytes: 40000, outBytes: 9000 },
      varz: noMonitor ? undefined : { connections: 42, totalConnections: 311, maxConnections: 65536, subscriptions: 870, slowConsumers: scenario === "prod" ? 2 : 0, cpu: last.cpu, mem: 120_000_000, cores: 8, uptime: "3d4h12m", start: new Date(now - 3 * 86400_000).toISOString() },
      monitor: noMonitor ? { url: "http://127.0.0.1:8222", ok: false, error: "connect ECONNREFUSED 127.0.0.1:8222" } : { url: "http://127.0.0.1:8222", ok: true },
      jetstream:
        scenario === "nojs"
          ? { enabled: false }
          : { enabled: true, streams: 12, totalStreams: 17, consumers: 31, kv: 4, obj: 1, memory: 1_200_000_000, storage: 9.6 * 1024 ** 3 + n * 4096, maxMemory: 1.25 * 1024 ** 3, maxStorage: 12 * 1024 ** 3, memorySource: "account", storageSource: "account", api: { total: 74000, errors: scenario === "prod" ? 12 : 0 }, domain: scenario === "prod" ? "hub" : undefined },
      history,
    };
  }

  const health =
    scenario === "prod"
      ? { connId: "c1", score: 54, errors: 1, warnings: 3, infos: 2, at: new Date(Date.now() - 95_000).toISOString(), top: [{ severity: "error", title: "Consumer ORDERS/shipping has 18,450 pending messages" }, { severity: "warning", title: "Stream TELEMETRY is at 92% of max_bytes" }, { severity: "warning", title: "Round-trip time 168 ms exceeds 100 ms" }] }
      : scenario === "dev"
        ? { connId: "c1", score: 96, errors: 0, warnings: 0, infos: 1, at: new Date(Date.now() - 20_000).toISOString(), top: [] }
        : undefined;

  function snapshot() {
    const list = scenario === "empty" ? [] : profiles.map((p) => ({ ...p }));
    const live = list.filter((p) => p.state === "connected" || p.state === "reconnecting");
    const activeP = list.find((p) => p.active && (p.state === "connected" || p.state === "reconnecting"));
    return {
      at: Date.now(),
      profiles: list,
      live,
      active: activeP ? { profile: activeP, metrics: metrics(), health } : undefined,
    };
  }

  window.__CALLS__ = [];
  window.__MOCK__ = {
    snapshot: () => new Promise((r) => setTimeout(() => r(snapshot()), n === 0 ? 400 : 30)),
    run: (p) => (window.__CALLS__.push(`run:${p.command}:${p.profileId || ""}`), null),
    setActive: (p) => (window.__CALLS__.push(`setActive:${p.profileId}`), null),
    reveal: (p) => (window.__CALLS__.push(`reveal:${p.profileId}`), null),
    retryMonitor: (p) => (window.__CALLS__.push(`retryMonitor:${p.profileId}`), null),
    openDocs: (p) => (window.__CALLS__.push(`openDocs:${p.url}`), null),
  };
})();

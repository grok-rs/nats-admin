// Mock host for the Home (fleet) webview (node scripts/harness.mjs home).
// Scenario via the URL hash: #fleet (default; mixed environments, states and health) or
// #empty (no profiles → getting started). Each `snapshot` call advances the metrics.
(function () {
  const scenario = (location.hash || "#fleet").slice(1);
  window.__MOCK_INIT__ = { refreshInterval: 1500, rttWarnMs: 100 };
  const base = { readOnly: false, origin: "manual", autoConnect: false, selectedContext: false, managed: true, active: false, auth: "none", tls: false };
  const profiles = [
    { ...base, id: "eu", name: "eu-prod", servers: ["tls://nats-eu-1.internal:4222", "tls://nats-eu-2.internal:4222", "tls://nats-eu-3.internal:4222"], environment: "prod", readOnly: true, origin: "nats-context", contextName: "eu-prod", selectedContext: true, managed: false, state: "connected", auth: "creds", tls: true, active: true },
    { ...base, id: "us", name: "us-prod", servers: ["tls://nats-us-1.internal:4222"], environment: "prod", readOnly: true, origin: "nats-context", contextName: "us-prod", managed: false, state: "reconnecting", auth: "creds", tls: true },
    { ...base, id: "stg", name: "staging", servers: ["nats://nats.staging.example.com:4222"], environment: "staging", origin: "workspace", managed: false, state: "connected", auth: "userpass" },
    { ...base, id: "qa", name: "qa-cluster", servers: ["nats://qa-1:4222", "nats://qa-2:4222"], environment: "test", state: "error", error: "Authorization Violation — user credentials expired on 2026-11-10", auth: "nkey" },
    { ...base, id: "local", name: "local", servers: ["nats://127.0.0.1:4222"], environment: "dev", state: "connected", autoConnect: true },
    { ...base, id: "sbx", name: "sandbox", servers: ["nats://localhost:4333"], environment: "dev", state: "disconnected", description: "Throwaway server for experiments" },
    { ...base, id: "ci", name: "NATS_URL", servers: ["nats://ci-nats:4222"], origin: "env", managed: false, state: "disconnected" },
    { ...base, id: "legacy", name: "legacy-nsc", servers: ["nats://old:4222"], origin: "nats-context", managed: false, state: "disconnected", warning: "nsc:// credentials are not supported — export a .creds file instead" },
  ];
  const hist = {};
  let n = 0;
  function history(id, rtt, rate) {
    const h = (hist[id] = hist[id] || []);
    const now = Date.now();
    if (!h.length) for (let i = 30; i > 0; i--) h.push(pt(now - i * 1500, rtt, rate, i));
    h.push(pt(now, rtt, rate, n));
    while (h.length > 90) h.shift();
    return h.slice();
  }
  function pt(t, rtt, rate, i) {
    return { t, rtt: rtt * (0.8 + Math.random() * 0.4), msgsIn: rate * (1 + 0.3 * Math.sin(i / 4)), msgsOut: rate * 0.8, bytesIn: rate * 300, bytesOut: rate * 250 };
  }
  function metrics(p) {
    const spec = {
      eu: { rtt: 38, rate: 18_400, server: "nats-eu-1", cluster: "eu-west", js: { streams: 42, totalStreams: 51, consumers: 188, kv: 7, obj: 2, storage: 610 * 1024 ** 3, maxStorage: 1024 * 1024 ** 3, memory: 3.1 * 1024 ** 3, maxMemory: 8 * 1024 ** 3 } },
      us: { rtt: 160, rate: 9_100, server: "nats-us-1", cluster: "us-east", js: { streams: 40, totalStreams: 48, consumers: 170, kv: 6, obj: 2, storage: 590 * 1024 ** 3, maxStorage: 640 * 1024 ** 3, memory: 1.1 * 1024 ** 3, maxMemory: 8 * 1024 ** 3 } },
      stg: { rtt: 12, rate: 640, server: "stg-nats-0", js: { streams: 18, totalStreams: 22, consumers: 41, kv: 3, obj: 1, storage: 21 * 1024 ** 3, maxStorage: 100 * 1024 ** 3, memory: 200 * 1024 ** 2, maxMemory: 2 * 1024 ** 3 } },
      local: { rtt: 0.4, rate: 1.5, server: "dev-local", monitorDown: true, js: { streams: 3, totalStreams: 5, consumers: 2, kv: 1, obj: 1, storage: 26 * 1024 ** 2, maxStorage: 74 * 1024 ** 3, memory: 0, maxMemory: 46 * 1024 ** 3, storageSource: "server", memorySource: "server" } },
    }[p.id];
    if (!spec) return undefined;
    const h = history(p.id, spec.rtt, spec.rate);
    const last = h[h.length - 1];
    return {
      profileId: p.id,
      at: Date.now(),
      connectedUrl: p.servers[0],
      server: { name: spec.server, id: `N${p.id.toUpperCase()}7V2C5QE5JIZUF4T4R33FCNT7OKAB2QZITYEMNHH43LVOOGU4Q`, version: p.id === "local" ? "2.14.4" : "2.12.3", cluster: spec.cluster, jetstream: true, tlsRequired: p.tls, authRequired: p.auth !== "none" },
      rttMs: last.rtt,
      rates: spec.monitorDown ? { msgsIn: 1.5, msgsOut: 0.5, bytesIn: 300, bytesOut: 90, source: "client" } : { msgsIn: last.msgsIn, msgsOut: last.msgsOut, bytesIn: last.bytesIn, bytesOut: last.bytesOut, source: "server" },
      monitor: spec.monitorDown ? { url: "http://127.0.0.1:8222", ok: false, error: "ECONNREFUSED" } : { url: `http://${spec.server}:8222`, ok: true },
      varz: spec.monitorDown ? undefined : { connections: 120, totalConnections: 9000, maxConnections: 65536, subscriptions: 3000, slowConsumers: 0, cpu: 12, mem: 900_000_000, cores: 16, uptime: "12d3h", start: new Date().toISOString() },
      jetstream: { enabled: true, storageSource: "account", memorySource: "account", api: { total: 1000, errors: 0 }, ...spec.js },
      history: h,
    };
  }
  const health = {
    eu: { connId: "eu", score: 97, errors: 0, warnings: 1, infos: 2, at: new Date(Date.now() - 300_000).toISOString(), top: [{ severity: "warning", title: "Consumer ORDERS/analytics has not been active for 2h" }] },
    stg: { connId: "stg", score: 48, errors: 2, warnings: 4, infos: 0, at: new Date(Date.now() - 60_000).toISOString(), top: [{ severity: "error", title: "Stream EVENTS is at 98% of max_bytes and discards new messages" }, { severity: "error", title: "Consumer EVENTS/indexer: 1.2M pending" }] },
    us: { connId: "us", score: 74, errors: 0, warnings: 3, infos: 0, at: new Date(Date.now() - 900_000).toISOString(), top: [{ severity: "warning", title: "Account storage at 92% of its limit" }] },
  };

  function snapshot() {
    n++;
    if (scenario === "empty") return { at: Date.now(), rows: [], hidden: 2 };
    return {
      at: Date.now(),
      hidden: 1,
      rows: profiles.map((p) => ({ profile: { ...p }, metrics: p.state === "connected" || p.state === "reconnecting" ? metrics(p) : undefined, health: health[p.id] })),
    };
  }

  window.__CALLS__ = [];
  window.__MOCK__ = {
    snapshot: () => new Promise((r) => setTimeout(() => r(snapshot()), n === 0 ? 500 : 40)),
    run: (p) => (window.__CALLS__.push(`run:${p.command}:${p.profileId || ""}`), null),
    reveal: (p) => (window.__CALLS__.push(`reveal:${p.profileId}`), null),
    retryMonitor: (p) => (window.__CALLS__.push(`retryMonitor:${p.profileId}`), null),
    openDocs: (p) => (window.__CALLS__.push(`openDocs:${p.url}`), null),
  };
})();

// Mock host for webview/cluster.tsx (node scripts/harness.mjs cluster).
// Variants via the URL hash: (default) super-cluster with $SYS access, #monitor, #basic,
// #prod, #loading, #error (reconnecting), #single
(function () {
  const variant = (location.hash || "").slice(1);
  const start = Date.now();
  window.__MOCK_INIT__ = {
    profileId: "c1",
    profileName: variant === "prod" ? "prod-eu" : "ops-east",
    environment: variant === "prod" ? "prod" : variant === "single" ? "dev" : "test",
    readOnly: variant === "prod",
    serverName: "n1",
    connectedUrl: "nats://n1.east.internal:4222",
    cluster: "east",
    monitorUrl: "http://n1.east.internal:8222",
    refreshInterval: 1000,
    state: variant === "error" ? "reconnecting" : "connected",
  };

  const GiB = 1024 ** 3;
  const servers = [
    { id: "NA2DHREBLVAKZOJSVJCSMG3JY5PX7IWA6KQOWO2JDBEKCFJKVEXHZX2V", name: "n1", cluster: "east", cores: 8, cpu: 14, mem: 412e6, conns: 412, subs: 18200, rate: 3200, slow: 0, js: [1.2, 8, 310, 600] },
    { id: "NBZMG63LCH2C22QIZP2ALXN4K57HRGZEXEBSXRUVZWKTT4EKFG355PNN", name: "n2", cluster: "east", cores: 8, cpu: 22, mem: 520e6, conns: 388, subs: 17900, rate: 2900, slow: 0, js: [1.3, 8, 300, 600], leader: true },
    { id: "NBFSL5TSUOLIVLQVW46HHCWVH7XKXDFD2HSYKRLCOM355PBEX7OAODTO", name: "n3", cluster: "east", cores: 8, cpu: 560, mem: 1.9e9, conns: 512, subs: 21000, rate: 4100, slow: 3, js: [1.25, 8, 560, 600] },
    { id: "NWEST1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "w1", cluster: "west", cores: 4, cpu: 9, mem: 300e6, conns: 120, subs: 6100, rate: 900, slow: 0, js: [0.5, 4, 80, 300] },
    { id: "NWEST2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "w2", cluster: "west", cores: 4, cpu: 11, mem: 310e6, conns: 131, subs: 6300, rate: 950, slow: 0, js: [0.5, 4, 82, 300] },
    { id: "NWEST3XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", name: "w3", cluster: "west", cores: 4, cpu: 7, mem: 290e6, conns: 98, subs: 5900, rate: 870, slow: 0, js: [0.5, 4, 79, 300], unhealthy: true },
  ];
  const user = {
    available: true,
    user: variant === "basic" || variant === "monitor" ? "app" : "ops",
    account: variant === "basic" || variant === "monitor" ? "APP" : "SYS",
    permissions:
      variant === "basic" || variant === "monitor"
        ? { unrestricted: false, publish: { allow: ["orders.>", "billing.>"], deny: ["secret.>"] }, subscribe: { allow: [">"], deny: [] }, lines: ["Publish: allow orders.>, billing.>; deny secret.>", "Subscribe: allow >"], short: "pub ✓ orders.> billing.> ✗ secret.> · sub ✓ >" }
        : { unrestricted: true, publish: { allow: [], deny: [] }, subscribe: { allow: [], deny: [] }, lines: ["Publish and subscribe: unrestricted"], short: "unrestricted" },
    expires: new Date(start + 3 * 86400000).toISOString(),
    server: "n1",
  };

  function row(s, t, i) {
    const secs = (t - start) / 1000;
    const wobble = 1 + 0.25 * Math.sin(secs / 7 + i);
    return {
      id: s.id,
      name: s.name,
      host: "0.0.0.0",
      cluster: s.cluster,
      version: i === 5 ? "2.12.1" : "2.14.4",
      jetstream: true,
      start: new Date(start - (i + 1) * 3.7 * 86400000).toISOString(),
      uptimeMs: (i + 1) * 3.7 * 86400000 + (t - start),
      cpu: s.cpu * wobble,
      cores: s.cores,
      mem: s.mem,
      connections: s.conns + Math.round(5 * Math.sin(secs / 5 + i)),
      totalConnections: s.conns * 31,
      subscriptions: s.subs,
      slowConsumers: s.slow,
      inMsgs: Math.round(1e8 + s.rate * secs * wobble),
      outMsgs: Math.round(1.4e8 + s.rate * 1.3 * secs * wobble),
      inBytes: Math.round(5e10 + s.rate * 512 * secs),
      outBytes: Math.round(7e10 + s.rate * 640 * secs),
      routePeers: servers.filter((o) => o.cluster === s.cluster && o !== s).map((o) => o.name),
      gateways: [s.cluster === "east" ? "west" : "east"],
      leafs: s.name === "n1" ? 2 : s.name === "w2" ? 1 : 0,
      js: { memory: s.js[0] * GiB, maxMemory: s.js[1] * GiB, storage: s.js[2] * GiB, maxStorage: s.js[3] * GiB, apiTotal: 120000, apiErrors: 12 },
      health: s.unhealthy ? { status: "error", detail: "JetStream stream DRILL is not current" } : { status: "ok" },
      metaLeader: !!s.leader,
      connected: s.name === "n1",
    };
  }

  function routes() {
    const out = [];
    for (const s of servers)
      for (const p of servers.filter((o) => o.cluster === s.cluster && o !== s))
        out.push({ serverId: s.id, serverName: s.name, remoteId: p.id, remoteName: p.name, ip: "10.0.0." + (servers.indexOf(p) + 10), port: 6222, rttMs: 0.2 + servers.indexOf(p) * 0.05, connections: 3, inMsgs: 120000, outMsgs: 118000, inBytes: 8.2e7, outBytes: 7.9e7, pending: 0, subscriptions: 4200, compression: "s2_auto", solicited: true });
    return out;
  }

  window.__MOCK__ = {
    snapshot() {
      if (variant === "loading") return new Promise(() => {});
      const t = Date.now();
      const base = { at: t, connectedServerId: servers[0].id, connectedServerName: "n1", connectedUrl: "nats://n1.east.internal:4222", rttMs: 0.42, user };
      if (variant === "basic")
        return { ...base, mode: "basic", servers: [{ id: servers[0].id, name: "n1", cluster: "east", version: "2.14.4", jetstream: true, routePeers: [], gateways: [], connected: true, health: { status: "unknown" } }], routes: [], gateways: [], leafs: [], monitorUrl: "http://n1.east.internal:8222", monitorError: "fetch failed: connect ECONNREFUSED 10.0.0.10:8222", sysNote: "No system-account access (no responders)" };
      if (variant === "monitor") {
        const r = row(servers[0], t, 0);
        r.routePeers = ["n2", "n3"];
        r.metaLeader = false;
        return {
          ...base,
          mode: "monitor",
          monitorUrl: "http://n1.east.internal:8222",
          sysNote: "No system-account access (no responders)",
          servers: [r, { id: servers[1].id, name: "n2", cluster: "east", version: "", jetstream: false, routePeers: ["n1"], gateways: [], ghost: true }, { id: servers[2].id, name: "n3", cluster: "east", version: "", jetstream: false, routePeers: ["n1"], gateways: [], ghost: true }],
          routes: routes().filter((x) => x.serverName === "n1"),
          gateways: [{ serverId: servers[0].id, serverName: "n1", cluster: "east", remote: "west", direction: "outbound", rttMs: 21.4, inMsgs: 41000, outMsgs: 52000 }],
          leafs: [{ serverId: servers[0].id, serverName: "n1", name: "edge-berlin", account: "APP", ip: "203.0.113.7", port: 51123, rttMs: 18 }],
          meta: { leader: "n2", clusterSize: 3 },
          topologyAt: t,
        };
      }
      const list = variant === "single" ? servers.slice(0, 1) : servers;
      const rows = list.map((s, i) => row(s, t, i));
      if (variant === "single") {
        rows[0].routePeers = [];
        rows[0].gateways = [];
        rows[0].cluster = undefined;
      }
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              ...base,
              mode: "system",
              servers: rows,
              expectedServers: variant === "single" ? 1 : 7,
              routes: variant === "single" ? [] : routes(),
              gateways: variant === "single" ? [] : [
                { serverId: servers[0].id, serverName: "n1", cluster: "east", remote: "west", direction: "outbound", rttMs: 21.4, inMsgs: 41000, outMsgs: 52000 },
                { serverId: servers[3].id, serverName: "w1", cluster: "west", remote: "east", direction: "outbound", rttMs: 21.9, inMsgs: 52000, outMsgs: 41000 },
                { serverId: servers[0].id, serverName: "n1", cluster: "east", remote: "west", direction: "inbound", rttMs: 22.1 },
              ],
              leafs: variant === "single" ? [] : [
                { serverId: servers[0].id, serverName: "n1", name: "edge-berlin", account: "APP", ip: "203.0.113.7", port: 51123, rttMs: 18, subscriptions: 120 },
                { serverId: servers[0].id, serverName: "n1", name: "edge-paris", account: "APP", ip: "203.0.113.9", port: 50210, rttMs: 23, subscriptions: 98 },
                { serverId: servers[4].id, serverName: "w2", name: "factory-7", account: "IOT", ip: "198.51.100.4", port: 7422, rttMs: 61, subscriptions: 40 },
              ],
              meta: { leader: "n2", clusterSize: 6, name: "east" },
              topologyAt: t,
            }),
          120,
        ),
      );
    },
    whoAmI() {
      window.__LAST__ = "whoAmI";
      return true;
    },
    serverDetails(p) {
      window.__LAST__ = "details:" + p.name;
      return true;
    },
    openMonitor() {
      return true;
    },
    editConnection() {
      return true;
    },
    reconnect() {
      setTimeout(() => window.__emit("connection", { state: "connected" }), 300);
      return true;
    },
  };
})();
